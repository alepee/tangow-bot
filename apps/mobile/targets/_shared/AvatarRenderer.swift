import UIKit

/// A bot's avatar for the extensions, which cannot run the app's renderer.
enum AvatarRenderer {
  /// A character's notification image (`targets/avatar-images.js`). A missing id, or one this app
  /// predates, gets the neutral character, never a hole.
  static func character(_ id: String?) -> UIImage? {
    UIImage(named: "avatar-\(id ?? "scout")") ?? UIImage(named: "avatar-scout")
  }
}
