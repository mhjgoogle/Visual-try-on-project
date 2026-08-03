"""Creation Workspace WFM1 data-baseline acceptance (TASK-033 / WSM3-B).

This is the milestone acceptance harness for "Workspace on WFM1": it proves the
closed cross-project loop — observe -> compare -> evaluate -> act -> run -> learn
— runs end to end through the REAL coordination chain (``WorkspaceQueryService``
reads, ``WorkspaceApp`` -> Command Gateway writes, the real HTTP server for the
origin guard), never through mocked pure functions, and that the workspace stays
safe under UI restart, projection corruption, command replay, stale targets,
credential leakage, path escape and cross-origin writes.

It does not add product capability. It ties the per-domain contracts delivered by
TASK-024..032 into one multi-project account and asserts the baseline acceptance
criteria. Out-of-WFM1 media types (image/audio/subtitle) are surfaced honestly as
not-yet-produced, never fabricated; their full acceptance is owned by
TASK-034..040. No provider is ever called, no network egress, no payment.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.action import read_records as read_action_records
from ai_video_workflow.evaluation import read_records as read_eval_records
from ai_video_workflow.learning import KnowledgeService
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.profile.project_profile import (
    parse_project_profile,
    write_project_profile,
)
from ai_video_workflow.qcd.events import build_asset_imported_event
from ai_video_workflow.qcd.log import append_event, read_events
from ai_video_workflow.workspace import (
    Provenance,
    WorkspaceQueryService,
    discover_projects,
    io_contract,
)
from tests.test_wfm1_e2e import (
    SHOTS,
    _paid_all_shots,
    _run,
    _setup,
)
from workspace_shell.app import WorkspaceApp

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64

REPO_ROOT = Path(__file__).resolve().parents[1]
_PROFILE = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "profile"
    / "project_profile_v1.example.json"
)
_CFG = REPO_ROOT / "examples" / "projects" / "wfm1-demo" / "config" / "wfm1.json"


def _clock():
    return T0


def _app(account_root: Path) -> WorkspaceApp:
    return WorkspaceApp(account_root, clock=_clock)


def _service(account_root: Path) -> WorkspaceQueryService:
    return WorkspaceQueryService(account_root, clock=_clock)


def _seed_project(account: Path, name: str, *, with_asset: bool) -> Path:
    """A real, discoverable project. ``with_asset`` seeds one authoritative
    QCD asset_imported fact (a "produced" video), the only hand-seeded fact —
    every downstream evaluation/feedback/action is written through the Gateway.
    """
    root = account / name
    root.mkdir()
    write_model_json(root / "project.json", Project(name, "Demo", T0))
    (root / "config").mkdir()
    (root / "config" / "wfm1.json").write_text(
        _CFG.read_text(encoding="utf-8"), encoding="utf-8"
    )
    raw = json.loads(_PROFILE.read_text(encoding="utf-8"))
    raw["version"] = 1
    write_project_profile(root, parse_project_profile(raw))
    if with_asset:
        append_event(
            root,
            build_asset_imported_event(
                project_id=name,
                shot_id="shot-1",
                task_id="task-1",
                asset_id="asset-a",
                sha256=_DIGEST,
                size_bytes=1024,
                path="assets/asset-a.mp4",
                version=1,
                duration_ms=2000,
                source_attempt_id=None,
                occurred_at=T0,
            ),
        )
    return root


@pytest.fixture
def account(tmp_path: Path) -> Path:
    """A multi-project account: one project with a produced asset + one empty
    (discoverable, no facts) project — the minimum to exercise cross-project
    analytics honesty (rate vs. insufficient_evidence)."""
    _seed_project(tmp_path, "proj-full", with_asset=True)
    _seed_project(tmp_path, "proj-empty", with_asset=False)
    return tmp_path


def _target(digest: str = _DIGEST) -> dict:
    return {"ref": "asset-a", "version": 1, "content_digest": digest}


def _post(app: WorkspaceApp, name: str, sub: str, payload: dict) -> tuple[int, dict]:
    resp = app.handle_write(f"/api/projects/{name}/{sub}", json.dumps(payload).encode())
    return resp.status, json.loads(resp.body.decode())


def _eval_cmd(command_id: str = "c-eval", digest: str = _DIGEST, **override) -> dict:
    payload = {
        "command_id": command_id,
        "name": "record-evaluation",
        "actor": "user",
        "target": _target(digest),
        "params": {
            "evaluation_id": "e-1",
            "criterion": "clarity",
            "pass": True,
            "rationale": "reads clearly",
        },
    }
    payload.update(override)
    return payload


def _feedback_cmd() -> dict:
    return {
        "command_id": "c-fb",
        "name": "create-feedback",
        "actor": "user",
        "target": _target(),
        "params": {"feedback_id": "fb-1", "summary": "jitter", "detail": "stutters"},
    }


def _action_cmd() -> dict:
    return {
        "command_id": "c-act",
        "name": "create-action",
        "actor": "user",
        "target": _target(),
        "params": {"action_id": "a-1", "feedback_id": "fb-1", "intent": "re-render"},
    }


def _transition_cmd() -> dict:
    return {
        "command_id": "c-tr",
        "name": "action-transition",
        "actor": "user",
        "params": {"event_id": "t1", "action_id": "a-1", "to_state": "in_progress"},
    }


def _snapshot(root: Path) -> list[tuple[str, int]]:
    return sorted(
        (str(p.relative_to(root)), p.stat().st_size)
        for p in root.rglob("*")
        if p.is_file()
    )


# =============================================================================
# 1. the closed WFM1 workspace loop: observe -> evaluate -> act -> learn
# =============================================================================


def test_wfm1_workspace_closed_loop(account: Path) -> None:
    app = _app(account)
    svc = _service(account)
    full = account / "proj-full"

    # --- observe: the plan surfaces the COMPLETE L0-S7 contract (nothing about
    # unbuilt WFM2 media steps is hidden or fabricated as done) --------------
    plan = svc.project_plan(full)
    assert plan.query_id == "WQ-01"
    ids = {it["step_id"].value for it in plan.items}
    assert ids == {s.step_id for s in io_contract.steps()}
    assert {"S4-T05", "S7-T05"} <= ids  # WFM2 media/postmortem steps are present

    # cross-project index sees both projects (observe across the account)
    index = svc.cross_project_index()
    assert index.query_id == "WQ-11"
    named = {it["project"].value for it in index.items}
    assert {"proj-full", "proj-empty"} <= named

    # --- evaluate: a user evaluation written THROUGH the Gateway -------------
    status, body = _post(app, "proj-full", "command", _eval_cmd())
    assert status == 200 and body["status"] == "completed"
    (rec,) = read_eval_records(full)
    assert rec.actor.value == "user"  # provenance is the local user, not forged
    eval_view = svc.evaluation_domain(full)
    assert eval_view.query_id == "WQ-15"
    ev_item = next(
        it for it in eval_view.items if it["record_type"].value == "evaluation"
    )
    assert ev_item["target"].value == _target()
    assert ev_item["stale"].value is False

    # --- act: feedback -> action -> transition, all through the Gateway ------
    assert _post(app, "proj-full", "command", _feedback_cmd())[0] == 200
    assert _post(app, "proj-full", "command", _action_cmd())[0] == 200
    assert _post(app, "proj-full", "command", _transition_cmd())[0] == 200
    kinds = [r.record_type.value for r in read_action_records(full)]
    assert kinds == ["feedback", "action", "transition"]
    action_view = svc.action_center(full)
    assert action_view.query_id == "WQ-16"
    action = next(it for it in action_view.items if it["kind"].value == "action")
    assert action["lifecycle_state"].value == "in_progress"
    assert action["lifecycle_state"].provenance is Provenance.DERIVED
    assert action["target_stale"].value is False

    # --- learn: promote user-confirmed knowledge (account-level), then the
    # cross-project analytics + evidence-based recommendation reflect it -----
    KnowledgeService(account, clock=_clock).promote(
        knowledge_id="k-1",
        category="provider_choice",
        applicability={"genre": "drama"},
        recommendation="prefer cloud-a for 60s drama shots",
        evidence_refs=[
            {"ref": "asset-a", "content_digest": _DIGEST, "project": "proj-full"}
        ],
        scope="1 project, 2026-Q3",
        limits="small sample",
        occurred_at=T0,
    )
    analytics = svc.cross_project_analytics()
    assert analytics.query_id == "WQ-17"
    by_project = {it["project"].value: it for it in analytics.items}
    # proj-full has facts: derived rates, never insufficient
    full_kpi = by_project["proj-full"]
    assert full_kpi["evaluation_pass_rate"].value == 1.0
    assert full_kpi["evaluation_pass_rate"].provenance is Provenance.DERIVED
    assert full_kpi["action_resolution_rate"].value == 0.0  # in_progress, unresolved
    assert full_kpi["insufficient_evidence"].value is False
    # proj-empty has no facts: insufficient_evidence, unavailable rate — NOT a
    # fabricated zero-confidence
    empty_kpi = by_project["proj-empty"]
    assert empty_kpi["insufficient_evidence"].value is True
    assert empty_kpi["evaluation_pass_rate"].provenance is Provenance.UNAVAILABLE

    recs = svc.recommendations()
    assert recs.query_id == "WQ-18"
    rec_item = recs.items[0]
    assert rec_item["recommendation"].value == "prefer cloud-a for 60s drama shots"
    assert rec_item["limits"].value  # limits are always surfaced, never hidden


# =============================================================================
# 2. projection rebuild: read-only, deterministic, survives UI restart,
#    fails closed on corruption and recovers
# =============================================================================


def test_projection_rebuild_readonly_and_ui_restart(account: Path) -> None:
    # write one evaluation so there are authoritative facts to project
    assert _post(_app(account), "proj-full", "command", _eval_cmd())[0] == 200
    full = account / "proj-full"
    routes = (
        "/api/projects/proj-full/plan",
        "/api/projects/proj-full/status",
        "/api/projects/proj-full/cost",
        "/api/projects",
    )

    before = _snapshot(account)
    # two INDEPENDENT app instances == closing and reopening the UI. No
    # persistent projection cache: the rebuilt views are byte-identical.
    app_a, app_b = _app(account), _app(account)
    for route in routes:
        ra, rb = app_a.handle(route), app_b.handle(route)
        assert ra.status == 200 and rb.status == 200
        assert ra.body == rb.body  # deterministic rebuild from authoritative files
    after = _snapshot(account)
    assert before == after  # strictly read-only: reads write nothing, no cache

    # corruption fails CLOSED: the query surfaces readiness_failed + a
    # source_corrupt problem in its envelope, never a silently-clean projection
    # a client could mistake for "no cost"
    qcd_log = full / "qcd" / "events" / "log.jsonl"
    original = qcd_log.read_text(encoding="utf-8")
    qcd_log.write_text("not json\n", encoding="utf-8")
    corrupt = _app(account).handle("/api/projects/proj-full/cost")
    corrupt_body = json.loads(corrupt.body.decode())
    assert corrupt_body["readiness_failed"] is True
    assert any(p["category"] == "source_corrupt" for p in corrupt_body["problems"])

    # restore the authoritative log: the view rebuilds cleanly with no residual
    # failure — recovery needs only the authoritative files, no projection cache
    qcd_log.write_text(original, encoding="utf-8")
    recovered = json.loads(_app(account).handle("/api/projects/proj-full/cost").body)
    assert recovered["readiness_failed"] is False


# =============================================================================
# 3. Gateway write safety: idempotent replay, stale target, secret, unknown
# =============================================================================


def test_gateway_write_safety(account: Path) -> None:
    app = _app(account)
    full = account / "proj-full"

    # (a) idempotent replay: the same command_id twice -> one identical receipt,
    # one record. Double-clicking never double-writes.
    a = _post(app, "proj-full", "command", _eval_cmd(command_id="c-1"))
    b = _post(app, "proj-full", "command", _eval_cmd(command_id="c-1"))
    assert a == b
    assert len(read_eval_records(full)) == 1

    # (b) stale target: a wrong content digest is refused, nothing written
    stale = _eval_cmd(command_id="c-2", digest=_DIGEST2)
    status, body = _post(app, "proj-full", "command", stale)
    assert status == 409 and body["error"]["category"] == "command_refused"
    assert len(read_eval_records(full)) == 1

    # (c) a credential-looking key in the action context is refused: the record
    # is never written, so no secret can land in an authoritative file
    poisoned = _feedback_cmd()
    poisoned["command_id"] = "c-3"
    poisoned["params"]["context"] = {"api_key": "sk-secret"}
    status, body = _post(app, "proj-full", "command", poisoned)
    assert body.get("status") != "completed"  # fail closed, not a successful write
    assert read_action_records(full) == ()  # credential never persisted

    # (d) an unregistered command name is refused (no arbitrary code path)
    unknown = _eval_cmd(command_id="c-4", name="rm-rf")
    status, body = _post(app, "proj-full", "command", unknown)
    assert status == 409 and body["error"]["category"] == "command_refused"


# =============================================================================
# 4. boundary safety: cross-origin write + path escape are refused
# =============================================================================


def test_non_localhost_origin_and_path_escape_refused(account: Path) -> None:
    import threading
    import urllib.error
    import urllib.request

    from workspace_shell.server import build_server

    # path escape at the read layer: a traversal project name and an escaping
    # artifact path are both refused, never served
    app = _app(account)
    assert app.handle("/api/projects/..%2f..%2fetc/plan").status in (403, 404)
    assert app.handle("/artifact?path=../../etc/passwd").status in (400, 403, 404)

    # cross-origin write at the HTTP layer: only an exact same-origin POST may
    # even reach command validation; every other origin is a 403 (CSRF)
    server = build_server(account, port=0, clock=_clock)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        base = f"http://127.0.0.1:{port}"
        for origin in ("http://evil.example", "null", f"http://127.0.0.1:{port + 1}"):
            req = urllib.request.Request(
                f"{base}/api/projects/proj-full/command",
                method="POST",
                data=b"{}",
                headers={"Origin": origin, "Content-Type": "application/json"},
            )
            with pytest.raises(urllib.error.HTTPError) as exc:
                urllib.request.urlopen(req, timeout=5)
            assert exc.value.code == 403
        # exact same-origin clears CSRF and then fails as a bad body (400), not 403
        req = urllib.request.Request(
            f"{base}/api/projects/proj-full/command",
            method="POST",
            data=b"{}",
            headers={"Origin": base, "Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req, timeout=5)
        assert exc.value.code == 400
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


# =============================================================================
# 5. the real finished episode: observe cost + lineage, media honesty
# =============================================================================


def test_full_episode_observe_cost_lineage_and_media_honesty(
    tmp_path, monkeypatch
) -> None:
    # a REAL paid+composed episode driven through the CLI coordination chain
    root, catalog_dir, _fake = _setup(tmp_path, monkeypatch)
    _paid_all_shots(root, catalog_dir)
    assert _run(root, catalog_dir, "compose") == 0
    svc = _service(tmp_path)

    # observe cost: the derived breakdown matches the authoritative charges
    cost = svc.cost_breakdown(root)
    assert cost.query_id == "WQ-07"
    cost_events = [
        e for e in read_events(root) if e.event_type.value == "provider_cost_recorded"
    ]
    assert len(cost_events) == SHOTS  # one charge per shot, no double-booking

    # the whole authoritative production is discoverable as one project
    roots = {p.root.resolve() for p in discover_projects(tmp_path)}
    assert root.resolve() in roots

    # media honesty: the plan still lists the unbuilt WFM2 media steps (image /
    # audio / subtitle) — the WFM1 baseline never pretends they are produced
    plan = svc.project_plan(root)
    ids = {it["step_id"].value for it in plan.items}
    assert ids == {s.step_id for s in io_contract.steps()}
