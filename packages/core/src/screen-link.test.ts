import { describe, expect, it } from "vitest";
import type { ScreenLinkClock } from "./screen-link.js";
import {
  createScreenLink,
  initialScreenLink,
  isScreenDocumentUrl,
  parseScreenLinkMessage,
  reduceScreenLink,
  screenLinkChannel,
  screenNavigationAllowed,
} from "./screen-link.js";

const ORIGIN = "https://tangow.example";
const DIRECTORY = "/novnc/session/view/1790000000000.AbC_d-9";
const EMBED = `${ORIGIN}${DIRECTORY}/embed.html?autoconnect=true&resize=scale&view_only=true&path=websockify`;
const PLAIN = `${ORIGIN}${DIRECTORY}/vnc.html?autoconnect=true&view_only=true`;
const OTHER_EMBED = `${ORIGIN}/novnc/session/control/1790000000000.XyZ/embed.html?view_only=false`;

const say = (state: string) => JSON.stringify({ type: "tangow-screen-state", version: 1, state });

describe("parseScreenLinkMessage", () => {
  it("accepts the three wire keys with a known state", () => {
    expect(
      parseScreenLinkMessage('{"type":"tangow-screen-state","version":1,"state":"stalled"}'),
    ).toBe("stalled");
    expect(
      parseScreenLinkMessage('{"state":"connected","version":1,"type":"tangow-screen-state"}'),
    ).toBe("connected");
  });

  it.each([
    ["an extra key", '{"type":"tangow-screen-state","version":1,"state":"failed","url":"x"}'],
    ["a missing key", '{"type":"tangow-screen-state","state":"failed"}'],
    [
      "a __proto__ key",
      '{"type":"tangow-screen-state","version":1,"__proto__":{"state":"failed"}}',
    ],
    ["another version", '{"type":"tangow-screen-state","version":2,"state":"failed"}'],
    ["a string version", '{"type":"tangow-screen-state","version":"1","state":"failed"}'],
    ["another type", '{"type":"tangow-screen","version":1,"state":"failed"}'],
    ["an unknown state", '{"type":"tangow-screen-state","version":1,"state":"expired"}'],
    ["a state from the prototype", '{"type":"tangow-screen-state","version":1,"state":"toString"}'],
    ["an array", '["tangow-screen-state",1,"failed"]'],
    ["null", "null"],
    ["a number", "1"],
    ["broken JSON", '{"type":'],
  ])("rejects %s", (_name, data) => {
    expect(parseScreenLinkMessage(data)).toBe(null);
  });

  it("rejects anything that is not a string, even with the right shape", () => {
    expect(
      parseScreenLinkMessage({ type: "tangow-screen-state", version: 1, state: "failed" }),
    ).toBe(null);
  });

  it("measures the 256 character limit before parsing", () => {
    const message = say("connected");
    expect(parseScreenLinkMessage(message.padEnd(256, " "))).toBe("connected");
    expect(parseScreenLinkMessage(message.padEnd(257, " "))).toBe(null);
  });
});

describe("screen link URL gates", () => {
  it("talks only to our embed page inside a capability directory", () => {
    expect(screenLinkChannel(EMBED)).toBe("embed");
    expect(screenLinkChannel(OTHER_EMBED)).toBe("embed");
    expect(screenLinkChannel(PLAIN)).toBe("plain");
    expect(screenLinkChannel(`${ORIGIN}/embed.html`)).toBe("plain");
    expect(screenLinkChannel(`${ORIGIN}${DIRECTORY}/nested/embed.html`)).toBe("plain");
    expect(screenLinkChannel(`desktop://screen${DIRECTORY}/embed.html`)).toBe("plain");
    expect(screenLinkChannel("not a url")).toBe("plain");
  });

  it("recognizes a document from the same origin and capability directory", () => {
    expect(isScreenDocumentUrl(`${ORIGIN}${DIRECTORY}/embed.html#x`, EMBED)).toBe(true);
    expect(isScreenDocumentUrl(`${ORIGIN}${DIRECTORY}/vnc.html`, EMBED)).toBe(true);
    expect(isScreenDocumentUrl(OTHER_EMBED, EMBED)).toBe(false);
    expect(isScreenDocumentUrl(`https://evil.example${DIRECTORY}/embed.html`, EMBED)).toBe(false);
    expect(isScreenDocumentUrl(`${ORIGIN}${DIRECTORY}/../1.Other/embed.html`, EMBED)).toBe(false);
    expect(isScreenDocumentUrl(`${ORIGIN}/novnc/session/view/1790000000000.AbC_d-9x/`, EMBED)).toBe(
      false,
    );
    expect(isScreenDocumentUrl("about:blank", EMBED)).toBe(false);
    expect(isScreenDocumentUrl(`${ORIGIN}/embed.html`, `${ORIGIN}/embed.html`)).toBe(false);
  });

  it("lets a WebView load only blank pages and the screen's own directory", () => {
    expect(screenNavigationAllowed("about:blank", EMBED)).toBe(true);
    expect(screenNavigationAllowed(EMBED, EMBED)).toBe(true);
    expect(screenNavigationAllowed("https://evil.example/", EMBED)).toBe(false);
    expect(screenNavigationAllowed(`${ORIGIN}/`, EMBED)).toBe(false);
    expect(screenNavigationAllowed("javascript:alert(1)", EMBED)).toBe(false);
  });
});

