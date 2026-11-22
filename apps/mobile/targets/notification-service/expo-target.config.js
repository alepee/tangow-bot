const avatarImages = require("../avatar-images");

module.exports = () => ({
  type: "notification-service",
  name: "TangowNotificationService",
  bundleIdentifier: ".notification-service",
  deploymentTarget: "16.4",
  frameworks: ["Intents"],
  images: avatarImages,
});
