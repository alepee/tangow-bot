import type {
  Bot,
  BotSection,
  ComputerMode,
  EntryId,
  Group,
  GroupPerson,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  ProductEvent,
  Space,
  SpaceNavigation,
  ThreadEntry,
  ThreadItem,
  ThreadMessagePage,
} from "@tangow/contracts";
import type { ProgressLayer, ThreadRow } from "@tangow/core";
import {
  applyEntryEvent,
  isRunTerminalEvent,
  readBoundedJsonResponse,
  reduceProgressLayer,
  runFailureError,
  signupRequiresEmailVerification,
  withOlderEntries,
  withRefreshedEntries,
} from "@tangow/core";
import * as SecureStore from "expo-secure-store";
import type { AccessCredentials } from "./access";
import { currentAccessHeaders, loadAccess, saveAccess } from "./access-store";
import { defaultApiBase, type EndpointResult, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { resumeLiveNotifications } from "./live-notifications";
import { serverError } from "./server-error";
import {
  clearSessionToken,
  loadSessionToken,
  restoreSessionToken,
  saveSessionToken,
  snapshotSessionToken,
  tokenFromAuthResponse,
} from "./session";

const ENDPOINT_KEY = "tangow.api_base";
const SPACE_KEY = "tangow.space_id";
const SPACE_ROLLBACK_KEY = "tangow.space_rollback";
const RPC_TIMEOUT_MS = 8_000;
export const MAX_MOBILE_AUTH_RESPONSE_BYTES = 256 * 1024;
export const MAX_MOBILE_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Inbox bootstrap reads safe to replay without a Space header during auth recovery. */
const SPACE_AUTH_RECOVERY_SAFE_PROCS = new Set(["spaces/list", "me"]);

let cachedApiBase: string | undefined;
let cachedSpaceId = "";
/** Bumped on every in-memory Space selection change so a delayed response
 * cannot treat a later reselection of the same Space id as its own. */
let spaceSelectionGeneration = 0;

function bumpSpaceSelectionGeneration(): void {
  spaceSelectionGeneration += 1;
}

function responseErrorMessage(body: unknown, fallback: string): string {
  return typeof body === "object" && body && "message" in body
    ? String((body as { message?: string }).message ?? fallback)
    : fallback;
}

export function currentApiBase() {
  const parsed = normalizeApiBase(cachedApiBase ?? defaultApiBase());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.url;
}

export async function loadApiBase() {
  let apiBase = defaultApiBase();
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        apiBase = parsed.url;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  cachedApiBase = apiBase;
  await loadAccess(apiBase);
  try {
    const storedSpace = (await SecureStore.getItemAsync(SPACE_KEY)) ?? "";
    cachedSpaceId = storedSpace;
    bumpSpaceSelectionGeneration();
    // A deletion fallback must override the now-invalid saved Space even when
    // the device failed to replace that value before the previous process exited.
    await recoverSpaceRollback(cachedApiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  return cachedApiBase;
}

export async function selectSpace(id: string) {
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = cachedSpaceId;
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  // Generation ownership distinguishes A→B→A from "we still own this claim":
  // an ID-only check would treat a later same-id selection as ours.
  const claimGeneration = spaceSelectionGeneration;
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    // Our write may have landed stale behind a newer overlapping selection's
    // write. Re-assert the live selection best-effort so durable converges
    // to it; each selector heals at most once, so overlapping chains settle
    // on the latest claim. Never delete here: a missing memory owner means
    // another path (recovery, sign-out) owns cleanup.
    const liveSpaceId = cachedSpaceId;
    if (liveSpaceId && liveSpaceId !== id) {
      await writeStoredValue(SPACE_KEY, liveSpaceId);
    }
  } catch {
    // Roll back the claim and heal durable state: a concurrent recovery may
    // have persisted the rolled-back id after reading it, which would leave
    // restart opening a Space the live session is not using. A newer
    // overlapping selection owns both by now, so only heal a claim we hold.
    if (cachedSpaceId === id && spaceSelectionGeneration === claimGeneration) {
      cachedSpaceId = previousSpaceId;
      bumpSpaceSelectionGeneration();
      if (previousSpaceId) await writeStoredValue(SPACE_KEY, previousSpaceId);
    }
    return false;
  }
  await resumeLiveNotifications(currentApiBase(), await loadSessionToken(), id).catch(
    () => undefined,
  );
  return true;
}

export function selectedSpaceId(): string | null {
  return cachedSpaceId || null;
}

/** Keep requests usable after the server deleted the selected Space but native
 * storage could not replace it. Neutralize any same-endpoint rollback before
 * writing the replacement selection so a cleanup failure cannot leave the new
 * id beside a stale record that recoverSpaceRollback would prefer on restart. */
export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  // Neutralize any same-endpoint rollback before writing SPACE_KEY. Writing the
  // selection first can leave it beside a stale record that recoverSpaceRollback
  // would prefer on restart if later cleanup fails.
  const rollbackNeutralized =
    (await clearStoredValue(SPACE_ROLLBACK_KEY)) || (await saveSpaceRollback(id));
  if (rollbackNeutralized && (await writeStoredValue(SPACE_KEY, id))) {
    // SPACE_KEY is authoritative; drop a rollback we may have written only to
    // overwrite a stale record (best-effort).
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    await resumeLiveNotifications(currentApiBase(), await loadSessionToken(), id).catch(
      () => undefined,
    );
    return true;
  }
  // Clear before saving recovery: an empty selection lets startup resolve the
  // server default even when the recovery record cannot be written.
  const staleSelectionCleared = await clearStoredValue(SPACE_KEY);
  const recoverySaved = await saveSpaceRollback(id);
  await resumeLiveNotifications(currentApiBase(), await loadSessionToken(), id).catch(
    () => undefined,
  );
  // Only treat a cleared selection as durable success when no same-endpoint
  // rollback remains to override it after restart.
  return recoverySaved || (staleSelectionCleared && (await clearStoredValue(SPACE_ROLLBACK_KEY)));
}

export async function selectInitialSpace(id: string) {
  if (selectedSpaceId()) return true;
  return selectSpace(id);
}

async function clearSpace(): Promise<boolean> {
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  const rollbackCleared = await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!spaceCleared || !rollbackCleared) return false;
  cachedSpaceId = "";
  bumpSpaceSelectionGeneration();
  return true;
}

