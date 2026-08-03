"""Read-only workspace shell tests (TASK-026 / WSM1-B).

Drives the real WorkspaceApp router against a real WFM1 episode built through
the CLI coordination chain (reusing the E2E + query fixtures). Covers the
query-contract integration surface, the fail-closed error path, the read-only
guards, path containment, and the lifecycle separation the ADR-0032 boundary
invariants require. No provider is called, no network, no payment.
"""

from __future__ import annotations

import ast
import json
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests.test_wfm1_e2e import _paid_all_shots, _run, _setup
from workspace_shell.app import WorkspaceApp
from workspace_shell.server import _host_is_loopback, build_server

_FIXED = datetime(2026, 8, 3, tzinfo=timezone.utc)
_SHELL_SRC = Path(__file__).resolve().parents[1] / "src" / "workspace_shell"


def _clock():
    return _FIXED


def _app(account_root: Path) -> WorkspaceApp:
    return WorkspaceApp(account_root, clock=_clock)


def _json(resp) -> dict:
    return json.loads(resp.body.decode("utf-8"))


def _episode(tmp_path, monkeypatch):
    """A composed episode; returns (account_root, project_root)."""
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    _paid_all_shots(root, catalog_dir)
    assert _run(root, catalog_dir, "compose") == 0
    return tmp_path, root


# --- static + meta -----------------------------------------------------------


def test_serves_index_and_static_assets(tmp_path):
    app = _app(tmp_path)
    index = app.handle("/")
    assert index.status == 200
    assert index.content_type.startswith("text/html")
    assert b"Creation Workspace" in index.body
    assert app.handle("/app.js").content_type.startswith("text/javascript")
    assert app.handle("/styles.css").content_type.startswith("text/css")
    assert app.handle("/unknown-asset.png").status == 404


# --- query-contract integration ---------------------------------------------


