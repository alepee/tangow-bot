import { createRequire } from "node:module";
import { AVATAR_CHARACTERS } from "@tangow/contracts";
import { expect, it } from "vitest";

const avatarImages: Record<string, string> = createRequire(import.meta.url)(
  "../targets/avatar-images.js",
);

it("ships a notification image for every catalogue character", () => {
  // A missing image would quietly show the neutral character in iPhone notifications.
  expect(Object.keys(avatarImages).sort()).toEqual(
    AVATAR_CHARACTERS.map((character) => `avatar-${character.id}`).sort(),
  );
});