async function clearStoredValue(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key);
    return true;
  } catch {
    return writeStoredValue(key, "");
  }
}

async function writeStoredValue(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value);
    return true;
  } catch {
    return false;
  }
}

async function snapshotSpace(): Promise<{ ok: true; value: string } | { ok: false }> {
  if (cachedSpaceId) return { ok: true, value: cachedSpaceId };
  try {
    return { ok: true, value: (await SecureStore.getItemAsync(SPACE_KEY)) ?? "" };
  } catch {
    return { ok: false };
  }
}

/** Clears session + space for an endpoint change. Restores both if either wipe fails. */
async function clearCredentialsForEndpointChange(): Promise<
  { ok: true; previousToken: string; previousSpace: string } | { ok: false; result: EndpointResult }
> {
  // Runs while the old endpoint, session and Access token are still stored, so the
  // previous server stops pushing to this device. Best effort: a rollback leaves the
  // device unregistered until the next launch re-registers it.
  await rpc("notifications/unregisterPush").catch(() => undefined);
  const previousToken = await snapshotSessionToken();
  const previousSpace = await snapshotSpace();
  if (!previousToken.ok || !previousSpace.ok) {
    return {
      ok: false,
      result: { ok: false, error: t("Could not clear the previous server session") },
    };
  }
  const rollbackReady = previousSpace.value
    ? await saveSpaceRollback(previousSpace.value)
    : await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!rollbackReady) {
    return {
      ok: false,
      result: { ok: false, error: t("Could not clear the previous server session") },
    };
  }
  const sessionCleared = await clearSessionToken();
  cachedSpaceId = "";
  bumpSpaceSelectionGeneration();
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  if (sessionCleared && spaceCleared) {
    return { ok: true, previousToken: previousToken.value, previousSpace: previousSpace.value };
  }

  await restoreCredentials(previousToken.value, previousSpace.value);
  return {
    ok: false,
    result: { ok: false, error: t("Could not clear the previous server session") },
  };
}

