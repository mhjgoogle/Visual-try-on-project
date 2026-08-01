"""Tests for the derived spend ledger (TASK-B3)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ai_video_workflow.budget import build_ledger, month_key_jst, read_ledger
from ai_video_workflow.config.project_config import FxConfig
from ai_video_workflow.qcd.events import (
    build_manual_attempt_recorded_event,
    build_task_created_event,
)
from ai_video_workflow.qcd.log import append_event

_FX = FxConfig(base_currency="JPY", rates={"USD": 160})


def _attempt(shot_id, task_id, attempt_id, cost, at):
    return build_manual_attempt_recorded_event(
        project_id="proj-1",
        shot_id=shot_id,
        task_id=task_id,
        attempt_id=attempt_id,
        provider_id="cloud-a",
        outcome="produced_candidate",
        occurred_at=at,
        cost_minor_units=cost,
        currency="USD",
    )


def _utc(year, month, day, hour=0):
    return datetime(year, month, day, hour, tzinfo=timezone.utc)


def test_build_ledger_aggregates_and_converts() -> None:
    events = [
        _attempt("shot-1", "task-1", "att-1", 1000, _utc(2026, 7, 15)),
        _attempt("shot-2", "task-2", "att-2", 500, _utc(2026, 7, 31, 16)),
        # a non-money event is ignored
        build_task_created_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            configured_provider_id="cloud-a",
            origin="bootstrap",
            redo_of_task_id=None,
            occurred_at=_utc(2026, 7, 15),
        ),
    ]
    ledger = build_ledger(events, _FX)
    assert ledger.project_total_jpy == 2400  # 1600 + 800
    assert ledger.shot_spent("shot-1") == 1600
    assert ledger.shot_spent("shot-2") == 800
    # 2026-07-31T16:00Z is 2026-08-01T01:00 JST -> August bucket
    assert ledger.month_spent("2026-07") == 1600
    assert ledger.month_spent("2026-08") == 800


def test_absent_buckets_return_zero() -> None:
    ledger = build_ledger([], _FX)
    assert ledger.project_total_jpy == 0
    assert ledger.shot_spent("nope") == 0
    assert ledger.month_spent("2026-01") == 0


def test_null_cost_attempt_ignored() -> None:
    event = build_manual_attempt_recorded_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        attempt_id="att-1",
        provider_id="manual",
        outcome="produced_candidate",
        occurred_at=_utc(2026, 7, 15),
        # no cost recorded
    )
    ledger = build_ledger([event], _FX)
    assert ledger.project_total_jpy == 0


def test_month_key_jst_boundary() -> None:
    assert month_key_jst(_utc(2026, 7, 31, 14)) == "2026-07"  # 23:00 JST
    assert month_key_jst(_utc(2026, 7, 31, 16)) == "2026-08"  # 01:00 JST next day


def test_read_ledger_from_project_root(tmp_path: Path) -> None:
    append_event(
        tmp_path, _attempt("shot-1", "task-1", "att-1", 1000, _utc(2026, 7, 1))
    )
    append_event(tmp_path, _attempt("shot-1", "task-1", "att-2", 250, _utc(2026, 7, 2)))
    ledger = read_ledger(tmp_path, _FX)
    assert ledger.shot_spent("shot-1") == 1600 + 400  # ceil(250*1.6)=400
    assert ledger.project_total_jpy == 2000


def test_read_ledger_missing_log_is_empty(tmp_path: Path) -> None:
    ledger = read_ledger(tmp_path, _FX)
    assert ledger.project_total_jpy == 0
