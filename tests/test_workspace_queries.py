"""Read-only workspace query layer tests (TASK-025 / WSM1-A).

Drives the real WQ-01..WQ-14 queries against a real finished episode built
through the CLI coordination chain (reusing the E2E fixtures), plus the
fail-closed / determinism / read-only / cross-project cases the query
contract and TASK-025 require. No provider is ever called (fakes only), no
real payment, no network.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.workspace import (
    QUERY_CONTRACT_VERSION,
    Provenance,
    WorkspaceQueryService,
    discover_projects,
)
from tests.test_wfm1_e2e import (
    SHOTS,
    _approve,
    _compile,
    _paid_all_shots,
    _run,
    _setup,
)

_FIXED = datetime(2026, 8, 3, 0, 0, 0, tzinfo=timezone.utc)


def _clock():
    return _FIXED


def _service(account_root: Path) -> WorkspaceQueryService:
    return WorkspaceQueryService(account_root, clock=_clock)


def _finished(tmp_path: Path, monkeypatch) -> tuple[Path, Path, Path]:
    """A full paid+composed+QC'd+released episode; returns (account, root, catalog)."""
    root, catalog_dir, _fake = _setup(tmp_path, monkeypatch)
    _paid_all_shots(root, catalog_dir)
    assert _run(root, catalog_dir, "compose") == 0
    assert _run(root, catalog_dir, "qc-run") == 0
    assert (
        _run(
            root,
            catalog_dir,
            "qc-review",
            "--verdict",
            "pass",
            "--by",
            "owner",
            "--reason",
            "meets the goals baseline",
        )
        == 0
    )
    _approve(root, catalog_dir, "assets_ready", "qc/technical_qc_v1.json")
    _approve(root, catalog_dir, "assembly_done", "reports/composition/final_v1.json")
    _approve(root, catalog_dir, "qc_release", "qc/final_review_v1.json")
    assert _run(root, catalog_dir, "package-release") == 0
    return tmp_path, root, catalog_dir


# --- WQ-01 / WQ-02 plan + status ---------------------------------------------


def test_wq01_plan_returns_full_l0_s7_step_contract_even_unrun(tmp_path, monkeypatch):
    from ai_video_workflow.workspace import io_contract

    # an unrun project still returns the COMPLETE L0-S7 step plan
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.project_plan(root)
    assert res.query_id == "WQ-01"
    assert res.contract_version == QUERY_CONTRACT_VERSION
    assert res.generated_at == _FIXED.isoformat()
    # every I/O contract step is present with its definition fields
    ids = {it["step_id"].value for it in res.items}
    assert ids == {s.step_id for s in io_contract.steps()}
    assert {"Project-Init", "L0-01", "L0-07", "S1-T07", "S4-T05", "S7-T05"} <= ids
    for it in res.items:
        for field in (
            "level",
            "title",
            "execution",
            "required_inputs",
            "logical_outputs",
            "responsibility",
            "completion",
        ):
            assert it[field].provenance is Provenance.AUTHORITATIVE
    # unimplemented steps' RUN instance is unavailable; definition stays A
    l0_01 = next(it for it in res.items if it["step_id"].value == "L0-01")
    assert l0_01["run_status"].provenance is Provenance.UNAVAILABLE
    assert l0_01["execution"].value == "required"
    # implemented approval stage carries an authoritative run status
    concept = next(it for it in res.items if it["step_id"].value == "L0-07")
    assert concept["run_status"].provenance is Provenance.AUTHORITATIVE
    # the L0->S1 gate is attached to concept lock
    assert concept["gate"].value is not None
    assert "contains_unavailable" in res.markers


