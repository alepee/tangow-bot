import { AVATAR_CHARACTERS } from "@tangow/contracts";
import { faceReactionFor, faceStateFor } from "@tangow/core";
import { describe, expect, it } from "vitest";
import { EXPRESSIONS, faceFor } from "./clay-face-data.js";

describe("clay face data", () => {
  it.each(AVATAR_CHARACTERS.map(({ id }) => id))("draws %s with its own face", (id) => {
    expect(faceFor(id).id).toBe(id);
  });

  it.each([null, "<svg/onload=1>"])("draws the neutral face for %j", (id) => {
    expect(faceFor(id).id).toBe("scout");
  });

  it("knows every expression a character or a run status can ask for", () => {
    const asked = [
      ...AVATAR_CHARACTERS.map(({ id }) => faceFor(id).defaut),
      faceStateFor("running", "").expression,
      faceReactionFor("running", "completed")!.expression,
      faceReactionFor("running", "failed")!.expression,
    ];
    expect(asked.filter((key) => !(key in EXPRESSIONS.expressions))).toEqual([]);
  });
});
