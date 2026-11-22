import { describe, expect, it } from "vitest";

import {
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "./composer-slash.js";

describe("serializeComposerPrompt", () => {
  it("sends the draft as typed, mentions in place", () => {
    expect(serializeComposerPrompt("  ask @Ivy to check with @Design crew ", null)).toBe(
      "ask @Ivy to check with @Design crew",
    );
  });

  it("moves an inline skill token to its own leading line", () => {
    expect(serializeComposerPrompt("/Daily standup check @Ivy", { name: "Daily standup" })).toBe(
      "/Daily standup\ncheck @Ivy",
    );
    expect(serializeComposerPrompt("/Daily standup ", { name: "Daily standup" })).toBe(
      "/Daily standup",
    );
  });
});

describe("truncateSlashDescription", () => {
  it("leaves short text alone", () => {
    expect(truncateSlashDescription("short")).toBe("short");
  });

  it("truncates long text with an ellipsis", () => {
    const long = "a".repeat(80);
    expect(truncateSlashDescription(long, 20)).toBe(`${"a".repeat(19)}…`);
  });
});

describe("SLASH_ACTIONS", () => {
  it("exposes chat and account destinations", () => {
    expect(SLASH_ACTIONS.map((action) => action.id)).toEqual([
      "chat-settings",
      "settings-general",
      "settings-usage",
    ]);
  });
});
