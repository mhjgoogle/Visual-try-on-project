"""Loopback HTTP transport for the read-only workspace shell (TASK-026).

A stdlib ``ThreadingHTTPServer`` bound to loopback wraps :class:`WorkspaceApp`.
The transport only adds network posture — it holds no core state, so stopping
it never affects the file-based core (ADR-0032 invariant 6):

- binds ``127.0.0.1`` only (never a routable interface);
- serves GET/HEAD only — POST/PUT/PATCH/DELETE get ``405`` because there is
  no write endpoint to reach (ADR-0032 invariant 2);
- validates the ``Host`` header is loopback (anti DNS-rebinding);
- sends a strict same-origin CSP, ``nosniff`` and ``no-store`` on every
  response (on-demand, no persistent cache; browser carries zero credentials).
"""

from __future__ import annotations

import argparse
import socket
from collections.abc import Callable
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from workspace_shell.app import Response, WorkspaceApp

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", ""}
# Origin CSRF check: ONLY explicit loopback hostnames are same-origin. Unlike
# the Host guard, an empty/opaque origin ("" or "null" from a sandboxed / data:
# page) is NOT allowed to write — it is a cross-site/opaque caller.
_LOOPBACK_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "::1"}
_MAX_BODY_BYTES = 1_000_000  # a command envelope is small; cap unbounded reads

# Strict, self-only posture. The page loads only its own assets; no external
# origin, no inline script, no framing, no form submission target.
_SECURITY_HEADERS: tuple[tuple[str, str], ...] = (
    (
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self'; "
        "script-src 'self'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'",
    ),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
    # A cross-origin page must not be able to embed loopback responses
    # (e.g. include a project .js artifact as a classic <script>).
    ("Cross-Origin-Resource-Policy", "same-origin"),
)


def _host_is_loopback(host_header: str | None) -> bool:
    """True when the Host header names a loopback address (or is absent)."""
    if not host_header:
        return True
    host = host_header.strip()
    if host.startswith("["):  # IPv6 literal: "[::1]" or "[::1]:port"
        host = host[1:].split("]", 1)[0]
    elif host.count(":") == 1:  # "host:port" (a bare "::1" has two colons)
        host = host.rsplit(":", 1)[0]
    return host.lower() in _LOOPBACK_HOSTS


