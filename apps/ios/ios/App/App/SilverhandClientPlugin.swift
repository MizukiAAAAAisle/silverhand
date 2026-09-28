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
  }

  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  @MainActor private func client() throws -> ClientSession {
    if let session { return session }
    let client = try ClientSession()
    client.onSocket = { [weak self] event in self?.notifyListeners("socket", data: event) }
    client.onInvalidated = { [weak self] in self?.notifyListeners("sessionInvalidated", data: [:]) }
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

  @objc public func getProfile(_ call: CAPPluginCall) { run(call) { try $0.profile() } }
  @objc public func saveProfile(_ call: CAPPluginCall) {
    run(call) { try await $0.saveProfile(call.getString("serverUrl") ?? "") }
  }
  @objc public func clearProfile(_ call: CAPPluginCall) {
    run(call) { ["cleared": try $0.clearProfile()] }
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
      UIApplication.shared.open(url, options: [:]) { opened in
        if opened { call.resolve() } else { call.reject("Unable to open this URL") }
      }
    }
  }
}

class SilverhandViewController: CAPBridgeViewController {
  override func capacitorDidLoad() {
    bridge?.registerPluginInstance(SilverhandClientPlugin())
  }
}
