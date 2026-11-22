import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  NotificationMessage,
  NotificationProvider,
} from "@tangow/adapter-kit";
import { getLogger } from "@tangow/logging";
import { combineSignals } from "./connector-safety.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const EXPO_PUSH_TIMEOUT_MS = 15_000;
export const MAX_EXPO_PUSH_RESPONSE_BYTES = 64 * 1024;

export function pushTokenPath(dataDir: string, userId: string) {
  return path.join(dataDir, "push-tokens", `${userId}.txt`);
}

export async function loadPushToken(dataDir: string, userId: string): Promise<string | undefined> {
  try {
    const handle = await open(pushTokenPath(dataDir, userId), constants.O_RDONLY | O_NOFOLLOW);
    try {
      const token = (await handle.readFile("utf8")).trim();
      return token || undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function savePushToken(dataDir: string, userId: string, token: string): Promise<void> {
  const file = pushTokenPath(dataDir, userId);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(token.trim(), "utf8");
  } finally {
    await handle.close();
  }
}

export async function deletePushToken(dataDir: string, userId: string): Promise<void> {
  await unlink(pushTokenPath(dataDir, userId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export type ExpoPushTicket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

export function expoPushTickets(body: unknown): ExpoPushTicket[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.filter((item): item is ExpoPushTicket => Boolean(item) && typeof item === "object");
  }
  if (data && typeof data === "object") return [data as ExpoPushTicket];
  return [];
}

export function expoPushErrorMessage(body: unknown, status: number): string | undefined {
  if (body && typeof body === "object" && "errors" in body) {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((error) => error.message ?? "expo push error").join("; ");
    }
  }
  const failed = expoPushTickets(body).filter((ticket) => ticket.status === "error");
  if (failed.length > 0) {
    return failed
      .map((ticket) => ticket.message ?? ticket.details?.error ?? "expo push ticket error")
      .join("; ");
  }
  if (status < 200 || status >= 300) return `expo push failed (${status})`;
  return undefined;
}

/**
 * True when Expo says the device behind the token is gone — the app was deleted, or
 * the token was minted for another EAS project or bundle id. Only this one error
 * condemns the token; `InvalidCredentials` blames the sender's push key instead, and
 * dropping a good token over it would silence a user until they reopen the app.
 */
export function expoPushTokenIsDead(body: unknown): boolean {
  return expoPushTickets(body).some((ticket) => ticket.details?.error === "DeviceNotRegistered");
}

export class ExpoPushProvider implements NotificationProvider {
  constructor(private readonly dataDir: string) {}

  describe() {
    return {
      id: "expo-push",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: true, email: false },
    };
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    const token = await loadPushToken(this.dataDir, context.userId);
    if (!token) return;
    const signal = combineSignals(context.signal, AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS));
    let response: Response;
    try {
      response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          to: token,
          title: message.title,
          subtitle: message.subtitle,
          body: message.body,
          collapseId: message.threadId,
          tag: message.threadId,
          badge: message.badge,
          mutableContent: message.avatar ? true : undefined,
          data: {
            kind: message.kind,
            spaceId: context.spaceId,
            botId: message.botId,
            groupId: message.groupId,
            threadId: message.threadId,
            avatarCharacter: message.avatar?.character,
            avatarColor: message.avatar?.color,
            avatarShape: message.avatar?.shape,
          },
        }),
        signal,
      });
    } catch (error) {
      getLogger().error("expo push request failed", error);
      throw error;
    }
    const body = await readExpoPushBody(response, signal);
    if (response.ok && body === undefined) {
      throw new Error("Expo push returned an invalid response.");
    }
    const failure = expoPushErrorMessage(body, response.status);
    if (!failure) return;
    if (expoPushTokenIsDead(body)) {
      // Expo asks senders to stop pushing to a dead token. Keeping it also hides the
      // breakage: every later notification fails the same way and nothing ever asks
      // the device for a fresh one. Dropping it makes the next app open re-register.
      // ponytail: re-read instead of locking — the device can register a fresh token
      // while this request is in flight, and that one is not the one Expo condemned.
      if ((await loadPushToken(this.dataDir, context.userId)) === token) {
        await deletePushToken(this.dataDir, context.userId);
        getLogger().warn(`expo push dropped a dead token: ${failure}`);
      }
    }
    getLogger().error(failure);
    throw new Error(failure);
  }
}

async function readExpoPushBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_EXPO_PUSH_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error("Expo push response is too large.");
  }
  try {
    const bytes = await readBodyCapped(response, MAX_EXPO_PUSH_RESPONSE_BYTES, signal);
    if (bytes.byteLength === 0) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Expo push response is too large.");
    }
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
