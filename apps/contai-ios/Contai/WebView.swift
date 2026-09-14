import SwiftUI
import WebKit
import Combine

/// WKWebView com a web app. A câmara e a galeria funcionam através do <input type="file"> da própria página.
struct WebView: UIViewRepresentable {
    let url: URL
    @ObservedObject var inbox: SharedInbox

    func makeCoordinator() -> Coordinator { Coordinator(inbox: inbox) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.websiteDataStore = .default()          // guarda a sessão (localStorage) entre arranques
        // Marca a página como app nativa: esconde o botão "Instalar" e activa a recepção de partilhas.
        let marker = WKUserScript(source: "window.__contaiNative = { platform: 'ios' };", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(marker)

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.backgroundColor = UIColor(red: 0.97, green: 0.96, blue: 0.94, alpha: 1)
        web.isOpaque = false
        web.load(URLRequest(url: url))
        context.coordinator.webView = web
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.deliverPendingIfPossible()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        let inbox: SharedInbox
        private var loaded = false
        private var cancellable: AnyCancellable?

        init(inbox: SharedInbox) {
            self.inbox = inbox
            super.init()
            cancellable = inbox.$pending.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.deliverPendingIfPossible() }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            deliverPendingIfPossible()
        }

        /// Ligações externas (sites da AT, do Banco de Portugal, etc.) abrem no Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url, action.navigationType == .linkActivated,
                  let appHost = webView.url?.host, let host = target.host, host != appHost else {
                decisionHandler(.allow); return
            }
            UIApplication.shared.open(target)
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { webView.load(URLRequest(url: url)) }   // target=_blank fica na app
            return nil
        }

        /// Entrega os ficheiros partilhados à página: window.__contaiShared + navegação para #digitalizar.
        func deliverPendingIfPossible() {
            guard loaded, let web = webView, !inbox.pending.isEmpty else { return }
            let files = inbox.consume()
            guard !files.isEmpty,
                  let json = try? JSONSerialization.data(withJSONObject: files.map { ["name": $0.name, "type": $0.type, "base64": $0.base64] }),
                  let payload = String(data: json, encoding: .utf8) else { return }
            let js = "window.__contaiShared = \(payload); location.hash = '#digitalizar?t=' + Date.now();"
            web.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
