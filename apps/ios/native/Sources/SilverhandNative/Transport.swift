import Foundation

public struct HTTPResult {
  public let status: Int
  public let headers: [String: String]
  public let data: Data

  public init(status: Int, headers: [String: String] = [:], data: Data) {
    self.status = status
    self.headers = headers
    self.data = data
  }

  public var json: [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
  public func bridge(binary: Bool = false) -> [String: Any] {
    var value: [String: Any] = [
      "status": status, "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
      "headers": headers,
    ]
    if binary {
      value["bodyBase64"] = data.base64EncodedString()
    } else {
      value["bodyText"] = String(data: data, encoding: .utf8) ?? ""
    }
    return value
  }
}

public struct WireContract: Decodable {
  public let desktopApi: Int
  public let desktopMinServer: Int
  public let eventWebSocketPath: String
  public let eventWebSocketSessionCookie: String
  public let desktopApiEpochHeader: String
  public let serverInfo: String
  public let me: String
  public let mePassword: String
  public let login: String
  public let signup: String
  public let logout: String
  public let passwordRecoveryRequest: String
  public let passwordRecoveryReset: String

  public static func bundled() throws -> WireContract {
    guard let url = Bundle.module.url(forResource: "Protocol", withExtension: "json") else {
      throw ClientError.invalidResponse
    }
    return try JSONDecoder().decode(WireContract.self, from: Data(contentsOf: url))
  }
}

/// Native networking keeps cookies, caches and credentials out of WKWebView.
/// Redirects are deliberately refused, including same-origin redirects: an API
/// endpoint is an exact route, not a navigation instruction.
public final class NativeTransport: NSObject, URLSessionTaskDelegate, URLSessionWebSocketDelegate,
  @unchecked Sendable
{
  public var socketOpened: ((URLSessionWebSocketTask) -> Void)?
  public var socketClosed: ((URLSessionWebSocketTask, Int) -> Void)?
  public lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 30
    return URLSession(configuration: config, delegate: self, delegateQueue: .main)
  }()

  public func fetch(_ request: URLRequest) async throws -> HTTPResult {
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
    var headers: [String: String] = [:]
    for (key, value) in response.allHeaderFields {
      if let key = key as? String, key.lowercased() != "set-cookie" {
        headers[key] = String(describing: value)
      }
    }
    return HTTPResult(status: response.statusCode, headers: headers, data: data)
  }

  public func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
  public func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
  ) {
    if let socket = task as? URLSessionWebSocketTask, error != nil { socketClosed?(socket, 1006) }
  }
  public func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) { socketOpened?(webSocketTask) }
  public func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) { socketClosed?(webSocketTask, closeCode.rawValue) }
}
