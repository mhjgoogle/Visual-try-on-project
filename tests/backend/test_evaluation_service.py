"""Evaluation-domain application service tests (TASK-028 / ADR-0034).

Covers the binding/stale/actor policy layered on top of the append-only log:
- actor separation (AI cannot form a pass=true final or a 'select' auto-winner);
- write-time fail-closed binding (missing goals, missing target, digest
  mismatch) and automatic binding of the current goals version;
- read-time derived staleness (goals drift, digest drift, newer version,
  vanished target) without ever rewriting the immutable log;
- experiments bind and verify every compared variant;
- the concrete WorkflowAuthoritativeFacts resolver against a real temp project.

No provider, no network, no payment; a temp project root only.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.evaluation import (
    EvaluationActor,
    EvaluationActorError,
    EvaluationService,
    MissingGoalsBaselineError,
    StaleTargetError,
    TargetFact,
    WorkflowAuthoritativeFacts,
)

_AT = datetime(2026, 8, 3, 12, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64


def _clock() -> datetime:
    return _AT


class FakeFacts:
    """Controllable AuthoritativeFacts for policy/stale tests."""

    def __init__(self, *, goals: int | None = 1, targets: dict | None = None) -> None:
        self._goals = goals
        self._targets = targets or {}

    def current_goals_version(self, project_root: Path) -> int | None:
        return self._goals

    def resolve_target(
        self, project_root: Path, *, ref: str, version: int
    ) -> TargetFact:
        return self._targets.get(
            (ref, version), TargetFact(exists=False, content_digest=None)
        )


def _target(ref: str = "asset-a-v1", version: int = 1, digest: str = _DIGEST) -> dict:
    return {"ref": ref, "version": version, "content_digest": digest}


def _facts(
    *, goals: int | None = 1, digest: str = _DIGEST, latest: int | None = None, **tgt
) -> FakeFacts:
    t = _target(**tgt)
    return FakeFacts(
        goals=goals,
        targets={
            (t["ref"], t["version"]): TargetFact(
                exists=True,
                content_digest=digest,
                latest_version=latest if latest is not None else t["version"],
            )
        },
    )


def _service(tmp_path: Path, facts: FakeFacts) -> EvaluationService:
    return EvaluationService(tmp_path, "proj-demo", facts=facts, clock=_clock)


# --- actor separation / user final judgement ---------------------------------


def test_ai_cannot_form_a_pass_true_evaluation(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    with pytest.raises(EvaluationActorError):
        svc.record_evaluation(
            actor=EvaluationActor.AI,
            target=_target(),
            evaluation_id="e-1",
            criterion="clarity",
            score=5,
            tag=None,
            passed=True,
            rationale="looks great",
        )
    # nothing was written — the refusal is before the append
    assert svc.read() == ()


def test_ai_may_record_an_advisory_non_pass_evaluation(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    record = svc.record_evaluation(
        actor=EvaluationActor.AI,
        target=_target(),
        evaluation_id="e-1",
        criterion="clarity",
        score=3,
        tag="advisory",
        passed=False,
        rationale="assistive suggestion only",
    )
    assert record.actor is EvaluationActor.AI
    assert svc.read() == (record,)


def test_user_may_form_a_pass_true_evaluation(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    record = svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(),
        evaluation_id="e-1",
        criterion="clarity",
        score=5,
        tag=None,
        passed=True,
        rationale="the user confirms the pass",
    )
    assert record.payload["pass"] is True


def test_ai_cannot_form_a_select_auto_winner(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    with pytest.raises(EvaluationActorError):
        svc.record_creative_decision(
            actor=EvaluationActor.AI,
            target=_target(),
            decision_id="d-1",
            decision_type="select",
            changed="picked v1",
            why="AI thinks it is best",
            expected="better",
            actual=None,
        )
    assert svc.read() == ()


def test_ai_may_record_a_non_winner_decision(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    record = svc.record_creative_decision(
        actor=EvaluationActor.AI,
        target=_target(),
        decision_id="d-1",
        decision_type="abandon",
        changed="dropped this candidate",
        why="advisory suggestion to abandon",
        expected="no gain",
        actual=None,
    )
    assert record.payload["decision_type"] == "abandon"


# --- write-time binding (fail-closed) ----------------------------------------


def test_write_binds_the_current_goals_version_automatically(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts(goals=7))
    record = svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(),
        evaluation_id="e-1",
        criterion="clarity",
        score=4,
        tag=None,
        passed=True,
        rationale="bound to the current goals baseline",
    )
    assert record.goals_version == 7


def test_write_refuses_when_no_goals_baseline(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts(goals=None))
    with pytest.raises(MissingGoalsBaselineError):
        svc.record_evaluation(
            actor=EvaluationActor.USER,
            target=_target(),
            evaluation_id="e-1",
            criterion="clarity",
            score=4,
            tag=None,
            passed=True,
            rationale="no goals to bind",
        )
    assert svc.read() == ()


def test_write_refuses_a_missing_target(tmp_path: Path) -> None:
    # facts know a different target, so ours does not resolve
    svc = _service(tmp_path, _facts(ref="asset-other-v1"))
    with pytest.raises(StaleTargetError):
        svc.record_evaluation(
            actor=EvaluationActor.USER,
            target=_target(),
            evaluation_id="e-1",
            criterion="clarity",
            score=4,
            tag=None,
            passed=True,
            rationale="target does not exist",
        )
    assert svc.read() == ()


def test_write_refuses_a_digest_mismatch(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts(digest=_DIGEST2))
    with pytest.raises(StaleTargetError):
        svc.record_evaluation(
            actor=EvaluationActor.USER,
            target=_target(digest=_DIGEST),
            evaluation_id="e-1",
            criterion="clarity",
            score=4,
            tag=None,
            passed=True,
            rationale="digest does not match authoritative",
        )
    assert svc.read() == ()


def test_experiment_verifies_every_variant(tmp_path: Path) -> None:
    # subject + variant v1 resolve; variant v2 does not
    facts = FakeFacts(
        goals=1,
        targets={
            ("asset-a-v1", 1): TargetFact(True, _DIGEST, 1),
        },
    )
    svc = _service(tmp_path, facts)
    with pytest.raises(StaleTargetError):
        svc.record_experiment(
            actor=EvaluationActor.USER,
            target=_target(),
            experiment_id="x-1",
            variants=[_target(version=1), _target(version=2, digest=_DIGEST2)],
            changed_factor="prompt",
            expected_improvement="tighter framing",
            actual_result=None,
            reuse_conclusion=None,
        )
    assert svc.read() == ()


def test_experiment_writes_when_all_variants_resolve(tmp_path: Path) -> None:
    facts = FakeFacts(
        goals=1,
        targets={
            ("asset-a-v1", 1): TargetFact(True, _DIGEST, 1),
            ("asset-a-v1", 2): TargetFact(True, _DIGEST2, 2),
        },
    )
    svc = _service(tmp_path, facts)
    record = svc.record_experiment(
        actor=EvaluationActor.USER,
        target=_target(),
        experiment_id="x-1",
        variants=[_target(version=1), _target(version=2, digest=_DIGEST2)],
        changed_factor="prompt",
        expected_improvement="tighter framing",
        actual_result="framing improved",
        reuse_conclusion="keep v2",
    )
    assert svc.read() == (record,)


# --- read-time derived staleness (log never rewritten) -----------------------


def test_fresh_record_is_not_stale(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(),
        evaluation_id="e-1",
        criterion="clarity",
        score=4,
        tag=None,
        passed=True,
        rationale="fresh",
    )
    (view,) = svc.read_views()
    assert view.staleness.is_stale is False
    assert view.staleness.reasons == ()


def test_goals_drift_marks_stale(tmp_path: Path) -> None:
    # write against goals v1, then the baseline moves to v2
    write_facts = _facts(goals=1)
    svc = _service(tmp_path, write_facts)
    svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(),
        evaluation_id="e-1",
        criterion="clarity",
        score=4,
        tag=None,
        passed=True,
        rationale="ok",
    )
    # re-read through a resolver whose goals baseline has advanced
    moved = _facts(goals=2)
    svc2 = _service(tmp_path, moved)
    (view,) = svc2.read_views()
    assert view.staleness.is_stale is True
    assert any("goals baseline moved" in r for r in view.staleness.reasons)
    # the raw record is unchanged (append-only, still bound to v1)
    assert view.record.goals_version == 1


def test_digest_drift_marks_stale(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts(digest=_DIGEST))
    svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(digest=_DIGEST),
        evaluation_id="e-1",
        criterion="clarity",
        score=4,
        tag=None,
        passed=True,
        rationale="ok",
    )
    drifted = _service(tmp_path, _facts(digest=_DIGEST2))
    (view,) = drifted.read_views()
    assert view.staleness.is_stale is True
    assert any("content_digest drifted" in r for r in view.staleness.reasons)


def test_missing_target_marks_stale(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(),
        evaluation_id="e-1",
        criterion="clarity",
        score=4,
        tag=None,
        passed=True,
        rationale="ok",
    )
    gone = _service(tmp_path, FakeFacts(goals=1, targets={}))
    (view,) = gone.read_views()
    assert view.staleness.is_stale is True
    assert any("target missing" in r for r in view.staleness.reasons)


def test_newer_target_version_marks_stale(tmp_path: Path) -> None:
    # write against v1; a newer authoritative v2 appears (same ref)
    svc = _service(tmp_path, _facts(version=1, latest=1))
    svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(version=1),
        evaluation_id="e-1",
        criterion="clarity",
        score=4,
        tag=None,
        passed=True,
        rationale="ok",
    )
    superseded = _service(tmp_path, _facts(version=1, latest=2))
    (view,) = superseded.read_views()
    assert view.staleness.is_stale is True
    assert any("newer authoritative version" in r for r in view.staleness.reasons)


def test_immutable_history_two_records_both_readable(tmp_path: Path) -> None:
    svc = _service(tmp_path, _facts())
    first = svc.record_creative_decision(
        actor=EvaluationActor.USER,
        target=_target(),
        decision_id="d-1",
        decision_type="abandon",
        changed="dropped v1",
        why="weak framing",
        expected="n/a",
        actual=None,
    )
    second = svc.record_creative_decision(
        actor=EvaluationActor.USER,
        target=_target(),
        decision_id="d-2",
        decision_type="select",
        changed="chose v1 after all",
        why="revisited",
        expected="ship it",
        actual="shipped",
    )
    # the old decision is not deleted or rewritten by the new one
    assert svc.read() == (first, second)


# --- concrete resolver against a real temp project ---------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
_PROFILE_EXAMPLE = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "profile"
    / "project_profile_v1.example.json"
)


def _write_profile(project_root: Path, version: int = 1) -> None:
    from ai_video_workflow.profile.project_profile import (
        parse_project_profile,
        write_project_profile,
    )

    raw = json.loads(_PROFILE_EXAMPLE.read_text(encoding="utf-8"))
    raw["version"] = version
    write_project_profile(project_root, parse_project_profile(raw))


def _import_asset(project_root: Path, *, asset_id: str, version: int, sha: str) -> None:
    from ai_video_workflow.qcd.events import build_asset_imported_event
    from ai_video_workflow.qcd.log import append_event

    append_event(
        project_root,
        build_asset_imported_event(
            project_id="proj-demo",
            shot_id="shot-1",
            task_id="task-1",
            asset_id=asset_id,
            sha256=sha,
            size_bytes=1024,
            path=f"assets/{asset_id}.mp4",
            version=version,
            duration_ms=2000,
            source_attempt_id=None,
            occurred_at=_AT,
        ),
    )


def test_concrete_resolver_binds_real_goals_and_asset(tmp_path: Path) -> None:
    from ai_video_workflow.models import Project
    from ai_video_workflow.persistence import write_model_json

    # project.json establishes the owning project_id the resolver checks against
    write_model_json(tmp_path / "project.json", Project("proj-demo", "Demo", _AT))
    _write_profile(tmp_path, version=1)
    _import_asset(tmp_path, asset_id="asset-task1-v1", version=1, sha=_DIGEST)
    facts = WorkflowAuthoritativeFacts()
    assert facts.current_goals_version(tmp_path) == 1

    svc = EvaluationService(tmp_path, "proj-demo", facts=facts, clock=_clock)
    record = svc.record_evaluation(
        actor=EvaluationActor.USER,
        target=_target(ref="asset-task1-v1", version=1, digest=_DIGEST),
        evaluation_id="e-1",
        criterion="motion quality",
        score=4,
        tag="strong",
        passed=True,
        rationale="motion reads cleanly against the goals",
    )
    assert record.goals_version == 1
    (view,) = svc.read_views()
    assert view.staleness.is_stale is False


def test_concrete_resolver_fails_closed_on_unknown_target(tmp_path: Path) -> None:
    _write_profile(tmp_path, version=1)
    # no asset_imported event → the target does not resolve
    svc = EvaluationService(
        tmp_path, "proj-demo", facts=WorkflowAuthoritativeFacts(), clock=_clock
    )
    with pytest.raises(StaleTargetError):
        svc.record_evaluation(
            actor=EvaluationActor.USER,
            target=_target(ref="asset-task1-v1", version=1, digest=_DIGEST),
            evaluation_id="e-1",
            criterion="motion quality",
            score=4,
            tag=None,
            passed=True,
            rationale="no such asset",
        )


def test_concrete_resolver_no_profile_refuses_write(tmp_path: Path) -> None:
    _import_asset(tmp_path, asset_id="asset-task1-v1", version=1, sha=_DIGEST)
    svc = EvaluationService(
        tmp_path, "proj-demo", facts=WorkflowAuthoritativeFacts(), clock=_clock
    )
    assert WorkflowAuthoritativeFacts().current_goals_version(tmp_path) is None
    with pytest.raises(MissingGoalsBaselineError):
        svc.record_evaluation(
            actor=EvaluationActor.USER,
            target=_target(ref="asset-task1-v1", version=1, digest=_DIGEST),
            evaluation_id="e-1",
            criterion="motion quality",
            score=4,
            tag=None,
            passed=True,
            rationale="no goals baseline",
        )
