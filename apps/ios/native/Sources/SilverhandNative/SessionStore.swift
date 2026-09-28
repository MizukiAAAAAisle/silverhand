import Foundation
import Security

public struct SessionRecord: Codable, Equatable {
  public var serverURL: String
  public var updatedAt: Double
  public var token: String?

  public init(serverURL: String, updatedAt: Double, token: String? = nil) {
    self.serverURL = serverURL
    self.updatedAt = updatedAt
    self.token = token
  }
}

public protocol SessionStore {
  func read() throws -> SessionRecord?
  func write(_ record: SessionRecord?) throws
}

public struct KeychainSessionStore: SessionStore {
  private let service: String
  public init(service: String = "com.silverhand.ios.session") { self.service = service }

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "active-session",
    ]
  }

  public func read() throws -> SessionRecord? {
    var query = query
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else {
      throw ClientError.storage(status)
    }
    return try JSONDecoder().decode(SessionRecord.self, from: data)
  }

  public func write(_ record: SessionRecord?) throws {
    guard let record else {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw ClientError.storage(status)
      }
      return
    }
    let data = try JSONEncoder().encode(record)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let inserted = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
      guard inserted == errSecSuccess else { throw ClientError.storage(inserted) }
    } else if status != errSecSuccess {
      throw ClientError.storage(status)
    }
  }
}

public enum ClientError: Error, LocalizedError {
  case invalidURL, invalidPath, noServer, unauthorized, staleSession, invalidResponse
  case storage(OSStatus)
  case suspended
  public var errorDescription: String? {
    switch self {
    case .invalidURL: return "Enter an HTTPS server origin without a path, query or credentials."
    case .invalidPath: return "Only API requests to the selected server are allowed."
    case .noServer: return "Select a server first."
    case .unauthorized: return "Sign in to continue."
    case .staleSession: return "The session changed. Retry in the current session."
    case .invalidResponse: return "The server returned an invalid response."
    case .storage: return "Secure session storage is unavailable. No server change was committed."
    case .suspended: return "The app is in the background."
    }
  }
}
