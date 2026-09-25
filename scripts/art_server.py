#!/usr/bin/env python3
"""Static server for render_menu_art.html plus a POST /save sink.

The renderer page produces the menu background in a canvas; there is no way for
a file:// page to write it back to the repo, so it POSTs the base64 JPEG here
and this writes assets/menu_bg.jpg. Run it, open /scripts/render_menu_art.html.
"""
import base64
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'menu_bg.jpg')
MAX_BYTES = 8 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_POST(self):
        if self.path != '/save':
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BYTES:
            self.send_error(413)
            return
        body = self.rfile.read(length).decode('ascii', 'ignore')
        if ',' in body:                      # tolerate a full data: URI
            body = body.split(',', 1)[1]
        try:
            raw = base64.b64decode(body)
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        if not raw.startswith(b'\xff\xd8'):  # JPEG SOI
            self.send_error(400, 'not a JPEG')
            return
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, 'wb') as fh:
            fh.write(raw)
        msg = ('wrote %s (%d bytes)' % (OUT, len(raw))).encode()
        sys.stderr.write(msg.decode() + '\n')
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print('serving %s on http://localhost:%d' % (ROOT, port))
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
