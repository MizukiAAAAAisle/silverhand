import XCTest

@testable import SilverhandNative

#if os(iOS)
  import UIKit
  import WebKit
#endif

/// Requires the isolated simulator CA and scripts/ios-acceptance-server.mjs.
@MainActor
final class NetworkAcceptanceTests: XCTestCase {
  private func json(_ value: [String: Any]) throws -> String {
    String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
  }
  private func body(_ response: [String: Any]) throws -> [String: Any] {
    XCTAssertTrue(
      (200..<300).contains(response["status"] as? Int ?? 0),
      "HTTP status \(response["status"] ?? 0): \(response["bodyText"] ?? "")")
    return try JSONSerialization.jsonObject(
      with: Data((response["bodyText"] as? String ?? "{}").utf8)) as? [String: Any] ?? [:]
  }
  private func waitFor(_ predicate: () -> Bool) async throws {
    for _ in 0..<100 {
      if predicate() { return }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTFail("Timed out waiting for authenticated WS frame")
  }

  func testNativeHTTPSAndAuthenticatedWSMessageLifecycle() async throws {
    #if !os(iOS)
      throw XCTSkip("Requires isolated iOS simulator with test CA and acceptance server")
    #else
      let store = KeychainSessionStore(service: "com.silverhand.acceptance.\(UUID().uuidString)")
      defer { try? store.write(nil) }
      let client = try ClientSession(store: store)
      _ = try await client.saveProfile("https://localhost:19443")
      let name =
        "ios" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
      let password = "Acceptance-2663-only!"
      let signup = try await client.authenticate(
        action: "signup",
        body: json(["email": "\(name)@example.test", "name": name, "password": password]))
      XCTAssertEqual(signup["ok"] as? Bool, true)
      XCTAssertNil(signup["user_token"])
      XCTAssertNotNil(try store.read()?.token)
      let hosts = try body(await client.proxy(path: "/api/hosts"))
      XCTAssertEqual(
        (hosts["hosts"] as? [Any])?.count, 0, "An iOS signup must not create a computer")
      let restored = try ClientSession(store: store)
      let restoredState = try await restored.authState()
      XCTAssertEqual((restoredState["me"] as? [String: Any])?["status"] as? Int, 200)
      let workspaceBody = try body(
        await client.proxy(path: "/api/workspaces", method: "POST", body: json(["name": name])))
      let workspace = workspaceBody["workspace"] as? [String: Any] ?? workspaceBody
      let workspaceID = try XCTUnwrap(workspace["id"] as? String)
      let channelBody = try body(
        await client.proxy(
          path: "/api/workspaces/\(workspaceID)/channels", method: "POST",
          body: json(["title": "iOS acceptance"])))
      let channel = channelBody["channel"] as? [String: Any] ?? channelBody
      let channelID = try XCTUnwrap(channel["id"] as? String)
      let messagesPath = "/api/channels/\(channelID)/messages"
      var frames: [[String: Any]] = []
      client.onSocket = { event in
        if let data = event["data"] as? String,
          let object = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any]
        {
          frames.append(object)
        }
      }
      try client.openSocket(id: "first", url: "wss://localhost:19443/api/ws/events")
      try await waitFor { frames.contains { $0["type"] as? String == "authenticated" } }
      try await client.sendSocket(
        id: "first", data: json(["type": "subscribe", "scope": "conversation:\(channelID)"]))
      try await waitFor { frames.contains { $0["type"] as? String == "subscribed" } }
      _ = try body(
        await client.proxy(
          path: messagesPath, method: "POST", body: json(["content": "native live message"])))
      try await waitFor { frames.contains { ($0["type"] as? String) == "event" } }
      let history = try await client.proxy(path: messagesPath)
      XCTAssertTrue((history["bodyText"] as? String ?? "").contains("native live message"))
      client.setActive(false)
      do {
        try client.openSocket(id: "background", url: "wss://localhost:19443/api/ws/events")
        XCTFail("must not connect in background")
      } catch {}
      _ = try body(
        await restored.proxy(
          path: messagesPath, method: "POST", body: json(["content": "message while suspended"])))
      client.setActive(true)
      frames.removeAll()
      try client.openSocket(id: "resumed", url: "wss://localhost:19443/api/ws/events")
      try await waitFor { frames.contains { $0["type"] as? String == "authenticated" } }
      let resumedHistory = try await client.proxy(path: messagesPath)
      XCTAssertTrue(
        (resumedHistory["bodyText"] as? String ?? "").contains("message while suspended"))
      _ = try body(
        await client.proxy(
          path: "/api/me/password", method: "POST",
          body: json(["current_password": password, "new_password": password + "changed"])))
      XCTAssertNil(try store.read()?.token)
      let login = try await client.authenticate(
        action: "login",
        body: json(["email": "\(name)@example.test", "password": password + "changed"]))
      XCTAssertEqual(login["ok"] as? Bool, true)
      try await client.logout()
      XCTAssertNil(try store.read()?.token)
      _ = try client.clearProfile()
      XCTAssertNil(try store.read())
    #endif
  }
  #if os(iOS)
    private func findWebView(_ view: UIView) -> WKWebView? {
      if let web = view as? WKWebView { return web }
      for child in view.subviews { if let web = findWebView(child) { return web } }
      return nil
    }

