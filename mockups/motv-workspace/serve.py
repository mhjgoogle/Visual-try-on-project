#!/usr/bin/env python3
"""Cross-platform static file server for motv-workspace DEMO mode (ADR-0049).

`python -m http.server` derives MIME types from the OS. On native Windows it
reads the registry, where `.js`/`.mjs` are frequently `text/plain`, and a
browser REFUSES to execute an ES module served with a non-JS MIME — so demo
mode silently fails to boot. This server sends explicit, correct types for the
handful of extensions the prototype uses, identically on every platform.

Usage (from anywhere):
    python serve.py [--port 8000] [--host 127.0.0.1]
then open http://127.0.0.1:8000/ (top bar shows "⚪ 演示模式").

This is the DEMO (backend-less) launcher. For the connected/paid backend use
`server.py` instead (it already serves files with explicit MIME).
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".woff2": "font/woff2",
}


class _Handler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with an explicit, platform-independent MIME map."""

    def guess_type(self, path):  # noqa: N802 - stdlib signature
        ext = Path(str(path)).suffix.lower()
        return _MIME.get(ext, "application/octet-stream")


def main() -> None:
    ap = argparse.ArgumentParser(description="motv-workspace demo static server")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    root = Path(__file__).resolve().parent
    handler = partial(_Handler, directory=str(root))
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"motv demo (⚪ 演示模式) → http://{args.host}:{args.port}/  (Ctrl+C 退出)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
