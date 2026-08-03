"""Transport-agnostic routing + fail-closed logic for the workspace shell.

This module never opens a socket. It maps a request path to exactly one
TASK-025 public query and returns a :class:`Response`. Keeping it free of the
HTTP transport makes the read-only boundary and the fail-closed behaviour
directly unit-testable without a running server.

Boundary invariants enforced here (ADR-0032 / ADR-0033):
- GET routes read the public query package ``ai_video_workflow.workspace`` only.
- The ONLY write path is POST -> the Command Gateway (TASK-031): every mutation
  is a registered Gateway command (preflight / submit); the shell never calls a
  service, Provider, or business file directly — the Gateway enforces version
  binding, idempotency, and fail-closed admission.
- A query or command failure is a structured problem/error envelope with a
  non-2xx status — never an empty result (fail-closed, contract §5).
- ``/artifact`` serves files only from within a discovered project root, with
  strict path containment; arbitrary paths are refused.
"""

from __future__ import annotations

import json
import mimetypes
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO
from urllib.parse import parse_qs, unquote, urlsplit

from ai_video_workflow.workspace import (
    QUERY_CONTRACT_VERSION,
    AccountScopeError,
    QueryResult,
    WorkspaceError,
    WorkspaceQueryService,
    discover_projects,
    to_jsonable,
)

# The static assets that ship with the shell, served by fixed name (no user
# input reaches the filesystem here, so containment is trivial).
_STATIC_DIR = Path(__file__).parent / "static"
_STATIC = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
}

# WSM1-B read-only page queries (no argument beyond the project root):
# sub-path -> WorkspaceQueryService method name.
_PROJECT_QUERIES: dict[str, str] = {
    "plan": "project_plan",
    "status": "project_status",
    "approvals": "approval_audit",
    "cost": "cost_breakdown",
    "budget": "budget_standing",
    "problems": "recent_problems",
}

# WSM1-C deep-dive queries that take exactly one identifier from the query
# string (lineage / prompt version / shot attempts): sub-path -> (method name,
# query-string key). Each still consumes only the TASK-025 public contract and
# is read-only; a missing identifier is a 400, never a silent empty result.
_PROJECT_PARAM_QUERIES: dict[str, tuple[str, str]] = {
    "lineage-upstream": ("lineage_upstream", "ref"),
    "lineage-downstream": ("lineage_downstream", "ref"),
    "prompt": ("prompt_history", "prompt_id"),
    "shot": ("shot_attempts", "shot_id"),
}


# Content types a browser will execute or render as an active document; a
# contained artifact of these types is served as inert text instead.
_ACTIVE_CONTENT_TYPES = frozenset(
    {
        "text/html",
        "application/xhtml+xml",
        "text/javascript",
        "application/javascript",
        "application/ecmascript",
        "image/svg+xml",
        "application/xml",
        "text/xml",
    }
)


@dataclass(frozen=True)
class Response:
    """A transport-agnostic response the server layer writes verbatim.

    ``stream``/``stream_size`` describe an already-open file body the
    transport must send in chunks and then close (used by ``/artifact`` so a
    large video is never loaded into memory whole); ``body`` stays empty in
    that case. The file is opened — and its containment re-verified — by the
    router, so the transport never touches a path. ``headers`` are extra
    per-response headers the transport sends verbatim.
    """

    status: int
    body: bytes
    content_type: str = "application/json; charset=utf-8"
    headers: tuple[tuple[str, str], ...] = ()
    stream: BinaryIO | None = None
    stream_size: int = 0


