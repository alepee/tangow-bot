import { faceStateFor } from "@tangow/core";
import { describe, expect, it } from "vitest";
import { faceFor, motionPlan, playCycle, playSpans } from "./clay-face";

const normalBlink = { every: 2200, close: 70, open: 120 };
const rareBlink = { every: 7000, close: 70, open: 120 };

describe("clay face on iPhone", () => {
  it.each([null, undefined, "", "__proto__", "<svg/onload=1>", "x".repeat(10_000)])(
    "draws the neutral face for %j",
    (id) => {
      expect(faceFor(id).id).toBe("scout");
    },
  );

  it("rests on an unknown status: blinks and glances, nothing else", () => {
    expect(motionPlan(faceStateFor("from-a-newer-server", "emerveille"), false)).toEqual({
      blink: normalBlink,
      glance: true,
      play: null,
      tremor: 0,
    });
  });

  it("reads while working, with rare blinks and no glance", () => {
    expect(motionPlan(faceStateFor("running", "panique"), false)).toEqual({
      blink: rareBlink,
      glance: false,
      play: "lit",
      tremor: 0,
    });
  });

  it("plays a character's own motion at rest and holds still while it waits on you", () => {
    expect(motionPlan(faceStateFor("idle", "panique"), false)).toMatchObject({ tremor: 1 });
    expect(motionPlan(faceStateFor("idle", "narquois"), false)).toMatchObject({ play: "tic" });
    expect(motionPlan(faceStateFor("waiting_input", "panique"), false)).toEqual({
      blink: rareBlink,
      glance: false,
      play: null,
      tremor: 0,
    });
  });

  it("holds every face still under Reduce Motion", () => {
    expect(motionPlan(faceStateFor("running", "emerveille"), true)).toEqual({
      blink: null,
      glance: false,
      play: null,
      tremor: 0,
    });
  });

  it("holds the working sweep still between its steps", () => {
    const spans = playSpans(playCycle("lit", 0));
    const moving = spans.filter((span) => span.moves).reduce((ms, span) => ms + span.ms, 0);
    expect(spans.reduce((ms, span) => ms + span.ms, 0)).toBeCloseTo(2600);
    expect(spans.at(-1)?.to).toBe(1);
    expect(spans.filter((span) => !span.moves)).toHaveLength(5);
    expect(moving).toBeLessThan(2600 * 0.3);
  });
});
