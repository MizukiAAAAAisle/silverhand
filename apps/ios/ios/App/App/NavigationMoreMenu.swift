import UIKit

// A compact menu presents actions without creating a fourth route history.
@MainActor
enum NavigationItemStyle {
  static let font = UIFont.systemFont(ofSize: 12, weight: .medium)
}

final class NavigationMoreMenu: UIViewController, UIViewControllerTransitioningDelegate {
  private(set) var menuButtons: [UIButton] = []
  private let items = [
    (title: "Members", target: "members", symbol: "NavigationMembers"),
    (title: "Computers", target: "computers", symbol: "NavigationComputers"),
    (title: "Settings", target: "settings", symbol: "NavigationSettings"),
  ]
  private let anchor: () -> CGRect
  private let edge: () -> NSDirectionalRectEdge?
  private let onSelect: (String) -> Void

  init(
    anchor: @escaping () -> CGRect,
    edge: @escaping () -> NSDirectionalRectEdge?,
    onSelect: @escaping (String) -> Void
  ) {
    self.anchor = anchor
    self.edge = edge
    self.onSelect = onSelect
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .custom
    transitioningDelegate = self
    // Shorter than the tab bar beneath it so the menu reads as its accessory.
    preferredContentSize = CGSize(width: 0, height: 60)
  }

  func presentationController(
    forPresented presented: UIViewController, presenting: UIViewController?,
    source: UIViewController
  ) -> UIPresentationController? {
    CompactMenuPresentation(
      presentedViewController: presented, presenting: presenting, anchor: anchor, edge: edge)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.accessibilityViewIsModal = true
    // On iOS 26 the menu shares the tab bar's glass instead of an opaque card.
    if #available(iOS 26.0, *) {
      let glass = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
      glass.frame = view.bounds
      glass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      glass.cornerConfiguration = .capsule()
      view.addSubview(glass)
    } else {
      view.backgroundColor = .systemBackground
    }

    // Beside a vertical bar the menu is an icon-only column, like the bar.
    let besideBar = edge() != nil
    let actions = UIStackView()
    actions.axis = besideBar ? .vertical : .horizontal
    actions.distribution = .fillEqually
    actions.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(actions)
    for item in items {
      let button = UIButton(type: .system)
      var configuration = UIButton.Configuration.plain()
      configuration.image = UIImage(named: item.symbol)
      if !besideBar { configuration.title = item.title }
      configuration.imagePlacement = .top
      configuration.imagePadding = 2
      configuration.contentInsets = .zero
      configuration.baseForegroundColor = .label
      configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
        incoming in
        var attributes = incoming
        attributes.font = NavigationItemStyle.font
        attributes.foregroundColor = .label
        return attributes
      }
      button.configuration = configuration
      button.accessibilityIdentifier = "more-" + item.target
      button.accessibilityLabel = item.title
      button.addAction(
        UIAction { [weak self] _ in
          guard let self else { return }
          self.dismiss(animated: true) { [onSelect = self.onSelect] in onSelect(item.target) }
        }, for: .touchUpInside)
      actions.addArrangedSubview(button)
      menuButtons.append(button)
    }
    NSLayoutConstraint.activate([
      actions.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
      actions.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
      actions.topAnchor.constraint(equalTo: view.topAnchor, constant: 4),
      actions.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -4),
    ])
  }
}

@MainActor
private final class CompactMenuPresentation: UIPresentationController {
  private let anchor: () -> CGRect
  private let edge: () -> NSDirectionalRectEdge?
  private let dismissArea = UIControl()

  init(
    presentedViewController: UIViewController, presenting: UIViewController?,
    anchor: @escaping () -> CGRect, edge: @escaping () -> NSDirectionalRectEdge?
  ) {
    self.anchor = anchor
    self.edge = edge
    super.init(presentedViewController: presentedViewController, presenting: presenting)
  }

  override var frameOfPresentedViewInContainerView: CGRect {
    guard let containerView else { return .zero }
    if let edge = edge() { return besideBar(edge, in: containerView) }
    // Share the glass pill's width so the menu stacks on it as one column.
    // The pill is narrower than the screen on a wide display.
    // Without item frames the anchor is the full-width bar; inset it then.
    let bar = anchor()
    let pill = bar.width < containerView.bounds.width - 1 ? bar : bar.insetBy(dx: 16, dy: 0)
    let height = presentedViewController.preferredContentSize.height
    return CGRect(
      x: pill.minX, y: max(containerView.safeAreaInsets.top + 8, bar.minY - height - 8),
      width: pill.width, height: height)
  }

  /// A vertical bar: a column level with the bar's bottom, beside the bar.
  private func besideBar(_ edge: NSDirectionalRectEdge, in containerView: UIView) -> CGRect {
    let pill = anchor()
    // Rows and width match the vertical pill's 50pt item pitch and width.
    let size = CGSize(width: pill.width, height: 3 * 50 + 8)
    let leftToRight = containerView.effectiveUserInterfaceLayoutDirection == .leftToRight
    let onRight = (edge == .trailing) == leftToRight
    let x = onRight ? pill.minX - size.width - 8 : pill.maxX + 8
    let y = pill.maxY - size.height
    return CGRect(
      x: x, y: max(containerView.safeAreaInsets.top + 8, y), width: size.width, height: size.height)
  }

  override func presentationTransitionWillBegin() {
    guard let containerView else { return }
    dismissArea.frame = containerView.bounds
    dismissArea.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    dismissArea.addTarget(self, action: #selector(closeMenu), for: .touchUpInside)
    containerView.insertSubview(dismissArea, at: 0)
    // Glass draws its own shape and depth.
    if #available(iOS 26.0, *) { return }
    presentedView?.layer.cornerRadius = 24
    presentedView?.layer.shadowColor = UIColor.black.cgColor
    presentedView?.layer.shadowOpacity = 0.12
    presentedView?.layer.shadowRadius = 18
    presentedView?.layer.shadowOffset = CGSize(width: 0, height: 6)
  }

  override func containerViewWillLayoutSubviews() {
    presentedView?.frame = frameOfPresentedViewInContainerView
  }

  @objc private func closeMenu() { presentedViewController.dismiss(animated: true) }
}
