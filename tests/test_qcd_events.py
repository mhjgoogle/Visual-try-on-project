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
    build_composition_completed_event,
    build_manual_attempt_recorded_event,
    build_manual_quality_rating_event,
    build_task_created_event,
    build_task_status_changed_event,
    build_validation_completed_event,
)

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def test_seven_event_types() -> None:
    assert len(QcdEventType) == 7
    assert len(_PAYLOAD_KEYS) == 7


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
