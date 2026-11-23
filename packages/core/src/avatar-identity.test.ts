import { describe, expect, it } from "vitest";
import { avatarIdentitySeed } from "./avatar-identity.js";

describe("avatarIdentitySeed", () => {
  it("is stable for an identity", () => {
    expect(avatarIdentitySeed("research")).toBe(avatarIdentitySeed("research"));
    expect(avatarIdentitySeed("research")).not.toBe(avatarIdentitySeed("github"));
  });
});
