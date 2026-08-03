"""Tests for the QCD event model and typed constructors (TASK-005 / ADR-0003)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ai_video_workflow.errors import (
    FieldTypeError,
    InvariantViolationError,
    MissingFieldError,
)
from ai_video_workflow.qcd.events import (
    _PAYLOAD_KEYS,
    RATING_SCALE,
    QcdEvent,
    QcdEventType,
    build_asset_imported_event,
    build_audiovisual_completed_event,
    build_composition_completed_event,
    build_manual_attempt_recorded_event,
    build_manual_quality_rating_event,
    build_task_created_event,
    build_task_status_changed_event,
    build_validation_completed_event,
)

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def test_event_types() -> None:
    # ADR-0003 fixed seven; ADR-0008 adds provider_cost_recorded (eighth);
    # ADR-0003 revision (TASK-008) adds audiovisual_completed (ninth).
    assert len(QcdEventType) == 9
    assert len(_PAYLOAD_KEYS) == 9


def test_audiovisual_completed_event_id_and_payload() -> None:
    event = build_audiovisual_completed_event(
        project_id="proj-1",
        output_path="outputs/final_av_v1.mp4",
        output_version=1,
        output_sha256="a" * 64,
        base_video_path="outputs/final_v1.mp4",
        base_video_sha256="b" * 64,
        audio_refs=(("voiceover", "narration", 1), ("sfx", "whoosh", 2)),
        subtitle_ref=("en", 1, "soft"),
        profile_digest="pd",
        occurred_at=T0,
        output_duration_ms=8000,
    )
    assert event.event_id == "audiovisual_completed:proj-1:v1"
    assert event.event_type is QcdEventType.AUDIOVISUAL_COMPLETED
    assert event.payload["audio_track_count"] == 2
    assert event.payload["subtitle"] == {"ref": "en", "version": 1, "mode": "soft"}
    expected_keys = _PAYLOAD_KEYS[QcdEventType.AUDIOVISUAL_COMPLETED]
    assert frozenset(event.payload) == expected_keys


def test_audiovisual_completed_allows_no_subtitle() -> None:
    event = build_audiovisual_completed_event(
        project_id="proj-1",
        output_path="outputs/final_av_v1.mp4",
        output_version=1,
        output_sha256="a" * 64,
        base_video_path="outputs/final_v1.mp4",
        base_video_sha256="b" * 64,
        audio_refs=(("voiceover", "narration", 1),),
        subtitle_ref=None,
        profile_digest="pd",
        occurred_at=T0,
        output_duration_ms=None,
    )
    assert event.payload["subtitle"] is None


def test_task_created_event_id_and_payload() -> None:
    event = build_task_created_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        configured_provider_id="manual",
        origin="bootstrap",
        redo_of_task_id=None,
        occurred_at=T0,
    )
    assert event.event_id == "task_created:task-shot-1-1"
    assert event.payload["initial_status"] == "pending"
    assert event.payload["task_kind"] == "generation"
    assert event.payload["redo_of_task_id"] is None
    assert "staging_ref" not in event.payload
    assert frozenset(event.payload) == _PAYLOAD_KEYS[QcdEventType.TASK_CREATED]


def test_task_created_rejects_bad_origin() -> None:
    with pytest.raises(InvariantViolationError):
        build_task_created_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            configured_provider_id="manual",
            origin="other",
            redo_of_task_id=None,
            occurred_at=T0,
        )


def test_task_status_changed_event_id() -> None:
    event = build_task_status_changed_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        previous_status="pending",
        new_status="in_progress",
        orchestration_action="submit",
        operation_id="op-a",
        occurred_at=T0,
    )
    assert event.event_id == "task_status_changed:task-1:op-a"
    assert event.payload["reason"] == "provider_transition"


def test_status_changed_rejects_unknown_status() -> None:
    with pytest.raises(InvariantViolationError):
        build_task_status_changed_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            previous_status="pending",
            new_status="bogus",
            orchestration_action="submit",
            operation_id="op-a",
            occurred_at=T0,
        )


def test_status_changed_rejects_unknown_action() -> None:
    with pytest.raises(InvariantViolationError):
        build_task_status_changed_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            previous_status="pending",
            new_status="in_progress",
            orchestration_action="teleport",
            operation_id="op-a",
            occurred_at=T0,
        )


def test_asset_imported_rejects_bad_sha256() -> None:
    with pytest.raises(InvariantViolationError):
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            asset_id="asset-1",
            sha256="NOT-HEX",
            size_bytes=1,
            path="assets/media/x.mp4",
            version=1,
            duration_ms=None,
            source_attempt_id=None,
            occurred_at=T0,
        )


def test_asset_imported_rejects_nonpositive_version() -> None:
    with pytest.raises(InvariantViolationError):
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            asset_id="asset-1",
            sha256="a" * 64,
            size_bytes=1,
            path="assets/media/x.mp4",
            version=0,
            duration_ms=None,
            source_attempt_id=None,
            occurred_at=T0,
        )


def test_status_changed_accepts_replay_result_action() -> None:
    event = build_task_status_changed_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        previous_status="in_progress",
        new_status="done",
        orchestration_action="replay_result",
        operation_id="op-a",
        occurred_at=T0,
    )
    assert event.payload["orchestration_action"] == "replay_result"


def test_direct_qcd_event_rejects_mismatched_event_id() -> None:
    # the value-domain + event_id derivation is enforced in QcdEvent itself,
    # so a hand-built (or deserialized) event with a forged id is rejected.
    with pytest.raises(InvariantViolationError):
        QcdEvent(
            event_id="task_created:WRONG",
            event_type=QcdEventType.TASK_CREATED,
            occurred_at=T0,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            payload={
                "initial_status": "pending",
                "task_kind": "generation",
                "configured_provider_id": "manual",
                "origin": "bootstrap",
                "redo_of_task_id": None,
            },
        )


def test_direct_qcd_event_rejects_bad_sha_in_payload() -> None:
    with pytest.raises(InvariantViolationError):
        QcdEvent(
            event_id="asset_imported:proj-1:shot-1:task-1:asset-1:NOTHEX",
            event_type=QcdEventType.ASSET_IMPORTED,
            occurred_at=T0,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            payload={
                "asset_id": "asset-1",
                "asset_kind": "video",
                "sha256": "NOTHEX",
                "size_bytes": 1,
                "duration_ms": None,
                "source_task_id": "task-1",
                "source_attempt_id": None,
                "path": "assets/media/x.mp4",
                "version": 1,
            },
        )


def test_composition_rejects_bad_output_sha() -> None:
    with pytest.raises(InvariantViolationError):
        build_composition_completed_event(
            project_id="proj-1",
            output_path="outputs/final_v1.mp4",
            output_version=1,
            output_sha256="zz",
            input_asset_ids=("asset-1",),
            profile_digest="d",
            occurred_at=T0,
            output_duration_ms=None,
        )


def test_manual_attempt_money_pairing() -> None:
    event = build_manual_attempt_recorded_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        attempt_id="att-1",
        provider_id="manual",
        outcome="produced_candidate",
        occurred_at=T0,
        elapsed_ms=1200,
        cost_minor_units=500,
        currency="USD",
    )
    assert event.event_id == "manual_attempt_recorded:task-1:att-1"
    assert event.payload["cost_minor_units"] == 500


def test_manual_attempt_money_must_pair() -> None:
    with pytest.raises(InvariantViolationError):
        build_manual_attempt_recorded_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            attempt_id="att-1",
            provider_id="manual",
            outcome="unknown",
            occurred_at=T0,
            cost_minor_units=500,
            currency=None,
        )


def test_manual_attempt_negative_elapsed_rejected() -> None:
    with pytest.raises(InvariantViolationError):
        build_manual_attempt_recorded_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            attempt_id="att-1",
            provider_id="manual",
            outcome="unknown",
            occurred_at=T0,
            elapsed_ms=-1,
        )


def test_asset_imported_event_id_binds_identity_and_content() -> None:
    event = build_asset_imported_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        asset_id="asset-task-1-v1",
        sha256="a" * 64,
        size_bytes=1024,
        path="assets/media/s01_sh001_v1.mp4",
        version=1,
        duration_ms=4000,
        source_attempt_id=None,
        occurred_at=T0,
    )
    assert event.event_id == (
        "asset_imported:proj-1:shot-1:task-1:asset-task-1-v1:" + "a" * 64
    )
    assert event.payload["source_task_id"] == "task-1"
    assert event.payload["asset_kind"] == "video"


def test_validation_completed_event_id_version() -> None:
    event = build_validation_completed_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        passed=True,
        report_path="reports/validation/task-1_v2.json",
        report_version=2,
        checks_total=10,
        checks_failed=0,
        input_sha256="b" * 64,
        asset_id="asset-task-1-v2",
        occurred_at=T0,
    )
    assert event.event_id == "validation_completed:task-1:v2"


def test_composition_completed_event() -> None:
    event = build_composition_completed_event(
        project_id="proj-1",
        output_path="outputs/final_v1.mp4",
        output_version=1,
        output_sha256="c" * 64,
        input_asset_ids=("asset-a", "asset-b"),
        profile_digest="d" * 64,
        occurred_at=T0,
        output_duration_ms=8000,
    )
    assert event.event_id == "composition_completed:proj-1:v1"
    assert event.payload["entry_count"] == 2
    assert event.task_id is None and event.shot_id is None


def test_manual_quality_rating_range() -> None:
    event = build_manual_quality_rating_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id=None,
        rating_id="rate-1",
        score=5,
        asset_id=None,
        occurred_at=T0,
    )
    assert event.event_id == "manual_quality_rating_recorded:shot-1:rate-1"
    assert event.payload["scale"] == RATING_SCALE
    with pytest.raises(InvariantViolationError):
        build_manual_quality_rating_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id=None,
            rating_id="rate-2",
            score=6,
            asset_id=None,
            occurred_at=T0,
        )


def test_qcd_event_rejects_extra_payload_key() -> None:
    with pytest.raises(InvariantViolationError):
        QcdEvent(
            event_id="task_created:task-1",
            event_type=QcdEventType.TASK_CREATED,
            occurred_at=T0,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            payload={
                "initial_status": "pending",
                "task_kind": "generation",
                "configured_provider_id": "manual",
                "origin": "bootstrap",
                "redo_of_task_id": None,
                "unexpected": 1,
            },
        )


def test_qcd_event_rejects_missing_payload_key() -> None:
    with pytest.raises(MissingFieldError):
        QcdEvent(
            event_id="task_created:task-1",
            event_type=QcdEventType.TASK_CREATED,
            occurred_at=T0,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            payload={"initial_status": "pending"},
        )


def test_qcd_event_rejects_naive_datetime() -> None:
    with pytest.raises(InvariantViolationError):
        build_task_created_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            configured_provider_id="manual",
            origin="bootstrap",
            redo_of_task_id=None,
            occurred_at=datetime(2026, 7, 29, 8, 0, 0),
        )


def test_qcd_event_rejects_bad_type() -> None:
    with pytest.raises(FieldTypeError):
        QcdEvent(
            event_id="x",
            event_type="task_created",  # type: ignore[arg-type]
            occurred_at=T0,
            project_id="proj-1",
            shot_id=None,
            task_id=None,
            payload={},
        )


def test_envelope_round_trip_keys() -> None:
    event = build_task_created_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        configured_provider_id="manual",
        origin="redo",
        redo_of_task_id="task-0",
        occurred_at=T0,
    )
    envelope = event.to_envelope()
    assert set(envelope) == {
        "schema_version",
        "event_id",
        "event_type",
        "occurred_at",
        "project_id",
        "shot_id",
        "task_id",
        "payload",
    }
    assert envelope["schema_version"] == 1
    assert envelope["event_type"] == "task_created"
    assert envelope["occurred_at"] == "2026-07-29T08:00:00.000000+00:00"


def _reconstruct(event: QcdEvent, **payload_changes) -> QcdEvent:
    payload = dict(event.payload)
    payload.update(payload_changes)
    return QcdEvent(
        event_id=event.event_id,
        event_type=event.event_type,
        occurred_at=event.occurred_at,
        project_id=event.project_id,
        shot_id=event.shot_id,
        task_id=event.task_id,
        payload=payload,
    )


def test_qcdevent_enforces_fixed_value_domains() -> None:
    # a directly-constructed / deserialized QcdEvent (not only the typed
    # builders) must reject the ADR-0003 fixed values and the entry_count
    # cross-field invariant.
    tc = build_task_created_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        configured_provider_id="manual",
        origin="bootstrap",
        redo_of_task_id=None,
        occurred_at=T0,
    )
    for change in ({"initial_status": "done"}, {"task_kind": "evil"}):
        with pytest.raises(InvariantViolationError):
            _reconstruct(tc, **change)

    tsc = build_task_status_changed_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        previous_status="pending",
        new_status="in_progress",
        orchestration_action="submit",
        operation_id="op-1",
        occurred_at=T0,
    )
    with pytest.raises(InvariantViolationError):
        _reconstruct(tsc, reason="whatever")

    ma = build_manual_attempt_recorded_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        attempt_id="att-1",
        provider_id="manual",
        outcome="produced_candidate",
        occurred_at=T0,
    )
    with pytest.raises(InvariantViolationError):
        _reconstruct(ma, action="hack")

    ai = build_asset_imported_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        asset_id="asset-task-shot-1-1-v1",
        sha256="a" * 64,
        size_bytes=10,
        path="assets/media/x.mp4",
        version=1,
        duration_ms=4000,
        source_attempt_id=None,
        occurred_at=T0,
    )
    with pytest.raises(InvariantViolationError):
        _reconstruct(ai, asset_kind="audio")

    rating = build_manual_quality_rating_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        rating_id="rate-1",
        score=4,
        asset_id=None,
        occurred_at=T0,
    )
    with pytest.raises(InvariantViolationError):
        _reconstruct(rating, scale="other")

    comp = build_composition_completed_event(
        project_id="proj-1",
        output_path="outputs/final_v1.mp4",
        output_version=1,
        output_sha256="b" * 64,
        input_asset_ids=("asset-a", "asset-b"),
        profile_digest="d",
        occurred_at=T0,
        output_duration_ms=8000,
    )
    with pytest.raises(InvariantViolationError):
        _reconstruct(comp, entry_count=3)
