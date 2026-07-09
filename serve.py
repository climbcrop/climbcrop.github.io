"""ClimbCrop local dev server.

Windows registry sometimes maps .js to text/plain, which makes Python's default
http.server break ES module loading (strict MIME checking). This server forces
the correct types regardless of OS configuration.

Usage:  python serve.py [port]   (default 8787)
"""
import http.server
import socketserver
import sys

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.md': 'text/markdown; charset=utf-8',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        for ext, mime in MIME.items():
            if path.lower().endswith(ext):
                return mime
        return super().guess_type(path)

    # Dev server: never allow conditional requests or caching, so stale entries
    # (e.g. .js cached as text/plain by an earlier server) can't survive.
    def parse_request(self):
        ok = super().parse_request()
        if ok:
            for h in ('If-Modified-Since', 'If-None-Match'):
                try:
                    del self.headers[h]
                except KeyError:
                    pass
        return ok

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class Server(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    with Server(('', port), Handler) as httpd:
        print(f'ClimbCrop dev server → http://localhost:{port}')
        httpd.serve_forever()
