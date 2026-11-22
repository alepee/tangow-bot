import Intents
import UIKit
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    lock.lock()
    self.contentHandler = contentHandler
    bestAttempt = request.content
    lock.unlock()
    guard let sender = BotSender(request.content) else {
      deliver(request.content)
      return
    }
    let intent = sender.messageIntent(body: request.content.body)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    // iOS hides a communication notification's subtitle, so the sender's name carries it (BotSender).
    let base = request.content.mutableCopy() as! UNMutableNotificationContent
    base.subtitle = ""
    interaction.donate { _ in
      let content = (try? base.updating(from: intent)) ?? request.content
      self.deliver(content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock()
    let content = bestAttempt
    lock.unlock()
    if let content { deliver(content) }
  }

  private func deliver(_ content: UNNotificationContent) {
    lock.lock()
    let handler = contentHandler
    contentHandler = nil
    lock.unlock()
    handler?(content)
  }
}

struct BotSender {
  let botId: String
  let name: String
  let image: Data

  init?(_ content: UNNotificationContent) {
    let data = BotSender.payload(content.userInfo)
    guard let botId = data["botId"] as? String,
      let image = AvatarRenderer.character(data["avatarCharacter"] as? String)?.pngData(),
      !content.title.isEmpty
    else { return nil }
    self.botId = botId
    self.name = content.subtitle.isEmpty ? content.title : "\(content.title) · \(content.subtitle)"
    self.image = image
  }

  private static func payload(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
    if let body = userInfo["body"] as? [String: Any] { return body }
    if let body = userInfo["body"] as? String,
      let data = body.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    {
      return object
    }
    return userInfo.reduce(into: [String: Any]()) { result, entry in
      if let key = entry.key as? String { result[key] = entry.value }
    }
  }

  func messageIntent(body: String) -> INSendMessageIntent {
    let image = INImage(imageData: self.image)
    let person = INPerson(
      personHandle: INPersonHandle(value: botId, type: .unknown),
      nameComponents: nil,
      displayName: name,
      image: image,
      contactIdentifier: nil,
      customIdentifier: botId
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: body,
      speakableGroupName: nil,
      // The share extension's target id, so a bot that writes is also suggested in the share sheet.
      conversationIdentifier: "bot:\(botId)",
      serviceName: nil,
      sender: person,
      attachments: nil
    )
    intent.setImage(image, forParameterNamed: \.sender)
    return intent
  }
}
