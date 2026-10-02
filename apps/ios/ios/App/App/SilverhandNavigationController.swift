import Capacitor
import UIKit

// UIKit owns only the chrome and transition pixels. All routes and tab histories
// remain in React. The same Capacitor controller is moved between empty hosts;
// no tab creates another WebView or an independent navigation stack.
@MainActor
final class SilverhandNavigationController: UITabBarController, UITabBarControllerDelegate,
  UIGestureRecognizerDelegate
{
  let content = SilverhandViewController()
  let moreAction = TabItemHitRegion()
  private let names = ["chat", "activity", "tasks", "more"]
  private var session = ""
  private var entryKey = ""
  private var invalidatedSessions = Set<String>()
  private var pendingBadges: (session: String, values: [Bool])?
  private var backKey: String?
  private var modalVersion = 0
  private var blocked = false
  private var visible = false
  private var backVisible = false
  private var images: [String: UIImage] = [:]
  private var imageOrder: [String] = []
  private var front: UIView?
  private var previous: UIImageView?
  private var gestureRequest: String?
  private var gestureEntryKey: String?
  private var pendingCompletion = false
  var onIntent: (([String: Any]) -> Void)?

  override func viewDidLoad() {
    super.viewDidLoad()
    delegate = self
    tabBar.tintColor = .label
    tabBar.unselectedItemTintColor = .label
    let appearance = tabBar.standardAppearance.copy()
    for layout in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance,
      appearance.compactInlineLayoutAppearance]
    {
      for state in [layout.normal, layout.selected] {
        state.titleTextAttributes = [.font: NavigationItemStyle.font, .foregroundColor: UIColor.label]
        state.iconColor = .label
      }
    }
    tabBar.standardAppearance = appearance
    tabBar.scrollEdgeAppearance = appearance
    let titles = ["Chats", "Activity", "Tasks", "More"]
    viewControllers = titles.enumerated().map { index, title in
      let page = UIViewController()
      page.tabBarItem = UITabBarItem(
        title: title, image: UIImage(named: "Navigation" + title),
        selectedImage: UIImage(named: "Navigation" + title + "Selected"))
      page.tabBarItem.tag = index
      return page
    }
    // More is an action, not a touch-selected destination. Own its hit region
    // before UIKit begins the glass tab selection tracking animation.
    // VoiceOver retains the system tab item; this region only routes touch input.
    moreAction.isAccessibilityElement = false
    moreAction.accessibilityIdentifier = "native-more-action"
    moreAction.addAction(UIAction { [weak self] _ in self?.showMore() }, for: .touchUpInside)
    moreAction.region = { [weak self] in self?.moreItemFrame() }
    view.addSubview(moreAction)
    attachContent(to: viewControllers![0])
    hideBar(true, animated: false)
    let pan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgePan(_:)))
    pan.edges = .left
    pan.delegate = self
    view.addGestureRecognizer(pan)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    moreAction.frame = view.bounds
    view.bringSubviewToFront(moreAction)
  }

  /// Read at touch time: a minimized tab bar relocates its items without a
  /// controller layout pass, so a cached frame would cover content.
  private func moreItemFrame() -> CGRect? {
    guard !tabBar.isHidden, tabBar.alpha > 0 else { return nil }
    if #available(iOS 17.0, *), let item = viewControllers?[3].tabBarItem,
      let itemFrame = item.frame(in: view)
    {
      return itemFrame.isEmpty ? nil : itemFrame
    }
    let actionRegion = CGRect(
      x: tabBar.bounds.width * 0.75, y: 0,
      width: tabBar.bounds.width * 0.25, height: tabBar.bounds.height)
    return tabBar.convert(actionRegion, to: view)
  }

  private func attachContent(to host: UIViewController) {
    guard content.parent !== host else { return }
    content.willMove(toParent: nil)
    content.view.removeFromSuperview()
    content.removeFromParent()
    host.addChild(content)
    content.view.frame = host.view.bounds
    content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    host.view.addSubview(content.view)
    content.didMove(toParent: host)
  }

  private func hideBar(_ hidden: Bool, animated: Bool) {
    moreAction.isHidden = hidden
    if #available(iOS 18.0, *) {
      setTabBarHidden(hidden, animated: animated)
    } else {
      tabBar.isHidden = hidden
    }
  }

  func sync(_ call: CAPPluginCall) -> CGFloat {
    let nextSession = call.getString("session") ?? ""
    guard !nextSession.isEmpty, !invalidatedSessions.contains(nextSession) else { return 0 }
    if session != nextSession {
      clearTransition()
      images.removeAll()
      imageOrder.removeAll()
      session = nextSession
      for page in viewControllers ?? [] { page.tabBarItem.badgeValue = nil }
    }
    applyBadges()
    entryKey = call.getString("key") ?? ""
    backKey = call.getString("backKey")
    modalVersion = call.getInt("modalVersion") ?? 0
    blocked = call.getBool("blocked") ?? false
    visible = call.getBool("visible") ?? false
    if blocked {
      clearTransition()
      presentedViewController?.dismiss(animated: false)
    }
    backVisible = call.getBool("backVisible") ?? false
    if let index = names.firstIndex(of: call.getString("tab") ?? ""), index < 4,
      let host = viewControllers?[index]
    {
      selectedIndex = index
      attachContent(to: host)
    }
    if front == nil { hideBar(!visible || blocked, animated: false) }
    view.layoutIfNeeded()
    observeContentScroll()
    return visible ? max(0, view.bounds.maxY - tabBar.frame.minY) : 0
  }

  // WebKit backs each overflow scroller with its own UIScrollView. Handing the
  // page's main one to UIKit lets the glass tab bar minimize on scroll. WebKit
  // may replace it after layout, so look again once the page settles.
  private func observeContentScroll() {
    guard #available(iOS 26.0, *) else { return }
    tabBarMinimizeBehavior = visible ? .onScrollDown : .never
    let host = selectedViewController
    for delay in [0.05, 0.6] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self, let host, host === self.selectedViewController,
          let root = self.content.webView?.scrollView
        else { return }
        host.setContentScrollView(self.visible ? self.mainScroller(in: root) : nil, for: .bottom)
      }
    }
  }

  private func mainScroller(in root: UIScrollView) -> UIScrollView? {
    var best: UIScrollView?
    var bestArea: CGFloat = 0
    var stack: [UIView] = root.subviews
    while let next = stack.popLast() {
      stack.append(contentsOf: next.subviews)
      guard let scroller = next as? UIScrollView, scroller.window != nil,
        scroller.contentSize.height > scroller.bounds.height + 1
      else { continue }
      let area = scroller.bounds.width * scroller.bounds.height
      if area > bestArea {
        best = scroller
        bestArea = area
      }
    }
    return best
  }

  func invalidate() {
    if !session.isEmpty { invalidatedSessions.insert(session) }
    reset(session: session)
  }

  func badges(_ call: CAPPluginCall) {
    guard let owner = call.getString("session"), !invalidatedSessions.contains(owner) else {
      return
    }
    pendingBadges = (owner, names.prefix(3).map { call.getBool($0) == true })
    applyBadges()
  }

  private func applyBadges() {
    guard let pendingBadges, pendingBadges.session == session else { return }
    for (index, value) in pendingBadges.values.enumerated() {
      viewControllers?[index].tabBarItem.badgeValue = value ? "•" : nil
    }
  }

  func reset(session expected: String) {
    guard expected == session else { return }
    session = ""
    pendingBadges = nil
    for page in viewControllers ?? [] { page.tabBarItem.badgeValue = nil }
    entryKey = ""
    backKey = nil
    visible = false
    blocked = false
    clearTransition()
    images.removeAll()
    imageOrder.removeAll()
    hideBar(true, animated: false)
    presentedViewController?.dismiss(animated: false)
  }

  func capture(session expected: String, key: String) async {
    guard expected == session, key == entryKey, front == nil, let web = content.webView else {
      return
    }
    let image = try? await web.takeSnapshot(configuration: nil)
    guard expected == session, key == entryKey, let image else { return }
    images[key] = image
    imageOrder.removeAll { $0 == key }
    imageOrder.append(key)
    // Snapshots are optional presentation caches, never history entries.
    while imageOrder.count > 12 { images.removeValue(forKey: imageOrder.removeFirst()) }
  }

  func tabBarController(
    _ tabBarController: UITabBarController, shouldSelect viewController: UIViewController
  ) -> Bool {
    guard !session.isEmpty, front == nil, !blocked else { return false }
    let index = viewController.tabBarItem.tag
    if index == 3 {
      showMore()
    } else {
      onIntent?([
        "session": session, "modalVersion": modalVersion, "kind": "tab", "target": names[index],
      ])
    }
    // Selection is acknowledged exclusively through shared state sync.
    return false
  }

  private func showMore() {
    guard !session.isEmpty, front == nil, !blocked, presentedViewController == nil else { return }
    let originSession = session
    let menu = NavigationMoreMenu(
      anchor: { [weak self] in
        guard let self else { return .zero }
        return self.tabBar.convert(self.tabBar.bounds, to: self.view)
      }
    ) { [weak self] target in
      guard let self, self.session == originSession else { return }
      self.openMore(target)
    }
    present(menu, animated: true)
  }

  func openMore(_ target: String) {
    guard !blocked, !session.isEmpty, ["members", "computers", "settings"].contains(target) else {
      return
    }
    onIntent?(["session": session, "modalVersion": modalVersion, "kind": "more", "target": target])
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard !blocked, front == nil, presentedViewController == nil, !session.isEmpty,
      let backKey, images[backKey] != nil
    else { return false }
    let velocity = (gestureRecognizer as? UIPanGestureRecognizer)?.velocity(in: view) ?? .zero
    return velocity.x > abs(velocity.y)
  }

  func beginInteractiveBack() -> Bool {
    guard !blocked, front == nil, !session.isEmpty, let backKey, let image = images[backKey],
      let web = content.webView, let snapshot = web.snapshotView(afterScreenUpdates: false)
    else { return false }
    let bounds = web.convert(web.bounds, to: view)
    let previous = UIImageView(image: image)
    previous.frame = bounds
    previous.contentMode = .scaleToFill
    view.insertSubview(previous, belowSubview: tabBar)
    snapshot.frame = bounds
    snapshot.accessibilityIdentifier = "navigation-transition-front"
    view.insertSubview(snapshot, belowSubview: tabBar)
    self.previous = previous
    front = snapshot
    gestureRequest = UUID().uuidString
    gestureEntryKey = entryKey
    pendingCompletion = false
    hideBar(!(visible || backVisible), animated: false)
    tabBar.alpha = visible ? 1 : 0
    return true
  }

  func updateInteractiveBack(progress raw: CGFloat) {
    guard let front else { return }
    let progress = min(1, max(0, raw))
    front.transform = CGAffineTransform(translationX: view.bounds.width * progress, y: 0)
    previous?.transform = CGAffineTransform(
      translationX: -view.bounds.width * 0.25 * (1 - progress), y: 0)
    tabBar.alpha =
      visible == backVisible ? (visible ? 1 : 0) : (backVisible ? progress : 1 - progress)
  }

  func endInteractiveBack(complete: Bool) {
    guard let request = gestureRequest, !pendingCompletion else { return }
    if complete {
      pendingCompletion = true
      onIntent?([
        "session": session, "modalVersion": modalVersion, "kind": "back", "request": request,
        "key": gestureEntryKey ?? "",
      ])
    } else {
      animateFinish(false)
    }
  }

  @objc private func edgePan(_ pan: UIScreenEdgePanGestureRecognizer) {
    switch pan.state {
    case .began: _ = beginInteractiveBack()
    case .changed: updateInteractiveBack(progress: pan.translation(in: view).x / view.bounds.width)
    case .ended:
      endInteractiveBack(
        complete: pan.translation(in: view).x > view.bounds.width * 0.4
          || pan.velocity(in: view).x > 700)
    case .cancelled, .failed: endInteractiveBack(complete: false)
    default: break
    }
  }

  func finish(session expected: String, request: String, accepted: Bool) {
    guard expected == session, request == gestureRequest, pendingCompletion else { return }
    pendingCompletion = false
    if accepted { content.view.endEditing(true) }
    animateFinish(accepted)
  }

  private func animateFinish(_ accepted: Bool) {
    let owner = gestureRequest
    let originSession = session
    let duration = UIAccessibility.isReduceMotionEnabled ? 0 : 0.22
    UIView.animate(
      withDuration: duration,
      animations: {
        self.front?.transform =
          accepted ? CGAffineTransform(translationX: self.view.bounds.width, y: 0) : .identity
        self.previous?.transform =
          accepted
          ? .identity : CGAffineTransform(translationX: -self.view.bounds.width * 0.25, y: 0)
        self.tabBar.alpha = self.visible ? 1 : 0
      },
      completion: { _ in
        guard self.gestureRequest == owner, self.session == originSession else { return }
        self.clearTransition()
      })
  }

  private func clearTransition() {
    front?.removeFromSuperview()
    previous?.removeFromSuperview()
    front = nil
    previous = nil
    gestureRequest = nil
    gestureEntryKey = nil
    pendingCompletion = false
    tabBar.alpha = 1
    hideBar(!visible || blocked, animated: false)
  }
}

/// Claims touches only inside `region`; everything else passes through.
final class TabItemHitRegion: UIControl {
  var region: () -> CGRect? = { nil }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    guard let superview, let frame = region() else { return false }
    return frame.contains(convert(point, to: superview))
  }
}