    func testWebViewBridgeAndSharedUIMessageRoundTrip() async throws {
      var web: WKWebView?
      for _ in 0..<100 {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
          for window in scene.windows { if let found = findWebView(window) { web = found } }
        }
        if web != nil { break }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      let view = try XCTUnwrap(web)
      for _ in 0..<100 {
        if (try? await view.evaluateJavaScript(
          "typeof window.Capacitor?.nativePromise === 'function'")) as? Bool == true
        {
          break
        }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      func call(_ method: String, _ options: [String: Any] = [:]) async throws -> [String: Any] {
        try await view.callAsyncJavaScript(
          "return await window.Capacitor.nativePromise('SilverhandClient', method, options)",
          arguments: ["method": method, "options": options], in: nil, contentWorld: .page)
          as? [String: Any] ?? [:]
      }
      _ = try await call("clearProfile")
      _ = try await call("saveProfile", ["serverUrl": "https://localhost:19443"])
      let name =
        "bridge" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10).lowercased()
      let auth = try await call(
        "authenticate",
        [
          "action": "signup",
          "body": json([
            "email": "\(name)@example.test", "name": name, "password": "Isolated-bridge-2663!",
          ]),
        ])
      XCTAssertEqual(auth["ok"] as? Bool, true)
      XCTAssertNil(auth["user_token"])
      let workspace = try body(
        await call(
          "request",
          ["path": "/api/workspaces", "method": "POST", "bodyText": json(["name": name])]))
      let workspaceID = try XCTUnwrap(
        (workspace["workspace"] as? [String: Any] ?? workspace)["id"] as? String)
      let channel = try body(
        await call(
          "request",
          [
            "path": "/api/workspaces/\(workspaceID)/channels", "method": "POST",
            "bodyText": json(["title": "Bridge acceptance"]),
          ]))
      let channelID = try XCTUnwrap(
        (channel["channel"] as? [String: Any] ?? channel)["id"] as? String)
      _ = try await view.evaluateJavaScript(
        "window.location.hash = '/chat/w/\(workspaceID)/c/\(channelID)'; window.location.reload();")
      var composerReady = false
      for _ in 0..<150 {
        composerReady =
          ((try? await view.evaluateJavaScript("!!document.querySelector('textarea')")) as? Bool)
          == true
        if composerReady { break }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      XCTAssertTrue(composerReady, "Shared React channel composer must mount after native login")
      guard composerReady else { return }
      _ = try await view.evaluateJavaScript(
        "document.querySelector('button[aria-label=\"Hide sidebar\"]')?.click();")
      try await Task.sleep(nanoseconds: 300_000_000)
      let composerWidth =
        try await view.evaluateJavaScript(
          "document.querySelector('textarea').getBoundingClientRect().width") as? Double ?? 0
      XCTAssertGreaterThan(
        composerWidth, 180, "The iPhone composer must remain usable when the sidebar is dismissed")
      _ = try await view.evaluateJavaScript(
        "const field = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'shared UI sent message'); field.dispatchEvent(new Event('input', {bubbles:true}));"
      )
      try await Task.sleep(nanoseconds: 100_000_000)
      _ = try await view.evaluateJavaScript(
        "document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',bubbles:true}));"
      )
      var sent = false
      for _ in 0..<100 {
        let history = try await call("request", ["path": "/api/channels/\(channelID)/messages"])
        if (history["bodyText"] as? String ?? "").contains("shared UI sent message") {
          sent = true
          break
        }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      XCTAssertTrue(sent, "The shared composer must send through the native HTTP bridge")
      _ = try body(
        await call(
          "request",
          [
            "path": "/api/channels/\(channelID)/messages", "method": "POST",
            "bodyText": json(["content": "native WS delivered message"]),
          ]))
      var received = false
      for _ in 0..<100 {
        received =
          ((try? await view.evaluateJavaScript(
            "document.body.innerText.includes('native WS delivered message')")) as? Bool) == true
        if received { break }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      XCTAssertTrue(received, "Native WS events must reach the shared React message list")
      // Drive the notifications observed by the actual Capacitor plugin, not
      // ClientSession.setActive directly. The same DOM node and draft must live
      // through reconnect and a missed-message snapshot refresh.
      _ = try await view.evaluateJavaScript(
        "window.acceptanceComposer = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(window.acceptanceComposer, 'unsent foreground draft'); window.acceptanceComposer.dispatchEvent(new Event('input', {bubbles:true}));"
      )
      try await Task.sleep(nanoseconds: 100_000_000)
      NotificationCenter.default.post(
        name: UIApplication.didEnterBackgroundNotification, object: nil)
      try await Task.sleep(nanoseconds: 200_000_000)
      _ = try body(
        await call(
          "request",
          [
            "path": "/api/channels/\(channelID)/messages", "method": "POST",
            "bodyText": json(["content": "message during suspension"]),
          ]))
      NotificationCenter.default.post(
        name: UIApplication.willEnterForegroundNotification, object: nil)
      var resumed = false
      for _ in 0..<100 {
        resumed =
          (try? await view.evaluateJavaScript(
            "document.body.innerText.includes('message during suspension')")) as? Bool == true
        if resumed { break }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      XCTAssertTrue(resumed, "Foreground notification must refresh the mounted message list")
      // After catch-up, another event must arrive through the resumed socket.
      try await Task.sleep(nanoseconds: 500_000_000)
      _ = try body(
        await call(
          "request",
          [
            "path": "/api/channels/\(channelID)/messages", "method": "POST",
            "bodyText": json(["content": "WS after foreground"]),
          ]))
      var liveAfterResume = false
      for _ in 0..<100 {
        liveAfterResume =
          (try? await view.evaluateJavaScript(
            "document.body.innerText.includes('WS after foreground')")) as? Bool == true
        if liveAfterResume { break }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      XCTAssertTrue(liveAfterResume, "Foreground must also restore live WS delivery")
      let resumedDraft =
        try await view.evaluateJavaScript(
          "document.querySelector('textarea').value") as? String
      let sameComposer =
        try await view.evaluateJavaScript(
          "window.acceptanceComposer === document.querySelector('textarea')") as? Bool
      XCTAssertEqual(resumedDraft, "unsent foreground draft")
      XCTAssertEqual(
        sameComposer, true,
        "Resuming must retain the composer instance and its in-flight send identity")
      let snapshot = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
        view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
      }
      let screenshot = XCTAttachment(image: snapshot)
      screenshot.lifetime = .keepAlways
      add(screenshot)
      _ = try await call("logout")
      _ = try await call("clearProfile")
    }
  #endif

}
