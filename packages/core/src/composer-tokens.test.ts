import { describe, expect, it } from "vitest";
import {
  caretAfterEdit,
  composerSegments,
  mentionQueryAt,
  mentionsInDraft,
  messageSegments,
} from "./composer-tokens.js";

const ivy = { name: "Ivy" };
const ivyLab = { name: "Ivy Lab" };
const everyone = { name: "everyone" };
const notes = { name: "release-notes" };

function shape(segments: ReturnType<typeof messageSegments>) {
  return segments.map((segment) => (segment.kind === "text" ? segment.text : `[${segment.text}]`));
}

describe("messageSegments", () => {
  it("matches the longest name on word boundaries, case-insensitively", () => {
    expect(
      shape(
        messageSegments(
          "ask @ivy lab, then @Ivy. mail@Ivy @Ivyx @everyone",
          [ivy, ivyLab, everyone],
          [],
        ),
      ),
    ).toEqual(["ask ", "[@ivy lab]", ", then ", "[@Ivy]", ". mail@Ivy @Ivyx ", "[@everyone]"]);
  });

  it("reads a leading skill alone on its line, its line break shown as a space", () => {
    expect(shape(messageSegments("/release-notes\nDraft for @Ivy", [ivy], [notes]))).toEqual([
      "[/release-notes]",
      " Draft for ",
      "[@Ivy]",
    ]);
    expect(shape(messageSegments("/release-notes now", [], [notes]))).toEqual([
      "/release-notes now",
    ]);
  });
});

describe("composer draft", () => {
  it("draws only the picked skill and mentions", () => {
    expect(shape(composerSegments("/release-notes ask @Ivy and @Bob", [ivy], notes))).toEqual([
      "[/release-notes]",
      " ask ",
      "[@Ivy]",
      " and @Bob",
    ]);
  });

  it("drops a mention whose token text was edited away", () => {
    expect(mentionsInDraft("ask @Iv", [ivy])).toEqual([]);
    expect(mentionsInDraft("ask @Ivy Lab", [ivy, ivyLab])).toEqual([ivyLab]);
  });

  it("opens the picker at the caret, not at an already picked token", () => {
    expect(mentionQueryAt("ask @iv and more", 7)).toEqual({ query: "iv", start: 4 });
    expect(mentionQueryAt("ask @Ivy", 8, [ivy])).toBeNull();
  });

  it("puts the caret at the end of an edit", () => {
    expect(caretAfterEdit("ask  now", "ask @ now")).toBe(5);
    expect(caretAfterEdit("ask @x now", "ask @ now")).toBe(5);
  });
});