def test_wq02_status_tracks_progress_running_and_reason(tmp_path, monkeypatch):
    # _setup approves concept..production_lock, so assets_ready is running and
    # later stages are blocked with a reason naming their prerequisites
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.project_status(root)
    by_stage = {it["stage_id"].value: it for it in res.items}
    assert res.scope["current_stage"] == "assets_ready"
    assert 0.0 < res.scope["progress"] < 1.0
    assert by_stage["assets_ready"]["running"].value is True
    # a downstream stage is blocked and its reason names the prerequisite
    assembly = by_stage["assembly_done"]
    assert assembly["blocked_by"].value == ["assets_ready"]
    assert "assets_ready" in assembly["reason"].value


# --- WQ-03 / WQ-04 lineage ----------------------------------------------------


def test_wq03_upstream_from_asset(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    data = cli._load_project_data(root)
    asset_id = data.video_assets[0].asset_id
    res = svc.lineage_upstream(root, asset_id)
    assert res.items and not res.readiness_failed
    assert res.items[0]["producing_task"].provenance is Provenance.AUTHORITATIVE


def test_wq03_orphan_artifact_fails_closed(tmp_path, monkeypatch):
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.lineage_upstream(root, "no-such-asset")
    assert res.readiness_failed
    assert "readiness_failed" in res.markers


def test_wq04_downstream_of_task(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.lineage_downstream(root, "task-shot-1-1")
    kinds = {it["consumer_kind"].value for it in res.items}
    assert "video_asset" in kinds  # the task produced an asset


# --- WQ-05 prompt-history -----------------------------------------------------


def test_wq05_prompt_history_full_results_and_media_unavailable(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.prompt_history(root, "p-main")
    assert res.items
    first = res.items[0]
    assert first["version"].provenance is Provenance.AUTHORITATIVE
    assert first["image_audio_subtitle_results"].provenance is Provenance.UNAVAILABLE
    assert first["generation_packets"].value  # references its packets
    assert first["all_results"].value  # settled operations for its shots
    assert first["selected_results"].value  # registered formal assets
    assert first["downstream_products"].provenance is Provenance.DERIVED


# --- WQ-06 shot-attempts ------------------------------------------------------


def test_wq06_shot_attempts_distinguishes_kind_and_reason(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.shot_attempts(root, "shot-1")
    assert res.items
    op = res.items[0]
    assert op["status"].value == "committed"
    assert op["attempt_kind"].value == "primary"
    assert op["attempt_kind"].provenance is Provenance.DERIVED
    assert "reason" in op and op["provider_id"].provenance is Provenance.AUTHORITATIVE


# --- WQ-07 cost-breakdown -----------------------------------------------------


def test_wq07_cost_breakdown_per_operation_and_derived_rollups(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.cost_breakdown(root)
    item = res.items[0]
    # per-operation facts are authoritative; rollups/JPY are DERIVED (not A)
    assert item["per_operation"].provenance is Provenance.AUTHORITATIVE
    assert len(item["per_operation"].value) == SHOTS
    op0 = item["per_operation"].value[0]
    assert op0["actual"]["cost_minor_units"] == 10  # raw authoritative amount
    assert item["by_shot"].provenance is Provenance.DERIVED
    assert item["by_provider"].provenance is Provenance.DERIVED
    assert item["actual_by_currency"].provenance is Provenance.DERIVED  # aggregate
    assert item["actual_by_currency"].value.get("USD") == SHOTS * 10
    assert item["actual_total_jpy"].provenance is Provenance.DERIVED
    assert item["actual_total_jpy"].value == SHOTS * 16
    assert not res.readiness_failed  # a clean episode reconciles
    # v1.1 (TASK-027): step/stage/time rollups are derived projections over the
    # same events — paid cost books at the paid_generation step S4-T05 / stage
    # S4, and by_time buckets by JST month; per-op carries its cost timestamp.
    assert item["by_step"].provenance is Provenance.DERIVED
    assert item["by_step"].value == {"S4-T05": {"USD": SHOTS * 10}}
    assert item["by_stage"].value == {"S4": {"USD": SHOTS * 10}}
    assert item["by_time"].provenance is Provenance.DERIVED
    assert (
        sum(c for months in item["by_time"].value.values() for c in months.values())
        == SHOTS * 10
    )
    assert op0["occurred_at"] is not None


def test_wq07_unreconciled_committed_op_fails_closed(tmp_path, monkeypatch):
    # a committed reservation with no authoritative cost event is unreconciled
    from ai_video_workflow.budget.reservation import (
        commit_reservation,
        hold_reservation,
    )

    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    hold_reservation(
        root,
        project_id="proj-demo",
        task_id="task-orphan",
        operation_id="op-x",
        shot_id="shot-1",
        provider_id="fake-a",
        model_id="m1",
        estimate_jpy=16,
        created_at="2026-08-02T00:00:00+00:00",
    )
    commit_reservation(
        root, "task-orphan", "op-x", resolved_at="2026-08-02T00:00:00+00:00"
    )
    svc = _service(tmp_path)
    res = svc.cost_breakdown(root)
    cats = {p.category.value for p in res.problems}
    assert "cost_unreconciled" in cats
    assert res.readiness_failed


# --- WQ-08 evaluation-decision ------------------------------------------------


def test_wq08_evaluation_binds_target_version_and_tags(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.evaluation_decision(root)
    review = [
        it for it in res.items if it.get("kind") and it["kind"].value == "final_review"
    ]
    assert review
    assert review[0]["verdict"].value == "pass"
    assert review[0]["target"].value["content_digest"]  # bound to digest
    assert review[0]["target_version"].value == 1  # explicit final version
    assert "issue_tags" in review[0]  # frozen field present


# --- WQ-09 recent-problems ----------------------------------------------------


def test_wq09_recent_problems_clean_episode(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.recent_problems(root)
    # a clean episode has no validation failures / reconciliation gaps
    assert not res.readiness_failed


# --- WQ-10 rebuild-check ------------------------------------------------------


def test_wq10_rebuild_is_deterministic_and_read_only(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    data = cli._load_project_data(root)
    asset_id = data.video_assets[0].asset_id
    # every applicable query (with its params) rebuilds deterministically
    checks = [
        ("WQ-01", {}),
        ("WQ-02", {}),
        ("WQ-03", {"ref": asset_id}),
        ("WQ-04", {"ref": "task-shot-1-1"}),
        ("WQ-05", {"prompt_id": "p-main"}),
        ("WQ-06", {"shot": "shot-1"}),
        ("WQ-07", {}),
        ("WQ-08", {}),
        ("WQ-09", {}),
        ("WQ-11", {}),
        ("WQ-12", {"asset_id": "character-mia", "version": 1}),
        ("WQ-13", {}),
        ("WQ-14", {}),
    ]
    for qid, params in checks:
        res = svc.rebuild_check(root, qid, **params)
        assert res.items[0]["deterministic"].value is True, qid
        assert res.items[0]["read_only"].value is True, qid
        assert not res.readiness_failed, qid


def test_wq10_detects_same_size_overwrite(tmp_path, monkeypatch):
    # the snapshot uses content digests, so an equal-size overwrite between
    # the two evaluations would be caught (guarding the read-only claim)
    from ai_video_workflow.workspace import queries

    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    before = queries._snapshot(root)
    target = root / "project.json"
    original = target.read_bytes()
    # same length, different content
    target.write_bytes(bytes([b ^ 0x01 for b in original[:1]]) + original[1:])
    after = queries._snapshot(root)
    assert before != after  # digest-based snapshot catches it
    target.write_bytes(original)


# --- WQ-11 / WQ-12 cross-project ---------------------------------------------


def test_wq11_cross_project_index(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.cross_project_index()
    names = {it["project"].value for it in res.items}
    assert "wfm1-demo" in names
    demo = next(it for it in res.items if it["project"].value == "wfm1-demo")
    assert demo["cost_by_currency"].value.get("USD") == SHOTS * 10


def test_wq11_includes_version_and_holds(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.cross_project_index()
    demo = next(it for it in res.items if it["project"].value == "wfm1-demo")
    assert demo["cost_by_currency"].value.get("USD") == SHOTS * 10
    assert demo["profile_version"].value == 1
    assert "outstanding_holds_jpy" in demo
    assert res.scope["total"] >= 1 and res.scope["returned"] >= 1


def test_wq12_reuse_usage_verified_against_account_pack(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.reuse_usage("character-mia", 1)
    assert res.items  # the demo project references the reuse asset
    assert res.items[0]["content_digest"].provenance is Provenance.AUTHORITATIVE
    assert res.items[0]["matches_account_pack"].value is True
    assert not res.readiness_failed


def test_wq12_missing_account_version_fails_closed(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.reuse_usage("character-mia", 99)  # no such account version
    cats = {p.category.value for p in res.problems}
    assert "version_absent" in cats
    assert res.readiness_failed


# --- WQ-13 approval-audit -----------------------------------------------------


def test_wq13_approval_audit_carries_targets_actor_time(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.approval_audit(root)
    stage_items = [it for it in res.items if "status" in it]
    approved = [it for it in stage_items if it["status"].value == "approved"]
    assert approved
    first = approved[0]
    assert first["approved_by"].value is not None  # actor
    assert first["approved_at"].value is not None  # time
    assert first["approved_targets"].value  # locked ref/version/digest
    assert first["approved_targets"].value[0]["content_digest"]
    assert res.scope["audit_entries"] > 0


# --- WQ-14 budget-standing ----------------------------------------------------


def test_wq14_budget_standing_account_and_episode(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    res = svc.budget_standing(root)
    item = res.items[0]
    assert item["budgets_jpy"].value["episode_soft"] == 1200
    assert item["episode_committed_by_currency"].value.get("USD") == SHOTS * 10
    # account-level monthly standing actually uses account_root
    assert item["month_committed_jpy"].value == SHOTS * 16
    assert item["monthly_remaining_jpy"].provenance is Provenance.DERIVED
    assert item["monthly_remaining_jpy"].value == 5000 - SHOTS * 16


# --- fail-closed / decoupling -------------------------------------------------


def test_empty_project_returns_plan_no_crash(tmp_path, monkeypatch):
    # a bare seeded project (no planning, no config) still answers WQ-01
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    assert svc.project_plan(root).items  # never raises


def test_corrupt_shot_plan_fails_closed(tmp_path, monkeypatch):
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    _compile(root, catalog_dir)
    (root / "planning" / "shot_plan_v1.json").write_text("{ not json", encoding="utf-8")
    svc = _service(tmp_path)
    res = svc.cost_breakdown(root)
    assert res.problems  # corrupt source surfaces, no crash
    assert "has_problems" in res.markers


def test_unsupported_schema_surfaces_as_problem(tmp_path, monkeypatch):
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    _compile(root, catalog_dir)
    # bump a packet to an unknown schema_version
    pkt = root / "planning" / "packets" / "shot-1_v1.json"
    raw = json.loads(pkt.read_text(encoding="utf-8"))
    raw["schema_version"] = 999
    pkt.write_text(json.dumps(raw), encoding="utf-8")
    svc = _service(tmp_path)
    res = svc.cost_breakdown(root)
    cats = {p.category.value for p in res.problems}
    assert "schema_unsupported" in cats


def test_service_does_not_import_ui_or_call_provider(tmp_path, monkeypatch):
    # the query layer must not IMPORT provider/registry/write machinery
    # (substring checks would false-positive on the I/O contract's prose, so
    # scan import statements only)
    import ai_video_workflow.workspace as ws

    src = Path(ws.__file__).parent
    import_lines = [
        line
        for p in src.rglob("*.py")
        for line in p.read_text(encoding="utf-8").splitlines()
        if line.lstrip().startswith(("import ", "from "))
    ]
    imports = "\n".join(import_lines)
    assert "ai_video_workflow.providers" not in imports
    assert "default_registry" not in imports
    assert "write_model_json" not in imports
    assert "composition" not in imports  # no composer/write side
    # and never a provider call token anywhere in the package body
    body = "\n".join(p.read_text(encoding="utf-8") for p in src.rglob("*.py"))
    assert "default_registry(" not in body


def test_queries_write_nothing(tmp_path, monkeypatch):
    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    before = sorted(
        (str(p.relative_to(tmp_path)), p.stat().st_size)
        for p in tmp_path.rglob("*")
        if p.is_file()
    )
    svc = _service(tmp_path)
    svc.cross_project_index()
    svc.project_plan(root)
    svc.cost_breakdown(root)
    svc.shot_attempts(root, "shot-1")
    svc.budget_standing(root)
    after = sorted(
        (str(p.relative_to(tmp_path)), p.stat().st_size)
        for p in tmp_path.rglob("*")
        if p.is_file()
    )
    assert before == after  # strictly read-only


def test_discovery_skips_non_projects(tmp_path, monkeypatch):
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    found = {p.name for p in discover_projects(tmp_path)}
    assert "wfm1-demo" in found
    assert "catalog" not in found  # no config/wfm1.json there


# --- security / account containment (I4) --------------------------------------


def test_project_outside_account_root_is_refused(tmp_path, monkeypatch):
    from ai_video_workflow.workspace import AccountScopeError

    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    # a service scoped to a DIFFERENT account root must refuse this project
    other_account = tmp_path / "elsewhere"
    other_account.mkdir()
    svc = WorkspaceQueryService(other_account, clock=_clock)
    with pytest.raises(AccountScopeError):
        svc.project_plan(root)


def test_queries_never_expose_credentials_or_private_urls(tmp_path, monkeypatch):
    # WQ results must never carry credential env-var names/values or private
    # download URLs; the smoke uses fake providers with no such data, and the
    # DTO of every query is scanned for the forbidden shapes.
    from ai_video_workflow.workspace import to_jsonable

    _, root, catalog_dir = _finished(tmp_path, monkeypatch)
    svc = _service(tmp_path)
    data = cli._load_project_data(root)
    asset_id = data.video_assets[0].asset_id
    # the run-fact queries (WQ-01 plan is static I/O-contract prose, not run
    # data, so it is excluded from the credential scan)
    results = [
        svc.project_status(root),
        svc.lineage_upstream(root, asset_id),
        svc.prompt_history(root, "p-main"),
        svc.shot_attempts(root, "shot-1"),
        svc.cost_breakdown(root),
        svc.evaluation_decision(root),
        svc.recent_problems(root),
        svc.cross_project_index(),
        svc.reuse_usage("character-mia", 1),
        svc.approval_audit(root),
        svc.budget_standing(root),
    ]
    blob = "\n".join(json.dumps(to_jsonable(r), ensure_ascii=False) for r in results)
    lowered = blob.lower()
    assert "authorization" not in lowered
    assert "api_key" not in lowered and "api-key" not in lowered
    assert "wfm1_minimax" not in lowered  # credential env var name
    assert "bearer " not in lowered
    # no http(s) download URL leaks into any run-fact result
    assert "http://" not in lowered and "https://" not in lowered


def test_symlink_escape_in_records_fails_closed(tmp_path, monkeypatch):
    # a symlinked record path pointing outside the project must not be
    # followed into a query result (ADR-0004 containment)
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    _compile(root, catalog_dir)
    outside = tmp_path / "outside-secret.json"
    outside.write_text('{"secret": "leak"}', encoding="utf-8")
    shots_dir = root / "records" / "shots"
    (shots_dir / "shot-evil.json").symlink_to(outside)
    svc = _service(tmp_path)
    # loading the project snapshot routes through resolve_within_root, which
    # rejects the symlinked component -> a structured problem, never a leak
    res = svc.lineage_upstream(root, "no-such-asset")
    blob = json.dumps([p.detail for p in res.problems], ensure_ascii=False)
    assert "leak" not in blob
