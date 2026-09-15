import SwiftUI

/// Cont.ai by Lumarcont para iOS: abre a web app em ecrã inteiro e recebe ficheiros da extensão de partilha.
@main
struct ContaiApp: App {
    @StateObject private var inbox = SharedInbox()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(inbox)
                .onOpenURL { _ in inbox.refresh() }          // contai://digitalizar
                .onChange(of: scenePhase) { phase in
                    if phase == .active { inbox.refresh() }  // ficheiros guardados pela extensão enquanto a app estava fechada
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var inbox: SharedInbox

    var body: some View {
        WebView(url: AppConfig.appURL, inbox: inbox)
            .ignoresSafeArea(edges: .bottom)
            .background(Color(red: 0.97, green: 0.96, blue: 0.94))
    }
}

enum AppConfig {
    /// Endereço da web app (Info.plist > ContaiAppURL). Sem domínio definido usa o IP de testes.
    static var appURL: URL {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "ContaiAppURL") as? String) ?? "http://159.69.51.149"
        return URL(string: raw) ?? URL(string: "http://159.69.51.149")!
    }
    static let appGroup = "group.pt.lumarcont.contai"
}
