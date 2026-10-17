#!/bin/bash
# Storyboarder iPad — 本地服务器（局域网）
cd "$(dirname "$0")" || exit 1
PORT="${1:-8899}"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -z "$IP" ] && IP="127.0.0.1"
echo ""
echo "  Storyboarder 已启动"
echo "  ----------------------------------------"
echo "  iPad（同一 Wi-Fi）Safari 打开："
echo "      http://$IP:$PORT"
echo ""
echo "  iPad：分享按钮 → 添加到主屏幕 → 添加"
echo "  停止：Ctrl+C"
echo "  ----------------------------------------"
echo ""
exec python3 - "$PORT" <<'PY'
import http.server, socketserver, sys, os
port = int(sys.argv[1]); os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        super().end_headers()
    def log_message(self, *a): pass
socketserver.ThreadingTCPServer.daemon_threads = True
srv = http.server.ThreadingHTTPServer(('0.0.0.0', port), H)
print(f"  http://0.0.0.0:{port}/")
srv.serve_forever()
PY
