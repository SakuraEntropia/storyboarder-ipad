import UIKit
import WebKit

final class AppModel: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate {

    let webView: WKWebView
    private var server: LocalHTTPServer?
    private lazy var backupURL: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("Storyboarder-Project.json")
    }()

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.isElementFullscreenEnabled = true

        let controller = WKUserContentController()
        configuration.userContentController = controller

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        controller.add(self, name: "share")
        controller.add(self, name: "backup")
        controller.add(self, name: "wake")
        controller.add(self, name: "video")

        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.2, green: 0.2, blue: 0.2, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        injectNativeProject()
        startLocalServer()
    }

    // MARK: - Server

    private func startLocalServer() {
        guard let www = Bundle.main.url(forResource: "www", withExtension: nil) else { return }
        let server = LocalHTTPServer(root: www, preferredPort: 8734)
        server.onReady = { [weak self] port in
            DispatchQueue.main.async {
                guard let self, let url = URL(string: "http://localhost:\(port)/index.html") else { return }
                self.webView.load(URLRequest(url: url))
            }
        }
        server.start()
        self.server = server
    }

    // MARK: - Persistence mirror (Files app / iCloud backup)

    private func injectNativeProject() {
        guard let data = try? Data(contentsOf: backupURL),
              let json = String(data: data, encoding: .utf8), !json.isEmpty else { return }
        let source = "window.__nativeProject = \(json);"
        let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        webView.configuration.userContentController.addUserScript(script)
    }

    private func writeBackup(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        let url = backupURL
        DispatchQueue.global(qos: .utility).async {
            try? data.write(to: url, options: .atomic)
        }
    }

    func flush() {
        webView.evaluateJavaScript("window.__sbSaveNow && window.__sbSaveNow()") { _, _ in }
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "share":
            presentShare(message.body)
        case "backup":
            if let json = message.body as? String { writeBackup(json) }
        case "wake":
            if let on = message.body as? Bool { setAwake(on) }
        case "video":
            handleVideo(message.body)
        default:
            break
        }
    }

    // MARK: - Video export

    private var videoName = "Storyboarder.mp4"
    private var videoFPS: Int32 = 30
    private var videoDurations: [Int] = []
    private var videoFrames: [Int: Data] = [:]

    private func handleVideo(_ body: Any) {
        guard let dict = body as? [String: Any], let cmd = dict["cmd"] as? String else { return }
        switch cmd {
        case "begin":
            videoName = (dict["name"] as? String) ?? "Storyboarder.mp4"
            videoFPS = Int32((dict["fps"] as? Int) ?? 30)
            videoDurations = (dict["durations"] as? [Int]) ?? []
            videoFrames = [:]
        case "frame":
            if let index = dict["i"] as? Int,
               let base64 = dict["b64"] as? String,
               let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) {
                videoFrames[index] = data
            }
        case "end":
            finishVideo()
        default:
            break
        }
    }

    private func finishVideo() {
        let count = videoDurations.count
        guard count > 0 else { notifyVideo(false); return }
        var frames: [Data] = []
        frames.reserveCapacity(count)
        for index in 0..<count {
            guard let data = videoFrames[index] else { notifyVideo(false); return }
            frames.append(data)
        }
        videoFrames = [:]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(videoName)
        try? FileManager.default.removeItem(at: url)
        VideoExport.write(jpegFrames: frames, durationsMs: videoDurations, fps: videoFPS, to: url) { [weak self] ok in
            DispatchQueue.main.async {
                guard let self else { return }
                self.notifyVideo(ok)
                if ok { self.presentShare(fileURL: url) }
            }
        }
    }

    private func notifyVideo(_ ok: Bool) {
        webView.evaluateJavaScript("window.__sbVideoDone && window.__sbVideoDone(\(ok ? "true" : "false"))") { _, _ in }
    }

    // MARK: - Share sheet

    private func presentShare(fileURL: URL) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.topViewController() else { return }
            self.presentActivity(items: [fileURL], from: presenter)
        }
    }

    private func presentActivity(items: [Any], from presenter: UIViewController) {
        let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = webView
            popover.sourceRect = CGRect(x: webView.bounds.midX, y: 60, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        presenter.present(activity, animated: true)
    }

    private func presentShare(_ body: Any) {
        guard let dict = body as? [String: Any],
              let base64 = dict["base64"] as? String,
              let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              !data.isEmpty else { return }

        let rawName = (dict["name"] as? String) ?? "Storyboarder-export"
        let safeName = rawName.replacingOccurrences(of: "/", with: "_")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.topViewController() else { return }
            self.presentActivity(items: [url], from: presenter)
        }
    }

    private func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow }) ?? scenes.first?.windows.first
        var controller = window?.rootViewController
        while let presented = controller?.presentedViewController {
            controller = presented
        }
        return controller
    }

    private func setAwake(_ on: Bool) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
        }
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Fallback: some networks/ATS configs prefer the raw loopback IP.
        if let url = webView.url, url.host == "localhost",
           let port = url.port,
           let fallback = URL(string: "http://127.0.0.1:\(port)/index.html") {
            webView.load(URLRequest(url: fallback))
        }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url {
            if url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost") {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }
}
