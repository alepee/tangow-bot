import { describe, expect, it, vi } from "vitest";
import { attachHostClipboardPaste } from "./clipboard-bridge.js";
import { attachMobileKeyboard } from "./mobile-keyboard.js";
import { encodeStateMessage, SCREEN_STATES } from "./screen-link-machine.js";
import type { RfbLike } from "./screen-link-session.js";
import { hostPoster, startScreenLinkSession } from "./screen-link-session.js";

const URL = "wss://screen.test/novnc/session/control/1.token/websockify";
const MODIFIER_RELEASES = 8;

class FakeCanvas {
  width = 800;
  height = 600;
  alpha = 0;
  getContext() {
    return { getImageData: () => ({ data: [0, 0, 0, this.alpha] }) };
  }
}

const OTHER_CONTROL = { id: "mobile-keyboard" };
const page = { activeElement: null as object | null };

class FakeSlot {
  children: object[] = [];
  canvas = new FakeCanvas();
}

/**
 * noVNC 1.3 as read from rfb.js: the screen div leaves the slot before `disconnect` is
 * dispatched, a disconnected object never comes back, and our own `disconnect()` is followed
 * by a late `disconnect` event once the socket has really closed.
 */
class FakeRfb implements RfbLike {
  static all: FakeRfb[] = [];
  viewOnly = false;
  focusOnClick: boolean | undefined = true;
  showDotCursor: boolean | undefined = false;
  state: "connecting" | "connected" | "disconnecting" | "disconnected" = "connecting";
  keys: Array<[number, string | undefined, boolean | undefined]> = [];
  pasted: string[] = [];
  private listeners = new Map<string, Set<() => void>>();
  constructor(
    readonly slot: FakeSlot,
    readonly url: string,
  ) {
    slot.children.push(slot.canvas);
    FakeRfb.all.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  private emit(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  private leaveSlot() {
    this.slot.children = [];
    if (page.activeElement === this.slot.canvas) page.activeElement = null;
  }
  focus() {
    if (this.slot.children.includes(this.slot.canvas)) page.activeElement = this.slot.canvas;
  }
  connect() {
    this.state = "connected";
    this.emit("connect");
  }
  paint() {
    this.slot.canvas.alpha = 255;
  }
  /** A server or network close, or a refused upgrade: the same event either way. */
  close() {
    this.leaveSlot();
    this.state = "disconnected";
    this.emit("disconnect");
  }
  disconnect() {
    if (this.state === "disconnected") return;
    this.leaveSlot();
    this.state = "disconnecting";
  }
  lateDisconnect() {
    this.state = "disconnected";
    this.emit("disconnect");
  }
  sendKey(keysym: number, code?: string, down?: boolean) {
    if (this.state === "connected") this.keys.push([keysym, code, down]);
  }
  clipboardPasteFrom(text: string) {
    if (this.state === "connected") this.pasted.push(text);
  }
  get open() {
    return this.state === "connecting" || this.state === "connected";
  }
}

function harness({
  viewOnly = false,
  failConstructor = false,
}: {
  viewOnly?: boolean;
  failConstructor?: boolean;
} = {}) {
  FakeRfb.all = [];
  page.activeElement = null;
  const log: string[] = [];
  const posted: string[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  const frames: Array<() => void> = [];
  const pageListeners = new Set<(type: "visible" | "hidden" | "online" | "offline") => void>();
  let nextTimer = 1;
  let now = 1_000_000;
  let visible = true;
  let maxOpen = 0;
  let throwing = failConstructor;
  const stage = {
    frozen: null as FakeCanvas | null,
    slots: [] as FakeSlot[],
    newSlot() {
      const slot = new FakeSlot();
      stage.slots = [slot];
      return slot;
    },
    canvasOf: (slot: FakeSlot) => slot.children.find((c) => c instanceof FakeCanvas) ?? null,
    freeze(canvas: FakeCanvas) {
      stage.frozen = canvas;
      log.push("freeze");
    },
    thaw() {
      stage.frozen = null;
      log.push("thaw");
    },
    clear() {
      stage.slots = [];
      stage.frozen = null;
      log.push("clear");
    },
    nextFrame(callback: () => void) {
      frames.push(callback);
      return () => {
        const index = frames.indexOf(callback);
        if (index >= 0) frames.splice(index, 1);
      };
    },
    keyboardFocus() {
      const active = page.activeElement;
      if (active === null) return "none" as const;
      return stage.slots.some((slot) => slot.children.includes(active)) ? "screen" : "elsewhere";
    },
  };
  const session = startScreenLinkSession({
    createRfb(slot: FakeSlot, url: string) {
      if (throwing) throw new Error("constructor failed");
      const rfb = new FakeRfb(slot, url);
      maxOpen = Math.max(maxOpen, FakeRfb.all.filter((r) => r.open).length);
      return rfb;
    },
    url: URL,
    viewOnly,
    stage,
    page: {
      visible: () => visible,
      online: () => true,
      listen(listener) {
        pageListeners.add(listener);
        return () => pageListeners.delete(listener);
      },
    },
    clock: {
      now: () => now,
      setTimeout(run: () => void, ms: number) {
        const id = nextTimer++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimeout(id: number | null) {
        if (id !== null) timers.delete(id);
      },
    },
    rand: () => 0.5,
    post(state) {
      posted.push(state);
      log.push(`post ${state}`);
    },
  });
  const advance = (ms: number) => {
    const target = now + ms;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].run();
    }
    now = target;
  };
  const pump = () => {
    for (const frame of frames.splice(0)) frame();
  };
  const current = () => FakeRfb.all.at(-1) as FakeRfb;
  const goLive = () => {
    current().connect();
    current().paint();
    pump();
  };
  return {
    session,
    stage,
    posted,
    log,
    advance,
    pump,
    current,
    goLive,
    get timers() {
      return timers.size;
    },
    get pageListeners() {
      return pageListeners.size;
    },
    get maxOpen() {
      return maxOpen;
    },
    get focused() {
      return page.activeElement;
    },
    focusOtherControl() {
      page.activeElement = OTHER_CONTROL;
    },
    setConstructorFailure(value: boolean) {
      throwing = value;
    },
    setVisible(value: boolean) {
      visible = value;
      for (const listener of [...pageListeners]) listener(value ? "visible" : "hidden");
    },
  };
}

describe("screen link session", () => {
  it("connects one RFB, announces connecting then connected on the first painted frame", () => {
    const h = harness();
    expect(h.posted).toEqual(["connecting"]);
    expect(FakeRfb.all).toHaveLength(1);
    expect(h.current().url).toBe(URL);
    h.current().connect();
    expect(h.posted).toEqual(["connecting"]);
    expect(h.session.rfb.connected).toBe(false);
    h.pump();
    expect(h.posted).toEqual(["connecting"]);
    h.current().paint();
    h.pump();
    expect(h.posted).toEqual(["connecting", "connected"]);
    expect(h.session.rfb.connected).toBe(true);
  });

  it("treats a connection that never draws as live after the 2 s grace", () => {
    const h = harness();
    h.current().connect();
    h.advance(2_000);
    expect(h.posted).toEqual(["connecting", "connected"]);
  });

  it("keeps the last frame on screen after an unwanted drop and thaws it on the next paint", () => {
    const h = harness();
    h.goLive();
    const first = h.current();
    first.close();
    expect(h.stage.frozen).toBe(first.slot.canvas);
    expect(h.posted.slice(-1)).toEqual(["reconnecting"]);
    expect(h.session.rfb.connected).toBe(false);
    h.advance(1_000);
    expect(FakeRfb.all).toHaveLength(2);
    h.goLive();
    expect(h.stage.frozen).toBeNull();
    expect(h.posted.slice(-1)).toEqual(["connected"]);
    expect(h.log.indexOf("thaw")).toBeGreaterThan(h.log.indexOf("freeze"));
  });

  it("never holds two open RFBs across 20 drops and recycles", () => {
    const h = harness();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      h.goLive();
      if (cycle % 2 === 0) {
        h.advance(10_000);
        h.current().close();
      } else {
        h.setVisible(false);
        h.advance(11_000);
        h.setVisible(true);
        h.advance(5_000);
      }
    }
    expect(h.maxOpen).toBe(1);
    expect(FakeRfb.all.filter((rfb) => rfb.open)).toHaveLength(1);
  });

  it("detaches an old RFB and ignores its late disconnect", () => {
    const h = harness();
    h.goLive();
    h.setVisible(false);
    h.advance(11_000);
    h.setVisible(true);
    const [old, replacement] = FakeRfb.all as [FakeRfb, FakeRfb];
    expect(FakeRfb.all).toHaveLength(2);
    expect(old.state).toBe("disconnecting");
    expect(old.listenerCount()).toBe(0);
    const postedBefore = [...h.posted];
    old.lateDisconnect();
    expect(h.posted).toEqual(postedBefore);
    expect(FakeRfb.all).toHaveLength(2);
    expect(replacement.open).toBe(true);
  });

  it("ignores a late connect and paint from an RFB the attempt timeout replaced", () => {
    const h = harness();
    const [first] = FakeRfb.all as [FakeRfb];
    h.advance(10_000);
    expect(first.state).toBe("disconnecting");
    h.advance(1_000);
    expect(FakeRfb.all).toHaveLength(2);
    first.connect();
    first.paint();
    h.pump();
    h.advance(3_000);
    expect(h.posted).toEqual(["connecting"]);
    expect(h.session.rfb.connected).toBe(false);
    h.goLive();
    expect(h.current()).not.toBe(first);
    expect(h.posted).toEqual(["connecting", "connected"]);
  });

  it("survives a constructor that throws and retries", () => {
    const h = harness({ failConstructor: true });
    expect(h.posted).toEqual(["connecting"]);
    h.setConstructorFailure(false);
    h.advance(3_000);
    expect(FakeRfb.all).toHaveLength(1);
    h.goLive();
    expect(h.posted).toContain("connected");
  });

  it("stops after 60 s without a connection: clears both layers, then reports failed", () => {
    const h = harness();
    for (let guard = 0; guard < 100 && !h.posted.includes("failed"); guard += 1) {
      if (h.current().open) h.current().close();
      h.advance(1_000);
    }
    expect(h.posted.at(-1)).toBe("failed");
    expect(h.log.indexOf("clear")).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf("clear")).toBeLessThan(h.log.indexOf("post failed"));
    expect(h.timers).toBe(0);
    expect(h.pageListeners).toBe(0);
    expect(FakeRfb.all.filter((rfb) => rfb.open)).toHaveLength(0);
    expect(h.session.rfb.connected).toBe(false);
  });

  it("posts each state change in order", () => {
    const h = harness();
    h.goLive();
    h.current().close();
    h.advance(1_000);
    h.current().close();
    h.advance(2_000);
    h.goLive();
    expect(h.posted).toEqual(["connecting", "connected", "reconnecting", "stalled", "connected"]);
  });

  it("tears down on dispose with no timer, listener or RFB left", () => {
    const h = harness();
    h.goLive();
    h.session.dispose();
    expect(h.timers).toBe(0);
    expect(h.pageListeners).toBe(0);
    expect(FakeRfb.all.filter((rfb) => rfb.open)).toHaveLength(0);
    h.setVisible(false);
    expect(h.timers).toBe(0);
  });
});