class WorkspaceApp:
    """Read-only request router over the TASK-025 public query contract."""

    def __init__(
        self,
        account_root: Path,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._account_root = Path(account_root)
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    # -- public entry ------------------------------------------------------

    def handle(self, raw_path: str) -> Response:
        """Route a raw request target (path + query string) to a Response."""
        parts = urlsplit(raw_path)
        path = parts.path
        params = parse_qs(parts.query)

        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path in ("/app.js", "/styles.css"):
            return self._static(path.lstrip("/"))
        if path == "/artifact":
            return self._artifact(params)
        if path == "/api/meta":
            return self._meta()
        if path == "/api/projects":
            return self._run_query(
                "cross_project_index", lambda s: s.cross_project_index()
            )
        if path.startswith("/api/projects/"):
            name, _, sub = path[len("/api/projects/") :].partition("/")
            # The client percent-encodes the project name; decode it so
            # names with spaces/Unicode resolve. Decoding happens before the
            # separator guard in _project_root, so an encoded "/" stays refused.
            return self._project_api(unquote(name), sub, params)
        return self._error(404, "not_found", "unknown route")

    def handle_write(self, raw_path: str, body: bytes) -> Response:
        """Route a POST write to the Command Gateway (TASK-031 / ADR-0033).

        The ONLY mutating path in the shell. Every write is a Gateway command
        (preflight or submit); the shell never calls a service, Provider, or
        business file directly — it constructs a per-project
        :class:`CommandGateway` over the approved WFM1 registry and forwards.
        Bad input and fail-closed admission refusals are structured errors,
        never silent successes.
        """
        path = urlsplit(raw_path).path
        if not path.startswith("/api/projects/"):
            return self._error(404, "not_found", "unknown write route")
        name, _, sub = path[len("/api/projects/") :].partition("/")
        if sub not in ("preflight", "command"):
            return self._error(404, "not_found", f"unknown write route: {sub!r}")
        try:
            root = self._project_root(unquote(name))
        except Exception as exc:  # noqa: BLE001 - discovery must fail closed too
            return self._discovery_error(exc)
        if root is None:
            return self._error(404, "not_found", "unknown project", project=name)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return self._error(400, "bad_request", "invalid JSON body")
        envelope, confirmation, err = self._parse_command(payload)
        if err is not None:
            return err
        gateway = self._gateway(root)
        if sub == "preflight":
            return self._run_gateway(
                lambda: gateway.preflight(envelope), preflight=True
            )
        return self._run_gateway(
            lambda: gateway.submit(envelope, confirmation=confirmation)
        )

    # -- gateway write path (TASK-031) -------------------------------------

    def _gateway(self, root: Path):
        from ai_video_workflow.app.gateway_commands import build_gateway

        return build_gateway(root, self._clock)

    def _parse_command(self, payload: object):
        """Build a CommandEnvelope from a client payload (identity is OURS).

        The shell stamps ``occurred_at`` from its own clock (time-authority) and
        FORCES ``actor="user"`` — the workspace is the local human's surface, so
        a client cannot forge audit provenance or impersonate a privileged
        actor. Agent/system provenance comes only from the programmatic/CLI
        path, never the UI. The client supplies command_id (its idempotency
        key), name, params, and an optional target + confirmation.
        """
        from ai_video_workflow.errors import AiVideoWorkflowError
        from ai_video_workflow.gateway import CommandEnvelope

        if not isinstance(payload, dict):
            return None, None, self._error(400, "bad_request", "body must be an object")
        try:
            envelope = CommandEnvelope(
                command_id=payload["command_id"],
                name=payload["name"],
                actor="user",  # not client-controlled (no provenance forgery)
                params=payload.get("params") or {},
                occurred_at=self._clock(),
                target=payload.get("target"),
            )
        except KeyError as exc:
            return (
                None,
                None,
                self._error(
                    400, "bad_request", f"missing command field: {exc.args[0]!r}"
                ),
            )
        except AiVideoWorkflowError as exc:
            return (
                None,
                None,
                self._error(
                    400, "bad_request", f"invalid command: {type(exc).__name__}"
                ),
            )
        confirmation = payload.get("confirmation")
        if confirmation is not None and not isinstance(confirmation, str):
            return (
                None,
                None,
                self._error(400, "bad_request", "confirmation must be a string"),
            )
        return envelope, confirmation, None

    def _run_gateway(self, call, *, preflight: bool = False) -> Response:
        """Run a Gateway call fail-closed; refusals are structured, not empty."""
        from ai_video_workflow.errors import AiVideoWorkflowError
        from ai_video_workflow.gateway import GatewayError

        try:
            result = call()
        except GatewayError as exc:
            # fail-closed admission refusal (unregistered / stale target /
            # blocked / confirmation / conflict) — safe, path-free messages.
            return self._error(409, "command_refused", str(exc))
        except AiVideoWorkflowError as exc:
            return self._error(400, "bad_request", type(exc).__name__)
        except Exception as exc:  # noqa: BLE001 - fail closed, never leak internals
            return self._error(
                500, "command_failed", f"unexpected {type(exc).__name__}"
            )
        return self._ok(_preflight_json(result) if preflight else _receipt_json(result))

    # -- api ---------------------------------------------------------------

    def _service(self) -> WorkspaceQueryService:
        return WorkspaceQueryService(self._account_root, clock=self._clock)

    def _meta(self) -> Response:
        """Static contract metadata so the client can flag legacy responses."""
        return self._ok(
            {
                "contract_version": QUERY_CONTRACT_VERSION,
                "read_only": True,
            }
        )

    def _project_root(self, name: str) -> Path | None:
        """Resolve an account-relative project name to a discovered root.

        Only names returned by discovery are accepted, so a traversal or an
        unknown name can never reach a query. Returns ``None`` when unknown.
        """
        if not name or "/" in name or "\\" in name or name in (".", ".."):
            return None
        for project in discover_projects(self._account_root):
            if project.name == name:
                return project.root
        return None

    def _project_api(
        self, name: str, sub: str, params: dict[str, list[str]]
    ) -> Response:
        zero = _PROJECT_QUERIES.get(sub)
        param = _PROJECT_PARAM_QUERIES.get(sub)
        if zero is None and param is None:
            return self._error(404, "not_found", f"unknown project view: {sub!r}")
        try:
            root = self._project_root(name)
        except Exception as exc:  # noqa: BLE001 - discovery must fail closed too
            return self._discovery_error(exc)
        if root is None:
            return self._error(404, "not_found", "unknown project", project=name)
        if zero is not None:
            return self._run_query(zero, lambda s: getattr(s, zero)(root))
        method, key = param
        value = (params.get(key) or [""])[0]
        if not value:
            # A missing identifier is a bad request, not "no data" — a
            # deep-dive query is meaningless without its target, and a
            # fail-closed 400 keeps it from being mistaken for an empty page.
            return self._error(400, "bad_request", f"missing {key!r}", query=method)
        return self._run_query(method, lambda s: getattr(s, method)(root, value))

    def _run_query(
        self, label: str, call: Callable[[WorkspaceQueryService], QueryResult]
    ) -> Response:
        """Run one query fail-closed: an exception becomes a problem envelope.

        A raised error is a scope violation or a query-layer defect, not
        "no data". It is surfaced as a non-2xx structured problem so the
        client can never mistake a failure for a genuinely empty result
        (query contract §5). Detail text is the exception message only —
        the query layer already redacts credentials/URLs from problems.
        """
        try:
            # Serialization stays inside the guard: an unserializable query
            # result must also fail closed, not abort the request.
            return self._ok(to_jsonable(call(self._service())))
        except AccountScopeError as exc:
            return self._error(403, "account_scope", str(exc), query=label)
        except WorkspaceError as exc:
            return self._error(502, "query_failed", str(exc), query=label)
        except Exception as exc:  # noqa: BLE001 - fail closed, never leak as empty
            # Unexpected exceptions may carry absolute paths or file contents
            # in their message — expose the type only, never the message.
            return self._error(
                500, "query_failed", f"unexpected {type(exc).__name__}", query=label
            )

    # -- static + artifacts ------------------------------------------------

    def _static(self, name: str) -> Response:
        content_type = _STATIC.get(name)
        if content_type is None:
            return self._error(404, "not_found", "unknown asset")
        try:
            body = (_STATIC_DIR / name).read_bytes()
        except OSError:
            return self._error(404, "not_found", "asset missing")
        return Response(200, body, content_type)

    def _artifact(self, params: dict[str, list[str]]) -> Response:
        """Serve a project artifact file with strict path containment.

        Only files inside a discovered project root are served, and only
        after resolving symlinks/`..` — any path that escapes a project root
        (traversal, absolute system path, sibling directory) is refused
        (ADR-0032 invariant 4). No path is trusted for its spelling.
        """
        raw = (params.get("path") or [""])[0]
        if not raw:
            return self._error(400, "bad_request", "missing 'path'")
        base = self._account_root / raw if not Path(raw).is_absolute() else Path(raw)
        try:
            resolved = base.resolve()
        except OSError as exc:
            return self._error(400, "bad_request", f"unresolvable path: {exc}")
        try:
            roots = [p.root.resolve() for p in discover_projects(self._account_root)]
        except Exception as exc:  # noqa: BLE001 - discovery must fail closed too
            return self._discovery_error(exc)
        if not any(_within(resolved, root) for root in roots):
            return self._error(403, "forbidden", "path is outside any project")
        if not resolved.is_file():
            return self._error(404, "not_found", "artifact not found")
        content_type = (
            mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        )
        # Active content is served inert: with nosniff set, text/plain can
        # never be executed as a script or rendered as a document, so a
        # project-controlled .js/.html/.svg artifact stays viewable text.
        if content_type.split(";")[0].strip() in _ACTIVE_CONTENT_TYPES:
            content_type = "text/plain; charset=utf-8"
        try:
            stream = resolved.open("rb")
        except OSError:
            return self._error(404, "not_found", "unreadable artifact")
        # Re-verify containment on the file actually opened: between the
        # resolve() check above and open(), a path component could have been
        # swapped for a symlink escaping the project (TOCTOU). The opened
        # descriptor's real path (/proc/self/fd, Linux/WSL2 — this project's
        # only supported platform) cannot be redirected after the fact.
        try:
            opened = Path(os.readlink(f"/proc/self/fd/{stream.fileno()}"))
            size = os.fstat(stream.fileno()).st_size
        except OSError:
            stream.close()
            return self._error(404, "not_found", "unreadable artifact")
        if not any(_within(opened, root) for root in roots):
            stream.close()
            return self._error(403, "forbidden", "path is outside any project")
        # Streamed by the transport (never loaded whole into memory), and
        # sandboxed: a project-controlled HTML/JS artifact opened as a
        # document must not execute with the workspace's same-origin powers.
        return Response(
            200,
            b"",
            content_type,
            headers=(("Content-Security-Policy", "sandbox"),),
            stream=stream,
            stream_size=size,
        )

    def _discovery_error(self, exc: Exception) -> Response:
        """Project discovery failed: a structured 502, never an aborted request.

        A WorkspaceError message is already safe to show (the query layer
        redacts internals); anything else exposes its type only.
        """
        detail = (
            str(exc)
            if isinstance(exc, WorkspaceError)
            else f"unexpected {type(exc).__name__}"
        )
        return self._error(502, "query_failed", detail, query="discover_projects")

    # -- envelopes ---------------------------------------------------------

    def _ok(self, payload: dict) -> Response:
        return Response(200, _dumps(payload))

    def _error(
        self, status: int, category: str, detail: str, **context: str
    ) -> Response:
        """A structured, fail-closed error envelope (never an empty result)."""
        readiness_failed = category in ("query_failed", "account_scope")
        payload = {
            "error": {
                "category": category,
                "detail": detail,
                "context": context,
                "readiness_failed": readiness_failed,
            }
        }
        return Response(status, _dumps(payload))


def _preflight_json(pf) -> dict:
    return {
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
    }


def _receipt_json(receipt) -> dict:
    return {
        "command_id": receipt.command_id,
        "name": receipt.name,
        "status": receipt.status.value,
        "outcome": receipt.outcome,
        "reason": receipt.reason,
        "occurred_at": receipt.occurred_at.isoformat(timespec="microseconds"),
    }


def _within(candidate: Path, base: Path) -> bool:
    """True when ``candidate`` is ``base`` itself or nested under it."""
    return candidate == base or candidate.is_relative_to(base)


def _dumps(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
