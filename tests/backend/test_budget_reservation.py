"""Tests for pre-flight budget reservations (TASK-014 contract 4)."""

from __future__ import annotations

from pathlib import Path

import pytest

from ai_video_workflow.budget import (
    ReservationError,
    commit_reservation,
    hold_reservation,
    list_reservations,
    outstanding_holds,
    reconcile_reservations,
    release_reservation,
)

_AT = "2026-08-01T00:00:00+00:00"


def _hold(root, task_id, operation_id, *, shot_id="shot-1", estimate=100):
    return hold_reservation(
        root,
        project_id="proj-1",
        task_id=task_id,
        operation_id=operation_id,
        shot_id=shot_id,
        provider_id="cloud-a",
        model_id="m1",
        estimate_jpy=estimate,
        created_at=_AT,
    )


def test_hold_creates_held(tmp_path: Path) -> None:
    r = _hold(tmp_path, "task-1", "op-1")
    assert r.status == "held"
    assert r.estimate_jpy == 100
    assert r.reservation_id == "resv:task-1:op-1"


def test_hold_is_idempotent(tmp_path: Path) -> None:
    a = _hold(tmp_path, "task-1", "op-1")
    b = _hold(tmp_path, "task-1", "op-1")  # same key, same content
    assert a == b
    assert len(list_reservations(tmp_path)) == 1


def test_conflicting_rehold_rejected(tmp_path: Path) -> None:
    _hold(tmp_path, "task-1", "op-1", estimate=100)
    with pytest.raises(ReservationError, match="conflicting re-hold"):
        _hold(tmp_path, "task-1", "op-1", estimate=200)


def test_outstanding_holds_sum(tmp_path: Path) -> None:
    _hold(tmp_path, "task-1", "op-1", shot_id="shot-1", estimate=100)
    _hold(tmp_path, "task-2", "op-1", shot_id="shot-2", estimate=250)
    _hold(tmp_path, "task-1", "op-2", shot_id="shot-1", estimate=50)
    summary = outstanding_holds(tmp_path)
    assert summary.total_jpy == 400
    assert summary.shot_held("shot-1") == 150
    assert summary.shot_held("shot-2") == 250


def test_commit_removes_from_outstanding(tmp_path: Path) -> None:
    _hold(tmp_path, "task-1", "op-1", estimate=100)
    commit_reservation(tmp_path, "task-1", "op-1", resolved_at=_AT)
    assert outstanding_holds(tmp_path).total_jpy == 0
    r = list_reservations(tmp_path)[0]
    assert r.status == "committed"


def test_release_removes_from_outstanding(tmp_path: Path) -> None:
    _hold(tmp_path, "task-1", "op-1", estimate=100)
    release_reservation(tmp_path, "task-1", "op-1", resolved_at=_AT)
    assert outstanding_holds(tmp_path).total_jpy == 0


def test_commit_and_release_are_idempotent(tmp_path: Path) -> None:
    _hold(tmp_path, "task-1", "op-1")
    commit_reservation(tmp_path, "task-1", "op-1", resolved_at=_AT)
    again = commit_reservation(tmp_path, "task-1", "op-1", resolved_at=_AT)
    assert again.status == "committed"


def test_cannot_release_a_committed_hold(tmp_path: Path) -> None:
    _hold(tmp_path, "task-1", "op-1")
    commit_reservation(tmp_path, "task-1", "op-1", resolved_at=_AT)
    with pytest.raises(ReservationError, match="already 'committed'"):
        release_reservation(tmp_path, "task-1", "op-1", resolved_at=_AT)


def test_resolve_missing_reservation_rejected(tmp_path: Path) -> None:
    with pytest.raises(ReservationError, match="no reservation"):
        commit_reservation(tmp_path, "ghost", "op", resolved_at=_AT)


def test_reconcile_partitions_holds(tmp_path: Path) -> None:
    _hold(tmp_path, "task-1", "op-1")  # will be committed
    _hold(tmp_path, "task-2", "op-1")  # failed -> released
    _hold(tmp_path, "task-3", "op-1")  # indeterminate -> needs_reconciliation
    result = reconcile_reservations(
        tmp_path,
        committed_operations=[("task-1", "op-1")],
        failed_operations=[("task-2", "op-1")],
        resolved_at=_AT,
    )
    assert result.committed == (("task-1", "op-1"),)
    assert result.released == (("task-2", "op-1"),)
    assert result.needs_reconciliation == (("task-3", "op-1"),)
    # a needs_reconciliation hold still counts as outstanding (conservative)
    assert outstanding_holds(tmp_path).total_jpy == 100


def test_path_component_rejects_separators(tmp_path: Path) -> None:
    with pytest.raises(ReservationError, match="valid path component"):
        _hold(tmp_path, "a/b", "op-1")
