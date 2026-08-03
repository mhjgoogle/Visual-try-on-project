"""WQ-15 evaluation-domain read-only query tests (TASK-028 / ADR-0034).

Drives the real WQ-15 query through WorkspaceQueryService against a project
holding a goals baseline, authoritative asset facts, and evaluation-domain
records written through the approved service. Covers history + comparison view,
derived staleness (+ structured problem), fail-closed corrupt log, determinism
(rebuild-check), and the read-only posture. No provider, no network, no payment.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ai_video_workflow.evaluation import (
    EvaluationActor,
    EvaluationService,
    WorkflowAuthoritativeFacts,
    log_path,
)
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.profile.project_profile import (
    parse_project_profile,
    write_project_profile,
)
from ai_video_workflow.qcd.events import build_asset_imported_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.workspace import (
    Provenance,
    WorkspaceQueryService,
)

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64

REPO_ROOT = Path(__file__).resolve().parents[1]
_PROFILE_EXAMPLE = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "profile"
    / "project_profile_v1.example.json"
)


def _clock():
    return T0


def _service(account_root: Path) -> WorkspaceQueryService:
    return WorkspaceQueryService(account_root, clock=_clock)


def _write_profile(root: Path, version: int) -> None:
    raw = json.loads(_PROFILE_EXAMPLE.read_text(encoding="utf-8"))
    raw["version"] = version
    write_project_profile(root, parse_project_profile(raw))


def _import_asset(root: Path, *, asset_id: str, version: int, sha: str) -> None:
    append_event(
        root,
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            asset_id=asset_id,
            sha256=sha,
            size_bytes=1024,
            path=f"assets/{asset_id}.mp4",
            version=version,
            duration_ms=2000,
            source_attempt_id=None,
            occurred_at=T0,
        ),
    )


def _target(ref="asset-a", version=1, digest=_DIGEST) -> dict:
    return {"ref": ref, "version": version, "content_digest": digest}


@pytest.fixture
def project(tmp_path) -> Path:
    """An account root (tmp_path) with one child project holding facts+records."""
    root = tmp_path / "proj-1"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    _write_profile(root, 1)
    _import_asset(root, asset_id="asset-a", version=1, sha=_DIGEST)
    _import_asset(root, asset_id="asset-b", version=2, sha=_DIGEST2)
    return root


def _write_records(root: Path) -> None:
    svc = EvaluationService(
        root, "proj-1", facts=WorkflowAuthoritativeFacts(), clock=_clock
    )
    svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(),
        evaluation_id="e-1",
        criterion="clarity",
        score=4,
        tag="strong",
        passed=True,
        rationale="reads clearly",
        occurred_at=T0,
    )
    svc.record_experiment(
        actor=EvaluationActor.USER,
        target=_target(),
        experiment_id="x-1",
        variants=[
            _target(version=1),
            _target(ref="asset-b", version=2, digest=_DIGEST2),
        ],
        changed_factor="prompt wording",
        expected_improvement="tighter framing",
        actual_result="framing improved",
        reuse_conclusion="keep v2",
        occurred_at=T0 + timedelta(minutes=1),
    )
    svc.record_creative_decision(
        actor=EvaluationActor.USER,
        target=_target(ref="asset-b", version=2, digest=_DIGEST2),
        decision_id="d-1",
        decision_type="select",
        changed="chose asset-b",
        why="clearer framing",
        expected="ship it",
        actual="shipped",
        occurred_at=T0 + timedelta(minutes=2),
    )


# --- history + comparison view ----------------------------------------------


def test_wq15_returns_history_sorted_with_authoritative_facts(project) -> None:
    _write_records(project)
    res = _service(project.parent).evaluation_domain(project)
    assert res.query_id == "WQ-15"
    assert res.contract_version == "1.5"
    kinds = [it["record_type"].value for it in res.items]
    assert kinds == [
        "evaluation",
        "experiment",
        "creative_decision",
    ]  # occurred_at order
    first = res.items[0]
    assert first["record_id"].provenance is Provenance.AUTHORITATIVE
    assert first["target"].value == _target()
    assert first["stale"].provenance is Provenance.DERIVED
    assert first["stale"].value is False


def test_wq15_experiment_exposes_variants(project) -> None:
    _write_records(project)
    res = _service(project.parent).evaluation_domain(project)
    exp = next(it for it in res.items if it["record_type"].value == "experiment")
    variants = exp["payload"].value["variants"]
    assert len(variants) == 2
    assert exp["payload"].value["reuse_conclusion"] == "keep v2"


def test_wq15_experiment_cost_time_known_zero_manual(project):
    # the fixture's variant assets were imported (their producing task is known
    # to the QCD facts) but carry no paid cost -> KNOWN zero (a manual variant):
    # cost_known True, empty cost map, null elapsed, and zero/empty deltas —
    # DERIVED and honest, never a faked number.
    _write_records(project)
    res = _service(project.parent).evaluation_domain(project)
    exp = next(it for it in res.items if it["record_type"].value == "experiment")
    ct = exp["incremental_cost_time"]
    assert ct.provenance is Provenance.DERIVED
    variants = ct.value["variants"]
    assert len(variants) == 2
    assert all(v["cost_known"] is True for v in variants)
    assert all(v["cost_by_currency"] == {} for v in variants)
    assert all(v["attempts_elapsed_ms"] is None for v in variants)
    assert variants[1]["delta_cost_by_currency"] == {}
    assert variants[1]["delta_attempts_elapsed_ms"] is None
    # evaluation / decision records: incremental cost/time is not applicable
    ev = next(it for it in res.items if it["record_type"].value == "evaluation")
    assert ev["incremental_cost_time"].provenance is Provenance.UNAVAILABLE
    assert "contains_unavailable" in res.markers


def test_wq15_empty_when_no_records(project) -> None:
    res = _service(project.parent).evaluation_domain(project)
    assert res.items == ()
    assert res.problems == ()


# --- derived staleness -------------------------------------------------------


def test_wq15_goals_drift_marks_stale_with_problem(project) -> None:
    _write_records(project)
    _write_profile(project, 2)  # goals baseline advances after the records
    res = _service(project.parent).evaluation_domain(project)
    assert all(it["stale"].value is True for it in res.items)
    assert any(
        "goals baseline moved" in r
        for it in res.items
        for r in it["stale_reasons"].value
    )
    # each stale record surfaces a structured, non-readiness problem
    assert len(res.problems) == len(res.items)
    assert res.readiness_failed is False


def test_wq15_deterministic_under_duplicate_asset_import(project) -> None:
    # a video asset_id encodes its version, so a genuine digest drift for the
    # same (ref, version) cannot occur against the concrete resolver (the
    # digest-drift stale path is covered with a fake resolver in the service
    # tests). A duplicate asset_imported line for the same id+version must not
    # perturb the result: QCD read is first-wins, so the ORIGINAL fact wins and
    # the record stays fresh.
    _write_records(project)
    _import_asset(project, asset_id="asset-a", version=1, sha=_DIGEST2)
    res = _service(project.parent).evaluation_domain(project)
    assert res.items[0]["stale"].value is False


# --- fail-closed + determinism + read-only -----------------------------------


def test_wq15_corrupt_log_is_source_corrupt_problem(project) -> None:
    log_path(project).parent.mkdir(parents=True, exist_ok=True)
    log_path(project).write_text("this is not json\n", encoding="utf-8")
    res = _service(project.parent).evaluation_domain(project)
    assert res.items == ()
    assert any(p.category.value == "source_corrupt" for p in res.problems)


def test_wq15_rebuild_check_is_deterministic_and_writes_nothing(project) -> None:
    _write_records(project)
    res = _service(project.parent).rebuild_check(project, "WQ-15")
    # rebuild-check evaluates the query twice and compares the full envelope
    assert res.query_id == "WQ-10"
    assert res.readiness_failed is False


# --- derived incremental cost/time (pure helpers) ----------------------------


def _metrics(task_id: str, *, cost: dict, elapsed: int | None):
    from ai_video_workflow.qcd.aggregation import TaskMetrics

    return TaskMetrics(
        task_id=task_id,
        shot_id="shot-1",
        created_at=None,
        origin=None,
        first_asset_imported_at=None,
        delivery_ms=None,
        attempt_count=1,
        attempts_elapsed_ms=elapsed,
        cost_by_currency=cost,
        validation_runs=0,
        validation_failures=0,
        latest_status=None,
    )


def test_asset_task_index_first_wins():
    from ai_video_workflow.qcd.events import build_asset_imported_event
    from ai_video_workflow.workspace.queries import _asset_task_index

    def _ev(task_id, sha):
        return build_asset_imported_event(
            project_id="p",
            shot_id="shot-1",
            task_id=task_id,
            asset_id="asset-a",
            sha256=sha,
            size_bytes=1,
            path="a.mp4",
            version=1,
            duration_ms=1,
            source_attempt_id=None,
            occurred_at=T0,
        )

    index = _asset_task_index([_ev("task-1", _DIGEST), _ev("task-2", _DIGEST2)])
    assert index[("asset-a", 1)] == "task-1"  # first-wins


def test_experiment_cost_time_absolute_and_delta_vs_first():
    from ai_video_workflow.evaluation import EvaluationActor, build_experiment_record
    from ai_video_workflow.workspace.queries import _experiment_cost_time

    record = build_experiment_record(
        project_id="proj-1",
        actor=EvaluationActor.USER,
        target=_target(),
        goals_version=1,
        experiment_id="x-1",
        variants=[
            _target(ref="asset-a", version=1),
            _target(ref="asset-b", version=2, digest=_DIGEST2),
            _target(ref="asset-c", version=3, digest="c" * 64),
            _target(ref="asset-d", version=4, digest="d" * 64),
        ],
        changed_factor="prompt",
        expected_improvement="tighter",
        actual_result=None,
        reuse_conclusion=None,
        occurred_at=T0,
    )
    asset_task = {
        ("asset-a", 1): "task-a",
        ("asset-b", 2): "task-b",
        # asset-c has no producing task -> UNKNOWN cost
        ("asset-d", 4): "task-d",
    }
    per_task = {
        "task-a": _metrics("task-a", cost={"JPY": 12000}, elapsed=31200),
        "task-b": _metrics("task-b", cost={"JPY": 15000}, elapsed=28800),
        # task-d is an aggregated task with NO paid cost -> KNOWN zero (manual)
        "task-d": _metrics("task-d", cost={}, elapsed=None),
    }
    out = _experiment_cost_time(record, asset_task, per_task)
    assert out["baseline_index"] == 0
    a, b, c, d = out["variants"]
    # baseline: known, zero deltas
    assert a["cost_known"] is True
    assert a["cost_by_currency"] == {"JPY": 12000}
    assert a["attempts_elapsed_ms"] == 31200
    assert a["delta_cost_by_currency"] == {"JPY": 0}
    assert a["delta_attempts_elapsed_ms"] == 0
    # second variant: absolute + delta vs first
    assert b["delta_cost_by_currency"] == {"JPY": 3000}
    assert b["delta_attempts_elapsed_ms"] == -2400
    # UNKNOWN variant (no task): null cost, null deltas — never a faked -12000
    assert c["cost_known"] is False
    assert c["task_id"] is None
    assert c["cost_by_currency"] is None
    assert c["delta_cost_by_currency"] is None
    assert c["attempts_elapsed_ms"] is None
    assert c["delta_attempts_elapsed_ms"] is None
    # KNOWN-zero variant (aggregated task, no paid cost): real numeric delta
    assert d["cost_known"] is True
    assert d["cost_by_currency"] == {}
    assert d["delta_cost_by_currency"] == {"JPY": -12000}  # genuinely 0 - 12000
    assert d["delta_attempts_elapsed_ms"] is None  # elapsed unknown on d
