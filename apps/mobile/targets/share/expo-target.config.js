const avatarImages = require("../avatar-images");

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "share",
  name: "TangowShare",
  displayName: config.name,
  bundleIdentifier: ".share",
  deploymentTarget: "16.4",
  frameworks: ["Intents"],
  images: avatarImages,
  entitlements: {
    // Reads the app's session from the keychain; the app lists the same group.
    "keychain-access-groups": config.ios.entitlements["keychain-access-groups"],
  },
});