describe("keyboard focus across reconnects", () => {
  it("hands focus to the new screen only when the user was typing into the old one", () => {
    const h = harness();
    h.goLive();
    h.current().close();
    h.advance(1_000);
    h.goLive();
    expect(h.focused).toBe(null);

    const second = h.current();
    second.focus();
    h.advance(10_000);
    second.close();
    expect(h.focused).toBe(null);
    h.advance(1_000);
    h.goLive();
    expect(FakeRfb.all).toHaveLength(3);
    expect(h.focused).toBe(h.current().slot.canvas);
  });

  it("hands focus to the screen that replaces one recycled after a long hide", () => {
    const h = harness();
    h.goLive();
    h.current().focus();
    h.setVisible(false);
    h.advance(11_000);
    h.setVisible(true);
    h.goLive();
    expect(FakeRfb.all).toHaveLength(2);
    expect(h.focused).toBe(h.current().slot.canvas);
  });

  it("keeps focus on another control the user picked while reconnecting", () => {
    const h = harness();
    h.goLive();
    h.current().focus();
    h.advance(1_000);
    h.current().close();
    h.focusOtherControl();
    h.advance(1_000);
    h.goLive();
    expect(h.focused).toBe(OTHER_CONTROL);
  });
});

describe("live RFB facade", () => {
  it("forwards input only while live and never queues it", () => {
    const h = harness();
    const { rfb } = h.session;
    rfb.sendKey(1, "KeyA", true);
    h.current().connect();
    rfb.sendKey(2, "KeyB", true);
    h.pump();
    expect(h.current().keys).toEqual([]);
    h.current().paint();
    h.pump();
    const first = h.current();
    expect(first.keys).toHaveLength(MODIFIER_RELEASES);
    rfb.sendKey(3, "KeyC", true);
    rfb.clipboardPasteFrom("one");
    expect(first.keys.at(-1)).toEqual([3, "KeyC", true]);
    expect(first.pasted).toEqual(["one"]);

    first.close();
    rfb.sendKey(4, "KeyD", true);
    rfb.clipboardPasteFrom("lost");
    h.advance(1_000);
    h.goLive();
    const second = h.current();
    expect(second.keys).toHaveLength(MODIFIER_RELEASES);
    expect(second.pasted).toEqual([]);
    expect(first.keys).toHaveLength(MODIFIER_RELEASES + 1);
    expect(first.pasted).toEqual(["one"]);
  });

  it("releases every modifier on each new live connection", () => {
    const h = harness();
    h.goLive();
    h.current().close();
    h.advance(1_000);
    h.goLive();
    expect(h.current().keys.every(([, , down]) => down === false)).toBe(true);
    expect(h.current().keys).toHaveLength(MODIFIER_RELEASES);
  });

  it("captures viewOnly once and sends nothing to a view-only RFB", () => {
    const h = harness({ viewOnly: true });
    h.goLive();
    expect(h.session.rfb.viewOnly).toBe(true);
    expect(h.current().viewOnly).toBe(true);
    expect(h.current().keys).toEqual([]);
  });

  it("re-applies sticky focusOnClick and showDotCursor to every new RFB", () => {
    const h = harness();
    h.goLive();
    h.session.rfb.focusOnClick = false;
    h.session.rfb.showDotCursor = true;
    expect(h.current().focusOnClick).toBe(false);
    h.current().close();
    h.advance(1_000);
    expect(FakeRfb.all).toHaveLength(2);
    expect(h.current().focusOnClick).toBe(false);
    expect(h.current().showDotCursor).toBe(true);
  });

  it("serves the clipboard bridge: paste is dropped while reconnecting and sent once when live", () => {
    const h = harness();
    const listeners = new Map<string, (event: object) => void>();
    attachHostClipboardPaste(h.session.rfb, {
      target: {
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: () => {},
      },
    });
    const paste = () => {
      const preventDefault = vi.fn();
      listeners.get("paste")?.({
        clipboardData: { getData: () => "secret" },
        preventDefault,
        stopPropagation: vi.fn(),
      });
      return preventDefault.mock.calls.length;
    };
    expect(paste()).toBe(0);
    h.goLive();
    h.current().keys.length = 0;
    expect(paste()).toBe(1);
    expect(h.current().pasted).toEqual(["secret"]);
    h.current().close();
    expect(paste()).toBe(0);
  });

  it("serves the mobile keyboard: typing goes to the live RFB only and focus survives reconnects", () => {
    const h = harness();
    const handlers = new Map<string, (event: object) => void>();
    const input = {
      value: "",
      selectionStart: 0,
      focus() {},
      blur() {},
      setSelectionRange() {},
      addEventListener: (type: string, handler: (event: object) => void) =>
        handlers.set(type, handler),
      removeEventListener() {},
    };
    const noop = { addEventListener() {}, removeEventListener() {}, setAttribute() {} };
    const button = { ...noop, hidden: true, classList: { toggle() {} }, contains: () => false };
    const documentTarget = {
      activeElement: input,
      documentElement: {
        ...noop,
        style: { setProperty() {}, removeProperty() {} },
        classList: { toggle() {}, remove() {} },
      },
    };
    class Keyboard {
      onkeyevent: ((keysym: number, code: string, down: boolean) => void) | null = null;
      grab() {}
    }
    attachMobileKeyboard(h.session.rfb, {
      button,
      input,
      Keyboard,
      backspaceKeysym: 0xff08,
      lookupKeysym: (codePoint: number) => codePoint,
      documentTarget,
      windowTarget: {},
    });
    const type = (character: string) => {
      input.value = `${"_".repeat(99)}${character}`;
      input.selectionStart = input.value.length;
      handlers.get("input")?.({ target: input });
    };
    type("a");
    h.goLive();
    const first = h.current();
    first.keys.length = 0;
    handlers.get("focus")?.({});
    expect(first.focusOnClick).toBe(false);
    type("b");
    expect(first.keys.map(([keysym]) => keysym)).toContain(0x62);
    const typedOnFirst = first.keys.length;

    first.close();
    type("c");
    h.advance(1_000);
    h.goLive();
    const second = h.current();
    expect(second.focusOnClick).toBe(false);
    expect(second.keys.map(([keysym]) => keysym)).not.toContain(0x63);
    expect(first.keys).toHaveLength(typedOnFirst);
  });
});

