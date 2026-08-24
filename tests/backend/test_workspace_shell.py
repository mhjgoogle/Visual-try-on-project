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
import re
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests.symlink_support import symlink_or_skip
from tests.wfm1_scenario import _paid_all_shots, _run, _setup
from workspace_shell.app import WorkspaceApp
from workspace_shell.server import _host_is_loopback, build_server

_FIXED = datetime(2026, 8, 3, tzinfo=timezone.utc)
_SHELL_SRC = Path(__file__).resolve().parents[2] / "src" / "workspace_shell"


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
    symlink_or_skip(link, outside)
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


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="simulates a TOCTOU swap via os.readlink(/proc/self/fd), which is "
    "the POSIX check; the Windows branch re-resolves the path instead — ADR-0049",
)
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


# --- WQ-12 reuse-usage (TASK-027 part-2b) -------------------------------------


def test_reuse_usage_is_reachable_and_account_scoped(tmp_path, monkeypatch):
    """part-2b 的「下游使用」页要问的是**跨项目**的事实。

    查询层早有 `reuse_usage`，但壳里**没有任何路由通向它** —— 那个页面因此
    拿不到数据。挂在 `/api/reuse-usage`（账户级）而不是
    `/api/projects/<name>/…`：挂到某个项目下面会暗示「这是那个项目的事实」，
    而它恰恰是跨项目的。
    """
    account, _root = _episode(tmp_path, monkeypatch)
    res = _app(account).handle("/api/reuse-usage?asset_id=pack-a&version=1")
    # 资产不存在时是 200 + readiness 失败的 problem 信封，不是 404：
    # 「这个复用包不存在」本身就是这条查询要回答的东西之一
    assert res.status == 200, res.body
    body = _json(res)
    assert body["query_id"] == "WQ-12"
    assert body["contract_version"] == "1.6"


def test_reuse_usage_refuses_a_missing_or_unusable_version(tmp_path, monkeypatch):
    """`version` 拿不准时**报错，不猜**。

    强制成正整数：非数字、0、负数一律 400。默默当成 0 或「最新那一版」
    正是一次复用审计答到错版本上去的方式 —— 而这个页面的全部意义就是
    「**这一版**被谁用了」。
    """
    account, _root = _episode(tmp_path, monkeypatch)
    app = _app(account)
    for query, why in (
        ("?version=1", "缺 asset_id"),
        ("?asset_id=pack-a", "缺 version"),
        ("?asset_id=pack-a&version=", "version 空"),
        ("?asset_id=pack-a&version=latest", "version 非数字"),
        ("?asset_id=pack-a&version=0", "version 为 0"),
        ("?asset_id=pack-a&version=-1", "version 为负"),
        ("?asset_id=pack-a&version=1.5", "version 非整数"),
    ):
        res = app.handle(f"/api/reuse-usage{query}")
        assert res.status == 400, f"{why}：期望 400，得到 {res.status}"
        assert _json(res)["error"]["category"] == "bad_request", why


