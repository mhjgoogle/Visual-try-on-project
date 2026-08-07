#!/usr/bin/env python3
"""Optional same-origin loopback backend for the motv workspace mockup.

Two things a plain ``python3 -m http.server`` cannot do, provided here so the
mockup can do REAL data interaction:

1. **Read real project data** through the accepted ADR-0031 read-only query
   contract — it imports the PUBLIC package ``ai_video_workflow.workspace`` (the
   same public surface ``src/workspace_shell/app.py`` consumes; NOT core internal
   types) and exposes a few read-only queries same-origin. A cross-port
   ``http.server`` page cannot read the production shell's ``/api/*`` (that shell
   sends no CORS and CORP=same-origin), which is exactly why this mockup needs
   its own same-origin backend.
2. **Persist the canvas's OWN editable state** (script drafts, node positions,
   edges) to ``data/<name>.json`` under this mockup dir — prototype-local
   scratch, never a projection of core facts and never written back to any
   ``<project>/`` core file.

Write paths (both Origin/CSRF-guarded, loopback-only):
- ``PUT /api/canvas/<name>`` — mockup-local canvas scratch (always available).
- ``POST /api/projects/<name>/{preflight,command}`` — the ADR-0041 generation
  write path, ONLY when started with ``--enable-paid``: every mutation goes
  through the Command Gateway → approved coordinator (ADR-0033 P1/P2); this
  server never calls a Provider or writes a business file itself. The paid
  command's registration is doubly gated (``authorized=True`` +
  ``AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1``), and real spend additionally
  requires ``WFM1_MINIMAX_API_KEY`` plus a human preflight-digest confirmation.

Host-guarded, strict same-origin CSP. This backend is deliberately kept OUT of
``src/workspace_shell/`` and imports only public/app-approved modules.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

MOCKUP_DIR = Path(__file__).resolve().parent
REPO_ROOT = MOCKUP_DIR.parents[1]
DATA_DIR = MOCKUP_DIR / "data"

# Static files this server will serve (same-origin). Everything else — data/,
# server.py, README, plans — is refused.
_STATIC_PREFIXES = ("src/", "styles/", "fixtures/")
_MAX_BODY_BYTES = 2_000_000
_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", ""}
_LOOPBACK_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "::1"}

# style-src allows 'unsafe-inline' because the mockup uses inline style="..."
# attributes; script stays 'self' (external module only, no inline JS/handlers);
# connect-src 'self' permits same-origin fetch of /api/*.
_SECURITY_HEADERS = (
    (
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'",
    ),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
)

# --- optional read-only query backend (public ADR-0031 contract) -------------
try:  # imported lazily so the server still serves static + persistence without it
    from ai_video_workflow.workspace import (  # type: ignore
        QUERY_CONTRACT_VERSION,
        AccountScopeError,
        WorkspaceError,
        WorkspaceQueryService,
        discover_projects,
        to_jsonable,
    )

    _QUERY_OK = True
except Exception:  # noqa: BLE001 - degrade to static/persistence-only if absent
    _QUERY_OK = False
    QUERY_CONTRACT_VERSION = "unavailable"

# sub-path -> zero-arg query method (same shape as workspace_shell/app.py)
_QUERIES = {
    "plan": "project_plan",
    "status": "project_status",
    "budget": "budget_standing",
    "cost": "cost_breakdown",
    "problems": "recent_problems",
    "approvals": "approval_audit",
}

_CTYPE = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


def _host_is_loopback(host_header):
    if not host_header:
        return True
    host = host_header.strip()
    if host.startswith("["):
        host = host[1:].split("]", 1)[0]
    elif host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    return host.lower() in _LOOPBACK_HOSTS


class _App:
    """Transport-agnostic routing + read-only query/persistence logic.

    With ``paid_catalog_dir`` set (server started with ``--enable-paid``), the
    app additionally exposes the ADR-0041 generation write path: POST
    ``/api/projects/<name>/{preflight,command}`` routed to a Command Gateway
    whose registry holds ONLY the authorized ``submit-video-generation``
    command. Registration is doubly gated (in-code ``authorized=True`` + the
    ``AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1`` deployment flag); a real
    provider call additionally needs ``WFM1_MINIMAX_API_KEY`` at submit time.
    The server never calls a Provider itself — every write goes through the
    Gateway → approved coordinator (ADR-0033 P1/P2).
    """

    def __init__(self, account_root: Path, paid_catalog_dir: Path | None = None):
        self.account_root = account_root
        self._svc = None
        self._projects: dict[str, Path] = {}
        self.paid_catalog_dir = paid_catalog_dir
        if _QUERY_OK and account_root is not None:
            try:
                self._svc = WorkspaceQueryService(
                    account_root, clock=lambda: datetime.now(timezone.utc)
                )
                self._projects = {
                    p.name: p.root for p in discover_projects(account_root)
                }
            except Exception:  # noqa: BLE001 - stay up; queries just return unavailable
                self._svc = None

    @property
    def connected(self) -> bool:
        return self._svc is not None

    @property
    def paid(self) -> bool:
        return self.paid_catalog_dir is not None

    def _paid_gateway(self, root: Path):
        """A per-project Gateway holding only the paid generation command."""
        from ai_video_workflow.app.media_fetch import UrllibMediaFetcher
        from ai_video_workflow.app.paid_gateway import (
            ShotRecordTargetResolver,
            register_paid_video_command,
        )
        from ai_video_workflow.gateway import CommandGateway, CommandRegistry
        from ai_video_workflow.providers.registry import default_registry

        registry = CommandRegistry()
        register_paid_video_command(
            registry,
            provider_registry=default_registry,
            fetcher=UrllibMediaFetcher,
            catalog_dir=self.paid_catalog_dir,
            authorized=True,  # --enable-paid; env flag enforced inside
            account_root=self.account_root,
        )
        return CommandGateway(
            root,
            registry=registry,
            target_resolver=ShotRecordTargetResolver(),
            clock=lambda: datetime.now(timezone.utc),
        )

    # -- GET routing ------------------------------------------------------
    def handle(self, raw_path: str):
        path = urlsplit(raw_path).path
        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path == "/api/meta":
            return _json(
                200,
                {
                    "contract_version": QUERY_CONTRACT_VERSION,
                    "mode": "connected" if self.connected else "local",
                    "paid": self.paid,
                    "account_root": str(self.account_root)
                    if self.account_root
                    else None,
                },
            )
        if path == "/api/projects":
            if not self.connected:
                return _json(200, {"projects": [], "mode": "local"})
            return _json(
                200, {"projects": [{"name": n} for n in sorted(self._projects)]}
            )
        if path.startswith("/api/projects/"):
            rest = path[len("/api/projects/") :]
            name, _, sub = rest.partition("/")
            if sub.startswith("generation-target"):
                params = parse_qs(urlsplit(raw_path).query)
                return self._generation_target(
                    unquote(name), (params.get("shot_id") or [""])[0]
                )
            return self._query(unquote(name), sub)
        if path.startswith("/api/canvas/"):
            return self._canvas_get(unquote(path[len("/api/canvas/") :]))
        rel = path.lstrip("/")
        if any(rel.startswith(p) for p in _STATIC_PREFIXES):
            return self._static(rel)
        return _json(
            404, {"error": {"category": "not_found", "detail": "unknown route"}}
        )

    # -- PUT (mockup-local canvas save) ------------------------------------
    def handle_put(self, raw_path: str, body: bytes):
        path = urlsplit(raw_path).path
        if not path.startswith("/api/canvas/"):
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "unknown write route"}},
            )
        return self._canvas_put(unquote(path[len("/api/canvas/") :]), body)

    # -- POST (Gateway write path, ADR-0041; only in paid mode) ------------
    def handle_post(self, raw_path: str, body: bytes):
        path = urlsplit(raw_path).path
        if not path.startswith("/api/projects/"):
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "unknown write route"}},
            )
        rest = path[len("/api/projects/") :]
        name, _, sub = rest.partition("/")
        if sub not in ("preflight", "command"):
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "unknown write route"}},
            )
        if not self.paid:
            return _json(
                403,
                {
                    "error": {
                        "category": "forbidden",
                        "detail": "paid commands not enabled (--enable-paid)",
                    }
                },
            )
        root = self._projects.get(unquote(name))
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        from ai_video_workflow.errors import AiVideoWorkflowError
        from ai_video_workflow.gateway import CommandEnvelope, GatewayError

        try:
            envelope = CommandEnvelope(
                command_id=payload["command_id"],
                name=payload["name"],
                actor="user",  # forced server-side — no provenance forgery
                params=payload.get("params") or {},
                occurred_at=datetime.now(timezone.utc),
                target=payload.get("target"),
            )
        except KeyError as exc:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": f"missing command field: {exc.args[0]!r}",
                    }
                },
            )
        except AiVideoWorkflowError as exc:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": f"invalid command: {type(exc).__name__}",
                    }
                },
            )
        confirmation = payload.get("confirmation")
        if confirmation is not None and not isinstance(confirmation, str):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "confirmation must be a string",
                    }
                },
            )
        try:
            gateway = self._paid_gateway(root)
            if sub == "preflight":
                pf = gateway.preflight(envelope)
                return _json(
                    200,
                    {
                        "command_id": pf.command_id,
                        "name": pf.name,
                        "is_high_risk": pf.is_high_risk,
                        "preflight_digest": pf.preflight_digest,
                        "preview": {
                            "inputs": dict(pf.preview.inputs),
                            "estimated_cost": (
                                dict(pf.preview.estimated_cost)
                                if pf.preview.estimated_cost is not None
                                else None
                            ),
                            "downstream": list(pf.preview.downstream),
                            "blockers": list(pf.preview.blockers),
                        },
                    },
                )
            receipt = gateway.submit(envelope, confirmation=confirmation)
            return _json(
                200,
                {
                    "command_id": receipt.command_id,
                    "name": receipt.name,
                    "status": receipt.status.value,
                    "outcome": receipt.outcome,
                    "reason": receipt.reason,
                    "occurred_at": receipt.occurred_at.isoformat(
                        timespec="microseconds"
                    ),
                },
            )
        except GatewayError as exc:
            # fail-closed admission refusal — safe, path-free message
            return _json(
                409, {"error": {"category": "command_refused", "detail": str(exc)}}
            )
        except AiVideoWorkflowError as exc:
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": type(exc).__name__}},
            )
        except Exception as exc:  # noqa: BLE001 - fail closed, never leak internals
            return _json(
                500,
                {
                    "error": {
                        "category": "command_failed",
                        "detail": f"unexpected {type(exc).__name__}",
                    }
                },
            )

    def _generation_target(self, name: str, shot_id: str):
        """Read-only generation coordinates for the UI (ref/digest/params).

        Computed from the authoritative shot record via the same resolver the
        Gateway uses, so the digest the UI binds is the digest the submit will
        verify. Suggested params follow the recorded-task rule (initial id).
        """
        if not self.paid:
            return _json(
                403,
                {"error": {"category": "forbidden", "detail": "paid mode disabled"}},
            )
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        if not shot_id or not _NAME_RE.fullmatch(shot_id):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "bad shot_id"}}
            )
        from ai_video_workflow.app.bootstrap import initial_task_id
        from ai_video_workflow.app.paid_gateway import ShotRecordTargetResolver

        resolved = ShotRecordTargetResolver().resolve_target(
            root, ref=shot_id, version=1
        )
        if not resolved.exists:
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "shot record not found"}},
            )
        return _json(
            200,
            {
                "target": {
                    "ref": shot_id,
                    "version": 1,
                    "content_digest": resolved.content_digest,
                },
                "params": {
                    "task_id": initial_task_id(shot_id),
                    "shot_id": shot_id,
                    "packet_version": 1,
                },
            },
        )

    # -- queries (read-only) ---------------------------------------------
    def _query(self, name: str, sub: str):
        method = _QUERIES.get(sub)
        if method is None:
            return _json(
                404,
                {
                    "error": {
                        "category": "not_found",
                        "detail": f"unknown query: {sub!r}",
                    }
                },
            )
        if not self.connected:
            return _json(
                503,
                {
                    "error": {
                        "category": "unavailable",
                        "detail": "query backend not available",
                    }
                },
            )
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        try:
            return _json(200, to_jsonable(getattr(self._svc, method)(root)))
        except AccountScopeError as exc:
            return _json(
                403, {"error": {"category": "account_scope", "detail": str(exc)}}
            )
        except WorkspaceError as exc:
            return _json(
                502, {"error": {"category": "query_failed", "detail": str(exc)}}
            )
        except Exception as exc:  # noqa: BLE001 - fail closed, expose type only
            return _json(
                500,
                {
                    "error": {
                        "category": "query_failed",
                        "detail": f"unexpected {type(exc).__name__}",
                    }
                },
            )

    # -- canvas persistence (mockup-local scratch) -----------------------
    def _canvas_path(self, name: str):
        if not _NAME_RE.fullmatch(name):
            return None
        p = (DATA_DIR / f"{name}.json").resolve()
        # strict containment: must live directly under DATA_DIR
        if p.parent != DATA_DIR.resolve():
            return None
        return p

    def _canvas_get(self, name: str):
        p = self._canvas_path(name)
        if p is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        if not p.is_file():
            return _json(200, {})
        try:
            return _json(200, json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            return _json(200, {})

    def _canvas_put(self, name: str, body: bytes):
        p = self._canvas_path(name)
        if p is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "body must be an object",
                    }
                },
            )
        DATA_DIR.mkdir(exist_ok=True)
        # A unique temp file per write so concurrent saves for the same project
        # (multiple tabs) can't collide on a shared ``<name>.json.tmp``.
        fd, tmpname = tempfile.mkstemp(dir=str(DATA_DIR), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(payload, ensure_ascii=False))
            os.replace(tmpname, p)  # atomic, mockup-local only
        except OSError:
            try:
                os.unlink(tmpname)
            except OSError:
                pass
            return _json(
                500, {"error": {"category": "write_failed", "detail": "could not save"}}
            )
        return _json(200, {"ok": True})

    # -- static ----------------------------------------------------------
    def _static(self, rel: str):
        try:
            resolved = (MOCKUP_DIR / rel).resolve()
        except OSError:
            return _json(
                404, {"error": {"category": "not_found", "detail": "bad path"}}
            )
        base = MOCKUP_DIR.resolve()
        if base not in resolved.parents and resolved != base:
            return _json(
                403,
                {"error": {"category": "forbidden", "detail": "outside mockup dir"}},
            )
        if not resolved.is_file():
            return _json(
                404, {"error": {"category": "not_found", "detail": "not found"}}
            )
        ctype = _CTYPE.get(resolved.suffix, "application/octet-stream")
        try:
            return _Resp(200, resolved.read_bytes(), ctype)
        except OSError:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unreadable"}}
            )


class _Resp:
    __slots__ = ("status", "body", "content_type")

    def __init__(self, status, body, content_type="application/json; charset=utf-8"):
        self.status = status
        self.body = body
        self.content_type = content_type


def _json(status, payload):
    return _Resp(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"))


class _Handler(BaseHTTPRequestHandler):
    server_version = "motv-mockup"
    protocol_version = "HTTP/1.1"

    @property
    def _app(self) -> _App:
        return self.server.app  # type: ignore[attr-defined]

    def _guard_host(self) -> bool:
        if _host_is_loopback(self.headers.get("Host")):
            return True
        self._write(
            _json(
                403, {"error": {"category": "forbidden", "detail": "non-loopback host"}}
            )
        )
        return False

    def _guard_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        o = urlsplit(origin)
        host_hdr = urlsplit("//" + (self.headers.get("Host") or ""))
        try:
            same = (
                o.scheme == "http"
                and (o.hostname or "").lower() in _LOOPBACK_ORIGIN_HOSTS
                and (o.hostname or "").lower() == (host_hdr.hostname or "").lower()
                and o.port == host_hdr.port
            )
        except ValueError:
            same = False
        if same:
            return True
        self.close_connection = True
        self._write(
            _json(
                403,
                {
                    "error": {
                        "category": "forbidden",
                        "detail": "cross-origin write refused",
                    }
                },
            )
        )
        return False

    def do_GET(self):  # noqa: N802
        if not self._guard_host():
            return
        self._write(self._app.handle(self.path))

    def do_HEAD(self):  # noqa: N802
        if not self._guard_host():
            return
        self._write(self._app.handle(self.path), body=False)

    def do_PUT(self):  # noqa: N802
        if not self._guard_host() or not self._guard_origin():
            return
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._write(
                _json(
                    411,
                    {
                        "error": {
                            "category": "length_required",
                            "detail": "Content-Length required",
                        }
                    },
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
                _json(
                    413,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": "request body too large",
                        }
                    },
                )
            )
            return
        body = self.rfile.read(length) if length else b""
        self._write(self._app.handle_put(self.path, body))

    def _reject(self):
        self.close_connection = True
        self._write(
            _json(
                405,
                {
                    "error": {
                        "category": "method_not_allowed",
                        "detail": "unsupported method",
                    }
                },
            )
        )

    def do_POST(self):  # noqa: N802 - Gateway write path (ADR-0041, paid mode only)
        if not self._guard_host() or not self._guard_origin():
            return
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._write(
                _json(
                    411,
                    {
                        "error": {
                            "category": "length_required",
                            "detail": "Content-Length required",
                        }
                    },
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
                _json(
                    413,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": "request body too large",
                        }
                    },
                )
            )
            return
        body = self.rfile.read(length) if length else b""
        self._write(self._app.handle_post(self.path, body))

    do_PATCH = _reject  # noqa: N815
    do_DELETE = _reject  # noqa: N815

    def _write(self, resp: _Resp, *, body: bool = True):
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.content_type)
        self.send_header("Content-Length", str(len(resp.body)))
        for name, value in _SECURITY_HEADERS:
            self.send_header(name, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(resp.body)

    def log_message(self, *args):  # quiet
        pass


def build_server(account_root, host="127.0.0.1", port=8770, paid_catalog_dir=None):
    if ":" in host and not host.startswith("["):
        addr_family = socket.AF_INET6
    else:
        addr_family = socket.AF_INET

    class _Server(ThreadingHTTPServer):
        address_family = addr_family
        daemon_threads = True

    srv = _Server((host, port), _Handler)
    srv.app = _App(account_root, paid_catalog_dir)  # type: ignore[attr-defined]
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="motv mockup loopback backend (read-only + canvas persistence)"
    )
    ap.add_argument(
        "--account-root",
        default=str(REPO_ROOT / "examples" / "projects"),
        help="parent dir whose children are projects (each with config/wfm1.json). "
        "Default: examples/projects",
    )
    ap.add_argument(
        "--host",
        default="127.0.0.1",
        help="loopback address only (127.0.0.1/localhost/::1)",
    )
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument(
        "--enable-paid",
        action="store_true",
        help="expose the ADR-0041 generation write path (POST → Command "
        "Gateway). Also requires AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1; a "
        "real provider call additionally needs WFM1_MINIMAX_API_KEY.",
    )
    ap.add_argument(
        "--catalog-dir",
        type=Path,
        default=None,
        help="locked provider catalog dir for paid mode "
        "(default: <account-root>/catalog)",
    )
    args = ap.parse_args(argv)

    # Loopback-only by design: this backend serves real project data and accepts
    # canvas writes with only a same-origin (not authenticated) guard, so it must
    # never bind a routable interface where a spoofed Host header could reach it.
    if args.host not in _LOOPBACK_ORIGIN_HOSTS:
        ap.error("--host must be a loopback address (127.0.0.1, localhost, or ::1)")

    account_root = Path(args.account_root).resolve()
    paid_catalog_dir = None
    if args.enable_paid:
        if os.environ.get("AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS") != "1":
            ap.error(
                "--enable-paid requires AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1 "
                "(the deployment opt-in for the real-spend command)"
            )
        if not _QUERY_OK:
            ap.error("--enable-paid requires the venv (ai_video_workflow importable)")
        paid_catalog_dir = (
            Path(args.catalog_dir).resolve()
            if args.catalog_dir is not None
            else account_root / "catalog"
        )
        if not paid_catalog_dir.is_dir():
            ap.error(f"catalog dir not found: {paid_catalog_dir}")
    srv = build_server(
        account_root,
        host=args.host,
        port=args.port,
        paid_catalog_dir=paid_catalog_dir,
    )
    app: _App = srv.app  # type: ignore[attr-defined]
    mode = (
        "connected (real read-only data)"
        if app.connected
        else "local (fixtures + persistence only)"
    )
    if not _QUERY_OK:
        mode += " — query package not importable; run inside the venv for real data"
    if app.paid:
        mode += " + PAID write path (Gateway; spend still needs key + confirmation)"
    print(f"motv mockup backend → http://{args.host}:{args.port}/")
    print(f"  mode: {mode}")
    print(f"  account-root: {account_root}")
    if app.connected:
        print(f"  projects: {', '.join(sorted(app._projects)) or '(none discovered)'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