describe("host poster", () => {
  const message = (state: string) => encodeStateMessage(state as (typeof SCREEN_STATES)[number]);

  it("prefers the native bridge and never touches the framing page then", () => {
    const bridge = vi.fn();
    const parent = vi.fn();
    hostPoster({ ReactNativeWebView: { postMessage: bridge }, parent: { postMessage: parent } })(
      "connected",
    );
    expect(bridge.mock.calls).toEqual([[message("connected")]]);
    expect(parent).not.toHaveBeenCalled();
  });

  it("posts to the framing page with a wildcard target", () => {
    const parent = { postMessage: vi.fn() };
    hostPoster({ parent })("reconnecting");
    expect(parent.postMessage.mock.calls).toEqual([[message("reconnecting"), "*"]]);
  });

  it("posts nothing without a host, including when the page frames itself", () => {
    expect(() => hostPoster({})("failed")).not.toThrow();
    const self: { parent?: unknown; postMessage: () => void } = { postMessage: vi.fn() };
    self.parent = self;
    hostPoster(self as Parameters<typeof hostPoster>[0])("failed");
    expect(self.postMessage).not.toHaveBeenCalled();
  });

  it("drops a state outside the closed list", () => {
    const bridge = vi.fn();
    const post = hostPoster({ ReactNativeWebView: { postMessage: bridge } });
    post("expired");
    post("wss://screen.test/secret");
    expect(bridge).not.toHaveBeenCalled();
    for (const state of SCREEN_STATES) post(state);
    expect(bridge.mock.calls.map(([sent]) => JSON.parse(sent).state)).toEqual([...SCREEN_STATES]);
  });
});
