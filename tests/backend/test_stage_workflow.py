"""Tests for WFM1 stage registry, transitions, and change control (TASK-019)."""

from __future__ import annotations

from pathlib import Path

import pytest

from ai_video_workflow.approval import (
    STAGE_IDS,
    ApprovalError,
    NotApprovedError,
    StaleApprovalError,
    read_audit,
    require_stage_ready,
    stage_plan,
    stage_status,
    transition_stage,
)

AT = "2026-08-02T00:00:00+00:00"


def _target(root: Path, rel: str = "records/shots/s.json", body: str = "{}") -> str:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return rel


def _approve(root: Path, stage: str, rel: str) -> None:
    transition_stage(root, stage, "review", at=AT, by="owner")
    transition_stage(root, stage, "approve", at=AT, by="owner", targets=(rel,))


# --- plan / registry --------------------------------------------------------


def test_plan_is_complete_before_any_run(tmp_path: Path) -> None:
    plan = stage_plan()
    assert tuple(info.stage_id for info in plan) == STAGE_IDS
    assert plan[0].prerequisites == ()
    # linear chain: each later stage requires the previous one
    for earlier, later in zip(plan, plan[1:], strict=False):
        assert later.prerequisites == (earlier.stage_id,)
    # a brand-new project derives full status from the registry alone
    states = stage_status(tmp_path)
    assert len(states) == len(STAGE_IDS)
    assert all(s.status == "draft" for s in states)


# --- transitions ------------------------------------------------------------


def test_full_legal_lifecycle_with_audit(tmp_path: Path) -> None:
    rel = _target(tmp_path)
    transition_stage(tmp_path, "concept_lock", "review", at=AT, by="owner")
    transition_stage(
        tmp_path, "concept_lock", "approve", at=AT, by="owner", targets=(rel,)
    )
    states = {s.stage_id: s for s in stage_status(tmp_path)}
    assert states["concept_lock"].status == "approved"
    assert not states["concept_lock"].stale
    audit = read_audit(tmp_path)
    assert [r["action"] for r in audit] == ["review", "approve"]
    assert audit[1]["from_status"] == "review_needed"
    assert audit[1]["targets"] == [rel]


def test_illegal_transitions_rejected(tmp_path: Path) -> None:
    with pytest.raises(ApprovalError, match="illegal transition"):
        transition_stage(
            tmp_path, "concept_lock", "approve", at=AT, by="o", targets=("x",)
        )  # draft -> approve is illegal
    with pytest.raises(ApprovalError, match="illegal transition"):
        transition_stage(tmp_path, "concept_lock", "revise", at=AT, by="o")
    with pytest.raises(ApprovalError, match="unknown stage"):
        transition_stage(tmp_path, "no_such_stage", "review", at=AT, by="o")
    with pytest.raises(ApprovalError, match="unknown action"):
        transition_stage(tmp_path, "concept_lock", "explode", at=AT, by="o")


def test_reject_and_revise_cycle(tmp_path: Path) -> None:
    rel = _target(tmp_path)
    transition_stage(tmp_path, "concept_lock", "review", at=AT, by="o")
    transition_stage(
        tmp_path, "concept_lock", "reject", at=AT, by="o", reason="not focused"
    )
    states = {s.stage_id: s for s in stage_status(tmp_path)}
    assert states["concept_lock"].status == "rejected"
    transition_stage(tmp_path, "concept_lock", "revise", at=AT, by="o")
    transition_stage(tmp_path, "concept_lock", "review", at=AT, by="o")
    transition_stage(tmp_path, "concept_lock", "approve", at=AT, by="o", targets=(rel,))
    audit = read_audit(tmp_path)
    assert [r["action"] for r in audit] == [
        "review",
        "reject",
        "revise",
        "review",
        "approve",
    ]
    assert audit[1]["reason"] == "not focused"


