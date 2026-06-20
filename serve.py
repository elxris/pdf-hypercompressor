#!/usr/bin/env python3
"""Minimal static server for the browser prototype.

Sets COOP/COEP so SharedArrayBuffer is available (lets Tesseract use threads),
and disables caching so edits show up immediately.

    python3 serve.py        # -> http://localhost:8000
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Serving prototype at http://localhost:{PORT}  (Ctrl-C to stop)")
    httpd.serve_forever()
