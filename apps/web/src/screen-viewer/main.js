import Keyboard from "@novnc/novnc/core/input/keyboard.js";
import KeyTable from "@novnc/novnc/core/input/keysym.js";
import keysyms from "@novnc/novnc/core/input/keysymdef.js";
import RFB from "@novnc/novnc/core/rfb.js";
import { attachHostClipboardPaste } from "./clipboard-bridge.js";
import { attachMobileKeyboard, attachMobileTrackpad, isTouchBrowser } from "./mobile-keyboard.js";
import { hostPoster, startScreenLinkSession } from "./screen-link-session.js";

function query(name, fallback) {
  const match = `${document.location.href}${window.location.hash}`.match(
    new RegExp(`.*[?&]${name}=([^&#]*)`),
  );
  return match ? decodeURIComponent(match[1]) : fallback;
}

function flag(name) {
  const value = String(query(name, "false")).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// The socket always lives next to this page, inside the capability directory.
const url = new URL("websockify", window.location.href);
url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
url.search = "";
url.hash = "";

const live = document.getElementById("live");
const frozen = document.getElementById("frozen");
const stage = {
  newSlot() {
    const slot = document.createElement("div");
    live.replaceChildren(slot);
    return slot;
  },
  canvasOf: (slot) => slot.querySelector("canvas"),
  freeze(canvas) {
    if (!canvas.width || !canvas.height) return;
    frozen.width = canvas.width;
    frozen.height = canvas.height;
    frozen.getContext("2d").drawImage(canvas, 0, 0);
    frozen.hidden = false;
  },
  thaw() {
    frozen.hidden = true;
    frozen.width = 0;
  },
  clear() {
    live.replaceChildren();
    stage.thaw();
  },
  nextFrame(callback) {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
  keyboardFocus() {
    const active = document.activeElement;
    if (!active || active === document.body) return "none";
    return live.contains(active) ? "screen" : "elsewhere";
  },
};
const page = {
  visible: () => document.visibilityState !== "hidden",
  online: () => navigator.onLine !== false,
  listen(listener) {
    const events = [
      [document, "visibilitychange", () => listener(page.visible() ? "visible" : "hidden")],
      [window, "online", () => listener("online")],
      [window, "offline", () => listener("offline")],
    ];
    for (const [target, type, handler] of events) target.addEventListener(type, handler);
    return () => {
      for (const [target, type, handler] of events) target.removeEventListener(type, handler);
    };
  },
};
const clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (timer) => window.clearTimeout(timer),
};

const { rfb } = startScreenLinkSession({
  createRfb(slot, socketUrl) {
    const connection = new RFB(slot, socketUrl);
    connection.scaleViewport = true;
    connection.clipViewport = false;
    return connection;
  },
  url: url.href,
  viewOnly: flag("view_only"),
  stage,
  page,
  clock,
  rand: Math.random,
  post: hostPoster(window),
});
if (!rfb.viewOnly) attachHostClipboardPaste(rfb);
if (!rfb.viewOnly && isTouchBrowser()) {
  attachMobileKeyboard(rfb, {
    button: document.getElementById("mobile-keyboard"),
    input: document.getElementById("mobile-keyboard-input"),
    Keyboard,
    backspaceKeysym: KeyTable.XK_BackSpace,
    lookupKeysym: keysyms.lookup,
  });
  attachMobileTrackpad(rfb, {
    button: document.getElementById("mobile-trackpad"),
    surface: live,
  });
}
