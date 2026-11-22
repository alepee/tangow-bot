import {
  parseScreenLinkMessage,
  SCREEN_LINK_MESSAGE_TYPE,
  SCREEN_LINK_STATES,
  SCREEN_LINK_VERSION,
} from "@tangow/core";
import { describe, expect, it } from "vitest";
import type { Effect, Event } from "./screen-link-machine.js";
import {
  encodeStateMessage,
  initialModel,
  MESSAGE_TYPE,
  MESSAGE_VERSION,
  nextWake,
  SCREEN_STATES,
  step,
} from "./screen-link-machine.js";

describe("host link drift", () => {
  it("shares the wire vocabulary with the hosts", () => {
    expect([...SCREEN_STATES]).toEqual([...SCREEN_LINK_STATES]);
    expect(MESSAGE_TYPE).toBe(SCREEN_LINK_MESSAGE_TYPE);
    expect(MESSAGE_VERSION).toBe(SCREEN_LINK_VERSION);
    expect(SCREEN_STATES.map((state) => parseScreenLinkMessage(encodeStateMessage(state)))).toEqual(
      ["connecting", "connected", "reconnecting", "stalled", "failed"],
    );
  });
});

type WithoutNow<E> = E extends unknown ? Omit<E, "now"> : never;
type Input = WithoutNow<Event>;

function machine(rand: () => number = () => 0.5) {
  let model = initialModel();
  let now = 0;
  let sockets = 0;
  let maxSockets = 0;
  const log: Array<{ at: number; effect: Effect }> = [];
  const feed = (input: Input) => {
    const result = step(model, { ...input, now } as Event, { rand });
    model = result.model;
    if (input.type === "drop" && sockets > 0) sockets -= 1;
    for (const effect of result.effects) {
      log.push({ at: now, effect });
      if (effect.type === "attempt") sockets += 1;
      if (effect.type === "abort" || effect.type === "stop") sockets = Math.max(0, sockets - 1);
      maxSockets = Math.max(maxSockets, sockets);
    }
    return result.effects;
  };
  const advanceTo = (target: number, onAttempt?: () => void) => {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const wake = nextWake(model);
      if (wake === null || wake > target) break;
      now = Math.max(now, wake);
      const effects = feed({ type: "tick" });
      if (onAttempt && effects.some((effect) => effect.type === "attempt")) onAttempt();
    }
    now = target;
  };
  return {
    feed,
    advanceTo,
    jump(to: number) {
      now = to;
    },
    get now() {
      return now;
    },
    get model() {
      return model;
    },
    get maxSockets() {
      return maxSockets;
    },
    emitted: () =>
      log.flatMap(({ at, effect }) => (effect.type === "emit" ? [`${at} ${effect.state}`] : [])),
    attempts: () => log.flatMap(({ at, effect }) => (effect.type === "attempt" ? [at] : [])),
  };
}

function liveAt(m: ReturnType<typeof machine>, at: number) {
  m.advanceTo(at);
  m.feed({ type: "connect" });
  m.feed({ type: "painted" });
}

