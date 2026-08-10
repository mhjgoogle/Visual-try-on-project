"""Cross-project learning / knowledge / recommendations tests (TASK-032).

Covers the account-level user-confirmed knowledge domain (promote / read /
validation / append-only / corrupt), the derived cross-project analytics KPIs
(evaluation pass rate + action resolution rate + insufficient_evidence), and the
WQ-17/WQ-18 read-only queries. No provider, no network, no payment.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ai_video_workflow.errors import InvariantViolationError
from ai_video_workflow.learning import (
    CorruptKnowledgeLogError,
    KnowledgeService,
    build_knowledge_record,
    log_path,
    read_records,
)
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.profile.project_profile import (
    parse_project_profile,
    write_project_profile,
)
from ai_video_workflow.qcd.events import build_asset_imported_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.workspace import WorkspaceQueryService

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
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


def _evidence(ref="asset-a", digest=_DIGEST, project="proj-1"):
    return {"ref": ref, "content_digest": digest, "project": project}


def _promote(svc, knowledge_id="k-1"):
    return svc.promote(
        knowledge_id=knowledge_id,
        category="provider_choice",
        applicability={"genre": "drama", "duration_band": 60},
        recommendation="prefer cloud-a for 60s drama shots",
        evidence_refs=[_evidence()],
        scope="2 projects, 2026-Q3",
        limits="small sample; drama only",
        occurred_at=T0,
    )


# --- knowledge domain --------------------------------------------------------


def test_promote_and_read(tmp_path):
    svc = KnowledgeService(tmp_path, clock=_clock)
    rec = _promote(svc)
    assert rec.record_id == "knowledge:k-1"
    assert rec.actor == "user"
    (read,) = read_records(tmp_path)
    assert read.payload["category"] == "provider_choice"


def test_actor_is_always_user(tmp_path):
    # the builder fixes actor=user; a non-user record cannot be constructed
    from ai_video_workflow.learning.records import KnowledgeRecord

    payload = build_knowledge_record(
        knowledge_id="k-1",
        category="c",
        applicability={},
        recommendation="r",
        evidence_refs=[_evidence()],
        scope="s",
        limits="l",
        occurred_at=T0,
    ).payload
    with pytest.raises(InvariantViolationError):
        KnowledgeRecord(
            record_id="knowledge:k-1",
            occurred_at=T0,
            actor="agent",
            payload=dict(payload),
        )


def test_evidence_refs_required(tmp_path):
    svc = KnowledgeService(tmp_path, clock=_clock)
    with pytest.raises(InvariantViolationError):
        svc.promote(
            knowledge_id="k-1",
            category="c",
            applicability={},
            recommendation="r",
            evidence_refs=[],
            scope="s",
            limits="l",
            occurred_at=T0,
        )


def test_append_only_history(tmp_path):
    svc = KnowledgeService(tmp_path, clock=_clock)
    _promote(svc, "k-1")
    _promote(svc, "k-2")
    assert len(read_records(tmp_path)) == 2


def test_duplicate_knowledge_id_rejected(tmp_path):
    svc = KnowledgeService(tmp_path, clock=_clock)
    _promote(svc, "k-1")
    with pytest.raises(InvariantViolationError):
        _promote(svc, "k-1")  # same id, would be silently deduped by readers
    assert len(read_records(tmp_path)) == 1


def test_corrupt_log_raises(tmp_path):
    log_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    log_path(tmp_path).write_text("not json\n", encoding="utf-8")
    with pytest.raises(CorruptKnowledgeLogError):
        read_records(tmp_path)


# --- derived cross-project analytics -----------------------------------------


def _project_with_facts(account_root):
    """A discoverable project with 2 evals (1 pass, 1 fail) + 1 completed action."""
    from ai_video_workflow.action import ActionActor, ActionService
    from ai_video_workflow.action import WorkflowTargetResolver as ActRes
    from ai_video_workflow.evaluation import (
        EvaluationActor,
        EvaluationService,
        WorkflowAuthoritativeFacts,
    )

    root = account_root / "proj-1"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    (root / "config").mkdir()
    (root / "config" / "wfm1.json").write_text(
        _CFG.read_text(encoding="utf-8"), encoding="utf-8"
    )
    raw = json.loads(_PROFILE.read_text(encoding="utf-8"))
    raw["version"] = 1
    write_project_profile(root, parse_project_profile(raw))
    append_event(
        root,
        build_asset_imported_event(
            project_id="proj-1",
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
    target = {"ref": "asset-a", "version": 1, "content_digest": _DIGEST}
    ev = EvaluationService(
        root, "proj-1", facts=WorkflowAuthoritativeFacts(), clock=_clock
    )
    ev.record_evaluation(
        actor=EvaluationActor.USER,
        target=target,
        evaluation_id="e-1",
        criterion="c",
        score=4,
        tag=None,
        passed=True,
        rationale="ok",
        occurred_at=T0,
    )
    ev.record_evaluation(
        actor=EvaluationActor.USER,
        target=target,
        evaluation_id="e-2",
        criterion="c",
        score=1,
        tag=None,
        passed=False,
        rationale="no",
        occurred_at=T0,
    )
    ac = ActionService(root, "proj-1", resolver=ActRes(), clock=_clock)
    ac.create_feedback(
        actor=ActionActor.USER,
        feedback_id="fb-1",
        target=target,
        context={},
        summary="s",
        detail="d",
        occurred_at=T0,
    )
    ac.create_action(
        actor=ActionActor.USER,
        action_id="a-1",
        feedback_id="fb-1",
        target=target,
        context={},
        intent="fix",
        occurred_at=T0 + timedelta(seconds=1),
    )
    ac.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="a-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=2),
    )
    ac.transition(
        actor=ActionActor.AGENT,
        event_id="t2",
        action_id="a-1",
        to_state="completed",
        occurred_at=T0 + timedelta(seconds=3),
    )
    return root


def test_project_kpis_derived(tmp_path):
    _project_with_facts(tmp_path)
    (kpi,) = KnowledgeService(tmp_path, clock=_clock).project_kpis()
    assert kpi.project == "proj-1"
    assert kpi.evaluation_count == 2
    assert kpi.evaluation_pass_rate == 0.5
    assert kpi.action_count == 1
    assert kpi.action_resolution_rate == 1.0
    assert kpi.insufficient_evidence is False


def test_wq17_analytics_query(tmp_path):
    _project_with_facts(tmp_path)
    res = WorkspaceQueryService(tmp_path, clock=_clock).cross_project_analytics()
    assert res.query_id == "WQ-17"
    assert res.contract_version == "1.5"
    item = res.items[0]
    assert item["evaluation_pass_rate"].value == 0.5
    assert item["action_resolution_rate"].value == 1.0


def test_wq17_corrupt_source_fails_closed_not_insufficient(tmp_path):
    # a corrupt evaluation log must surface source_corrupt, not a silent
    # insufficient_evidence / zero rate
    from ai_video_workflow.evaluation import log_path as eval_log_path
    from ai_video_workflow.workspace import Provenance

    root = _project_with_facts(tmp_path)
    eval_log_path(root).write_text("not json\n", encoding="utf-8")
    res = WorkspaceQueryService(tmp_path, clock=_clock).cross_project_analytics()
    assert any(p.category.value == "source_corrupt" for p in res.problems)
    assert res.readiness_failed is True
    item = res.items[0]
    assert item["insufficient_evidence"].value is False  # corrupt != no evidence
    assert item["evaluation_pass_rate"].provenance is Provenance.UNAVAILABLE
    assert item["evaluation_pass_rate"].value == "source_corrupt"
    # the count of a corrupt source is unavailable, never authoritative zero
    assert item["evaluation_count"].provenance is Provenance.UNAVAILABLE


def test_wq17_insufficient_evidence(tmp_path):
    # a project with no eval/action facts -> insufficient_evidence, unavailable
    root = tmp_path / "proj-empty"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-empty", "Demo", T0))
    (root / "config").mkdir()
    (root / "config" / "wfm1.json").write_text(
        _CFG.read_text(encoding="utf-8"), encoding="utf-8"
    )
    res = WorkspaceQueryService(tmp_path, clock=_clock).cross_project_analytics()
    from ai_video_workflow.workspace import Provenance

    item = res.items[0]
    assert item["insufficient_evidence"].value is True
    assert item["evaluation_pass_rate"].provenance is Provenance.UNAVAILABLE


# --- recommendations (WQ-18) -------------------------------------------------


def test_wq18_recommendations_lists_promoted_knowledge(tmp_path):
    _promote(KnowledgeService(tmp_path, clock=_clock))
    res = WorkspaceQueryService(tmp_path, clock=_clock).recommendations()
    assert res.query_id == "WQ-18"
    item = res.items[0]
    assert item["recommendation"].value == "prefer cloud-a for 60s drama shots"
    assert item["evidence_refs"].value == [_evidence()]
    assert item["limits"].value  # limits surfaced, never hidden


def test_wq18_insufficient_evidence_when_empty(tmp_path):
    res = WorkspaceQueryService(tmp_path, clock=_clock).recommendations()
    assert res.items == ()
    assert any("insufficient_evidence" in p.detail for p in res.problems)


def test_wq18_corrupt_knowledge_log_fails_closed(tmp_path):
    log_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    log_path(tmp_path).write_text("not json\n", encoding="utf-8")
    res = WorkspaceQueryService(tmp_path, clock=_clock).recommendations()
    assert res.items == ()
    assert any(p.category.value == "source_corrupt" for p in res.problems)
