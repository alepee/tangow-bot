const { readdirSync } = require("node:fs");
const path = require("node:path");

const IMAGES = "../../../packages/avatars/notifications";

/**
 * Each character's notification image as an `avatar-<id>` asset of the target. Paths are relative
 * to the target folder, where @bacons/apple-targets resolves them.
 */
module.exports = Object.fromEntries(
  readdirSync(path.join(__dirname, IMAGES))
    .filter((file) => file.endsWith(".png"))
    .map((file) => [`avatar-${path.basename(file, ".png")}`, `../${IMAGES}/${file}`]),
);