async function restoreCredentials(previousToken: string, previousSpace: string) {
  if (previousToken) await restoreSessionToken(previousToken);
  if (previousSpace) {
    cachedSpaceId = previousSpace;
    bumpSpaceSelectionGeneration();
    try {
      await SecureStore.setItemAsync(SPACE_KEY, previousSpace);
      await clearStoredValue(SPACE_ROLLBACK_KEY);
    } catch {
      // The endpoint-bound rollback record restores this selection after restart.
    }
  }
  if (previousToken) {
    await resumeLiveNotifications(currentApiBase(), previousToken, previousSpace).catch(
      () => undefined,
    );
  }
}

async function saveSpaceRollback(spaceId: string): Promise<boolean> {
  return writeStoredValue(
    SPACE_ROLLBACK_KEY,
    JSON.stringify({ apiBase: currentApiBase(), spaceId }),
  );
}

async function recoverSpaceRollback(apiBase: string) {
  const stored = await SecureStore.getItemAsync(SPACE_ROLLBACK_KEY);
  if (!stored) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  const rollback = parsed as { apiBase?: unknown; spaceId?: unknown };
  if (rollback.apiBase !== apiBase || typeof rollback.spaceId !== "string" || !rollback.spaceId) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  cachedSpaceId = rollback.spaceId;
  bumpSpaceSelectionGeneration();
  if (await writeStoredValue(SPACE_KEY, rollback.spaceId)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  // Could not replace the selection yet. Drop the deleted id so startup RPCs
  // are not scoped to an inaccessible Space; keep the recovery record.
  await clearStoredValue(SPACE_KEY);
}

export async function saveApiBase(
  input: string,
  access: AccessCredentials | null = null,
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (parsed.url === defaultApiBase()) return resetApiBase(access);
  const previous = currentApiBase();
  let cleared: { previousToken: string; previousSpace: string } | undefined;
  if (parsed.url !== previous) {
    const result = await clearCredentialsForEndpointChange();
    if (!result.ok) return result.result;
    cleared = result;
  }
  try {
    await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
  } catch {
    if (cleared) await restoreCredentials(cleared.previousToken, cleared.previousSpace);
    return { ok: false, error: t("Could not save the server URL") };
  }
  cachedApiBase = parsed.url;
  // The endpoint is already stored, so a failure here only costs the token.
  if (!(await saveAccess(parsed.url, access))) {
    return { ok: false, error: "Could not save the Cloudflare Access service token" };
  }
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return parsed;
}

/** Back to the build-time server. A token entered for it is kept: the probe's Access cookie expires, and the share extension never sees it. */
export async function resetApiBase(
  access: AccessCredentials | null = null,
): Promise<EndpointResult> {
  const previous = currentApiBase();
  const url = defaultApiBase();
  let cleared: { previousToken: string; previousSpace: string } | undefined;
  if (url !== previous) {
    const result = await clearCredentialsForEndpointChange();
    if (!result.ok) return result.result;
    cleared = result;
  }
  try {
    await SecureStore.deleteItemAsync(ENDPOINT_KEY);
  } catch {
    if (cleared) {
      await restoreCredentials(cleared.previousToken, cleared.previousSpace);
      return { ok: false, error: t("Could not clear the custom server URL") };
    }
  }
  cachedApiBase = url;
  await saveAccess(url, access);
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return { ok: true, url };
}

export async function authHeaders(
  spaceId: string | null = selectedSpaceId(),
): Promise<Record<string, string>> {
  const token = await loadSessionToken();
  return {
    ...currentAccessHeaders(currentApiBase(), defaultApiBase()),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(spaceId ? { "x-tangow-space-id": spaceId } : {}),
  };
}

export type ApiRequestContext = {
  apiBase: string;
  headers: Record<string, string>;
};

export async function captureApiRequestContext(): Promise<ApiRequestContext> {
  const apiBase = currentApiBase();
  const headers = await authHeaders(selectedSpaceId());
  if (apiBase !== currentApiBase()) {
    throw new Error(t("The server changed while starting the request"));
  }
  return { apiBase, headers };
}

async function authenticateWithEmail(
  action: "sign-in" | "sign-up",
  input: { email: string; password: string; name?: string },
) {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/${action}/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "tangow://",
        ...currentAccessHeaders(currentApiBase(), defaultApiBase()),
      },
      body: JSON.stringify(input),
    },
    {},
  );
  if (!response.ok) {
    throw new Error(responseErrorMessage(body, `Could not ${action.replace("-", " ")}`));
  }
  const token = tokenFromAuthResponse(response, body);
  if (action === "sign-up" && signupRequiresEmailVerification(body))
    return { verificationRequired: true };
  if (!token)
    throw new Error(
      t(
        action === "sign-in"
          ? "Sign-in did not return a session"
          : "Sign-up did not return a session",
      ),
    );
  if (!(await clearSpace())) throw new Error(t("Could not clear the previous space"));
  await saveSessionToken(token);
  return { verificationRequired: false };
}

