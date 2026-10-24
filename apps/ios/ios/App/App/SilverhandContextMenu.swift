import UIKit

struct ContextMenuItem {
  let id: String
  let label: String
  let icon: String
}

struct ContextMenuRequest {
  let point: CGPoint
  let reactions: [(emoji: String, label: String)]
  let sections: [[ContextMenuItem]]
}

enum ContextMenuChoice {
  case item(String)
  case react(String)
}

/// The page's context menu as the system draws it: above the native composer
/// and bars, clear of the screen's edges and the keyboard. The page sends the
/// actions and strings; the choice goes back, or nil when dismissed.
@MainActor
enum SilverhandContextMenu {
  private static var showing: AnchorButton?

  static func present(
    _ request: ContextMenuRequest, over web: UIView,
    completion: @escaping (ContextMenuChoice?) -> Void
  ) -> Bool {
    guard #available(iOS 17.4, *), let host = web.superview else { return false }
    showing?.finish(nil)

    // A system menu opens from a control; an invisible one stands at the press.
    let anchor = AnchorButton(frame: CGRect(origin: .zero, size: CGSize(width: 1, height: 1)))
    anchor.center = web.convert(request.point, to: host)
    anchor.isAccessibilityElement = false
    anchor.onFinish = { choice in
      anchor.removeFromSuperview()
      if showing === anchor { showing = nil }
      completion(choice)
    }
    anchor.menu = menu(for: request) { choice in anchor.finish(choice) }
    anchor.showsMenuAsPrimaryAction = true
    // Opened upward, the system would otherwise reverse it.
    anchor.preferredMenuElementOrder = .fixed
    host.addSubview(anchor)
    showing = anchor
    anchor.performPrimaryAction()
    return true
  }

  @available(iOS 17.4, *)
  private static func menu(
    for request: ContextMenuRequest, choose: @escaping (ContextMenuChoice) -> Void
  ) -> UIMenu {
    var children: [UIMenuElement] = []
    if !request.reactions.isEmpty {
      let row = UIMenu(
        options: .displayInline,
        children: request.reactions.map { reaction in
          let action = UIAction(title: reaction.emoji) { _ in choose(.react(reaction.emoji)) }
          action.accessibilityLabel = reaction.label
          return action
        })
      row.preferredElementSize = .small
      children.append(row)
    }
    for section in request.sections where !section.isEmpty {
      children.append(
        UIMenu(
          options: .displayInline,
          children: section.map { item in
            UIAction(title: item.label, image: BarGlyphs.image(item.icon, size: 18)) { _ in
              choose(.item(item.id))
            }
          }))
    }
    return UIMenu(children: children)
  }
}

/// Reports the choice once: an action's, or nil as the menu closes without one.
private final class AnchorButton: UIButton {
  var onFinish: ((ContextMenuChoice?) -> Void)?

  func finish(_ choice: ContextMenuChoice?) {
    guard let onFinish else { return }
    self.onFinish = nil
    onFinish(choice)
  }

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    // A chosen action runs as the menu finishes closing; only then is
    // "nothing chosen" known.
    let dismissed = { [weak self] in DispatchQueue.main.async { self?.finish(nil) } }
    if let animator { animator.addCompletion(dismissed) } else { dismissed() }
  }
}
