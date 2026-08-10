"""Feedback/Action domain + service tests (TASK-029 / ADR-0035).

Covers version-binding fail-closed, the independent state machine (legal /
illegal / terminal transitions, the waiting_for_user verification loop), stale
fail-closed + explicit rebind, actor rules (user-only verification), credential
isolation, immutable history, and the concrete QCD-backed resolver. No provider,
no network, no payment; a temp project root only.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ai_video_workflow.action import (
    ActionActor,
    ActionActorError,
    ActionService,
    ActionStateError,
    CorruptActionLogError,
    DuplicateRecordError,
    ResolvedTarget,
    StaleActionError,
    StaleTargetError,
    WorkflowTargetResolver,
    log_path,
    read_records,
)
from ai_video_workflow.errors import (
    FieldTypeError,
    InvariantViolationError,
    ReferenceValidationError,
)

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64


def _clock():
    return T0


class FakeResolver:
    def __init__(self, targets: dict | None = None) -> None:
        self._targets = targets if targets is not None else {("asset-a", 1): _DIGEST}

    def resolve_target(self, project_root: Path, *, ref: str, version: int):
        digest = self._targets.get((ref, version), "__missing__")
        if digest == "__missing__":
            return ResolvedTarget(exists=False, content_digest=None)
        return ResolvedTarget(exists=True, content_digest=digest)


def _target(ref="asset-a", version=1, digest=_DIGEST) -> dict:
    return {"ref": ref, "version": version, "content_digest": digest}


def _svc(tmp_path, resolver=None, clock=_clock) -> ActionService:
    return ActionService(
        tmp_path, "proj-1", resolver=resolver or FakeResolver(), clock=clock
    )


def _seed_action(svc, *, action_id="act-1", n=0):
    """Create a feedback + action; return the action record."""
    svc.create_feedback(
        actor=ActionActor.USER,
        feedback_id=f"fb-{action_id}",
        target=_target(),
        context={"stage": "S1", "shot": "shot-1"},
        summary="motion jitter",
        detail="the pan stutters near the end",
        occurred_at=T0,
    )
    return svc.create_action(
        actor=ActionActor.USER,
        action_id=action_id,
        feedback_id=f"fb-{action_id}",
        target=_target(),
        context={"stage": "S1"},
        intent="re-render the shot",
        occurred_at=T0 + timedelta(seconds=1),
    )


# --- binding fail-closed + credential isolation ------------------------------


def test_create_feedback_appends_and_binds(tmp_path):
    svc = _svc(tmp_path)
    rec = svc.create_feedback(
        actor=ActionActor.USER,
        feedback_id="fb-1",
        target=_target(),
        context={"stage": "S1"},
        summary="s",
        detail="d",
        occurred_at=T0,
    )
    assert rec.record_id == "feedback:proj-1:fb-1"
    assert len(read_records(tmp_path)) == 1


def test_create_feedback_missing_target_fails_closed(tmp_path):
    svc = _svc(tmp_path, FakeResolver({}))
    with pytest.raises(StaleTargetError):
        svc.create_feedback(
            actor=ActionActor.USER,
            feedback_id="fb-1",
            target=_target(),
            context={},
            summary="s",
            detail="d",
            occurred_at=T0,
        )
    assert read_records(tmp_path) == ()


def test_create_feedback_digest_mismatch_fails_closed(tmp_path):
    svc = _svc(tmp_path, FakeResolver({("asset-a", 1): _DIGEST2}))
    with pytest.raises(StaleTargetError):
        svc.create_feedback(
            actor=ActionActor.USER,
            feedback_id="fb-1",
            target=_target(digest=_DIGEST),
            context={},
            summary="s",
            detail="d",
            occurred_at=T0,
        )


def test_context_rejects_credential_key(tmp_path):
    svc = _svc(tmp_path)
    with pytest.raises(InvariantViolationError):
        svc.create_feedback(
            actor=ActionActor.USER,
            feedback_id="fb-1",
            target=_target(),
            context={"authorization": "Bearer xyz"},
            summary="s",
            detail="d",
            occurred_at=T0,
        )


def test_context_rejects_url_value(tmp_path):
    svc = _svc(tmp_path)
    with pytest.raises(InvariantViolationError):
        svc.create_feedback(
            actor=ActionActor.USER,
            feedback_id="fb-1",
            target=_target(),
            context={"download": "https://example.com/private?sig=abc"},
            summary="s",
            detail="d",
            occurred_at=T0,
        )


def test_malformed_target_is_domain_error_not_crash(tmp_path):
    svc = _svc(tmp_path)
    for bad in (
        {},
        {"ref": "x"},
        {"ref": "x", "version": "nope", "content_digest": _DIGEST},
    ):
        with pytest.raises(FieldTypeError):
            svc.create_feedback(
                actor=ActionActor.USER,
                feedback_id="fb-1",
                target=bad,
                context={},
                summary="s",
                detail="d",
                occurred_at=T0,
            )


def test_action_unknown_feedback_id_is_reference_error(tmp_path):
    svc = _svc(tmp_path)
    with pytest.raises(ReferenceValidationError):
        svc.create_action(
            actor=ActionActor.USER,
            action_id="act-1",
            feedback_id="nope",
            target=_target(),
            context={},
            intent="fix",
            occurred_at=T0,
        )


# --- state machine -----------------------------------------------------------


def test_action_starts_pending(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    view = svc.get_action("act-1")
    assert view.folded.lifecycle_state == "pending"
    assert view.effective_state == "pending"


def test_legal_transition(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=2),
    )
    assert svc.get_action("act-1").folded.lifecycle_state == "in_progress"


def test_illegal_transition_rejected(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    with pytest.raises(ActionStateError):
        svc.transition(
            actor=ActionActor.AGENT,
            event_id="t1",
            action_id="act-1",
            to_state="completed",  # pending -> completed is illegal
            occurred_at=T0 + timedelta(seconds=2),
        )


def test_terminal_action_rejects_further_transition(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="cancelled",
        occurred_at=T0 + timedelta(seconds=2),
    )
    assert svc.get_action("act-1").folded.lifecycle_state == "cancelled"
    with pytest.raises(ActionStateError):
        svc.transition(
            actor=ActionActor.AGENT,
            event_id="t2",
            action_id="act-1",
            to_state="in_progress",
            occurred_at=T0 + timedelta(seconds=3),
        )


def test_verification_loop_resolved_completes(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    t = T0 + timedelta(seconds=2)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=t,
    )
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t2",
        action_id="act-1",
        to_state="waiting_for_user",
        occurred_at=t + timedelta(seconds=1),
    )
    svc.record_verification(
        actor=ActionActor.USER,
        event_id="v1",
        action_id="act-1",
        verdict="resolved",
        note="looks good now",
        occurred_at=t + timedelta(seconds=2),
    )
    assert svc.get_action("act-1").folded.lifecycle_state == "completed"


def test_verification_continue_returns_to_in_progress(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    t = T0 + timedelta(seconds=2)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=t,
    )
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t2",
        action_id="act-1",
        to_state="waiting_for_user",
        occurred_at=t + timedelta(seconds=1),
    )
    svc.record_verification(
        actor=ActionActor.USER,
        event_id="v1",
        action_id="act-1",
        verdict="continue",
        note="still stutters",
        occurred_at=t + timedelta(seconds=2),
    )
    assert svc.get_action("act-1").folded.lifecycle_state == "in_progress"


def test_verification_only_by_user(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    t = T0 + timedelta(seconds=2)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=t,
    )
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t2",
        action_id="act-1",
        to_state="waiting_for_user",
        occurred_at=t + timedelta(seconds=1),
    )
    with pytest.raises(ActionActorError):
        svc.record_verification(
            actor=ActionActor.AGENT,
            event_id="v1",
            action_id="act-1",
            verdict="resolved",
            note="agent cannot confirm",
            occurred_at=t + timedelta(seconds=2),
        )


def test_verification_only_from_waiting_for_user(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    with pytest.raises(ActionStateError):
        svc.record_verification(
            actor=ActionActor.USER,
            event_id="v1",
            action_id="act-1",
            verdict="resolved",
            note="too early",
            occurred_at=T0 + timedelta(seconds=2),
        )


# --- stale fail-closed + rebind ----------------------------------------------


def test_stale_action_blocks_transition_but_allows_cancel_and_rebind(tmp_path):
    # created fresh against asset-a v1 = _DIGEST
    write = _svc(tmp_path, FakeResolver({("asset-a", 1): _DIGEST}))
    _seed_action(write)
    write.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=2),
    )
    # the target digest drifts underneath the action
    drifted = _svc(tmp_path, FakeResolver({("asset-a", 1): _DIGEST2}))
    view = drifted.get_action("act-1")
    assert view.target_stale is True
    assert view.effective_state == "stale"
    with pytest.raises(StaleActionError):
        drifted.transition(
            actor=ActionActor.AGENT,
            event_id="t2",
            action_id="act-1",
            to_state="waiting_for_user",
            occurred_at=T0 + timedelta(seconds=3),
        )
    # rebind to the current version clears stale and resets to pending
    drifted.rebind(
        actor=ActionActor.USER,
        event_id="rb1",
        action_id="act-1",
        target=_target(digest=_DIGEST2),
        occurred_at=T0 + timedelta(seconds=4),
    )
    reread = drifted.get_action("act-1")
    assert reread.target_stale is False
    assert reread.folded.lifecycle_state == "pending"
    assert reread.folded.rebind_count == 1


def test_stale_action_can_still_be_cancelled(tmp_path):
    write = _svc(tmp_path, FakeResolver({("asset-a", 1): _DIGEST}))
    _seed_action(write)
    drifted = _svc(tmp_path, FakeResolver({("asset-a", 1): _DIGEST2}))
    drifted.transition(
        actor=ActionActor.USER,
        event_id="t1",
        action_id="act-1",
        to_state="cancelled",
        occurred_at=T0 + timedelta(seconds=2),
    )
    assert drifted.get_action("act-1").folded.lifecycle_state == "cancelled"


def test_rebind_to_missing_target_fails_closed(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    with pytest.raises(StaleTargetError):
        svc.rebind(
            actor=ActionActor.USER,
            event_id="rb1",
            action_id="act-1",
            target=_target(ref="ghost", version=9, digest=_DIGEST),
            occurred_at=T0 + timedelta(seconds=2),
        )


def test_handling_recorded_and_blocked_when_stale(tmp_path):
    write = _svc(tmp_path, FakeResolver({("asset-a", 1): _DIGEST}))
    _seed_action(write)
    write.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=2),
    )
    write.record_handling(
        actor=ActionActor.AGENT,
        event_id="h1",
        action_id="act-1",
        execution_note="re-rendered",
        cost_change={"JPY": 1500},
        occurred_at=T0 + timedelta(seconds=3),
    )
    assert len(write.get_action("act-1").events) == 2  # transition + handling
    drifted = _svc(tmp_path, FakeResolver({("asset-a", 1): _DIGEST2}))
    with pytest.raises(StaleActionError):
        drifted.record_handling(
            actor=ActionActor.AGENT,
            event_id="h2",
            action_id="act-1",
            execution_note="on wrong version",
            occurred_at=T0 + timedelta(seconds=4),
        )


# --- immutable history + corrupt log -----------------------------------------


def test_history_is_append_only(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=2),
    )
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t2",
        action_id="act-1",
        to_state="blocked",
        occurred_at=T0 + timedelta(seconds=3),
    )
    # both transitions survive; the earlier one is not overwritten
    kinds = [r.record_type.value for r in read_records(tmp_path)]
    assert kinds.count("transition") == 2


def test_fold_ignores_out_of_band_illegal_records(tmp_path):
    # records appended via the low-level API (bypassing the service) that are
    # schema-valid but state-illegal must NOT forge or revive lifecycle state
    from ai_video_workflow.action import (
        append_record,
        build_transition_record,
    )

    svc = _svc(tmp_path)
    _seed_action(svc)  # act-1 is pending
    # forged: pending -> completed (illegal skip of the whole loop)
    append_record(
        tmp_path,
        build_transition_record(
            project_id="proj-1",
            actor=ActionActor.AGENT,
            event_id="forge1",
            action_id="act-1",
            to_state="completed",
            occurred_at=T0 + timedelta(seconds=2),
        ),
    )
    assert svc.get_action("act-1").folded.lifecycle_state == "pending"  # ignored
    # legitimately cancel, then forge a revival to in_progress
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="c1",
        action_id="act-1",
        to_state="cancelled",
        occurred_at=T0 + timedelta(seconds=3),
    )
    append_record(
        tmp_path,
        build_transition_record(
            project_id="proj-1",
            actor=ActionActor.AGENT,
            event_id="forge2",
            action_id="act-1",
            to_state="in_progress",
            occurred_at=T0 + timedelta(seconds=4),
        ),
    )
    assert svc.get_action("act-1").folded.lifecycle_state == "cancelled"  # not revived


def test_event_before_action_creation_is_ignored(tmp_path):
    # a transition pre-appended (out-of-band) BEFORE its action's creation must
    # not forge the Action's initial state
    from ai_video_workflow.action import append_record, build_transition_record

    svc = _svc(tmp_path)
    append_record(
        tmp_path,
        build_transition_record(
            project_id="proj-1",
            actor=ActionActor.AGENT,
            event_id="pre",
            action_id="act-1",
            to_state="in_progress",
            occurred_at=T0,
        ),
    )
    _seed_action(svc)  # act-1 created AFTER the pre-appended transition
    view = svc.get_action("act-1")
    assert view.folded.lifecycle_state == "pending"  # pre-creation event ignored
    assert len(view.events) == 0


def test_fold_ignores_out_of_band_agent_verification(tmp_path):
    # a forged NON-user verification appended out-of-band must not drive the
    # waiting_for_user -> completed tail (verification is the user's)
    from ai_video_workflow.action import append_record, build_verification_record

    svc = _svc(tmp_path)
    _seed_action(svc)
    t = T0 + timedelta(seconds=2)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=t,
    )
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t2",
        action_id="act-1",
        to_state="waiting_for_user",
        occurred_at=t + timedelta(seconds=1),
    )
    append_record(
        tmp_path,
        build_verification_record(
            project_id="proj-1",
            actor=ActionActor.AGENT,
            event_id="forge-v",
            action_id="act-1",
            verdict="resolved",
            note="forged agent verify",
            occurred_at=t + timedelta(seconds=2),
        ),
    )
    # the forged agent verification is ignored; the Action stays waiting_for_user
    assert svc.get_action("act-1").folded.lifecycle_state == "waiting_for_user"


def test_foreign_project_records_are_ignored(tmp_path):
    # a foreign-project record placed in this project's log (out-of-band) must
    # not be attributed to or alter this project's Actions
    from ai_video_workflow.action import (
        append_record,
        build_action_record,
        build_feedback_record,
        build_transition_record,
    )

    svc = _svc(tmp_path)  # project_id "proj-1"
    _seed_action(svc)  # act-1 (pending) for proj-1
    append_record(
        tmp_path,
        build_feedback_record(
            project_id="other-proj",
            actor=ActionActor.USER,
            feedback_id="fb-x",
            target=_target(),
            context={},
            summary="s",
            detail="d",
            occurred_at=T0,
        ),
    )
    append_record(
        tmp_path,
        build_action_record(
            project_id="other-proj",
            actor=ActionActor.USER,
            action_id="act-1",
            feedback_id=None,
            target=_target(),
            context={},
            intent="foreign",
            occurred_at=T0,
        ),
    )
    # a foreign transition on the same action_id must not move proj-1's Action
    append_record(
        tmp_path,
        build_transition_record(
            project_id="other-proj",
            actor=ActionActor.AGENT,
            event_id="ft",
            action_id="act-1",
            to_state="completed",
            occurred_at=T0,
        ),
    )
    actions = svc.read_actions()
    assert len(actions) == 1
    assert actions[0].action.project_id == "proj-1"
    assert actions[0].folded.lifecycle_state == "pending"  # foreign event ignored


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="POSIX mode-bit tightening (fchmod) is a no-op on Windows — ADR-0049",
)
def test_existing_loose_log_permissions_are_tightened(tmp_path):
    import os
    import stat

    svc = _svc(tmp_path)
    svc.create_feedback(
        actor=ActionActor.USER,
        feedback_id="fb-1",
        target=_target(),
        context={},
        summary="s",
        detail="d",
        occurred_at=T0,
    )
    os.chmod(log_path(tmp_path), 0o644)  # loosen out-of-band
    read_records(tmp_path)  # any open repairs the private-log guarantee
    mode = stat.S_IMODE(os.stat(log_path(tmp_path)).st_mode)
    assert mode & 0o077 == 0  # no group/other access remains


def test_resolver_fails_closed_without_project_json(tmp_path):
    from ai_video_workflow.qcd.events import build_asset_imported_event
    from ai_video_workflow.qcd.log import append_event

    append_event(
        tmp_path,
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
    # no project.json -> owning project_id unknown -> resolver fails closed even
    # though a matching asset_imported exists
    assert (
        WorkflowTargetResolver()
        .resolve_target(tmp_path, ref="asset-a", version=1)
        .exists
        is False
    )


def test_corrupt_log_raises(tmp_path):
    log_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    log_path(tmp_path).write_text("not json\n", encoding="utf-8")
    with pytest.raises(CorruptActionLogError):
        read_records(tmp_path)


# --- concrete resolver against real QCD facts --------------------------------


def test_credential_substring_keys_rejected(tmp_path):
    # substring match catches refresh_token / client_secret / authorization-header
    svc = _svc(tmp_path)
    for bad in (
        "refresh_token",
        "client_secret",
        "authorization-header",
        "X-API-Key",
        "api.key",
        "access/key",
        "session token",
        "accessKey",  # camelCase
        "privateKey",
        "apiKey",
    ):
        with pytest.raises(InvariantViolationError):
            svc.create_feedback(
                actor=ActionActor.USER,
                feedback_id=f"fb-{bad}",
                target=_target(),
                context={bad: "leak"},
                summary="s",
                detail="d",
                occurred_at=T0,
            )


def test_free_text_fields_reject_urls(tmp_path):
    # a private URL smuggled into prose (summary/detail/intent/notes) is refused
    svc = _svc(tmp_path)
    with pytest.raises(InvariantViolationError):
        svc.create_feedback(
            actor=ActionActor.USER,
            feedback_id="fb-1",
            target=_target(),
            context={},
            summary="see https://example.com/private?sig=leak",
            detail="d",
            occurred_at=T0,
        )
    _seed_action(svc)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=2),
    )
    with pytest.raises(InvariantViolationError):
        svc.record_handling(
            actor=ActionActor.AGENT,
            event_id="h1",
            action_id="act-1",
            execution_note="fetched from s3://bucket/secret",
            occurred_at=T0 + timedelta(seconds=3),
        )


def test_duplicate_record_id_rejected(tmp_path):
    svc = _svc(tmp_path)
    svc.create_feedback(
        actor=ActionActor.USER,
        feedback_id="fb-1",
        target=_target(),
        context={},
        summary="s",
        detail="d",
        occurred_at=T0,
    )
    with pytest.raises(DuplicateRecordError):
        svc.create_feedback(
            actor=ActionActor.USER,
            feedback_id="fb-1",
            target=_target(),
            context={},
            summary="dup",
            detail="dup",
            occurred_at=T0,
        )
    # the duplicate was NOT appended
    assert len(read_records(tmp_path)) == 1


def test_backdated_event_rejected(tmp_path):
    svc = _svc(tmp_path)
    _seed_action(svc)  # action created at T0+1s
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=5),
    )
    with pytest.raises(ActionStateError):
        svc.transition(
            actor=ActionActor.AGENT,
            event_id="t2",
            action_id="act-1",
            to_state="blocked",
            occurred_at=T0 + timedelta(seconds=3),  # backdated
        )


def test_fold_uses_append_order_not_record_id_order(tmp_path):
    # two transitions share a timestamp; append order (in_progress then blocked)
    # must win over record_id lexical order ("a-evt" < "z-evt" would give the
    # wrong final state if sorted by id)
    svc = _svc(tmp_path)
    _seed_action(svc)
    same = T0 + timedelta(seconds=5)
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="z-evt",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=same,
    )
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="a-evt",
        action_id="act-1",
        to_state="blocked",
        occurred_at=same,
    )
    assert svc.get_action("act-1").folded.lifecycle_state == "blocked"


def test_concrete_resolver_binds_real_asset(tmp_path):
    from ai_video_workflow.models import Project
    from ai_video_workflow.persistence import write_model_json
    from ai_video_workflow.qcd.events import build_asset_imported_event
    from ai_video_workflow.qcd.log import append_event

    # project.json establishes the owning project_id the resolver checks against
    write_model_json(tmp_path / "project.json", Project("proj-1", "Demo", T0))
    append_event(
        tmp_path,
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
    svc = ActionService(
        tmp_path, "proj-1", resolver=WorkflowTargetResolver(), clock=_clock
    )
    rec = svc.create_feedback(
        actor=ActionActor.USER,
        feedback_id="fb-1",
        target=_target(digest=_DIGEST),
        context={"stage": "S1"},
        summary="s",
        detail="d",
        occurred_at=T0,
    )
    assert rec.record_id == "feedback:proj-1:fb-1"
    # a wrong digest against the real asset fails closed
    with pytest.raises(StaleTargetError):
        svc.create_feedback(
            actor=ActionActor.USER,
            feedback_id="fb-2",
            target=_target(digest=_DIGEST2),
            context={},
            summary="s",
            detail="d",
            occurred_at=T0,
        )
