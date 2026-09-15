import Foundation
import Combine

/// Ficheiros deixados pela extensão de partilha no contentor do App Group (pasta Inbox).
struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL
    var name: String { url.lastPathComponent.replacingOccurrences(of: #"^\d+-"#, with: "", options: .regularExpression) }
    var mimeType: String {
        switch url.pathExtension.lowercased() {
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "heic", "heif": return "image/heic"
        case "webp": return "image/webp"
        default: return "image/jpeg"
        }
    }
}

final class SharedInbox: ObservableObject {
    @Published private(set) var pending: [SharedFile] = []

    static var inboxURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppConfig.appGroup)?.appendingPathComponent("Inbox", isDirectory: true)
    }

    init() { refresh() }

    func refresh() {
        guard let dir = SharedInbox.inboxURL,
              let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey]) else {
            pending = []; return
        }
        pending = items
            .filter { !$0.lastPathComponent.hasPrefix(".") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map(SharedFile.init(url:))
    }

    /// Devolve os ficheiros pendentes (como base64 para injectar na web app) e apaga-os do contentor.
    func consume() -> [(name: String, type: String, base64: String)] {
        let out = pending.compactMap { f -> (String, String, String)? in
            guard let data = try? Data(contentsOf: f.url) else { return nil }
            return (f.name, f.mimeType, data.base64EncodedString())
        }
        pending.forEach { try? FileManager.default.removeItem(at: $0.url) }
        pending = []
        return out.map { (name: $0.0, type: $0.1, base64: $0.2) }
    }
}
