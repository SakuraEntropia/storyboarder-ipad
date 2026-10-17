import Foundation
import Network

/// Minimal HTTP/1.1 file server bound to a random local port.
/// WKWebView talks to it over http://127.0.0.1:<port>, which is a secure
/// context, so IndexedDB / canvas / fonts behave like a normal website while
/// the whole app stays offline (files are served from the app bundle).
final class LocalHTTPServer {
    private let root: URL
    private let preferredPort: UInt16?
    private let queue = DispatchQueue(label: "com.sakuraentropia.storyboarder.httpserver")
    private var listener: NWListener?
    private var didFallback = false

    var onReady: ((UInt16) -> Void)?

    init(root: URL, preferredPort: UInt16? = nil) {
        self.root = root.standardizedFileURL
        self.preferredPort = preferredPort
    }

    /// A fixed port matters: WKWebView scopes IndexedDB/localStorage by origin,
    /// so the same port keeps the user's projects across launches.
    func start() {
        let port = preferredPort.flatMap { NWEndpoint.Port(rawValue: $0) } ?? .any
        createListener(on: port)
    }

    private func createListener(on port: NWEndpoint.Port) {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        guard let listener = try? NWListener(using: params) else {
            fallbackIfNeeded()
            return
        }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                if let port = listener.port?.rawValue { self.onReady?(port) }
            case .failed:
                self.listener = nil
                self.fallbackIfNeeded()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.handle(connection)
        }
        self.listener = listener
        listener.start(queue: queue)
    }

    private func fallbackIfNeeded() {
        guard preferredPort != nil, !didFallback else { return }
        didFallback = true
        createListener(on: .any)
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        readRequest(connection, buffer: Data())
    }

    private func readRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 128 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            var accumulated = buffer
            if let data, !data.isEmpty { accumulated.append(data) }
            if accumulated.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(connection, request: accumulated)
            } else if error != nil || isComplete || accumulated.count > 256 * 1024 {
                connection.cancel()
            } else {
                self.readRequest(connection, buffer: accumulated)
            }
        }
    }

    private func respond(_ connection: NWConnection, request: Data) {
        guard let head = String(data: request, encoding: .utf8),
              let firstLine = head.components(separatedBy: "\r\n").first else {
            connection.cancel(); return
        }
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else { connection.cancel(); return }
        var path = String(parts[1])
        if let queryStart = path.firstIndex(of: "?") { path = String(path[..<queryStart]) }
        if path.isEmpty || path == "/" { path = "/index.html" }
        guard let decoded = path.removingPercentEncoding else { connection.cancel(); return }
        let relative = decoded.hasPrefix("/") ? String(decoded.dropFirst()) : decoded
        #if DEBUG
        print("[http] GET \(relative)")
        #endif
        let fileURL = root.appendingPathComponent(relative).standardizedFileURL

        guard fileURL.path.hasPrefix(root.path) else {
            send(connection, status: "403 Forbidden", mime: "text/plain", body: Data("Forbidden".utf8))
            return
        }
        if let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) {
            send(connection, status: "200 OK", mime: Self.mimeType(for: fileURL.pathExtension), body: data)
        } else {
            send(connection, status: "404 Not Found", mime: "text/plain", body: Data("Not Found".utf8))
        }
    }

    private func send(_ connection: NWConnection, status: String, mime: String, body: Data) {
        var head = "HTTP/1.1 \(status)\r\n"
        head += "Content-Type: \(mime)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        default: return "application/octet-stream"
        }
    }
}
