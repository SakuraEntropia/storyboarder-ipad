import SwiftUI
import WebKit

@main
struct StoryboarderApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WebHost(model: model)
                .ignoresSafeArea()
                .persistentSystemOverlays(.hidden)
                .preferredColorScheme(.dark)
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active { model.flush() }
                }
        }
    }
}

struct WebHost: UIViewRepresentable {
    @ObservedObject var model: AppModel

    func makeUIView(context: Context) -> WKWebView {
        model.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