def test_reuse_usage_refuses_a_repeated_parameter(tmp_path, monkeypatch):
    """`?version=1&version=2` 是**歧义**，不是一个可以挑的列表。

    静默取第一个，正是一次复用审计报到没人问过的那一版上去的方式 ——
    而「哪一版」就是这条查询的全部主题（codex 轮 1 非阻塞）。
    """
    account, _root = _episode(tmp_path, monkeypatch)
    app = _app(account)
    for query, why in (
        ("?asset_id=pack-a&version=1&version=2", "version 给了两次"),
        ("?asset_id=a&asset_id=b&version=1", "asset_id 给了两次"),
    ):
        res = app.handle(f"/api/reuse-usage{query}")
        assert res.status == 400, f"{why}：期望 400，得到 {res.status}"
        assert _json(res)["error"]["category"] == "bad_request", why


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
    assert dto["contract_version"] == "1.6"
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
    """The shell may import only the public read (query) + write (Gateway) paths.

    It must not reach into core-internal modules (providers, orchestrator, CLI
    write paths, business records). The read side is the TASK-025 query package;
    the write side (TASK-031) is the public Command Gateway package plus the
    approved WFM1 command factory — never a Provider or a direct business writer.
    ``ai_video_workflow.errors`` (the base exception) is allowed for fail-closed
    handling.
    """
    allowed = {
        "ai_video_workflow.workspace",
        "ai_video_workflow.gateway",
        "ai_video_workflow.app.gateway_commands",
        "ai_video_workflow.errors",
    }
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
    # the JS client's ONLY mutating verb is POST (the Gateway write path,
    # TASK-031); PUT/DELETE/PATCH never appear.
    js = (_SHELL_SRC / "static" / "app.js").read_text(encoding="utf-8")
    for verb in ("PUT", "DELETE", "PATCH"):
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
        # PUT/PATCH/DELETE remain refused outright (no such endpoints). Their
        # unread body must not poison keep-alive, so the server closes it.
        for verb in ("PUT", "PATCH", "DELETE"):
            req = urllib.request.Request(
                f"{base}/api/projects", method=verb, data=b"{}" * 64
            )
            with pytest.raises(urllib.error.HTTPError) as exc:
                urllib.request.urlopen(req, timeout=5)
            assert exc.value.code == 405
            assert exc.value.headers.get("Connection") == "close"
        # POST is the Gateway write path (TASK-031): a non-command path is a
        # structured 404 (not 405), and its body IS read so keep-alive stays sane.
        req = urllib.request.Request(f"{base}/api/projects", method="POST", data=b"{}")
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req, timeout=5)
        assert exc.value.code == 404
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


# --- TASK-052 §2.2: a declared-but-undelivered body must not pin the thread ---