class _Handler(BaseHTTPRequestHandler):
    server_version = "workspace-shell"
    protocol_version = "HTTP/1.1"

    @property
    def _app(self) -> WorkspaceApp:
        return self.server.app  # type: ignore[attr-defined]

    def _guard_host(self) -> bool:
        if _host_is_loopback(self.headers.get("Host")):
            return True
        self._write(
            Response(
                403, b'{"error":{"category":"forbidden","detail":"non-loopback host"}}'
            )
        )
        return False

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self._guard_host():
            return
        self._write(self._app.handle(self.path))

    def do_HEAD(self) -> None:  # noqa: N802
        if not self._guard_host():
            return
        self._write(self._app.handle(self.path), body=False)

    def _reject_write(self) -> None:
        # No write endpoint exists; every mutating verb is refused outright.
        # The declared request body is never read, so the connection must be
        # closed after the 405 — otherwise HTTP/1.1 keep-alive would parse
        # the leftover body bytes as the start of the next request.
        self.close_connection = True
        self._write(
            Response(
                405,
                b'{"error":{"category":"method_not_allowed",'
                b'"detail":"read-only workspace; no write endpoints"}}',
                headers=(("Connection", "close"),),
            )
        )

    def _guard_origin(self) -> bool:
        """Reject a cross-origin write (CSRF). A browser sends ``Origin`` on a
        cross-site POST; it must match the server's OWN origin — scheme + host +
        PORT, not just a loopback host (so another local app on a different port,
        or an https page, cannot drive commands). A missing Origin is a
        same-origin/non-browser (local, trusted) caller. Combined with the
        strict same-origin CSP and loopback bind, this closes local cross-site
        command execution."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        o = urlsplit(origin)
        host_hdr = urlsplit("//" + (self.headers.get("Host") or ""))
        try:
            # .port raises ValueError on a non-numeric port; a malformed Origin
            # or Host is never same-origin -> fall through to the 403.
            same_origin = (
                o.scheme == "http"
                and (o.hostname or "").lower() in _LOOPBACK_ORIGIN_HOSTS
                and (o.hostname or "").lower() == (host_hdr.hostname or "").lower()
                and o.port == host_hdr.port
            )
        except ValueError:
            same_origin = False
        if same_origin:
            return True
        self.close_connection = True
        self._write(
            Response(
                403,
                b'{"error":{"category":"forbidden",'
                b'"detail":"cross-origin write refused"}}',
                headers=(("Connection", "close"),),
            )
        )
        return False

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        # The only mutating verb the shell accepts: a Gateway-routed write
        # command (TASK-031). Every write still flows through the Command
        # Gateway inside WorkspaceApp — the shell never touches a Provider or
        # a business file. The body is fully read so keep-alive stays in sync.
        if not self._guard_host() or not self._guard_origin():
            return
        # A chunked body has no Content-Length; this handler reads a fixed
        # Content-Length only, so accepting it would leave unread chunk bytes on
        # the socket and desync keep-alive. Refuse it and close the connection.
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._write(
                Response(
                    411,
                    b'{"error":{"category":"length_required",'
                    b'"detail":"Content-Length required"}}',
                    headers=(("Connection", "close"),),
                )
            )
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > _MAX_BODY_BYTES:
            self.close_connection = True
            self._write(
                Response(
                    413,
                    b'{"error":{"category":"too_large",'
                    b'"detail":"request body too large"}}',
                    headers=(("Connection", "close"),),
                )
            )
            return
        body = self.rfile.read(length) if length else b""
        self._write(self._app.handle_write(self.path, body))

    do_PUT = _reject_write  # noqa: N815
    do_PATCH = _reject_write  # noqa: N815
    do_DELETE = _reject_write  # noqa: N815

    def _write(self, resp: Response, *, body: bool = True) -> None:
        # The router-opened stream must be closed on EVERY exit — including a
        # client disconnect while headers are still being sent — or repeated
        # aborted artifact requests leak file descriptors.
        try:
            length = resp.stream_size if resp.stream is not None else len(resp.body)
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.content_type)
            self.send_header("Content-Length", str(length))
            for name, value in _SECURITY_HEADERS:
                self.send_header(name, value)
            for name, value in resp.headers:
                self.send_header(name, value)
            self.end_headers()
            if not body or self.command == "HEAD":
                return
            if resp.stream is None:
                self.wfile.write(resp.body)
                return
            # Stream the router-opened (and containment-verified) file body
            # in chunks — an artifact (e.g. video) is never loaded into
            # memory whole. Sends at most Content-Length bytes; on a short
            # read (file changed mid-stream) the connection is closed so the
            # client sees a truncated transfer, not a desynced next response.
            remaining = resp.stream_size
            try:
                while remaining > 0:
                    chunk = resp.stream.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except OSError:
                pass
            if remaining:
                self.close_connection = True
        finally:
            if resp.stream is not None:
                resp.stream.close()

    def log_message(self, *args: object) -> None:  # silence default stderr logs
        pass


def build_server(
    account_root: Path,
    *,
    host: str = "127.0.0.1",
    port: int = 8760,
    clock: Callable[[], datetime] | None = None,
) -> ThreadingHTTPServer:
    """Build (but do not start) a loopback server for ``account_root``.

    The bind address is validated here, not only in the CLI: the Host-header
    guard accepts ``Host: localhost``, so a programmatic caller binding a
    routable interface (e.g. ``0.0.0.0``) would expose project data remotely.
    """
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(
            "workspace shell binds loopback only (127.0.0.1 / localhost / ::1); "
            f"refusing host {host!r}"
        )
    # ThreadingHTTPServer defaults to an IPv4 socket; the IPv6 loopback needs
    # AF_INET6 or binding "::1" fails at startup.
    server_cls = ThreadingHTTPServer
    if host == "::1":

        class _V6Server(ThreadingHTTPServer):
            address_family = socket.AF_INET6

        server_cls = _V6Server
    server = server_cls((host, port), _Handler)
    server.app = WorkspaceApp(account_root, clock=clock)  # type: ignore[attr-defined]
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="workspace-shell",
        description="Read-only cross-project Creation Workspace shell (WSM1-B).",
    )
    parser.add_argument(
        "--account-root",
        type=Path,
        required=True,
        help="Account root whose immediate subdirectories are projects.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Loopback host to bind.")
    parser.add_argument("--port", type=int, default=8760, help="Port (0 = ephemeral).")
    args = parser.parse_args(argv)

    if args.host not in _LOOPBACK_HOSTS or args.host == "":
        parser.error("--host must be a loopback address (127.0.0.1 / localhost / ::1)")

    server = build_server(args.account_root, host=args.host, port=args.port)
    bound_host, bound_port = server.server_address[0], server.server_address[1]
    print(f"Workspace read-only shell: http://{bound_host}:{bound_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
