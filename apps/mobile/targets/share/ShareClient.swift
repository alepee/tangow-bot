import Foundation
import Security

/// A bot or group the link can be sent to.
struct ShareTarget: Identifiable, Hashable {
  enum Kind: String { case bot, group }

  let kind: Kind
  let targetId: String
  let name: String
  /// The bot's character; groups have none.
  let character: String?
  let spaceId: String
  /// Shown only when the person belongs to more than one space.
  let spaceName: String?
  let updatedAt: String

  var id: String { "\(kind.rawValue):\(targetId)" }
}

/// The app's session, read from the keychain group both targets share.
struct ShareSession {
  let base: String
  let headers: [String: String]

  /// The keys the app writes with expo-secure-store (lib/api.ts, lib/session.ts, lib/access-store.ts).
  private enum Key {
    static let session = "tangow.session_token"
    static let apiBase = "tangow.api_base"
    static let space = "tangow.space_id"
    static let access = "tangow.cf_access"
  }

  /// The local server the app falls back to when the build sets none (lib/endpoint.ts).
  private static let localApi = "http://127.0.0.1:3100"

  static func load() -> ShareSession? {
    guard let token = Keychain.read(Key.session), !token.isEmpty else { return nil }
    let info = containingAppInfo()
    let defaultBase = info["TangowApiBase"] as? String ?? localApi
    let stored = Keychain.read(Key.apiBase) ?? ""
    let base = stored.isEmpty ? defaultBase : stored
    var headers = [
      "content-type": "application/json",
      "origin": "tangow://",
      "authorization": "Bearer \(token)",
    ]
    if let space = Keychain.read(Key.space), !space.isEmpty { headers["x-tangow-space-id"] = space }
    if let access = access(base: base, defaultBase: defaultBase, info: info) {
      headers["CF-Access-Client-Id"] = access.clientId
      headers["CF-Access-Client-Secret"] = access.clientSecret
    }
    return ShareSession(base: base, headers: headers)
  }

  /// Same rule as `accessFor`: a stored token only for its own origin, the build-time token only
  /// for the build-time server. A token never reaches another server.
  private static func access(base: String, defaultBase: String, info: [String: Any])
    -> (clientId: String, clientSecret: String)?
  {
    if let raw = Keychain.read(Key.access),
      let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
      let origin = object["origin"] as? String, origin == base,
      let id = (object["clientId"] as? String)?.trimmingCharacters(in: .whitespaces), !id.isEmpty,
      let secret = (object["clientSecret"] as? String)?.trimmingCharacters(in: .whitespaces),
      !secret.isEmpty
    {
      return (id, secret)
    }
    guard base == defaultBase,
      let id = info["TangowAccessClientId"] as? String, !id.isEmpty,
      let secret = info["TangowAccessClientSecret"] as? String, !secret.isEmpty
    else { return nil }
    return (id, secret)
  }

  /// The app's Info.plist: the extension lives in `Tangow.app/PlugIns/`.
  private static func containingAppInfo() -> [String: Any] {
    let appURL = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
    return Bundle(url: appURL)?.infoDictionary ?? [:]
  }
}

/// Reads items exactly as expo-secure-store writes them. Without an access group the query
/// searches every group the extension is entitled to, which includes the app's.
enum Keychain {
  static func read(_ key: String) -> String? {
    let account = Data(key.utf8)
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrGeneric as String: account,
        kSecAttrAccount as String: account,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
      ]
      var item: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
        let data = item as? Data, let value = String(data: data, encoding: .utf8)
      {
        return value
      }
    }
    return nil
  }
}

struct ShareError: LocalizedError {
  let errorDescription: String?
}

/// The two procedures the extension calls, over the app's oRPC endpoint.
struct ShareClient {
  let session: ShareSession

  /// Every active bot and group across the person's spaces, most recent first.
  func targets() async throws -> [ShareTarget] {
    let spaces = try await call("spaces/list", [:]) as Navigation
    let named = spaces.spaces.count > 1
    return spaces.spaces.flatMap { space in
      let label = named ? space.name : nil
      let bots = space.bots.map { bot in
        ShareTarget(
          kind: .bot, targetId: bot.id, name: bot.name, character: bot.avatarCharacter,
          spaceId: space.id, spaceName: label, updatedAt: bot.updatedAt)
      }
      let groups = space.groups.map { group in
        ShareTarget(
          kind: .group, targetId: group.id, name: group.name, character: nil,
          spaceId: space.id, spaceName: label, updatedAt: group.updatedAt)
      }
      return bots + groups
    }
    .sorted { $0.updatedAt > $1.updatedAt }
  }

  func send(_ text: String, to target: ShareTarget) async throws {
    _ = try await post(
      "threads/send",
      [
        target.kind == .bot ? "botId" : "groupId": target.targetId,
        "clientNonce": UUID().uuidString,
        "text": text,
      ], spaceId: target.spaceId)
  }

  private struct Navigation: Decodable {
    struct Space: Decodable {
      let id: String
      let name: String
      let bots: [Listed]
      let groups: [Listed]
    }
    let spaces: [Space]
  }

  /// The navigation lists hold active bots and groups only.
  private struct Listed: Decodable {
    let id: String
    let name: String
    let avatarCharacter: String?
    let updatedAt: String
  }

  private struct Envelope<T: Decodable>: Decodable { let json: T }

  private func call<T: Decodable>(_ procedure: String, _ input: [String: Any]) async throws -> T {
    try JSONDecoder().decode(Envelope<T>.self, from: await post(procedure, input)).json
  }

  /// `spaceId` overrides the app's selected space for a target that lives in another one.
  private func post(_ procedure: String, _ input: [String: Any], spaceId: String? = nil)
    async throws -> Data
  {
    guard let url = URL(string: "\(session.base)/rpc/\(procedure)") else {
      throw ShareError(errorDescription: session.base)
    }
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    session.headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
    if let spaceId { request.setValue(spaceId, forHTTPHeaderField: "x-tangow-space-id") }
    request.httpBody = try JSONSerialization.data(withJSONObject: ["json": input])
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw ShareError(errorDescription: message(data) ?? "HTTP \(status)")
    }
    return data
  }

  /// oRPC puts a refusal's reason in `json.message`.
  private func message(_ data: Data) -> String? {
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    let json = object?["json"] as? [String: Any]
    return json?["message"] as? String
  }
}