export function signIn(email: string, password: string) {
  return authenticateWithEmail("sign-in", { email, password });
}

export function signUp(email: string, password: string, name: string) {
  return authenticateWithEmail("sign-up", { email, password, name });
}

export type PasswordResetCapabilities = { passwordReset: boolean; resetUrl: string | null };

export async function passwordResetCapabilities(): Promise<PasswordResetCapabilities> {
  const { response, body } = await fetchMobileJson<PasswordResetCapabilities>(
    `${currentApiBase()}/api/auth/capabilities`,
    { headers: { origin: "tangow://" } },
    { passwordReset: false, resetUrl: null },
  );
  if (!response.ok) throw new Error("Could not load password recovery settings");
  return body;
}

export async function requestPasswordReset(email: string, redirectTo: string): Promise<void> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/request-password-reset`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "tangow://" },
      body: JSON.stringify({ email, redirectTo }),
    },
    {},
  );
  if (!response.ok) throw new Error(responseErrorMessage(body, t("Could not send reset email")));
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/change-password`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "tangow://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
    },
    {},
  );
  if (!response.ok) throw new Error(responseErrorMessage(body, t("Could not change password")));
}

/** The photo lives on the session user, not on `me`, so it needs its own read. */
export async function fetchProfileImage(): Promise<string | null> {
  const response = await fetch(`${currentApiBase()}/api/auth/get-session`, {
    headers: { origin: "tangow://", ...(await authHeaders()) },
  });
  if (!response.ok) throw new Error(t("Could not load your profile photo"));
  const body = (await response.json()) as { user?: { image?: string | null } } | null;
  return body?.user?.image ?? null;
}

export async function updateProfileImage(image: string | null): Promise<void> {
  const response = await fetch(`${currentApiBase()}/api/auth/update-user`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "tangow://", ...(await authHeaders()) },
    body: JSON.stringify({ image }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseErrorMessage(body, t("Could not update your photo")));
}