function fakeClock() {
  let now = 0;
  let pending: { at: number; fn: () => void } | null = null;
  const clock: ScreenLinkClock = {
    now: () => now,
    schedule(fn, ms) {
      if (pending) throw new Error("a second timer was scheduled");
      const timer = { at: now + ms, fn };
      pending = timer;
      return () => {
        if (pending === timer) pending = null;
      };
    },
  };
  return {
    clock,
    get pending() {
      return pending !== null;
    },
    advance(ms: number) {
      const end = now + ms;
      while (pending && pending.at <= end) {
        const timer = pending;
        pending = null;
        now = timer.at;
        timer.fn();
      }
      now = end;
    },
  };
}

function screen(url: string | null = EMBED) {
  const time = fakeClock();
  const log: string[] = [];
  const link = createScreenLink({
    clock: time.clock,
    onAdjudicate: () => log.push(`${time.clock.now()} adjudicate`),
    onReload: () => log.push(`${time.clock.now()} reload`),
    onView: (view) => log.push(`${time.clock.now()} ${view}`),
  });
  link.url(url);
  return { link, log, time };
}

describe("createScreenLink", () => {
  it("follows the embed's announcements and ignores repeats", () => {
    const { link, log, time } = screen();
    link.message(say("connecting"));
    link.loaded();
    time.advance(500);
    link.message(say("connected"));
    link.message(say("connected"));
    time.advance(500);
    link.message(say("reconnecting"));
    link.message(say("reconnecting"));
    time.advance(500);
    link.message(say("connected"));
    expect(log).toEqual(["0 connecting", "500 none", "1000 reconnecting", "1500 none"]);
    expect(link.view()).toBe("none");
  });

  it("shows a plain page as connecting until it loads, and ignores its messages", () => {
    const { link, log, time } = screen(PLAIN);
    link.message(say("reconnecting"));
    time.advance(700);
    link.loaded();
    link.message(say("failed"));
    link.loaded();
    expect(log).toEqual(["0 connecting", "700 none"]);
  });

  it("demotes an embed that stays silent 1.5 s after loading, for good", () => {
    const { link, log, time } = screen();
    time.advance(200);
    link.loaded();
    time.advance(1_499);
    expect(link.view()).toBe("connecting");
    time.advance(1);
    link.message(say("reconnecting"));
    expect(log).toEqual(["0 connecting", "1700 none"]);
  });

  it("keeps an embed that spoke before its load event", () => {
    const { link, log, time } = screen();
    link.message(say("connecting"));
    link.loaded();
    time.advance(5_000);
    link.message(say("connected"));
    expect(log).toEqual(["0 connecting", "5000 none"]);
  });

  it("stops listening when the embed document loads a second time", () => {
    const { link, log, time } = screen();
    link.message(say("connected"));
    link.loaded();
    time.advance(3_000);
    link.loaded();
    link.message(say("reconnecting"));
    link.message(say("stalled"));
    expect(log).toEqual(["0 connecting", "0 none"]);
    expect(link.view()).toBe("none");
  });

  it("processes at most 20 messages a second", () => {
    const { link, log, time } = screen();
    for (let index = 0; index < 20; index += 1) link.message(say("connecting"));
    link.message(say("connected"));
    expect(link.view()).toBe("connecting");
    time.advance(1_000);
    link.message(say("connected"));
    expect(log).toEqual(["0 connecting", "1000 none"]);
  });

  it("fails and stops listening after more than 100 messages in 10 s", () => {
    const { link, log, time } = screen();
    for (let index = 0; index < 101; index += 1) {
      link.message(index % 2 ? say("connected") : say("reconnecting"));
      time.advance(90);
    }
    link.message(say("connected"));
    expect(log.at(-1)).toBe("9000 failed");
    expect(link.view()).toBe("failed");
    expect(time.pending).toBe(false);
  });

  it("asks for a status read on stalled, at most 3 a minute and 5 s apart", () => {
    const { link, log, time } = screen();
    link.message(say("reconnecting"));
    link.message(say("stalled"));
    time.advance(4_999);
    link.message(say("stalled"));
    time.advance(1);
    link.message(say("stalled"));
    time.advance(5_000);
    link.message(say("stalled"));
    time.advance(5_000);
    link.message(say("stalled"));
    expect(log).toEqual([
      "0 connecting",
      "0 reconnecting",
      "0 adjudicate",
      "5000 adjudicate",
      "10000 adjudicate",
    ]);
  });

  it("keeps following a flapping embed after its status reads run out", () => {
    const { link, log, time } = screen();
    for (let outage = 0; outage < 4; outage++) {
      link.message(say("connected"));
      time.advance(10_000);
      link.message(say("reconnecting"));
      link.message(say("stalled"));
      time.advance(3_000);
    }
    link.message(say("connected"));
    expect(log).toEqual([
      "0 connecting",
      "0 none",
      "10000 reconnecting",
      "10000 adjudicate",
      "13000 none",
      "23000 reconnecting",
      "23000 adjudicate",
      "26000 none",
      "36000 reconnecting",
      "36000 adjudicate",
      "39000 none",
      "49000 reconnecting",
      "52000 none",
    ]);
  });

  it("allows another status read once the oldest leaves the minute", () => {
    const { link, log, time } = screen();
    link.message(say("reconnecting"));
    link.message(say("stalled"));
    time.advance(5_000);
    link.message(say("stalled"));
    time.advance(5_000);
    link.message(say("stalled"));
    link.message(say("connected"));
    time.advance(50_000);
    link.message(say("stalled"));
    expect(log.slice(-2)).toEqual(["10000 none", "60000 adjudicate"]);
  });

  it("fails a page stuck connecting for 60 s or reconnecting for 75 s", () => {
    const connecting = screen();
    connecting.link.message(say("connecting"));
    connecting.time.advance(60_000);
    expect(connecting.log).toEqual(["0 connecting", "60000 failed"]);

    const reconnecting = screen();
    reconnecting.link.message(say("connected"));
    reconnecting.time.advance(1_000);
    reconnecting.link.message(say("reconnecting"));
    reconnecting.time.advance(75_000);
    expect(reconnecting.log).toEqual([
      "0 connecting",
      "0 none",
      "1000 reconnecting",
      "76000 failed",
    ]);
  });

  it("leaves hidden time out of the watchdog", () => {
    const { link, log, time } = screen();
    link.message(say("connecting"));
    time.advance(50_000);
    link.hidden();
    expect(time.pending).toBe(false);
    time.advance(5_000);
    link.returned(5_000);
    time.advance(9_999);
    expect(link.view()).toBe("connecting");
    time.advance(1);
    expect(log).toEqual(["0 connecting", "65000 failed"]);
  });

  it("reloads a plain or silent page after 10 s away, as before", () => {
    const plain = screen(PLAIN);
    plain.link.loaded();
    plain.link.hidden();
    plain.link.returned(9_999);
    plain.link.hidden();
    plain.link.returned(10_000);
    expect(plain.log).toEqual(["0 connecting", "0 none", "0 reload"]);

    const silent = screen();
    silent.link.hidden();
    silent.time.advance(10_000);
    silent.link.returned(10_000);
    expect(silent.log).toEqual(["0 connecting", "10000 reload"]);
  });

  it("gives a talking embed 10 s after a long absence to speak before reloading", () => {
    const quiet = screen();
    quiet.link.message(say("connected"));
    quiet.link.hidden();
    quiet.time.advance(30_000);
    quiet.link.returned(30_000);
    quiet.time.advance(10_000);
    expect(quiet.log).toEqual(["0 connecting", "0 none", "40000 reload"]);

    const alive = screen();
    alive.link.message(say("connected"));
    alive.link.hidden();
    alive.time.advance(30_000);
    alive.link.returned(30_000);
    alive.time.advance(2_000);
    alive.link.message(say("reconnecting"));
    alive.time.advance(500);
    alive.link.message(say("connected"));
    alive.time.advance(60_000);
    expect(alive.log).toEqual(["0 connecting", "0 none", "32000 reconnecting", "32500 none"]);
  });

  it("reloads a failed screen once the user comes back after 10 s away", () => {
    const { link, log, time } = screen();
    link.message(say("connected"));
    link.message(say("failed"));
    link.hidden();
    link.returned(9_999);
    link.hidden();
    time.advance(10_000);
    link.returned(10_000);
    expect(log).toEqual(["0 connecting", "0 none", "0 failed", "10000 reload"]);
  });

  it("starts over on a new URL and keeps the state for the same one", () => {
    const { link, log, time } = screen();
    link.message(say("connected"));
    link.url(EMBED);
    link.loaded();
    link.loaded();
    time.advance(1_000);
    link.url(OTHER_EMBED);
    link.message(say("connected"));
    link.url(null);
    expect(log).toEqual(["0 connecting", "0 none", "1000 connecting", "1000 none"]);
    expect(link.view()).toBe("none");
    expect(time.pending).toBe(false);
  });

  it("stays hidden across a URL set while away", () => {
    const { link, log, time } = screen(null);
    link.hidden();
    link.url(EMBED);
    time.advance(120_000);
    link.returned(120_000);
    expect(log).toEqual(["0 connecting", "120000 reload"]);
  });

  it("lets no deadline fire while hidden, even from a late timer", () => {
    const hidden = initialScreenLink(EMBED, 0, true);
    expect(reduceScreenLink(hidden, { type: "tick", now: 120_000 }).model.link).toBe("connecting");
  });

  it("goes quiet once disposed", () => {
    const { link, log, time } = screen();
    link.loaded();
    link.dispose();
    time.advance(60_000);
    link.message(say("stalled"));
    link.url(OTHER_EMBED);
    expect(log).toEqual(["0 connecting"]);
    expect(time.pending).toBe(false);
  });
});
