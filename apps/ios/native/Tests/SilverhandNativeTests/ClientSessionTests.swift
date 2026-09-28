import XCTest

@testable import SilverhandNative

private final class MemoryStore: SessionStore {
  var value: SessionRecord?
  var failWrites = false
  init(_ record: SessionRecord? = nil) { value = record }
  func read() throws -> SessionRecord? { value }
  func write(_ record: SessionRecord?) throws {
    if failWrites { throw ClientError.storage(-1) }
    value = record
  }
}

@MainActor
final class ClientSessionTests: XCTestCase {
  private let initial = SessionRecord(
    serverURL: "https://a.example", updatedAt: 1, token: "A-secret")
  private func response(_ status: Int = 200, _ json: String = "{}") -> HTTPResult {
    HTTPResult(status: status, data: Data(json.utf8))
  }
  private var info: HTTPResult {
    response(
      200, #"{"signup_enabled":true,"desktop_api":{"current_epoch":4,"minimum_client_epoch":4}}"#)
  }

  func testOriginsAreHTTPSOnlyAndCanonical() throws {
    XCTAssertEqual(try ClientSession.origin("https://Example.com:443/"), "https://example.com")
    for url in [
      "http://localhost", "http://server.example", "https://user:pw@server.example",
      "https://server.example/api", "https://server.example?x=1", "https://server.example#fragment",
      "file:///tmp",
    ] {
      XCTAssertThrowsError(try ClientSession.origin(url), url)
    }
  }

  func testSwitchClearsBearerAndPersistsOneOriginBoundRecord() async throws {
    let store = MemoryStore(initial)
    let client = try ClientSession(store: store, fetch: { _ in self.info })
    _ = try await client.saveProfile("https://b.example")
    XCTAssertEqual(store.value?.serverURL, "https://b.example")
    XCTAssertNil(store.value?.token)
  }

  func testMalformedDiscoveryNeverChangesProfileOrBearer() async throws {
    let malformed = [
      #"{"signup_enabled":true,"desktop_api":"invalid"}"#,
      #"{"signup_enabled":1}"#,
      #"{"signup_enabled":true,"desktop_api":null}"#,
      #"{"signup_enabled":true,"desktop_api":{"current_epoch":true,"minimum_client_epoch":1}}"#,
      #"{"signup_enabled":true,"outbound_protocol_version":-1}"#,
      #"{"signup_enabled":true,"bind_address_scope":"invalid"}"#,
    ]
    for initialRecord in [initial, nil] {
      for json in malformed {
        let store = MemoryStore(initialRecord)
        let client = try ClientSession(store: store, fetch: { _ in self.response(200, json) })
        do {
          _ = try await client.saveProfile("https://b.example")
          XCTFail("Malformed discovery must fail: \(json)")
        } catch {}
        XCTAssertEqual(store.value, initialRecord)
      }
    }
  }

  func testStorageFailureDoesNotCommitNewServer() async throws {
    let store = MemoryStore(initial)
    let client = try ClientSession(store: store, fetch: { _ in self.info })
    store.failWrites = true
    do {
      _ = try await client.saveProfile("https://b.example")
      XCTFail("must reject")
    } catch {}
    XCTAssertEqual(store.value, initial)
    XCTAssertEqual(try client.profile()["server_url"] as? String, initial.serverURL)
  }

  func testDelayedLoginCannotPersistTokenForNewOrigin() async throws {
    let store = MemoryStore(initial)
    var continuation: CheckedContinuation<HTTPResult, Never>?
    let client = try ClientSession(
      store: store,
      fetch: { request in
        if request.url?.path == "/auth/login" {
          return await withCheckedContinuation { continuation = $0 }
        }
        return self.info
      })
    let login = Task { try await client.authenticate(action: "login", body: "{}") }
    while continuation == nil { await Task.yield() }
    _ = try await client.saveProfile("https://b.example")
    continuation?.resume(
      returning: response(200, #"{"user_token":"late-secret","user":{"id":"A"}}"#))
    do {
      _ = try await login.value
      XCTFail("must reject stale login")
    } catch {}
    XCTAssertEqual(store.value?.serverURL, "https://b.example")
    XCTAssertNil(store.value?.token)
  }

  func testLate401DoesNotClearNewSession() async throws {
    let store = MemoryStore(initial)
    var continuation: CheckedContinuation<HTTPResult, Never>?
    let client = try ClientSession(
      store: store,
      fetch: { request in
        if request.url?.path == "/api/messages" {
          return await withCheckedContinuation { continuation = $0 }
        }
        if request.url?.path == "/auth/login" {
          return self.response(200, #"{"user_token":"B-secret","user":{"id":"B"}}"#)
        }
        return self.info
      })
    var invalidated = false
    client.onInvalidated = { invalidated = true }
    let pending = Task { try await client.proxy(path: "/api/messages") }
    while continuation == nil { await Task.yield() }
    _ = try await client.saveProfile("https://b.example")
    _ = try await client.authenticate(action: "login", body: "{}")
    continuation?.resume(returning: response(401))
    do {
      _ = try await pending.value
      XCTFail("must reject stale result")
    } catch {}
    XCTAssertEqual(store.value?.token, "B-secret")
    XCTAssertFalse(invalidated)
  }

  func testAuthenticationOnlyReturnsUserNotBearer() async throws {
    let store = MemoryStore(initial)
    let client = try ClientSession(
      store: store,
      fetch: { _ in
        self.response(
          200, #"{"user_token":"new-secret","user":{"id":"A","user_token":"nested-secret"}}"#)
      })
    let result = try await client.authenticate(action: "login", body: "{}")
    let wire = String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!
    XCTAssertFalse(wire.contains("secret"))
    XCTAssertEqual(store.value?.token, "new-secret")
  }

  func testProxyRestrictsPathsAndReplacesCallerCredentials() async throws {
    let store = MemoryStore(initial)
    var requests: [URLRequest] = []
    let client = try ClientSession(
      store: store,
      fetch: { request in
        requests.append(request)
        return self.response()
      })
    for path in [
      "https://evil.example/api/me", "//evil.example/api/me", "/api/../auth/login",
      "/api/%2e%2e/auth/login", "/auth/login", "/api/\\evil",
    ] {
      do {
        _ = try await client.proxy(path: path)
        XCTFail(path)
      } catch {}
    }
    XCTAssertTrue(requests.isEmpty)
    _ = try await client.proxy(
      path: "/api/me",
      headers: [
        "Authorization": "Bearer injected", "Cookie": "injected", "Origin": "https://evil.example",
      ])
    XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer A-secret")
    XCTAssertNil(requests.last?.value(forHTTPHeaderField: "Cookie"))
    XCTAssertNil(requests.last?.value(forHTTPHeaderField: "Origin"))
  }

  func testPasswordSuccessInvalidatesButFailureKeepsSession() async throws {
    let store = MemoryStore(initial)
    var status = 400
    let client = try ClientSession(store: store, fetch: { _ in self.response(status) })
    var invalidations = 0
    client.onInvalidated = { invalidations += 1 }
    _ = try await client.proxy(path: "/api/me/password", method: "POST", body: "{}")
    XCTAssertEqual(store.value?.token, "A-secret")
    status = 200
    _ = try await client.proxy(path: "/api/me/password", method: "POST", body: "{}")
    XCTAssertNil(store.value?.token)
    XCTAssertEqual(invalidations, 1)
  }

  func testDeletionFailureBlocksFurtherRequests() async throws {
    let store = MemoryStore(initial)
    let client = try ClientSession(store: store, fetch: { _ in self.response(401) })
    store.failWrites = true
    do {
      _ = try await client.proxy(path: "/api/me")
      XCTFail("cleanup must fail")
    } catch {}
    do {
      _ = try await client.proxy(path: "/api/me")
      XCTFail("stale disk token must not rehydrate")
    } catch {}
    XCTAssertThrowsError(try client.profile())
  }

  func testTransientValidationFailurePreservesCredential() async throws {
    let store = MemoryStore(initial)
    let client = try ClientSession(
      store: store,
      fetch: { request in request.url?.path == "/api/server/info" ? self.info : self.response(503) }
    )
    _ = try await client.authState()
    XCTAssertEqual(store.value?.token, "A-secret")
  }

  func testLogoutPinsRemoteRequestToOldServer() async throws {
    let store = MemoryStore(initial)
    var request: URLRequest?
    var continuation: CheckedContinuation<HTTPResult, Never>?
    let client = try ClientSession(
      store: store,
      fetch: { input in
        if input.url?.path == "/auth/logout" {
          request = input
          return await withCheckedContinuation { continuation = $0 }
        }
        return self.info
      })
    let logout = Task { try await client.logout() }
    while continuation == nil { await Task.yield() }
    _ = try await client.saveProfile("https://b.example")
    continuation?.resume(returning: response())
    try await logout.value
    XCTAssertEqual(request?.url?.host, "a.example")
    XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer A-secret")
    XCTAssertNil(store.value?.token)
  }
}
