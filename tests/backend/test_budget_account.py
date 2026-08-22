"""Tests for account-level monthly spend (TASK-014 contract 4)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.budget import read_account_month_spent
from ai_video_workflow.budget.errors import LedgerError
from ai_video_workflow.config import parse_project_config, write_project_config
from ai_video_workflow.qcd.events import build_manual_attempt_recorded_event
from ai_video_workflow.qcd.log import append_event


def _make_project(account_root: Path, name: str, usd_rate: int) -> Path:
    root = account_root / name
    root.mkdir(parents=True, exist_ok=True)
    config = parse_project_config(
        {
            "schema_version": 2,
            "default_provider": "cloud-a",
            "fallback_provider": None,
            "shot_overrides": {},
            "budgets_jpy": {
                "episode_soft": 1200,
                "episode_hard": 1500,
                "monthly_hard": 5000,
                "per_shot": 400,
            },
            "fx": {"base_currency": "JPY", "rates": {"USD": usd_rate}},
            "catalog_id": "wfm1-default",
            "catalog_version": 1,
            "catalog_digest": "0" * 64,
        }
    )
    write_project_config(root, config)
    return root


def _add_cost(root: Path, task_id: str, cost_minor: int, at: datetime) -> None:
    append_event(
        root,
        build_manual_attempt_recorded_event(
            project_id="proj",
            shot_id="shot-1",
            task_id=task_id,
            attempt_id="att-1",
            provider_id="cloud-a",
            outcome="produced_candidate",
            occurred_at=at,
            cost_minor_units=cost_minor,
            currency="USD",
        ),
    )


def _utc(y, m, d):
    return datetime(y, m, d, tzinfo=timezone.utc)


def test_account_month_sums_each_project_at_own_fx(tmp_path: Path) -> None:
    a = _make_project(tmp_path, "project-a", usd_rate=160)
    b = _make_project(tmp_path, "project-b", usd_rate=100)
    _add_cost(a, "task-1", 1000, _utc(2026, 7, 15))  # 1000c * 160/100 = 1600
    _add_cost(b, "task-1", 1000, _utc(2026, 7, 20))  # 1000c * 100/100 = 1000

    ledger = read_account_month_spent(tmp_path, "2026-07")
    assert ledger.total_jpy == 2600
    assert ledger.per_project_jpy == {"project-a": 1600, "project-b": 1000}


def test_non_project_subdir_is_skipped(tmp_path: Path) -> None:
    a = _make_project(tmp_path, "project-a", usd_rate=160)
    _add_cost(a, "task-1", 1000, _utc(2026, 7, 15))
    (tmp_path / "not-a-project").mkdir()
    (tmp_path / "not-a-project" / "readme.txt").write_text("hi", encoding="utf-8")

    ledger = read_account_month_spent(tmp_path, "2026-07")
    assert ledger.total_jpy == 1600
    assert set(ledger.per_project_jpy) == {"project-a"}


def test_month_with_no_spend_is_zero(tmp_path: Path) -> None:
    a = _make_project(tmp_path, "project-a", usd_rate=160)
    _add_cost(a, "task-1", 1000, _utc(2026, 7, 15))
    ledger = read_account_month_spent(tmp_path, "2026-06")
    assert ledger.total_jpy == 0
    assert ledger.per_project_jpy == {}


def test_bad_month_format_rejected(tmp_path: Path) -> None:
    with pytest.raises(LedgerError, match="YYYY-MM"):
        read_account_month_spent(tmp_path, "2026/07")
    with pytest.raises(LedgerError, match="YYYY-MM"):
        read_account_month_spent(tmp_path, "2026-13")
