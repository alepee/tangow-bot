import type { IncomingHttpHeaders } from "node:http";
import type { ScreenProxyTarget } from "@tangow/core/node/screen-capability";
import {
  isScreenProxyTarget,
  SCREEN_RECHECK_MS,
  SCREEN_TARGET_ENDPOINT,
} from "@tangow/core/node/screen-capability";

/**
 * The computer is untrusted: send only what websockify needs to upgrade its socket, never
 * credentials a browser, the desktop app or an auth proxy attached.
 */
const FORWARDED_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
]);

const CAPABILITY_FILE = /^\/novnc\/session\/(?:view|control)\/\d+\.[A-Za-z0-9_-]+\/([^?#]*)/;

/** The file a screen request names inside its capability directory, e.g. `embed.html`. */
export function screenFile(url: string) {
  return CAPABILITY_FILE.exec(url)?.[1] ?? null;
}

/** Fail closed when the authoritative lifecycle check is unavailable. */
export async function resolveNovncTarget(
  url: string | undefined,
  secret: string,
  api: string,
): Promise<ScreenProxyTarget | null> {
  if (!url?.startsWith("/novnc/session/")) return null;
  try {
    const response = await fetch(new URL(SCREEN_TARGET_ENDPOINT, api), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: url }),
    });
    if (!response.ok) return null;
    const target: unknown = await response.json();
    return isScreenProxyTarget(target) ? target : null;
  } catch {
    return null;
  }
}

export function safeProxyHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) => value != null && FORWARDED_HEADERS.has(key.toLowerCase()),
    ),
  );
}

/** Recheck streams as well as new requests; no positive authorization cache. */
export function watchScreenAuthorization(check: () => Promise<boolean>, revoke: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    let allowed = false;
    try {
      allowed = Boolean(await check());
    } catch {
      /* Fail closed. */
    }
    if (stopped) return;
    if (!allowed) {
      stopped = true;
      revoke();
      return;
    }
    timer = setTimeout(tick, SCREEN_RECHECK_MS);
    timer.unref?.();
  };
  timer = setTimeout(tick, SCREEN_RECHECK_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