def test_portfolio_index_lists_project(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(_app(account).handle("/api/projects"))
    assert dto["query_id"] == "WQ-11"
    assert any(it["project"]["value"] == root.name for it in dto["items"])


def test_plan_returns_full_l0_s7_with_provenance(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(_app(account).handle(f"/api/projects/{root.name}/plan"))
    assert dto["query_id"] == "WQ-01"
    ids = {it["step_id"]["value"] for it in dto["items"]}
    assert {"L0-01", "L0-07", "S4-T05", "S7-T05"} <= ids
    # definition is authoritative; an unimplemented step's run is unavailable
    l0_01 = next(it for it in dto["items"] if it["step_id"]["value"] == "L0-01")
    assert l0_01["execution"]["provenance"] == "authoritative"
    assert l0_01["run_status"]["provenance"] == "unavailable"
    assert "contains_unavailable" in dto["markers"]


def test_status_shows_running_and_block_reasons(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(_app(account).handle(f"/api/projects/{root.name}/status"))
    assert dto["query_id"] == "WQ-02"
    # at least one stage carries a non-empty blocked_by list (a prerequisite)
    reasons = [
        it["blocked_by"]["value"]
        for it in dto["items"]
        if it.get("blocked_by") and it["blocked_by"]["value"]
    ]
    assert reasons, "expected at least one blocked stage with a reason"


def test_cost_and_budget_endpoints(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    cost = _json(_app(account).handle(f"/api/projects/{root.name}/cost"))
    assert cost["query_id"] == "WQ-07"
    budget = _json(_app(account).handle(f"/api/projects/{root.name}/budget"))
    assert budget["query_id"] == "WQ-14"
    assert budget["items"][0]["budgets_jpy"]["value"]["episode_soft"] == 1200


def test_problems_and_approvals_endpoints(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    problems = _json(_app(account).handle(f"/api/projects/{root.name}/problems"))
    assert problems["query_id"] == "WQ-09"
    approvals = _json(_app(account).handle(f"/api/projects/{root.name}/approvals"))
    assert approvals["query_id"] == "WQ-13"


# --- fail-closed: a failure is a structured problem, never empty --------------


def test_unknown_project_is_structured_error_not_empty(tmp_path, monkeypatch):
    account, _ = _episode(tmp_path, monkeypatch)
    resp = _app(account).handle("/api/projects/no-such-project/plan")
    assert resp.status == 404
    body = _json(resp)
    assert "error" in body and "items" not in body  # not disguised as empty data
    assert body["error"]["category"] == "not_found"


def test_unknown_view_and_route_are_404(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    assert _app(account).handle(f"/api/projects/{root.name}/lineage").status == 404
    assert _app(account).handle("/api/nope").status == 404


def test_traversal_project_name_refused(tmp_path, monkeypatch):
    account, _ = _episode(tmp_path, monkeypatch)
    # a name with a separator can never resolve to a discovered project —
    # including an encoded "/" which decodes back into a separator
    resp = _app(account).handle("/api/projects/..%2f..%2fetc/plan")
    assert resp.status == 404
    assert _json(resp)["error"]["category"] == "not_found"


def test_percent_encoded_project_name_resolves(tmp_path, monkeypatch):
    """The client percent-encodes project names; the router must decode them."""
    account, root = _episode(tmp_path, monkeypatch)
    encoded = "".join(f"%{ord(c):02x}" for c in root.name)
    dto = _json(_app(account).handle(f"/api/projects/{encoded}/plan"))
    assert dto["query_id"] == "WQ-01"


def test_discovery_failure_is_structured_error_not_abort(tmp_path, monkeypatch):
    """A discovery crash (broken project files) fails closed, per contract."""
    import workspace_shell.app as app_mod

    def boom(_root):
        raise RuntimeError("secret /abs/path")

    monkeypatch.setattr(app_mod, "discover_projects", boom)
    for target in ("/api/projects/some-name/plan", "/artifact?path=x/y.json"):
        resp = _app(tmp_path).handle(target)
        assert resp.status == 502
        body = _json(resp)
        assert body["error"]["category"] == "query_failed"
        assert body["error"]["detail"] == "unexpected RuntimeError"
        assert "secret" not in resp.body.decode("utf-8")


def test_unserializable_result_fails_closed(tmp_path, monkeypatch):
    """Serialization failure is a structured 500, never an aborted request."""
    import workspace_shell.app as app_mod

    def bad_serializer(_result):
        raise TypeError("Object of type set is not JSON serializable: /leak")

    monkeypatch.setattr(app_mod, "to_jsonable", bad_serializer)
    resp = _app(tmp_path).handle("/api/projects")
    assert resp.status == 500
    body = _json(resp)
    assert body["error"]["category"] == "query_failed"
    assert body["error"]["detail"] == "unexpected TypeError"
    assert "/leak" not in resp.body.decode("utf-8")


def test_unexpected_exception_message_is_withheld(tmp_path, monkeypatch):
    """An unexpected exception's message (paths, internals) never leaks out."""
    from ai_video_workflow.workspace import WorkspaceQueryService

    def boom(self):
        raise RuntimeError("secret /absolute/path/leak")

    monkeypatch.setattr(WorkspaceQueryService, "cross_project_index", boom)
    resp = _app(tmp_path).handle("/api/projects")
    assert resp.status == 500
    body = _json(resp)
    assert body["error"]["detail"] == "unexpected RuntimeError"
    assert "secret" not in resp.body.decode("utf-8")


# --- artifact path containment ----------------------------------------------


def test_artifact_serves_inside_project_only(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    # a real committed project file resolves and is served — as a stream
    # (never loaded whole into memory) and sandboxed so a project-controlled
    # HTML/JS artifact cannot execute with the workspace's same-origin powers
    some_file = next(root.rglob("*.json"))
    rel = some_file.relative_to(account)
    ok = _app(account).handle(f"/artifact?path={rel}")
    assert ok.status == 200
    assert ok.stream is not None
    with ok.stream as stream:
        assert stream.read() == some_file.read_bytes()
    assert ok.stream_size == some_file.stat().st_size > 0
    assert not ok.body  # streamed by the transport, not buffered here
    assert ("Content-Security-Policy", "sandbox") in ok.headers

    # traversal / absolute system path / missing path are all refused
    outside = tmp_path.parent / "secret.txt"
    outside.write_text("nope", encoding="utf-8")
    assert _app(account).handle(f"/artifact?path={outside}").status == 403
    assert _app(account).handle("/artifact?path=../../etc/passwd").status == 403
    assert _app(account).handle("/artifact").status == 400

    # a symlink inside a project pointing outside it is refused
    link = root / "sneaky.json"
    link.symlink_to(outside)
    assert _app(account).handle(f"/artifact?path={root.name}/sneaky.json").status == 403


def test_artifact_active_content_served_inert(tmp_path, monkeypatch):
    """A project .js/.html artifact must never be executable content.

    With nosniff set, text/plain cannot be pulled in as a classic <script>
    by an external page (loopback URLs are guessable) nor rendered as a
    same-origin document.
    """
    account, root = _episode(tmp_path, monkeypatch)
    for fname in ("gadget.js", "page.html", "vector.svg"):
        (root / fname).write_text("content", encoding="utf-8")
        resp = _app(account).handle(f"/artifact?path={root.name}/{fname}")
        assert resp.status == 200
        assert resp.content_type == "text/plain; charset=utf-8"
        resp.stream.close()
    # ordinary media keeps its real type
    resp = _app(account).handle(
        f"/artifact?path={next(root.rglob('*.json')).relative_to(account)}"
    )
    assert resp.content_type == "application/json"
    resp.stream.close()


def test_artifact_containment_rechecked_on_opened_file(tmp_path, monkeypatch):
    """The post-open re-verification (anti-TOCTOU) refuses an escaped file.

    Simulates a path component being swapped for an outside symlink between
    the resolve()-time check and open(): the descriptor's real path reports
    an outside location, and the response must be 403 with the handle closed.
    """
    import workspace_shell.app as app_mod

    account, root = _episode(tmp_path, monkeypatch)
    some_file = next(root.rglob("*.json"))
    rel = some_file.relative_to(account)
    monkeypatch.setattr(
        app_mod.os, "readlink", lambda _p: str(tmp_path.parent / "swapped-outside")
    )
    resp = _app(account).handle(f"/artifact?path={rel}")
    assert resp.status == 403
    assert resp.stream is None  # the opened handle was not leaked into the response


# --- TASK-027 deep-dives: lineage / prompt / shot / cost drilldown ------------


def test_lineage_upstream_and_downstream_roundtrip(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    app = _app(account)
    # downstream of a producing task lists the video asset it produced
    down = _json(
        app.handle(f"/api/projects/{root.name}/lineage-downstream?ref=task-shot-1-1")
    )
    assert down["query_id"] == "WQ-04"
    assets = [
        it["ref"]["value"]
        for it in down["items"]
        if it["consumer_kind"]["value"] == "video_asset"
    ]
    assert assets, "the task should have produced at least one video asset"
    # upstream of that asset traces back to its producing task, authoritative
    up = _json(
        app.handle(f"/api/projects/{root.name}/lineage-upstream?ref={assets[0]}")
    )
    assert up["query_id"] == "WQ-03"
    assert up["items"][0]["producing_task"]["provenance"] == "authoritative"
    assert up["readiness_failed"] is False


def test_lineage_orphan_ref_fails_closed_not_empty(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(
        _app(account).handle(
            f"/api/projects/{root.name}/lineage-upstream?ref=no-such-asset"
        )
    )
    # an orphan ref is a structured readiness failure, never a silent empty page
    assert dto["query_id"] == "WQ-03"
    assert dto["readiness_failed"] is True
    assert "readiness_failed" in dto["markers"]
    assert dto["problems"] and not dto["items"]


def test_deep_dive_missing_identifier_is_bad_request(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    resp = _app(account).handle(f"/api/projects/{root.name}/prompt")  # no prompt_id
    assert resp.status == 400
    body = _json(resp)
    assert "error" in body and "items" not in body  # not disguised as empty data
    assert body["error"]["category"] == "bad_request"


def test_prompt_history_versions_and_media_unavailable(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(
        _app(account).handle(f"/api/projects/{root.name}/prompt?prompt_id=p-main")
    )
    assert dto["query_id"] == "WQ-05"
    assert dto["items"]
    first = dto["items"][0]
    assert first["version"]["provenance"] == "authoritative"
    # image/audio/subtitle results are explicitly out of WFM1 scope, not faked
    assert first["image_audio_subtitle_results"]["provenance"] == "unavailable"
    assert "contains_unavailable" in dto["markers"]


def test_prompt_history_unknown_prompt_fails_closed(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(
        _app(account).handle(f"/api/projects/{root.name}/prompt?prompt_id=nope")
    )
    assert dto["query_id"] == "WQ-05"
    assert dto["readiness_failed"] is True
    assert dto["problems"] and not dto["items"]


def test_shot_attempts_endpoint(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(_app(account).handle(f"/api/projects/{root.name}/shot?shot_id=shot-1"))
    assert dto["query_id"] == "WQ-06"
    assert dto["items"]
    op = dto["items"][0]
    assert op["attempt_kind"]["provenance"] == "derived"  # relationship is derived
    assert op["provider_id"]["provenance"] == "authoritative"


def test_cost_drilldown_keeps_currencies_separate(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    item = _json(_app(account).handle(f"/api/projects/{root.name}/cost"))["items"][0]
    # per-operation original amounts are authoritative; rollups / JPY are derived
    assert item["per_operation"]["provenance"] == "authoritative"
    assert item["by_shot"]["provenance"] == "derived"
    assert item["actual_by_currency"]["provenance"] == "derived"
    # cross-currency safety: every dimension key maps a CURRENCY to an amount,
    # so amounts of different currencies stay in separate buckets, never summed
    by_shot = item["by_shot"]["value"]
    assert by_shot, "expected an actual-cost rollup"
    for by_currency in by_shot.values():
        assert isinstance(by_currency, dict)
        assert all(isinstance(cur, str) for cur in by_currency)
    # the only cross-operation total is itself per-currency (no merged figure)
    assert set(item["actual_by_currency"]["value"]) == {"USD"}


def test_cost_drilldown_stage_step_time_dimensions(tmp_path, monkeypatch):
    """WQ-07 v1.1: cost also rolls up by step, stage and JST month (TASK-027).

    All are derived read-only projections over the same authoritative events —
    no writer change — and keep currencies in separate buckets.
    """
    account, root = _episode(tmp_path, monkeypatch)
    dto = _json(_app(account).handle(f"/api/projects/{root.name}/cost"))
    assert dto["contract_version"] == "1.3"
    item = dto["items"][0]
    for dim in ("by_step", "by_stage", "by_time"):
        assert item[dim]["provenance"] == "derived"
        assert item[dim]["value"], f"{dim} should carry the paid actual cost"
        for by_currency in item[dim]["value"].values():
            assert all(isinstance(cur, str) for cur in by_currency)
    # paid cost attributes to the single paid-generation step S4-T05 / stage S4
    assert set(item["by_step"]["value"]) == {"S4-T05"}
    assert set(item["by_stage"]["value"]) == {"S4"}
    # by_time buckets are YYYY-MM JST month keys
    assert all(len(k) == 7 and k[4] == "-" for k in item["by_time"]["value"]), item[
        "by_time"
    ]["value"]
    # every reconciled operation carries its authoritative cost timestamp
    paid_ops = [op for op in item["per_operation"]["value"] if op["actual"] is not None]
    assert paid_ops and all(op["occurred_at"] for op in paid_ops)


# --- read-only guards (source-level) -----------------------------------------


def test_backend_imports_only_public_query_contract():
    """The shell may import only the TASK-025 public query package.

    It must not reach into core-internal modules (providers, orchestrator,
    CLI write paths, business records) — importing any ``ai_video_workflow``
    submodule other than the public ``ai_video_workflow.workspace`` package
    would breach the ADR-0032 boundary.
    """
    allowed = {"ai_video_workflow.workspace"}
    for path in _SHELL_SRC.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            mods = []
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                mods = [node.module]
            for mod in mods:
                if mod.startswith("ai_video_workflow"):
                    assert mod in allowed, f"{path.name}: illegal core import {mod!r}"


def test_backend_has_no_write_or_provider_surface():
    """No write / provider / mutation identifier in executable shell code.

    Scans NAME tokens only, so prose in docstrings/comments is ignored and a
    real call to a filesystem-write, subprocess, or Provider symbol is what
    trips the guard.
    """
    import io
    import tokenize

    banned = {
        "Provider",
        "subprocess",
        "shutil",
        "popen",
        "system",
        "remove",
        "unlink",
        "rmtree",
        "mkdir",
        "rename",
        "replace",
        "write_text",
        "write_bytes",
        "write_model_json",
    }
    for path in _SHELL_SRC.rglob("*.py"):
        names = {
            tok.string
            for tok in tokenize.generate_tokens(
                io.StringIO(path.read_text(encoding="utf-8")).readline
            )
            if tok.type == tokenize.NAME
        }
        offenders = names & banned
        assert not offenders, f"{path.name} references write/provider names {offenders}"
    # the JS client issues no mutating fetch verb either
    js = (_SHELL_SRC / "static" / "app.js").read_text(encoding="utf-8")
    for verb in ("POST", "PUT", "DELETE", "PATCH"):
        assert f'"{verb}"' not in js and f"'{verb}'" not in js


# --- transport: loopback, methods, host guard, lifecycle ---------------------


def test_host_header_guard():
    assert _host_is_loopback("127.0.0.1:8760")
    assert _host_is_loopback("localhost")
    assert _host_is_loopback("[::1]:8760")
    assert _host_is_loopback("::1")
    assert _host_is_loopback(None)
    assert not _host_is_loopback("evil.example.com")
    assert not _host_is_loopback("192.168.1.5:8760")


def test_build_server_refuses_non_loopback_host(tmp_path):
    """Programmatic use cannot bind a routable interface (remote exposure)."""
    with pytest.raises(ValueError, match="loopback only"):
        build_server(tmp_path, host="0.0.0.0", port=0)
    with pytest.raises(ValueError, match="loopback only"):
        build_server(tmp_path, host="192.168.1.5", port=0)


def test_build_server_binds_ipv6_loopback(tmp_path):
    """The advertised ``::1`` host really binds (needs an AF_INET6 socket)."""
    server = build_server(tmp_path, host="::1", port=0)
    try:
        assert server.server_address[0] == "::1"
    finally:
        server.server_close()


def test_write_verbs_and_loopback_over_real_socket(tmp_path, monkeypatch):
    account, root = _episode(tmp_path, monkeypatch)
    server = build_server(account, port=0, clock=_clock)
    assert server.server_address[0] == "127.0.0.1"  # loopback only
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}"
        with urllib.request.urlopen(f"{base}/api/projects", timeout=5) as r:
            assert r.status == 200
            assert r.headers["Content-Security-Policy"]
            assert r.headers["X-Content-Type-Options"] == "nosniff"
            assert r.headers["Cache-Control"] == "no-store"
            assert r.headers["Cross-Origin-Resource-Policy"] == "same-origin"
        # an artifact is streamed byte-identical, with the sandbox CSP
        some_file = next(root.rglob("*.json"))
        rel = urllib.parse.quote(str(some_file.relative_to(account)))
        with urllib.request.urlopen(f"{base}/artifact?path={rel}", timeout=5) as r:
            assert r.status == 200
            assert "sandbox" in r.headers.get_all("Content-Security-Policy")
            assert r.read() == some_file.read_bytes()
        # a write verb is refused: there is no write endpoint. Its unread
        # request body must not poison the keep-alive connection, so the
        # server closes it (Connection: close) after the 405.
        req = urllib.request.Request(
            f"{base}/api/projects", method="POST", data=b"{}" * 64
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req, timeout=5)
        assert exc.value.code == 405
        assert exc.value.headers.get("Connection") == "close"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_stopping_server_leaves_core_files_untouched(tmp_path, monkeypatch):
    """ADR-0032 invariant 6: closing the backend never touches committed work."""
    account, root = _episode(tmp_path, monkeypatch)

    def snapshot() -> dict[str, int]:
        return {
            str(p.relative_to(account)): p.stat().st_size
            for p in sorted(account.rglob("*"))
            if p.is_file()
        }

    before = snapshot()
    server = build_server(account, port=0, clock=_clock)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    with urllib.request.urlopen(
        f"{base}/api/projects/{root.name}/plan", timeout=5
    ) as r:
        assert r.status == 200
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    assert snapshot() == before  # backend read nothing into existence, wrote nothing
