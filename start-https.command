#!/bin/bash
# Storyboarder iPad — HTTPS 模式（需要“添加到主屏幕”离线缓存 + 分享面板导出时用）
cd "$(dirname "$0")" || exit 1
PORT="${1:-8443}"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -z "$IP" ] && IP="127.0.0.1"
mkdir -p .cert
if [ ! -f .cert/key.pem ]; then
  echo "生成自签名证书…"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -keyout .cert/key.pem -out .cert/cert.pem \
    -subj "/CN=storyboarder.local" \
    -addext "subjectAltName=IP:$IP,DNS:localhost" >/dev/null 2>&1
fi
echo ""
echo "  Storyboarder iPad (HTTPS)"
echo "  iPad Safari 打开： https://$IP:$PORT"
echo "  证书警告 → 显示详细信息 → 继续访问"
echo "  停止：Ctrl+C"
echo ""
exec python3 - "$PORT" <<'PY'
import http.server, ssl, sys, os
port = int(sys.argv[1])
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        super().end_headers()
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('0.0.0.0', port), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('.cert/cert.pem', '.cert/key.pem')
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(f"  https://0.0.0.0:{port}/")
srv.serve_forever()
PY
