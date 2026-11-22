import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

describe("BotAvatar character", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["unknown", "no-such-character"],
    ["hostile", "<svg/onload=1>"],
    ["a prototype key", "__proto__"],
  ])("draws the neutral character when the character is %s", (_label, character) => {
    const html = renderToString(<BotAvatar character={character} size={40} />);
    expect(html).toContain("tangow-clay-avatar");
    expect(html).toContain("scout");
  });

  it("serves the mini image up to 20 px and the full image above", () => {
    const small = renderToString(<BotAvatar character="scout" size={20} />);
    const larger = renderToString(<BotAvatar character="scout" size={21} />);
    expect(small).toContain("scout-mini");
    expect(larger).not.toContain("scout-mini");
  });

  it("keeps the still image of a live bot until its body is decoded", () => {
    const html = renderToString(<BotAvatar character="atlas" size={80} live />);
    expect(html).toContain("characters/atlas.webp");
    expect(html).not.toContain("bodies/atlas");
    expect(html).not.toContain("tangow-clay-face");
  });

  it("marks a working bot, which shows its still until its body is decoded", () => {
    // Which statuses count as working is owned by `isWorkingStatus` (core run-state tests).
    const working = renderToString(<BotAvatar character="atlas" status="running" />);
    const idle = renderToString(<BotAvatar character="atlas" status="idle" live />);
    expect(working).toContain('data-working="true"');
    expect(working).toContain("characters/atlas.webp");
    expect(idle).toContain('data-working="false"');
  });
});
