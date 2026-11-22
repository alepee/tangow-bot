/** Reconnect machine for the chrome-less noVNC embed. */

export const SCREEN_STATES: readonly [
  "connecting",
  "connected",
  "reconnecting",
  "stalled",
  "failed",
];
export type ScreenState = (typeof SCREEN_STATES)[number];
export const MESSAGE_TYPE: "tangow-screen-state";
export const MESSAGE_VERSION: 1;

export function encodeStateMessage(state: ScreenState): string;

/**
 * opening: an attempt is in flight, no `connect` yet.
 * painting: connected, waiting for the first painted frame.
 * live: painted and announced `connected`.
 * waiting: the next attempt is due at `until`, unless hidden or offline.
 * stopped: terminal.
 */
export type Phase =
  | { readonly name: "idle" }
  | { readonly name: "opening"; readonly since: number }
  | { readonly name: "painting"; readonly since: number }
  | { readonly name: "live"; readonly since: number }
  | { readonly name: "waiting"; readonly until: number }
  | { readonly name: "stopped" };

export interface Model {
  readonly phase: Phase;
  readonly painted: boolean;
  readonly frozen: boolean;
  readonly announced: ScreenState | null;
  readonly outageStart: number;
  readonly failures: number;
  readonly stalled: boolean;
  readonly attemptedAt: number | null;
  readonly hiddenAt: number | null;
  readonly online: boolean;
  readonly lastAt: number;
}

export type Event =
  | {
      readonly type: "start";
      readonly now: number;
      readonly visible: boolean;
      readonly online: boolean;
    }
  | { readonly type: "connect"; readonly now: number }
  | { readonly type: "painted"; readonly now: number }
  | { readonly type: "drop"; readonly now: number }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "hidden"; readonly now: number }
  | { readonly type: "visible"; readonly now: number }
  | { readonly type: "online"; readonly now: number }
  | { readonly type: "offline"; readonly now: number };

/**
 * attempt: open exactly one new connection.
 * abort: tear down the current connection; no `drop` follows for it.
 * freeze: keep the current frame on screen; thaw: remove the kept frame.
 * stop: tear everything down; always precedes `emit failed`.
 */
export type Effect =
  | { readonly type: "attempt" }
  | { readonly type: "abort" }
  | { readonly type: "emit"; readonly state: ScreenState }
  | { readonly type: "freeze" }
  | { readonly type: "thaw" }
  | { readonly type: "stop" };

export function initialModel(): Model;

export function step(
  model: Model,
  event: Event,
  env: { rand: () => number },
): { model: Model; effects: Effect[] };

/** When the session must feed `tick` next; null when nothing is due. */
export function nextWake(model: Model): number | null;