async function fetchMobileJson<T>(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  invalidJsonFallback?: T,
): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), RPC_TIMEOUT_MS);
  try {
    const response = await withAbort(
      fetch(input, { ...init, signal: controller.signal }),
      controller.signal,
    );
    try {
      const body = await readBoundedJsonResponse<T>(
        response,
        MAX_MOBILE_AUTH_RESPONSE_BYTES,
        controller.signal,
      );
      return { response, body };
    } catch (error) {
      if (invalidJsonFallback !== undefined && error instanceof SyntaxError) {
        return { response, body: invalidJsonFallback };
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function signOut() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
  const headers = await authHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    await withAbort(
      fetch(`${currentApiBase()}/api/auth/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "tangow://", ...headers },
        signal: controller.signal,
      }),
      controller.signal,
    ).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
  const sessionCleared = await clearSessionToken();
  const spaceCleared = await clearSpace();
  if (!sessionCleared || !spaceCleared) throw new Error(t("Could not clear the local session"));
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function deleteAccount(password: string) {
  await rpc("notifications/unregisterPush").catch(() => undefined);
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/delete-user`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "tangow://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ password }),
    },
    {},
  );
  if (!response.ok) {
    throw new Error(responseErrorMessage(body, t("Could not delete account")));
  }
  await clearSessionToken();
  await clearSpace();
}

export async function rpc<T>(
  proc: string,
  body: unknown = {},
  options: {
    signal?: AbortSignal;
    timeoutMs?: number | null;
    requestContext?: ApiRequestContext;
    skipSpaceAuthRecovery?: boolean;
  } = {},
): Promise<T> {
  const requestSpaceGeneration = spaceSelectionGeneration;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer =
    options.timeoutMs === null ? undefined : setTimeout(abort, options.timeoutMs ?? RPC_TIMEOUT_MS);
  // Bind recovery to the Space + selection epoch this request was sent with:
  // a 401 arriving after the user switched Spaces — including A → B → A —
  // belongs to a stale request and must not touch the current selection.
  const requestHeaders = options.requestContext?.headers ?? (await authHeaders());
  const requestSpaceId = requestHeaders["x-tangow-space-id"];
  try {
    const res = await fetch(`${options.requestContext?.apiBase ?? currentApiBase()}/rpc/${proc}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "tangow://",
        ...requestHeaders,
      },
      body: JSON.stringify({ json: body }),
      signal: controller.signal,
    });
    const parsed = await readBoundedJsonResponse<{ json?: T; error?: { message?: string } }>(
      res,
      MAX_MOBILE_RPC_RESPONSE_BYTES,
      controller.signal,
    );
    if (!res.ok || parsed.error) {
      // oRPC sends a refused input's reason as `json.message`, the shape a validation error takes.
      const refusal = !res.ok ? (parsed.json as { message?: unknown } | undefined)?.message : null;
      const written = parsed.error?.message ?? (typeof refusal === "string" ? refusal : null);
      const message = written ?? `rpc ${proc} failed`;
      // A 5xx message is the server's own "Internal server error", not a reason for the person.
      const failure = () =>
        written && res.status < 500 ? serverError(written) : new Error(message);
      const unauthorized = res.status === 401 || /unauthorized/i.test(message);
      // After a delete where SecureStore could not clear the stale id, restart
      // reloads it and the first RPCs 401. Probe once without a Space header:
      // success means the selection was inaccessible (clear it); failure means
      // the session itself is bad (restore the selection so a later sign-in
      // keeps the user's Space). Never replay a mutation against the default
      // Space — only safe reads may retry as themselves; other procs probe
      // with spaces/list, then fail the original call.
      const previousSpaceId = selectedSpaceId();
      // Clear stale selection records, then re-persist a Space selected while
      // cleanup was in flight: check-then-clear cannot be atomic on
      // SecureStore, so reconcile afterwards instead of trusting the check.
      const clearStaleSpaceSelection = async () => {
        await clearStoredValue(SPACE_KEY);
        await clearStoredValue(SPACE_ROLLBACK_KEY);
        const reselected = selectedSpaceId();
        if (!reselected) return;
        // Own the reconcile write by generation: a newer selection that
        // persists between snapshot and write must not be overwritten by
        // this stale id, and a write that lands stale heals once to live.
        const writeGeneration = spaceSelectionGeneration;
        await writeStoredValue(SPACE_KEY, reselected);
        if (spaceSelectionGeneration !== writeGeneration) {
          const live = selectedSpaceId();
          if (live) await writeStoredValue(SPACE_KEY, live);
        }
      };
      if (
        unauthorized &&
        previousSpaceId &&
        requestSpaceId &&
        selectedSpaceId() === requestSpaceId &&
        spaceSelectionGeneration === requestSpaceGeneration &&
        !options.requestContext &&
        !options.skipSpaceAuthRecovery
      ) {
        cachedSpaceId = "";
        bumpSpaceSelectionGeneration();
        const retrySameProc = SPACE_AUTH_RECOVERY_SAFE_PROCS.has(proc);
        // Share the original deadline/cancellation with recovery calls instead
        // of starting a second full timeout behind the first request.
        const recoveryOptions: {
          signal?: AbortSignal;
          timeoutMs?: number | null;
          requestContext?: ApiRequestContext;
          skipSpaceAuthRecovery?: boolean;
        } = {
          ...options,
          timeoutMs: null,
          signal: controller.signal,
          skipSpaceAuthRecovery: true,
        };
        try {
          if (retrySameProc) {
            const result = await rpc<T>(proc, body, recoveryOptions);
            // A Space selected while the retry was in flight already owns both
            // the in-memory and durable selection; leave it alone.
            if (!selectedSpaceId()) await clearStaleSpaceSelection();
            return result;
          }
          await rpc("spaces/list", {}, recoveryOptions);
        } catch (retryError) {
          if (!selectedSpaceId()) {
            cachedSpaceId = previousSpaceId;
            bumpSpaceSelectionGeneration();
          }
          throw retryError;
        }
        if (!selectedSpaceId()) await clearStaleSpaceSelection();
        throw failure();
      }
      throw failure();
    }
    return parsed.json as T;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export type MobileBot = Pick<
  Bot,
  | "id"
  | "name"
  | "preview"
  | "title"
  | "color"
  | "shapeSeed"
  | "avatarCharacter"
  | "notifyOnFinish"
  | "threadId"
  | "pinned"
  | "status"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "computerMode"
  | "modelProvider"
  | "modelId"
  | "thinkingLevel"
  | "isOwner"
> &
  Partial<Pick<Bot, "parentBotId" | "spaceId">>;

export type MobileBotSection = BotSection;

export type MobileMe = Pick<
  Me,
  | "userId"
  | "name"
  | "email"
  | "spaceId"
  | "defaultProvider"
  | "defaultModel"
  | "needsModel"
  | "isDeploymentOwner"
>;

export type MobileModel = ModelCatalogEntry;

export type MobileModelCredential = ModelCredential;

export type MobileMessage = Extract<ThreadItem, { kind: "message" }>;

export type MobileGroup = Pick<
  Group,
  | "id"
  | "name"
  | "description"
  | "preview"
  | "pinned"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "members"
  | "people"
  | "canManage"
  | "leadBotId"
> &
  Partial<Pick<Group, "spaceId" | "creatorId">>;

/** A group as an older server sends it, from before groups held people. */
type ServerGroup = Omit<MobileGroup, "people" | "canManage" | "leadBotId" | "members"> &
  Partial<Pick<MobileGroup, "people" | "canManage" | "leadBotId">> & {
    members: (Omit<MobileGroup["members"][number], "canUse"> & { canUse?: boolean })[];
  };

/** The Space's groups; one from an older server is the viewer's own, with only their bots. */
export async function listGroups(): Promise<MobileGroup[]> {
  return (await rpc<ServerGroup[]>("groups/list")).map((group) => ({
    ...group,
    members: group.members.map((member) => ({ ...member, canUse: member.canUse ?? true })),
    people: group.people ?? [],
    canManage: group.canManage ?? true,
    leadBotId: group.leadBotId ?? null,
    // A server from before it said who made a group lists them first.
    creatorId: group.creatorId ?? group.people?.[0]?.userId,
  }));
}

export type MobileSpace = Space;
export type MobileSpaceNavigation = SpaceNavigation;

/** The slice of a run a thread screen reads. `startedAt` / `createdAt` are
 * absent on a run this client learned from a waiting event rather than a
 * snapshot, which is why both are optional. */
export type MobileRun = {
  id: string;
  botId?: string;
  /** The person it acts for: in a group, only they answer its cards. */
  userId?: string;
  status: string;
  error?: string | null;
  startedAt?: string | null;
  createdAt?: string;
};

/**
 * Epoch ms the earliest of these runs began, for the working line's clock: a
 * run that has not reported a start yet falls back to when it was created, and
 * runs with neither leave the clock to tick from mount instead.
 */
export function earliestRunStartMs(
  runs: readonly Pick<MobileRun, "startedAt" | "createdAt">[],
): number | undefined {
  const times = runs.flatMap((run) => {
    const value = run.startedAt ?? run.createdAt;
    if (!value) return [];
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? [parsed] : [];
  });
  return times.length > 0 ? Math.min(...times) : undefined;
}

export type MobileSnapshot = {
  botId?: string;
  groupId?: string;
  groupName?: string;
  threadId: string;
  cursor?: number;
  entries: ThreadEntry[];
  olderCursor: EntryId | null;
  layer: ProgressLayer;
  run: MobileRun | null;
  activeRuns?: MobileRun[];
  members?: MobileGroup["members"];
  /** A group's people, and those who wrote in it before leaving, for each message's author. */
  people?: GroupPerson[];
  computer?: {
    state: string;
    controlHolder: string;
    screenAvailable: boolean;
    mode: ComputerMode;
    busyBotName: string | null;
  };
};

export type MobileThreadResponse = Omit<MobileSnapshot, "layer"> & { progress: ProductEvent[] };

export function shouldApplyMobileThreadRefresh(input: {
  requestEpoch: number;
  currentEpoch: number;
  targetBotId: string | undefined;
  targetGroupId: string | undefined;
  activeBotId: string | undefined;
  activeGroupId: string | undefined;
}) {
  return (
    input.requestEpoch === input.currentEpoch &&
    input.targetBotId === input.activeBotId &&
    input.targetGroupId === input.activeGroupId
  );
}

export function mergeMobileSnapshot(
  prev: MobileSnapshot | null,
  next: MobileSnapshot,
  preserveLoadedHistory = false,
): MobileSnapshot {
  if (!prev || prev.threadId !== next.threadId) return next;
  // A refresh older than the events already applied keeps what they brought; a newer one carries
  // the open run's streamed text up to its cursor, so its layer replaces the held one.
  const behind = prev.cursor !== undefined && (next.cursor ?? 0) < prev.cursor;
  const refreshed = behind
    ? {
        ...next,
        entries: prev.entries,
        olderCursor: prev.olderCursor,
        cursor: prev.cursor,
        layer: prev.layer,
      }
    : withRefreshedEntries(prev, next, preserveLoadedHistory);
  const merged: MobileSnapshot = {
    ...refreshed,
    entries: keepEntries(prev.entries, refreshed.entries),
  };
  const shared: Record<string, unknown> = {};
  let unchanged = Object.keys(prev).length === Object.keys(merged).length;
  for (const [key, value] of Object.entries(merged)) {
    const previous = (prev as Record<string, unknown>)[key];
    shared[key] = sameJson(previous, value) ? previous : value;
    if (shared[key] !== previous) unchanged = false;
  }
  return unchanged ? prev : (shared as MobileSnapshot);
}

function keepEntries(held: ThreadEntry[], next: ThreadEntry[]): ThreadEntry[] {
  return held.length === next.length && held.every((entry, index) => entry.id === next[index]?.id)
    ? held
    : next;
}

export function withOlderPage(
  prev: MobileSnapshot | null,
  page: ThreadMessagePage,
): MobileSnapshot | null {
  if (!prev || prev.threadId !== page.threadId) return prev;
  return withOlderEntries(prev, page);
}

export function keepUnchangedRows(
  previous: ReadonlyMap<string, ThreadRow>,
  rows: readonly ThreadRow[],
): ThreadRow[] {
  return rows.map((row) => {
    const kept = previous.get(row.item.id);
    if (!kept) return row;
    if (sameJson(kept, row)) return kept;
    return sameJson(kept.item, row.item) ? { ...row, item: kept.item } : row;
  });
}

/** Deep equality for JSON-shaped values (what the API returns). */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Map || b instanceof Map) {
    return a instanceof Map && b instanceof Map && sameJson([...a], [...b]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => sameJson(item, other[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}

const MESSAGING_PROVIDER_LABELS: Record<string, string> = {
  sendblue: "iMessage",
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  lark: "Feishu",
};

export function messagingProviderLabel(provider: string, transport?: string): string {
  if (provider === "sendblue" && ["iMessage", "SMS", "RCS"].includes(transport ?? "")) {
    return transport!;
  }
  return MESSAGING_PROVIDER_LABELS[provider] ?? provider;
}

export function copyableMobileMessageText(message: Pick<MobileMessage, "blocks">): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask")
        return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function blockText(message: Pick<MobileMessage, "blocks">) {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "child_bot") {
        return `${block.status === "archived" ? "Archived" : block.status === "deleted" ? "Deleted" : "Bot"} ${block.name ?? ""}`;
      }
      if (block.kind === "widget") return `[widget: ${block.title}]`;
      if (block.kind === "image") return `[image: ${block.name ?? "attachment"}]`;
      if (block.kind === "file") {
        return `[file: ${block.name ?? "attachment"}${block.size ? ` (${block.size} bytes)` : ""}]`;
      }
      if (block.kind === "steps") {
        return (block.steps ?? [])
          .map((step) => `${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`)
          .join(" · ");
      }
      if (block.kind === "reasoning") return "";
      return ("text" in block ? block.text : "state" in block ? block.state : "") ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function subscribeThread(
  target: { botId: string } | { groupId: string },
  cursor: number,
  onEvent: (event: ProductEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(`${currentApiBase()}/rpc/threads/subscribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      origin: "tangow://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ json: { ...target, cursor } }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`rpc threads/subscribe failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { json?: ProductEvent; error?: { message?: string } };
        if (parsed.json?.type) onEvent(parsed.json);
      } catch {
        // ignore keepalives and partial frames
      }
    }
  }
}

export function applyMobileThreadEvent(
  prev: MobileSnapshot | null,
  event: ProductEvent,
): MobileSnapshot | null {
  if (!prev) return prev;
  if (event.type === "session.entry.appended" || event.type === "thread.progress") {
    return applyEntryEvent(prev, event);
  }
  const layer = reduceProgressLayer(prev.layer, event);
  const runs = runsAfter(prev, event);
  if (layer === prev.layer && !runs) return prev;
  return { ...prev, ...runs, cursor: event.seq, layer };
}

type MobileRuns = Pick<MobileSnapshot, "run" | "activeRuns" | "computer">;

function runsAfter(prev: MobileSnapshot, event: ProductEvent): MobileRuns | null {
  const held = prev.activeRuns ?? (prev.run ? [prev.run] : []);
  if (event.type === "run.started" && event.runId) {
    const known = held.find((candidate) => candidate.id === event.runId);
    const run: MobileRun = { ...known, id: event.runId, botId: event.botId, status: "running" };
    const others = held.filter((candidate) => candidate.id !== run.id);
    return {
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns: prev.groupId ? [...others, run] : [run],
    };
  }
  if (event.type === "computer.takeover.requested" && event.runId) {
    const runId = event.runId;
    const waiting = (run: MobileRun): MobileRun =>
      run.id === runId ? { ...run, status: "waiting_takeover" } : run;
    const inserted: MobileRun | null =
      prev.run?.id === runId || held.some((candidate) => candidate.id === runId)
        ? null
        : { id: runId, botId: event.botId, status: "waiting_takeover" };
    const promote =
      inserted &&
      (!prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover"));
    return {
      run: promote ? inserted : prev.run && waiting(prev.run),
      activeRuns: inserted ? [...held, inserted] : prev.activeRuns?.map(waiting),
      computer: prev.computer?.busyBotName
        ? { ...prev.computer, busyBotName: null }
        : prev.computer,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  return null;
}

export {
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  normalizeApiBase,
  probeApiBase,
  usesCustomApiBase,
} from "./endpoint";
export { loadSessionToken };
