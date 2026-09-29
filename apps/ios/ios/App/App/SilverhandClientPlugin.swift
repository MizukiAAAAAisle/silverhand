import Capacitor
import SilverhandNative
import UIKit

@objc(SilverhandClientPlugin)
public final class SilverhandClientPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "SilverhandClientPlugin"
  public let jsName = "SilverhandClient"
  public let pluginMethods: [CAPPluginMethod] = [
    "getProfile", "saveProfile", "clearProfile", "authState", "authenticate", "logout", "request",
    "openSocket", "sendSocket", "closeSocket", "openExternal",
    "navigationSync", "navigationCapture", "navigationFinish", "navigationReset",
    "navigationBadges", "sharePng",
  ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

  @MainActor private var session: ClientSession?
  private var observers: [NSObjectProtocol] = []

  public override func load() {
    observers.append(
      NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        Task { @MainActor in self?.session?.setActive(false) }
      })
    observers.append(
      NotificationCenter.default.addObserver(
        forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        Task { @MainActor in
          self?.session?.setActive(true)
          self?.notifyListeners("foreground", data: [:])
        }
      })
    observers.append(
      NotificationCenter.default.addObserver(
        forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
      ) { [weak self] notification in
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
        else { return }
        Task { @MainActor in
          guard let self, let window = self.bridge?.viewController?.view.window else { return }
          let keyboard = window.convert(frame, from: window.screen.coordinateSpace)
          let overlap = window.bounds.intersection(keyboard)
          let docked = !overlap.isNull && overlap.height > 0
            && keyboard.maxY >= window.bounds.maxY
          self.notifyListeners("keyboardChanged", data: ["docked": docked])
        }
      })
  }

  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  @objc func sharePng(_ call: CAPPluginCall) {
    Task { @MainActor in
      guard let encoded = call.getString("base64"),
        let bytes = Data(base64Encoded: encoded),
        let image = UIImage(data: bytes),
        let host = self.bridge?.viewController,
        host.view.window != nil,
        host.presentedViewController == nil
      else {
        call.reject("Unable to present image sharing")
        return
      }

      // UIKit owns the image for the duration of sharing. No temporary file or
      // alternative file-picker lifecycle is introduced.
      let activity = UIActivityViewController(activityItems: [image], applicationActivities: nil)
      activity.completionWithItemsHandler = { _, completed, _, error in
        if let error { call.reject(error.localizedDescription) }
        else { call.resolve(["completed": completed]) }
      }
      if let popover = activity.popoverPresentationController {
        popover.sourceView = host.view
        popover.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 1, width: 1, height: 1)
        popover.permittedArrowDirections = []
      }
      host.present(activity, animated: true)
    }
  }

  @MainActor private func client() throws -> ClientSession {
    if let session { return session }
    let client = try ClientSession(defaultServerURL: "https://silverhand.taobao.net")
    client.onSocket = { [weak self] event in self?.notifyListeners("socket", data: event) }
    client.onInvalidated = { [weak self] in
      self?.navigationHost?.invalidate()
      self?.notifyListeners("sessionInvalidated", data: [:])
    }
    session = client
    return client
  }

  private func run(
    _ call: CAPPluginCall,
    operation: @escaping @MainActor (ClientSession) async throws -> [String: Any]
  ) {
    Task { @MainActor in
      do { call.resolve(try await operation(client())) } catch {
        call.reject(error.localizedDescription)
      }
    }
  }

  @MainActor private var navigationHost: SilverhandNavigationController? {
    var controller: UIViewController? = bridge?.viewController
    while let current = controller {
      if let host = current as? SilverhandNavigationController { return host }
      controller = current.parent
    }
    return nil
  }

  @MainActor private func bindNavigationIntent(to host: SilverhandNavigationController) {
    host.onIntent = { [weak self] intent in self?.notifyListeners("navigation", data: intent) }
  }

  @objc public func navigationBadges(_ call: CAPPluginCall) {
    Task { @MainActor in
      navigationHost?.badges(call)
      call.resolve()
    }
  }
  @objc public func navigationSync(_ call: CAPPluginCall) {
    Task { @MainActor in
      guard let host = navigationHost else {
        call.reject("Native navigation host unavailable")
        return
      }
      bindNavigationIntent(to: host)
      call.resolve(["bottomInset": host.sync(call)])
    }
  }
  @objc public func navigationCapture(_ call: CAPPluginCall) {
    Task { @MainActor in
      await navigationHost?.capture(
        session: call.getString("session") ?? "", key: call.getString("key") ?? "")
      call.resolve()
    }
  }
  @objc public func navigationFinish(_ call: CAPPluginCall) {
    Task { @MainActor in
      navigationHost?.finish(
        session: call.getString("session") ?? "", request: call.getString("request") ?? "",
        accepted: call.getBool("accepted") ?? false)
      call.resolve()
    }
  }
  @objc public func navigationReset(_ call: CAPPluginCall) {
    Task { @MainActor in
      navigationHost?.reset(session: call.getString("session") ?? "")
      call.resolve()
    }
  }

  @objc public func getProfile(_ call: CAPPluginCall) { run(call) { try $0.profile() } }
  @objc public func saveProfile(_ call: CAPPluginCall) {
    run(call) {
      let result = try await $0.saveProfile(call.getString("serverUrl") ?? "")
      self.navigationHost?.invalidate()
      return result
    }
  }
  @objc public func clearProfile(_ call: CAPPluginCall) {
    run(call) {
      let cleared = try $0.clearProfile()
      self.navigationHost?.invalidate()
      return ["cleared": cleared]
    }
  }
  @objc public func authState(_ call: CAPPluginCall) { run(call) { try await $0.authState() } }
  @objc public func authenticate(_ call: CAPPluginCall) {
    run(call) {
      try await $0.authenticate(
        action: call.getString("action") ?? "", body: call.getString("body") ?? "{}")
    }
  }
  @objc public func logout(_ call: CAPPluginCall) {
    run(call) {
      try await $0.logout()
      self.navigationHost?.invalidate()
      return [:]
    }
  }
  @objc public func request(_ call: CAPPluginCall) {
    run(call) {
      try await $0.proxy(
        path: call.getString("path") ?? "", method: call.getString("method") ?? "GET",
        body: call.getString("bodyText"),
        headers: call.getObject("headers") as? [String: String] ?? [:],
        binary: call.getString("responseType") == "arrayBuffer")
    }
  }
  @objc public func openSocket(_ call: CAPPluginCall) {
    run(call) {
      try $0.openSocket(id: call.getString("id") ?? "", url: call.getString("url") ?? "")
      return [:]
    }
  }
  @objc public func sendSocket(_ call: CAPPluginCall) {
    run(call) {
      try await $0.sendSocket(id: call.getString("id") ?? "", data: call.getString("data") ?? "")
      return [:]
    }
  }
  @objc public func closeSocket(_ call: CAPPluginCall) {
    run(call) {
      $0.closeSocket(id: call.getString("id") ?? "")
      return [:]
    }
  }
  @objc public func openExternal(_ call: CAPPluginCall) {
    Task { @MainActor in
      guard let raw = call.getString("url"), let url = URL(string: raw),
        ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "")
      else {
        call.reject("Unsupported external URL")
        return
      }
      let opened = await UIApplication.shared.open(url, options: [:])
      if opened { call.resolve() } else { call.reject("Unable to open this URL") }
    }
  }
}

class SilverhandViewController: CAPBridgeViewController {
  override func capacitorDidLoad() {
    bridge?.registerPluginInstance(SilverhandClientPlugin())
  }
}
