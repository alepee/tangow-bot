import { releaseModifierKeys } from "./clipboard-bridge.js";
import {
  encodeStateMessage,
  initialModel,
  nextWake,
  SCREEN_STATES,
  step,
} from "./screen-link-machine.js";

/**
 * Runs the reconnect machine against noVNC. The machine decides, this file executes: one RFB at
 * a time, every handler tied to the generation that created it, one timer driven by `nextWake`.
 * Everything that touches the page or noVNC arrives through `ports`, so tests need no browser.
 */

const PAINT_PROBES = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.5, 0.5],
  [0.25, 0.75],
  [0.75, 0.75],
];

/** noVNC has no first-frame event: a canvas that has drawn anything has a non-zero alpha. */
function hasPaint(canvas) {
  try {
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) return false;
    return PAINT_PROBES.some(
      ([x, y]) =>
        context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1)
          .data[3] > 0,
    );
  } catch {
    return false;
  }
}

/**
 * The only way the embed talks to its host: one JSON string naming one of the five states, to the
 * native bridge or to the framing page, and nowhere else. The embed never listens for a reply.
 */
export function hostPoster(win) {
  return (state) => {
    if (!SCREEN_STATES.includes(state)) return;
    const message = encodeStateMessage(state);
    try {
      if (typeof win.ReactNativeWebView?.postMessage === "function") {
        win.ReactNativeWebView.postMessage(message);
      } else if (win.parent && win.parent !== win) {
        win.parent.postMessage(message, "*");
      }
    } catch {
      // A host that cannot receive is the same as no host.
    }
  };
}

/**
 * @param {{
 *   createRfb: (slot: unknown, url: string) => object,
 *   url: string,
 *   viewOnly: boolean,
 *   stage: object,
 *   page: object,
 *   clock: object,
 *   rand: () => number,
 *   post: (state: string) => void,
 * }} ports
 */
export function startScreenLinkSession(ports) {
  const { createRfb, url, viewOnly, stage, page, clock, rand, post } = ports;
  let model = initialModel();
  let current = null;
  let generation = 0;
  let timer = null;
  let cancelFrame = null;
  let unlisten = null;
  let ended = false;
  let draining = false;
  let keyboardOnScreen = false;
  const queue = [];
  const sticky = {};

  const isLive = () => current !== null && !current.closed && model.phase.name === "live";

  function teardown() {
    generation += 1;
    cancelFrame?.();
    cancelFrame = null;
    if (!current) return;
    const { rfb, onConnect, onDisconnect, closed } = current;
    current = null;
    rfb.removeEventListener("connect", onConnect);
    rfb.removeEventListener("disconnect", onDisconnect);
    if (closed) return;
    try {
      rfb.disconnect();
    } catch {
      // Already torn down by noVNC.
    }
  }

  function watchPaint(owner, entry) {
    const probe = () => {
      cancelFrame = null;
      if (owner !== generation || model.phase.name !== "painting") return;
      if (entry.canvas && hasPaint(entry.canvas)) dispatch({ type: "painted" });
      else cancelFrame = stage.nextFrame(probe);
    };
    cancelFrame = stage.nextFrame(probe);
  }

  function attempt() {
    teardown();
    const owner = generation;
    const slot = stage.newSlot();
    let rfb;
    try {
      rfb = createRfb(slot, url);
    } catch {
      dispatch({ type: "drop" });
      return;
    }
    const entry = { rfb, canvas: null, closed: false };
    entry.onConnect = () => {
      if (owner !== generation) return;
      entry.canvas = stage.canvasOf(slot);
      if (keyboardOnScreen && stage.keyboardFocus() === "none") rfb.focus();
      dispatch({ type: "connect" });
      watchPaint(owner, entry);
    };
    entry.onDisconnect = () => {
      if (owner !== generation) return;
      entry.closed = true;
      dispatch({ type: "drop" });
    };
    rfb.viewOnly = viewOnly;
    for (const [name, value] of Object.entries(sticky)) rfb[name] = value;
    rfb.addEventListener("connect", entry.onConnect);
    rfb.addEventListener("disconnect", entry.onDisconnect);
    current = entry;
  }

  function finish() {
    ended = true;
    clock.clearTimeout(timer);
    timer = null;
    unlisten?.();
    unlisten = null;
    teardown();
  }

  function run(effect) {
    switch (effect.type) {
      case "attempt":
        attempt();
        break;
      case "abort":
        teardown();
        break;
      case "emit":
        post(effect.state);
        break;
      case "freeze":
        if (current?.canvas) stage.freeze(current.canvas);
        break;
      case "thaw":
        stage.thaw();
        break;
      case "stop":
        finish();
        stage.clear();
        break;
    }
  }

  function schedule() {
    clock.clearTimeout(timer);
    timer = null;
    const wake = ended ? null : nextWake(model);
    if (wake === null) return;
    timer = clock.setTimeout(
      () => {
        timer = null;
        dispatch({ type: "tick" });
      },
      Math.max(0, wake - clock.now()),
    );
  }

  /**
   * Events are queued so an effect that raises another event never re-enters `step`.
   * noVNC listens for keys on its own canvas, which leaves the page with the old RFB: whether
   * the user was typing into the screen is sampled while live, so the next canvas can take over.
   */
  function dispatch(event) {
    if (ended) return;
    if (isLive()) keyboardOnScreen = stage.keyboardFocus() === "screen";
    queue.push({ ...event, now: clock.now() });
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !ended) {
        const wasLive = isLive();
        const result = step(model, queue.shift(), { rand });
        model = result.model;
        for (const effect of result.effects) run(effect);
        if (!wasLive && isLive() && !viewOnly) {
          const { rfb } = current;
          releaseModifierKeys((keysym, code, down) => rfb.sendKey(keysym, code, down));
        }
      }
    } finally {
      draining = false;
    }
    schedule();
  }

  /** Re-applied to every new RFB, because noVNC's own value dies with the old one. */
  function stickyProperty(name) {
    return {
      get: () => sticky[name],
      set: (value) => {
        sticky[name] = value;
        if (current) current.rfb[name] = value;
      },
    };
  }

  const rfb = Object.defineProperties(
    {
      viewOnly,
      sendKey(...args) {
        if (isLive()) current.rfb.sendKey(...args);
      },
      clipboardPasteFrom(text) {
        if (isLive()) current.rfb.clipboardPasteFrom(text);
      },
    },
    {
      connected: { get: isLive, enumerable: true },
      focusOnClick: { ...stickyProperty("focusOnClick"), enumerable: true },
      showDotCursor: { ...stickyProperty("showDotCursor"), enumerable: true },
    },
  );

  unlisten = page.listen((type) => dispatch({ type }));
  dispatch({ type: "start", visible: page.visible(), online: page.online() });

  return {
    rfb,
    dispose() {
      finish();
      stage.clear();
    },
  };
}
