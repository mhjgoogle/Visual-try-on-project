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
import sys
import threading
import time
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
#: Per-read stall bound (seconds) and total wall-clock bound for reading one
#: request body. A byte cap alone leaves the slow-drip hole open --
#: see `_Handler._read_bounded` (TASK-052 §2.2).
_SOCKET_TIMEOUT_SECONDS = 10.0
_BODY_DEADLINE_SECONDS = 30.0
#: Whole-connection bound. The two above cannot cover the request line and
#: headers -- those are read inside `http.server`, where no deadline of ours is
#: consulted -- so this one is enforced from OUTSIDE by a watchdog that shuts
#: the socket down. Generous on purpose: this server answers small JSON to a
#: local reader, so a connection alive this long is not a client we are serving.
_CONNECTION_DEADLINE_SECONDS = 60.0

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
    #: Per-read stall bound. ``socketserver.StreamRequestHandler.setup`` turns
    #: this into ``connection.settimeout``, so EVERY read on this connection --
    #: the request line, the headers, and both body paths -- gets it. Without
    #: it a peer that opens a socket and says nothing owns a thread forever
    #: (TASK-052 §2.2). Pairs with ``_BODY_DEADLINE_SECONDS``, which bounds the
    #: total instead of each individual read.
    timeout = _SOCKET_TIMEOUT_SECONDS

    def handle_one_request(self) -> None:
        """Bound the READING of one request, then re-arm for the next.

        Two corrections live in this shape, both from review, and both the same
        mistake: the guard's window was wider than the threat.

        1. PER REQUEST, NOT PER CONNECTION (round 3). Arming once in ``setup``
           bounded the whole HTTP/1.1 keep-alive conversation, so a well-behaved
           client making a steady stream of small requests got its socket shut
           at the 60-second mark.
        2. READING ONLY, NOT THE WHOLE REQUEST (round 4). Leaving it armed
           across application execution and response writing meant a legitimate
           slow request was disconnected mid-flight -- and on the write path
           that means a client-visible failure over a mutation that already
           happened. A slow APPLICATION is our own problem, not a slowloris;
           the only thing this watchdog exists to bound is time spent waiting on
           the PEER. So it is cancelled in ``parse_request`` once the headers
           are in, and re-armed around the body read in ``_read_bounded``.

        An IDLE keep-alive connection needs no watchdog: ``timeout`` already
        turns that into ``close_connection``.
        """
        self._arm_watchdog()
        try:
            super().handle_one_request()
        finally:
            self._cancel_watchdog()

    def parse_request(self) -> bool:
        # Headers are in -> we are no longer waiting on the peer. Everything
        # after this is our own work and must not be on a clock (round 4).
        parsed = super().parse_request()
        if parsed:
            self._cancel_watchdog()
        return parsed

    def _arm_watchdog(self) -> None:
        """Arm the whole-request watchdog.

        WHY A PER-READ TIMEOUT IS NOT ENOUGH, AND WHY THIS IS NOT IN
        ``_read_bounded`` (codex review round 2, TASK-052 §2.2). The body path
        can recheck a deadline between chunks because we own that loop. The
        REQUEST LINE AND HEADERS are read inside ``http.server``'s
        ``handle_one_request``, which we do not own -- a client dribbling header
        bytes just under ``timeout`` keeps the thread for as long as it likes
        and no deadline of ours is ever consulted. Bounding the CONNECTION from
        the outside is the one place that covers both halves, so slowloris is
        actually closed rather than closed-on-the-half-we-happened-to-touch.

        The watchdog shuts the socket down; the blocked read then fails and the
        handler unwinds normally.
        """
        self._cancel_watchdog()  # also bumps the generation
        self._watchdog = threading.Timer(
            _CONNECTION_DEADLINE_SECONDS,
            self._force_close,
            args=(self._watchdog_generation,),
        )
        self._watchdog.daemon = True
        self._watchdog.start()

    def _cancel_watchdog(self) -> None:
        # Bumping the generation is the part that matters. `Timer.cancel()`
        # only helps if the timer has not STARTED yet; a callback already on its
        # way runs regardless, and would then shut the socket down after we
        # stopped waiting on the peer -- losing the response to a request whose
        # mutation already happened (codex review round 5). The stale callback
        # sees a generation that has moved on and does nothing.
        self._watchdog_generation = getattr(self, "_watchdog_generation", 0) + 1
        watchdog = getattr(self, "_watchdog", None)
        if watchdog is not None:
            watchdog.cancel()
            self._watchdog = None

    def finish(self) -> None:
        self._cancel_watchdog()  # belt and braces if handle() raised early
        super().finish()

    def _force_close(self, generation: int) -> None:
        if generation != getattr(self, "_watchdog_generation", None):
            return  # superseded: this armed window is over
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass  # already closed by the handler finishing normally

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

    def _discard_body(self) -> None:
        """Read and throw away a declared request body before refusing it.

        The body is never PROCESSED, but it must leave the socket before the
        connection closes. Closing a socket that still holds unreceived data is
        an ABORTIVE close: Windows sends RST, which discards the refusal
        response the client has not read yet (the client then sees
        ``ConnectionAbortedError`` WinError 10053 instead of the status). Draining
        first also unblocks a client still writing a large body, which would
        otherwise never get round to reading our answer.

        Bounded by ``_MAX_BODY_BYTES`` so an inflated ``Content-Length`` cannot
        make this read forever; a chunked or oversized body is left alone (its
        length is unknown or too large to drain) and only the close is abrupt.
        A BYTE bound is not enough on its own -- see ``_read_bounded``.
        """
        if self.headers.get("Transfer-Encoding"):
            return
        try:
            remaining = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if remaining <= 0 or remaining > _MAX_BODY_BYTES:
            return
        self._read_bounded(remaining)

    def _read_bounded(self, remaining: int) -> bytes | None:
        """Read ``remaining`` bytes under a per-read stall bound AND a total
        wall-clock deadline. Returns ``None`` when either bound is hit.

        WHY BOTH, AND WHY A BYTE CAP IS NOT ENOUGH (TASK-052 §2.2).
        ``_MAX_BODY_BYTES`` stops a client that DECLARES a huge body. It does
        nothing about a client that declares a perfectly legal small one and
        then dribbles it a byte at a time, or stops mid-body and holds the
        socket open: the byte counter never advances past the cap, so the read
        loop simply waits forever and the handler thread is gone for good
        (slowloris). The per-read socket timeout (``_Handler.timeout``) catches
        the stalled case; the deadline here catches the slow-drip case, which a
        per-read timeout alone cannot -- each individual read arrives in time.

        Callers get ``None`` rather than an exception because every caller's
        answer is the same: stop reading and let the connection close.

        IT MUST BE ``read1``, NOT ``read`` (codex review, TASK-052 §2.2).
        ``self.rfile`` is a ``BufferedReader``, and ``BufferedReader.read(n)``
        blocks until it has all n bytes or hits EOF -- it does not return short.
        So a client dripping bytes just under the socket timeout keeps ONE
        ``read(65536)`` call blocked for as long as it likes, and the deadline
        above is never reached: the bound looks present and does nothing.
        ``read1`` performs at most one underlying syscall and returns whatever
        arrived, so control comes back to the deadline check between chunks.

        The deadline is checked BEFORE each read, so a read begun just under it
        can still run for one socket timeout -- the effective body bound is
        ``_BODY_DEADLINE_SECONDS + _SOCKET_TIMEOUT_SECONDS``. That overshoot is
        bounded and acceptable; the hard stop is the connection watchdog
        (codex review round 2, non-blocking).
        """
        # Re-armed here because reading the body is, again, waiting on the peer
        # (round 4: `parse_request` cancelled it so application time is free).
        self._arm_watchdog()
        try:
            return self._drain(remaining)
        finally:
            # Every exit disarms: the application work that follows must not
            # inherit this clock (round 4).
            self._cancel_watchdog()

    def _drain(self, remaining: int) -> bytes | None:
        deadline = time.monotonic() + _BODY_DEADLINE_SECONDS
        chunks: list[bytes] = []
        # `read1` exists on BufferedReader (rbufsize > 0, the default). An
        # unbuffered rfile is a raw SocketIO, whose `read` is already a single
        # syscall that returns short -- so the fallback keeps the same property.
        read_once = getattr(self.rfile, "read1", None) or self.rfile.read
        while remaining > 0:
            if time.monotonic() >= deadline:
                self.close_connection = True
                return None
            try:
                chunk = read_once(min(remaining, 65536))
            except (TimeoutError, OSError):
                # socket.timeout is an OSError subclass; either way the peer
                # stopped sending and we are done waiting on it.
                self.close_connection = True
                return None
            if not chunk:
                break  # client closed early; nothing left to drain
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _reject_write(self) -> None:
        # No write endpoint exists; every mutating verb is refused outright.
        # The declared body is drained but never processed, and the connection
        # is closed after the 405 — otherwise HTTP/1.1 keep-alive would parse
        # any leftover body bytes as the start of the next request.
        self.close_connection = True
        self._discard_body()
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
        self._discard_body()  # same abortive-close hazard as _reject_write
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
        # Same bounds as the discard path: a declared-but-never-delivered body
        # must not pin the thread (TASK-052 §2.2).
        body = self._read_bounded(length) if length else b""
        if body is None:
            self.close_connection = True
            self._write(
                Response(
                    408,
                    b'{"error":{"category":"timeout",'
                    b'"detail":"request body not delivered in time"}}',
                    headers=(("Connection", "close"),),
                )
            )
            return
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