def _serve_in_background(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


def test_declared_body_never_delivered_is_bounded(tmp_path, monkeypatch):
    """A byte cap alone does not close this: the client declares a perfectly
    legal small Content-Length and then sends nothing. Before TASK-052 §2.2 the
    drain loop waited on that socket forever and the handler thread was gone for
    good (slowloris). The bound must make the server answer and let go.
    """
    import socket as socket_mod

    from workspace_shell import server as server_mod

    # Shrink both bounds so the test asserts the mechanism, not the wall clock.
    monkeypatch.setattr(server_mod, "_BODY_DEADLINE_SECONDS", 0.5)
    monkeypatch.setattr(server_mod._Handler, "timeout", 0.5)

    httpd = server_mod.build_server(tmp_path, port=0, clock=_clock)
    host, port = httpd.server_address[0], httpd.server_address[1]
    _serve_in_background(httpd)
    try:
        with socket_mod.create_connection((host, port), timeout=10) as sock:
            sock.sendall(
                b"POST /api/anything HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Length: 5000\r\n"
                b"\r\n"
                # ...and then not one byte of the 5000 promised.
            )
            sock.settimeout(10)
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
    finally:
        httpd.shutdown()
        httpd.server_close()

    # It answered rather than hanging. Which refusal it is (405 for the verb,
    # 408 for the body) is not the point — that it CAME BACK is.
    assert head.startswith(b"HTTP/1.1 "), head[:80]
    assert b" 405 " in head or b" 408 " in head, head[:120]


def test_read_bounded_gives_up_on_a_slow_drip(monkeypatch):
    """The per-read socket timeout cannot catch this one: every individual read
    arrives in time, the body just never finishes. Only the total deadline does.
    """
    from workspace_shell import server as server_mod

    monkeypatch.setattr(server_mod, "_BODY_DEADLINE_SECONDS", 0.3)

    class _DripFile:
        """One byte per read, promptly — forever, up to a hard stop.

        The hard stop is what makes a REGRESSION fail fast instead of hanging
        the suite: without the deadline the read loop never ends, so a bare
        `return b"x"` would turn this test into a 60-second timeout instead of
        a red assertion (verified by mutation — removing the deadline check
        made the run hit the harness timeout at exit 124).
        """

        LIMIT = 2000

        def __init__(self):
            self.reads = 0

        def read(self, _n):
            # The real rfile is a BufferedReader, whose read(n) blocks until it
            # has ALL n bytes. If _read_bounded calls this, one call parks for
            # as long as the peer likes and the deadline is never rechecked --
            # the bound is present and useless (codex review, TASK-052 §2.2).
            raise AssertionError(
                "_read_bounded must use read1(): read() blocks until n bytes "
                "and starves the deadline check"
            )

        def read1(self, _n):
            self.reads += 1
            if self.reads > self.LIMIT:
                raise AssertionError(
                    f"_read_bounded kept reading past {self.LIMIT} chunks — "
                    "the total deadline is not bounding the drip (TASK-052 §2.2)"
                )
            time.sleep(0.001)
            return b"x"

    handler = object.__new__(server_mod._Handler)
    handler.close_connection = False
    handler.rfile = _DripFile()

    started = time.monotonic()
    out = handler._read_bounded(10_000_000)
    elapsed = time.monotonic() - started

    assert out is None, "a body that never finishes must not be returned"
    assert handler.close_connection is True
    assert elapsed < 5, f"deadline did not fire (took {elapsed:.1f}s)"
    assert handler.rfile.reads > 1, "the drip should have been read, then cut off"
    # `_DripFile.read` raises if called, so reaching here also proves the
    # single-syscall path (`read1`) is the one in use.


def test_slow_headers_do_not_pin_the_handler(tmp_path, monkeypatch):
    """The body bound cannot reach this one: the request line and headers are
    read inside http.server, where no deadline of ours is consulted. Only the
    connection watchdog closes it (codex review round 2, TASK-052 §2.2).
    """
    import socket as socket_mod

    from workspace_shell import server as server_mod

    monkeypatch.setattr(server_mod, "_CONNECTION_DEADLINE_SECONDS", 1.0)
    # Deliberately LONGER than the watchdog: this test must prove the watchdog
    # is what cuts the connection, not the per-read socket timeout.
    monkeypatch.setattr(server_mod._Handler, "timeout", 30.0)

    httpd = server_mod.build_server(tmp_path, port=0, clock=_clock)
    host, port = httpd.server_address[0], httpd.server_address[1]
    _serve_in_background(httpd)
    try:
        with socket_mod.create_connection((host, port), timeout=20) as sock:
            # A request that never ends: header bytes trickle, no blank line.
            sock.sendall(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            started = time.monotonic()
            sock.settimeout(20)
            while True:
                sock.sendall(b"X-Pad: x\r\n")
                try:
                    if not sock.recv(4096):
                        break  # server hung up — the watchdog fired
                except OSError:
                    break  # connection reset by the shutdown — same thing
                if time.monotonic() - started > 15:
                    raise AssertionError(
                        "the connection watchdog never fired — slow headers "
                        "still pin the handler (TASK-052 §2.2)"
                    )
                time.sleep(0.05)
            elapsed = time.monotonic() - started
    finally:
        httpd.shutdown()
        httpd.server_close()

    assert elapsed < 15, f"watchdog too slow ({elapsed:.1f}s)"


def test_keep_alive_survives_past_the_watchdog_window(tmp_path, monkeypatch):
    """The watchdog must bound a REQUEST, not the conversation.

    Arming it once per connection cut well-behaved keep-alive clients loose at
    the deadline (codex review round 3) — a guard that starts failing real
    traffic is worse than the drip it was added to stop. Several quick requests
    spanning more than one watchdog window must all be answered on ONE socket.
    """
    import socket as socket_mod

    from workspace_shell import server as server_mod

    # The gap between requests must sit COMFORTABLY under the budget and the
    # whole conversation comfortably over it. The budget starts when we begin
    # waiting for a request, not when its first byte lands (that wait has to be
    # inside the window, or a header drip would escape it — round 2), so tuning
    # the gap right up against the deadline makes this test flaky rather than
    # strict. In production the two never collide: an idle keep-alive socket is
    # closed by `timeout` (10s) long before the 60s watchdog.
    monkeypatch.setattr(server_mod, "_CONNECTION_DEADLINE_SECONDS", 1.5)
    httpd = server_mod.build_server(tmp_path, port=0, clock=_clock)
    host, port = httpd.server_address[0], httpd.server_address[1]
    _serve_in_background(httpd)
    answered = 0
    try:
        with socket_mod.create_connection((host, port), timeout=10) as sock:
            sock.settimeout(10)
            for _ in range(6):
                sock.sendall(b"GET /api/meta HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                buf = b""

                def _pull(so_far=answered):
                    chunk = sock.recv(4096)
                    if not chunk:
                        raise AssertionError(
                            f"connection dropped after {so_far} request(s) — "
                            "the watchdog is bounding the CONNECTION, not the "
                            "request (TASK-052 §2.2)"
                        )
                    return chunk

                while b"\r\n\r\n" not in buf:
                    buf += _pull()
                head, _, rest = buf.partition(b"\r\n\r\n")
                assert head.startswith(b"HTTP/1.1 "), head[:60]
                # Drain the BODY too. Leaving it in the socket makes the next
                # response start behind the previous one's bytes — an earlier
                # version of this test did exactly that and then blamed the
                # server for its own bookkeeping.
                match = re.search(rb"[Cc]ontent-[Ll]ength:\s*(\d+)", head)
                want = int(match.group(1)) if match else 0
                while len(rest) < want:
                    rest += _pull()
                answered += 1
                # Straddle the watchdog window between requests.
                time.sleep(0.5)
    finally:
        httpd.shutdown()
        httpd.server_close()

    assert answered == 6, f"only {answered} of 6 requests were answered"


def test_a_slow_application_is_not_cut_off(tmp_path, monkeypatch):
    """The watchdog bounds time spent WAITING ON THE PEER, nothing else.

    Leaving it armed across application execution disconnected legitimate slow
    requests mid-flight (codex review round 4) — and on the write path that is
    a client-visible failure over a mutation that already happened. A slow
    application is our own problem, not a slowloris.
    """
    import urllib.error

    from workspace_shell import server as server_mod

    monkeypatch.setattr(server_mod, "_CONNECTION_DEADLINE_SECONDS", 0.3)

    httpd = server_mod.build_server(tmp_path, port=0, clock=_clock)
    host, port = httpd.server_address[0], httpd.server_address[1]

    real_handle = httpd.app.handle

    def slow_handle(path):
        time.sleep(1.5)  # five watchdog windows of pure application time
        return real_handle(path)

    httpd.app.handle = slow_handle
    _serve_in_background(httpd)
    try:
        with urllib.request.urlopen(
            f"http://{host}:{port}/api/projects", timeout=20
        ) as r:
            status, body = r.status, r.read()
    except (urllib.error.URLError, ConnectionError) as exc:
        raise AssertionError(
            f"the watchdog cut a slow APPLICATION off ({exc}) — it must only "
            "bound waiting on the peer (TASK-052 §2.2)"
        ) from exc
    finally:
        httpd.shutdown()
        httpd.server_close()

    assert status == 200
    assert body, "a slow but successful request must still deliver its body"


def test_a_superseded_watchdog_callback_does_nothing():
    """Timer.cancel() only stops a timer that has not STARTED. A callback
    already on its way runs anyway, and before the generation guard it would
    shut the socket down after the header deadline was cancelled and the
    application had begun — losing the response to a request whose mutation had
    already happened (codex review round 5).
    """
    from workspace_shell import server as server_mod

    handler = object.__new__(server_mod._Handler)
    handler._watchdog = None
    handler._cancel_watchdog()
    stale_generation = handler._watchdog_generation
    handler._cancel_watchdog()  # a newer window opened; the old one is over

    class _Socket:
        def shutdown(self, _how):
            raise AssertionError(
                "a superseded watchdog callback must not touch the socket"
            )

    handler.connection = _Socket()
    handler.close_connection = False
    handler._force_close(stale_generation)
    assert handler.close_connection is False

    # ...and the CURRENT generation still closes, or the guard would be inert.
    closed = []
    handler.connection = type(
        "S", (), {"shutdown": lambda self, how: closed.append(how)}
    )()
    handler._force_close(handler._watchdog_generation)
    assert handler.close_connection is True
    assert closed, "the live watchdog must still shut the socket down"