describe("embed screen link machine", () => {
  it("announces connecting, then connected on the first painted frame", () => {
    const m = machine();
    expect(m.feed({ type: "start", visible: true, online: true })).toEqual([
      { type: "emit", state: "connecting" },
      { type: "attempt" },
    ]);
    m.advanceTo(300);
    expect(m.feed({ type: "connect" })).toEqual([]);
    expect(m.feed({ type: "painted" })).toEqual([{ type: "emit", state: "connected" }]);
  });

  it("treats a connection without a painted frame after 2 s as live", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.advanceTo(100);
    m.feed({ type: "connect" });
    m.advanceTo(2_100);
    expect(m.emitted()).toEqual(["0 connecting", "2100 connected"]);
  });

  it("retries a stable connection at once, then backs off 1, 2, 4, 8, 15, 15 s and fails 60 s after the drop", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(20_000);
    expect(m.feed({ type: "drop" })).toEqual([
      { type: "freeze" },
      { type: "emit", state: "reconnecting" },
      { type: "attempt" },
    ]);
    m.feed({ type: "drop" });
    m.advanceTo(90_000, () => m.feed({ type: "drop" }));
    expect(m.attempts()).toEqual([0, 20_000, 21_000, 23_000, 27_000, 35_000, 50_000, 65_000]);
    expect(m.emitted()).toEqual([
      "0 connecting",
      "0 connected",
      "20000 reconnecting",
      "21000 stalled",
      "80000 failed",
    ]);
    expect(nextWake(m.model)).toBe(null);
  });

  it("stops before it announces failed, and ignores everything afterwards", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.advanceTo(59_999, () => m.feed({ type: "drop" }));
    m.jump(60_000);
    expect(m.feed({ type: "tick" })).toEqual([{ type: "stop" }, { type: "emit", state: "failed" }]);
    expect(m.feed({ type: "visible" })).toEqual([]);
    expect(m.feed({ type: "online" })).toEqual([]);
  });

  it("keeps announcing connecting until a frame was painted", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.feed({ type: "drop" });
    m.advanceTo(70_000, () => m.feed({ type: "drop" }));
    expect(m.emitted()).toEqual(["0 connecting", "1000 stalled", "60000 failed"]);
  });

  it("does not re-arm the budget for a connection that drops within 10 s", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(20_000);
    m.feed({ type: "drop" });
    m.feed({ type: "drop" });
    m.advanceTo(200_000, () => {
      m.feed({ type: "connect" });
      m.feed({ type: "painted" });
      m.advanceTo(m.now + 1_000);
      m.feed({ type: "drop" });
    });
    const emitted = m.emitted();
    expect(emitted.at(-1)).toBe("80000 failed");
    expect(emitted.filter((line) => line.endsWith("stalled"))).toEqual(["22000 stalled"]);
    expect(m.maxSockets).toBe(1);
  });

  it("re-arms the budget after a connection stayed up 10 s", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(20_000);
    m.feed({ type: "drop" });
    m.feed({ type: "drop" });
    liveAt(m, 21_000);
    m.advanceTo(31_000);
    expect(m.feed({ type: "drop" })).toEqual([
      { type: "freeze" },
      { type: "emit", state: "reconnecting" },
      { type: "attempt" },
    ]);
    m.feed({ type: "drop" });
    m.advanceTo(120_000, () => m.feed({ type: "drop" }));
    expect(m.emitted().at(-1)).toBe("91000 failed");
  });

  it("thaws the kept frame once the next connection paints", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(20_000);
    m.feed({ type: "drop" });
    m.feed({ type: "connect" });
    expect(m.feed({ type: "painted" })).toEqual([
      { type: "thaw" },
      { type: "emit", state: "connected" },
    ]);
  });

  it("times out an attempt that never connects after 10 s", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.advanceTo(10_999);
    expect(m.attempts()).toEqual([0]);
    m.advanceTo(11_000);
    expect(m.attempts()).toEqual([0, 11_000]);
  });

  it("spreads each pause by up to 25 % either way", () => {
    const pauseAfterFirstFailure = (rand: () => number) => {
      const m = machine(rand);
      m.feed({ type: "start", visible: true, online: true });
      m.feed({ type: "drop" });
      return nextWake(m.model);
    };
    expect(pauseAfterFirstFailure(() => 0)).toBe(750);
    expect(pauseAfterFirstFailure(() => 0.5)).toBe(1_000);
    expect(pauseAfterFirstFailure(() => 1 - Number.EPSILON)).toBe(1_250);
  });

  it("suspends attempts while hidden and retries at once on a short return", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.feed({ type: "drop" });
    m.feed({ type: "hidden" });
    expect(nextWake(m.model)).toBe(null);
    m.jump(6_000);
    expect(m.feed({ type: "visible" })).toEqual([{ type: "attempt" }]);
    expect(m.attempts()).toEqual([0, 6_000]);
  });

  it("does not fail an outage whose budget ran out while hidden", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.feed({ type: "hidden" });
    m.jump(70_000);
    expect(m.feed({ type: "drop" })).toEqual([]);
    m.jump(300_000);
    expect(m.feed({ type: "visible" })).toEqual([
      { type: "emit", state: "connecting" },
      { type: "attempt" },
    ]);
  });

  it("ignores a timer that fires late while hidden", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.feed({ type: "drop" });
    m.feed({ type: "hidden" });
    m.jump(70_000);
    expect(m.feed({ type: "tick" })).toEqual([]);
  });

  it("holds an early retry on return until 5 s after the last attempt", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.feed({ type: "drop" });
    m.advanceTo(30_000, () => m.feed({ type: "drop" }));
    expect(m.attempts()).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000]);
    m.feed({ type: "hidden" });
    m.jump(31_000);
    expect(m.feed({ type: "visible" })).toEqual([]);
    expect(nextWake(m.model)).toBe(35_000);
    m.advanceTo(35_000);
    expect(m.attempts()).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 35_000]);
  });

  it("recycles a live connection after the page was hidden 10 s", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(5_000);
    m.feed({ type: "hidden" });
    m.jump(15_000);
    expect(m.feed({ type: "visible" })).toEqual([
      { type: "freeze" },
      { type: "abort" },
      { type: "emit", state: "reconnecting" },
      { type: "attempt" },
    ]);
  });

  it("keeps a live connection after a hide shorter than 10 s", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.feed({ type: "hidden" });
    m.jump(9_999);
    expect(m.feed({ type: "visible" })).toEqual([]);
    expect(nextWake(m.model)).toBe(10_999);
  });

  it("recycles a live connection when its own timer fired more than 5 s late", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(10_000);
    expect(m.emitted()).toEqual(["0 connecting", "0 connected"]);
    m.jump(16_001);
    expect(m.feed({ type: "tick" })).toEqual([
      { type: "freeze" },
      { type: "abort" },
      { type: "emit", state: "reconnecting" },
      { type: "attempt" },
    ]);
  });

  it("holds retries and the budget while offline, then starts a fresh budget once online", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(20_000);
    m.feed({ type: "offline" });
    m.feed({ type: "drop" });
    m.feed({ type: "drop" });
    m.advanceTo(90_000);
    expect(m.attempts()).toEqual([0, 20_000]);
    expect(m.emitted()).toEqual(["0 connecting", "0 connected", "20000 reconnecting"]);
    expect(m.feed({ type: "online" })).toEqual([
      { type: "emit", state: "reconnecting" },
      { type: "attempt" },
    ]);
    m.advanceTo(200_000, () => m.feed({ type: "drop" }));
    expect(m.emitted().at(-1)).toBe("150000 failed");
  });

  it("still tries once at start when the browser reports offline, then waits for the network", () => {
    const m = machine();
    expect(m.feed({ type: "start", visible: true, online: false })).toEqual([
      { type: "emit", state: "connecting" },
      { type: "attempt" },
    ]);
    m.feed({ type: "drop" });
    m.advanceTo(120_000);
    expect(m.attempts()).toEqual([0]);
    expect(m.emitted()).toEqual(["0 connecting"]);
    expect(m.feed({ type: "online" })).toEqual([
      { type: "emit", state: "connecting" },
      { type: "attempt" },
    ]);
  });

  it("connects at start even when the browser wrongly reports offline", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: false });
    m.advanceTo(300);
    m.feed({ type: "connect" });
    m.feed({ type: "painted" });
    expect(m.emitted()).toEqual(["0 connecting", "300 connected"]);
  });

  it("starts a fresh budget when a retry timer fires more than 5 s late", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(20_000);
    m.feed({ type: "drop" });
    m.feed({ type: "drop" });
    m.jump(140_000);
    expect(m.feed({ type: "tick" })).toEqual([
      { type: "emit", state: "reconnecting" },
      { type: "attempt" },
    ]);
    expect(nextWake(m.model)).toBe(150_000);
  });

  it("restarts an attempt in flight when its timeout fires more than 5 s late", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    m.advanceTo(20_000);
    m.feed({ type: "drop" });
    m.jump(140_000);
    expect(m.feed({ type: "tick" })).toEqual([
      { type: "abort" },
      { type: "emit", state: "reconnecting" },
      { type: "attempt" },
    ]);
  });

  it("fails without a new attempt on a short return after the budget ran out", () => {
    const m = machine();
    m.feed({ type: "start", visible: true, online: true });
    m.feed({ type: "drop" });
    m.advanceTo(55_000, () => m.feed({ type: "drop" }));
    m.feed({ type: "hidden" });
    m.jump(62_000);
    expect(m.feed({ type: "visible" })).toEqual([
      { type: "stop" },
      { type: "emit", state: "failed" },
    ]);
    expect(m.attempts()).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000]);
  });

  it("never runs two attempts at once across drops, recycles and timeouts", () => {
    const m = machine(() => 0.9);
    m.feed({ type: "start", visible: true, online: true });
    liveAt(m, 0);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      m.feed({ type: "hidden" });
      m.jump(m.now + 11_000);
      m.feed({ type: "visible" });
      m.feed({ type: "connect" });
      m.feed({ type: "painted" });
      m.advanceTo(m.now + 3_000);
    }
    m.advanceTo(m.now + 1_000);
    m.feed({ type: "drop" });
    m.advanceTo(m.now + 120_000);
    expect(m.maxSockets).toBe(1);
    expect(m.emitted().at(-1)?.endsWith("failed")).toBe(true);
  });

  it("encodes the three wire keys and nothing else", () => {
    expect(encodeStateMessage("stalled")).toBe(
      '{"type":"tangow-screen-state","version":1,"state":"stalled"}',
    );
  });
});