class _QuietServer(ThreadingHTTPServer):
    """Do not print a traceback when a connection simply went away.

    The watchdog in ``_Handler.setup`` closes a socket out from under a blocked
    read, which is exactly what it is for -- but the default ``handle_error``
    then dumps a ``BrokenPipeError`` / ``ConnectionResetError`` traceback to
    stderr for every one. That is noise from a working guard, on a local
    single-user server, so it is swallowed. Anything else still prints: a real
    bug in a handler must not be hidden by this.
    """

    def handle_error(self, request, client_address) -> None:  # noqa: ANN001
        exc = sys.exc_info()[1]
        if isinstance(exc, ConnectionError | TimeoutError):
            # ONE LINE, NOT SILENCE (codex review round 4, non-blocking). These
            # types are raised by the transport, but application code can raise
            # them too; swallowing them outright would make a genuine handler
            # failure vanish. The traceback is the noise, not the fact — so the
            # fact survives and only the traceback goes.
            print(
                f"workspace-shell: connection {client_address} ended: "
                f"{type(exc).__name__}",
                file=sys.stderr,
            )
            return
        super().handle_error(request, client_address)


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
    server_cls: type[ThreadingHTTPServer] = _QuietServer
    if host == "::1":

        class _V6Server(_QuietServer):
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
