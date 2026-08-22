"""Tests for the provider_cost_recorded QCD event (ADR-0008 / TASK-016)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.errors import InvariantViolationError
from ai_video_workflow.qcd.events import (
    QcdEvent,
    QcdEventType,
    build_provider_cost_recorded_event,
)
from ai_video_workflow.qcd.log import append_event, read_events

T0 = datetime(2026, 8, 1, tzinfo=timezone.utc)


def _event(**overrides):
    kwargs = dict(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        provider_id="minimax",
        model_id="hailuo-02",
        operation_id="op-1",
        cost_minor_units=10,
        currency="USD",
        billing_source="float_boundary_conversion",
        occurred_at=T0,
        observed_amount=0.10,
        observed_unit="USD",
    )
    kwargs.update(overrides)
    return build_provider_cost_recorded_event(**kwargs)


def test_event_id_and_payload() -> None:
    event = _event()
    assert event.event_id == "provider_cost_recorded:task-1:op-1"
    assert event.event_type is QcdEventType.PROVIDER_COST_RECORDED
    assert event.payload["cost_minor_units"] == 10
    assert event.payload["currency"] == "USD"
    assert event.payload["observed_amount"] == 0.10


def test_observed_telemetry_may_be_null() -> None:
    event = _event(observed_amount=None, observed_unit=None)
    assert event.payload["observed_amount"] is None


def test_append_and_read_dedup(tmp_path: Path) -> None:
    append_event(tmp_path, _event())
    append_event(tmp_path, _event())  # same event_id -> deduped by reader
    events = [
        e
        for e in read_events(tmp_path)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(events) == 1


def test_raw_event_rejects_bad_currency() -> None:
    good = _event()
    payload = dict(good.payload)
    payload["currency"] = "usd"
    with pytest.raises(InvariantViolationError, match="currency"):
        QcdEvent(
            event_id=good.event_id,
            event_type=QcdEventType.PROVIDER_COST_RECORDED,
            occurred_at=T0,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            payload=payload,
        )


def test_raw_event_rejects_negative_cost() -> None:
    good = _event()
    payload = dict(good.payload)
    payload["cost_minor_units"] = -1
    with pytest.raises(InvariantViolationError, match="cost_minor_units"):
        QcdEvent(
            event_id=good.event_id,
            event_type=QcdEventType.PROVIDER_COST_RECORDED,
            occurred_at=T0,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            payload=payload,
        )


def test_raw_event_rejects_missing_key() -> None:
    good = _event()
    payload = dict(good.payload)
    del payload["billing_source"]
    with pytest.raises(Exception, match="billing_source|missing"):
        QcdEvent(
            event_id=good.event_id,
            event_type=QcdEventType.PROVIDER_COST_RECORDED,
            occurred_at=T0,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            payload=payload,
        )
