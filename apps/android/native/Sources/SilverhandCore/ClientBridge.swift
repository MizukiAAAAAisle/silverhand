import Foundation
import SkipFuse
import SilverhandNative

public protocol PlatformStorage {
    func readRecord() throws -> String?
    func writeRecord(value: String?) throws
}
private final class StorageAdapter: SessionStore {
    let storage: PlatformStorage
    init(_ storage: PlatformStorage) { self.storage = storage }
    func read() throws -> SessionRecord? {
        guard let text = try storage.readRecord() else { return nil }
        return try JSONDecoder().decode(SessionRecord.self, from: Data(text.utf8))
    }
    func write(_ record: SessionRecord?) throws {
        try storage.writeRecord(value: record.map { String(decoding: try JSONEncoder().encode($0), as: UTF8.self) })
    }
}

/// Only JSON and explicit task IDs cross JNI. Upstream business types stay inside Swift.
@MainActor public final class ClientBridge {
    private let session: ClientSession
    private var tasks: [String: Task<Void, Never>] = [:]
    public init(storage: PlatformStorage) throws { session = try ClientSession(store: StorageAdapter(storage)) }
    public func listen(callback: @escaping (String, String) -> Void) {
        session.onSocket = { value in if let text = try? self.json(value) { callback("socket", text) } }
        session.onInvalidated = { callback("sessionInvalidated", "{}") }
    }
    public func active(value: Bool) { session.setActive(value) }
    public func cancel(id: String) { tasks[id]?.cancel() }
    public func shutdown() {
        session.onSocket = nil
        session.onInvalidated = nil
        session.setActive(false)
        for task in tasks.values { task.cancel() }
    }
    public func start(id: String, method: String, payload: String, completion: @escaping (String) -> Void) {
        guard tasks[id] == nil else { return }
        tasks[id] = Task {
            defer { tasks[id] = nil }
            do {
                let args = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] ?? [:]
                let value = try await execute(method, args)
                try Task.checkCancellation()
                completion(try json(["ok": true, "value": value]))
            } catch {
                if !Task.isCancelled { completion((try? json(["ok": false, "error": error.localizedDescription])) ?? "{}") }
            }
        }
    }
    private func execute(_ method: String, _ a: [String: Any]) async throws -> [String: Any] {
        func text(_ key: String, _ fallback: String = "") -> String { a[key] as? String ?? fallback }
        switch method {
        case "getProfile": return try session.profile()
        case "saveProfile": return try await session.saveProfile(text("serverUrl"))
        case "clearProfile": return ["cleared": try session.clearProfile()]
        case "authState": return try await session.authState()
        case "authenticate": return try await session.authenticate(action: text("action"), body: text("body", "{}"))
        case "logout": try await session.logout(); return [:]
        case "request": return try await session.proxy(path: text("path"), method: text("method", "GET"), body: a["bodyText"] as? String, headers: a["headers"] as? [String: String] ?? [:], binary: text("responseType") == "arrayBuffer")
        case "upload":
            let fields: [(name: String, value: String)] = try (a["fields"] as? [[String: Any]] ?? []).map {
                guard let name = $0["name"] as? String, let value = $0["value"] as? String else { throw ClientError.invalidResponse }
                return (name, value)
            }
            let files: [ClientSession.UploadFile] = try (a["files"] as? [[String: Any]] ?? []).map {
                guard let field = $0["fieldName"] as? String, let name = $0["filename"] as? String,
                      let encoded = $0["base64"] as? String, let data = Data(base64Encoded: encoded) else { throw ClientError.invalidResponse }
                return ClientSession.UploadFile(fieldName: field, filename: name, contentType: $0["contentType"] as? String ?? "application/octet-stream", data: data)
            }
            return try await session.upload(path: text("path"), fields: fields, files: files)
        case "openSocket": try session.openSocket(id: text("id"), url: text("url")); return [:]
        case "sendSocket": try await session.sendSocket(id: text("id"), data: text("data")); return [:]
        case "closeSocket": session.closeSocket(id: text("id")); return [:]
        default: throw ClientError.invalidPath
        }
    }
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
}
