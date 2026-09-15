import UIKit
import UniformTypeIdentifiers

/// Extensão "Enviar ao Cont.ai": copia imagens e PDFs partilhados para o App Group; a app principal envia-os ao abrir.
final class ShareViewController: UIViewController {
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.97, green: 0.96, blue: 0.94, alpha: 1)
        label.text = "A guardar para o Cont.ai..."
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .body)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            view.trailingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 24),
        ])
        Task { await saveAll() }
    }

    private func saveAll() async {
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.pt.lumarcont.contai")?.appendingPathComponent("Inbox", isDirectory: true) else {
            finish("Não foi possível aceder ao Cont.ai."); return
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var saved = 0
        let stamp = Int(Date().timeIntervalSince1970)
        for item in items {
            for provider in item.attachments ?? [] {
                for type in [UTType.pdf, UTType.image] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
                    if let url = await loadFile(provider, type: type) {
                        let ext = url.pathExtension.isEmpty ? (type == .pdf ? "pdf" : "jpg") : url.pathExtension
                        let name = url.lastPathComponent.isEmpty ? "documento.\(ext)" : url.lastPathComponent
                        let dest = dir.appendingPathComponent("\(stamp)\(saved)-\(name)")
                        try? FileManager.default.removeItem(at: dest)
                        if (try? FileManager.default.copyItem(at: url, to: dest)) != nil { saved += 1 }
                    }
                    break
                }
            }
        }
        finish(saved > 0
            ? "\(saved) ficheiro(s) guardado(s). Abra o Cont.ai para os enviar ao gabinete."
            : "Nenhuma imagem ou PDF reconhecido.")
    }

    private func loadFile(_ provider: NSItemProvider, type: UTType) async -> URL? {
        await withCheckedContinuation { cont in
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                // O URL é temporário: copiar já para um sítio nosso antes de devolver.
                guard let url else { cont.resume(returning: nil); return }
                let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                try? FileManager.default.copyItem(at: url, to: tmp)
                cont.resume(returning: FileManager.default.fileExists(atPath: tmp.path) ? tmp : nil)
            }
        }
    }

    private func finish(_ message: String) {
        DispatchQueue.main.async {
            self.label.text = message
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        }
    }
}
