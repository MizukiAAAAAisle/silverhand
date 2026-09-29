import UIKit

/// The system picker owns presentation; this controller owns only its temporary source.
@MainActor
final class AttachmentExportController: UIDocumentPickerViewController, UIDocumentPickerDelegate {
  let sourceURL: URL
  private let temporaryDirectory: URL
  private var completion: ((Bool) -> Void)?

  init(bytes: Data, filename: String, completion: @escaping (Bool) -> Void) throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("silverhand-export-\(UUID().uuidString)", isDirectory: true)
    // A server filename is a display name, never a path into the app sandbox.
    let name = filename.replacingOccurrences(of: "\\", with: "/")
      .components(separatedBy: "/").last ?? ""
    let safeName = name.isEmpty || name == "." || name == ".." ? "attachment" : name
    let source = directory.appendingPathComponent(safeName)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
      try bytes.write(to: source, options: [.atomic, .completeFileProtection])
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
    temporaryDirectory = directory
    sourceURL = source
    self.completion = completion
    super.init(forExporting: [source], asCopy: true)
    delegate = self
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    finish(completed: !urls.isEmpty)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(completed: false)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    // Programmatic dismissal (e.g. session invalidation) doesn't call the picker delegate.
    if presentingViewController == nil { finish(completed: false) }
  }

  private func finish(completed: Bool) {
    guard let callback = completion else { return }
    completion = nil
    try? FileManager.default.removeItem(at: temporaryDirectory)
    callback(completed)
  }

  deinit { try? FileManager.default.removeItem(at: temporaryDirectory) }
}
