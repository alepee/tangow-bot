import type { ScreenState } from "./screen-link-machine.js";

/** The noVNC `RFB` surface the session uses. */
export interface RfbLike {
  viewOnly: boolean;
  focusOnClick?: boolean;
  showDotCursor?: boolean;
  addEventListener(type: "connect" | "disconnect", listener: () => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: () => void): void;
  disconnect(): void;
  focus(): void;
  sendKey(keysym: number, code?: string, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): {
    getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
  } | null;
}

export interface Stage<Slot = unknown, Canvas extends CanvasLike = CanvasLike> {
  /** A fresh empty container for the next RFB; the previous one is gone. */
  newSlot(): Slot;
  /** The canvas noVNC created inside `slot`. */
  canvasOf(slot: Slot): Canvas | null;
  /** Show a copy of `canvas` above the live layer. */
  freeze(canvas: Canvas): void;
  thaw(): void;
  /** Remove the live layer's content and any frozen copy. */
  clear(): void;
  nextFrame(callback: () => void): () => void;
  /** Where the keyboard focus is: in the live layer, on nothing, or on some other control. */
  keyboardFocus(): "screen" | "none" | "elsewhere";
}

export interface Page {
  visible(): boolean;
  online(): boolean;
  listen(listener: (type: "visible" | "hidden" | "online" | "offline") => void): () => void;
}

export interface Clock<Timer = unknown> {
  now(): number;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer | null): void;
}

export interface SessionPorts<
  Slot = unknown,
  Canvas extends CanvasLike = CanvasLike,
  Timer = unknown,
> {
  createRfb(slot: Slot, url: string): RfbLike;
  url: string;
  /** Captured once; never re-read. */
  viewOnly: boolean;
  stage: Stage<Slot, Canvas>;
  page: Page;
  clock: Clock<Timer>;
  rand: () => number;
  post(state: ScreenState): void;
}

/** What the keyboard, clipboard and trackpad helpers hold: stable across reconnections. */
export interface LiveRfb {
  /** True only while the current connection is live; input at any other time is dropped. */
  readonly connected: boolean;
  readonly viewOnly: boolean;
  focusOnClick: boolean | undefined;
  showDotCursor: boolean | undefined;
  sendKey(keysym: number, code?: string, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
}

export function hostPoster(win: {
  ReactNativeWebView?: { postMessage(message: string): void };
  parent?: { postMessage(message: string, targetOrigin: string): void };
}): (state: string) => void;

export function startScreenLinkSession<Slot, Canvas extends CanvasLike, Timer>(
  ports: SessionPorts<Slot, Canvas, Timer>,
): { rfb: LiveRfb; dispose(): void };
