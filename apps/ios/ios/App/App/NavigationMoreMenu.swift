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
  private let onSelect: (String) -> Void

  init(
    anchor: @escaping () -> CGRect,
    onSelect: @escaping (String) -> Void
  ) {
    self.anchor = anchor
    self.onSelect = onSelect
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .custom
    transitioningDelegate = self
    preferredContentSize = CGSize(width: 0, height: 72)
  }

  func presentationController(
    forPresented presented: UIViewController, presenting: UIViewController?,
    source: UIViewController
  ) -> UIPresentationController? {
    CompactMenuPresentation(
      presentedViewController: presented, presenting: presenting, anchor: anchor)
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

    let actions = UIStackView()
    actions.axis = .horizontal
    actions.distribution = .fillEqually
    actions.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(actions)
    for item in items {
      let button = UIButton(type: .system)
      var configuration = UIButton.Configuration.plain()
      configuration.image = UIImage(named: item.symbol)
      configuration.title = item.title
      configuration.imagePlacement = .top
      configuration.imagePadding = 4
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
      button.addAction(
        UIAction { [weak self] _ in
          guard let self else { return }
          self.dismiss(animated: true) { [onSelect = self.onSelect] in onSelect(item.target) }
        }, for: .touchUpInside)
      actions.addArrangedSubview(button)
      menuButtons.append(button)
    }
    NSLayoutConstraint.activate([
      actions.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      actions.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      actions.topAnchor.constraint(equalTo: view.topAnchor, constant: 6),
      actions.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -6),
    ])
  }

}

@MainActor
private final class CompactMenuPresentation: UIPresentationController {
  private let anchor: () -> CGRect
  private let dismissArea = UIControl()

  init(
    presentedViewController: UIViewController, presenting: UIViewController?,
    anchor: @escaping () -> CGRect
  ) {
    self.anchor = anchor
    super.init(presentedViewController: presentedViewController, presenting: presenting)
  }

  override var frameOfPresentedViewInContainerView: CGRect {
    guard let containerView else { return .zero }
    let size = CGSize(
      width: containerView.bounds.width - 32,
      height: presentedViewController.preferredContentSize.height)
    return CGRect(
      x: containerView.bounds.maxX - size.width - 16,
      y: max(containerView.safeAreaInsets.top + 8, anchor().minY - size.height - 8),
      width: size.width, height: size.height)
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
