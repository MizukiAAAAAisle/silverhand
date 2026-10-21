import Foundation

/// Copy drawn by native chrome. It follows the language the web page resolved,
/// so tabs and sheets never disagree with the page they frame.
enum NativeLocale: String {
  case en, zh
}

@MainActor
enum NativeCopy {
  /// English until the page reports the language it resolved.
  private(set) static var locale: NativeLocale = .en

  /// Returns whether the language changed, so callers redraw only then.
  static func set(_ raw: String?) -> Bool {
    guard let raw, let next = NativeLocale(rawValue: raw), next != locale else { return false }
    locale = next
    return true
  }

  private static func pick(_ en: String, _ zh: String) -> String {
    locale == .zh ? zh : en
  }

  /// Tab titles in tab order: Chats, Activity, Tasks, Me.
  static var tabTitles: [String] {
    [pick("Chats", "聊天"), pick("Activity", "动态"), pick("Tasks", "任务"), pick("Me", "我")]
  }

  static var makeAvatar: String { pick("Make an avatar", "制作头像") }
  static var avatarPreview: String { pick("Avatar preview", "头像预览") }
  static var random: String { pick("Random", "随机") }
  static var reset: String { pick("Reset", "重置") }
  static var cancel: String { pick("Cancel", "取消") }
  static var use: String { pick("Use", "使用") }
  static var none: String { pick("None", "无") }

  static func avatarCategory(_ id: String) -> String {
    switch id {
    case "eyebrows": return pick("Brows", "眉毛")
    case "eyes": return pick("Eyes", "眼睛")
    case "nose": return pick("Nose", "鼻子")
    case "mouth": return pick("Mouth", "嘴巴")
    case "hair": return pick("Hair", "发型")
    case "glasses": return pick("Glasses", "眼镜")
    case "headwear": return pick("Headwear", "头饰")
    case "status": return pick("Mood", "心情")
    case "gesture": return pick("Gesture", "手势")
    case "buddy": return pick("Buddy", "伙伴")
    case "background": return pick("Color", "颜色")
    default: return id
    }
  }
}
