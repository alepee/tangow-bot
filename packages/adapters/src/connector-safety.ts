import { redactSecrets, secretRedactor } from "@tangow/core";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

/**
 * undici collapses every network failure to "fetch failed"; the cause names the host and
 * errno, which is the only part worth acting on. Walk the chain so it reaches the caller.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 3 && cause instanceof Error; depth += 1) {
    const code = "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    const detail = `${cause.message}${code}`;
    if (!parts.includes(detail)) parts.push(detail);
    cause = cause.cause;
  }
  return parts.join(": ");
}

export function sanitizeConnectorError(error: unknown, secrets: string[] = []): string {
  const message = describeError(error);
  return redactSecrets(
    message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
    secrets,
  ).slice(0, 2_000);
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  try {
    return redactPayloadValue(JSON.parse(JSON.stringify(value)), secrets);
  } catch {
    return { ok: true };
  }
}

/** Masks secrets in a value that is already plain JSON, such as a parsed frame. */
export function redactPayloadValue(value: unknown, secrets: string[]): unknown {
  return redactPayloadWith(value, secretRedactor(secrets));
}

/** `redactPayloadValue` with the secrets already prepared, for a caller that walks the value itself. */
export function redactPayloadWith(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactPayloadWith(item, redact));
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = String(value);
    return redact(serialized) === serialized ? value : "[redacted]";
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redact(key), redactPayloadWith(item, redact)]),
  );
}

/**
 * Masks secrets in a transcript's text. An image's base64 data is kept as it is: it would spend
 * the redaction budget and come back as a bare `[redacted]` in place of the image.
 */
export function redactTranscript(value: unknown, redact: (text: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactTranscript(item, redact));
  if (value === null || typeof value !== "object") return redactPayloadWith(value, redact);
  const image = (value as { type?: unknown }).type === "image";
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redact(key),
      image && key === "data" ? item : redactTranscript(item, redact),
    ]),
  );
}