def test_approve_requires_fresh_prerequisites(tmp_path: Path) -> None:
    concept = _target(tmp_path, "records/concept.json", '{"c": 1}')
    script = _target(tmp_path, "records/script.json", '{"s": 1}')
    _approve(tmp_path, "concept_lock", concept)
    # cannot approve S1 while its prerequisite chain is not satisfied? it is
    # satisfied now:
    transition_stage(tmp_path, "screenplay_lock", "review", at=AT, by="o")
    # upstream content changes -> concept approval is stale -> downstream
    # approve fails closed automatically
    (tmp_path / concept).write_text('{"c": 2}', encoding="utf-8")
    with pytest.raises(StaleApprovalError):
        transition_stage(
            tmp_path,
            "screenplay_lock",
            "approve",
            at=AT,
            by="o",
            targets=(script,),
        )


def test_missing_prerequisite_blocks_approve(tmp_path: Path) -> None:
    script = _target(tmp_path, "records/script.json")
    transition_stage(tmp_path, "screenplay_lock", "review", at=AT, by="o")
    with pytest.raises(NotApprovedError):
        transition_stage(
            tmp_path,
            "screenplay_lock",
            "approve",
            at=AT,
            by="o",
            targets=(script,),
        )


# --- downstream gate --------------------------------------------------------


def test_require_stage_ready_checks_whole_chain(tmp_path: Path) -> None:
    concept = _target(tmp_path, "records/concept.json", '{"c": 1}')
    script = _target(tmp_path, "records/script.json", '{"s": 1}')
    _approve(tmp_path, "concept_lock", concept)
    _approve(tmp_path, "screenplay_lock", script)
    require_stage_ready(tmp_path, "screenplay_lock")  # ok
    # upstream drift invalidates the whole downstream chain
    (tmp_path / concept).write_text('{"c": 2}', encoding="utf-8")
    with pytest.raises(StaleApprovalError):
        require_stage_ready(tmp_path, "screenplay_lock")
    states = {s.stage_id: s for s in stage_status(tmp_path)}
    assert states["concept_lock"].stale is True
    assert "concept_lock" in states["screenplay_lock"].blocked_by


def test_unapproved_stage_means_zero_provider_zero_reservation(
    tmp_path: Path,
) -> None:
    # the paid coordinator gates on the same require_stage_approved used
    # here; with no approval there are no provider calls and no holds
    # (asserted in the coordinator suite). Here: the gate itself blocks.
    with pytest.raises(NotApprovedError):
        require_stage_ready(tmp_path, "concept_lock")


# --- recovery ---------------------------------------------------------------


def test_corrupt_marker_is_typed_error_not_guessed(tmp_path: Path) -> None:
    marker = tmp_path / "approval" / "concept_lock.json"
    marker.parent.mkdir(parents=True)
    marker.write_text("{broken", encoding="utf-8")
    with pytest.raises(ApprovalError):
        transition_stage(tmp_path, "concept_lock", "review", at=AT, by="o")


def test_interrupted_state_resumes_without_overwrite(tmp_path: Path) -> None:
    rel = _target(tmp_path)
    transition_stage(tmp_path, "concept_lock", "review", at=AT, by="o")
    # a repeated identical command is an illegal transition, not a silent
    # overwrite of state
    with pytest.raises(ApprovalError, match="illegal transition"):
        transition_stage(tmp_path, "concept_lock", "review", at=AT, by="o")
    # resume by continuing from the current status
    transition_stage(tmp_path, "concept_lock", "approve", at=AT, by="o", targets=(rel,))
    assert read_audit(tmp_path)[-1]["to_status"] == "approved"


def test_cli_stage_flow(tmp_path: Path) -> None:
    import ai_video_workflow.cli as cli

    rel = _target(tmp_path)
    base = ["--project-root", str(tmp_path)]
    assert cli.main([*base, "stage-plan"]) == 0
    assert cli.main([*base, "stage-review", "concept_lock", "--by", "o"]) == 0
    assert (
        cli.main([*base, "stage-approve", "concept_lock", "--by", "o", "--target", rel])
        == 0
    )
    assert cli.main([*base, "stage-status"]) == 0
    # illegal transition -> non-zero exit
    assert cli.main([*base, "stage-review", "concept_lock", "--by", "o"]) == 1
