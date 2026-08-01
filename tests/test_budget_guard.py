"""Tests for the pure pre-flight budget guard (TASK-B3)."""

from __future__ import annotations

import pytest

from ai_video_workflow.budget import evaluate_pre_flight
from ai_video_workflow.budget.errors import GuardError
from ai_video_workflow.config.project_config import BudgetsJpy

_BUDGETS = BudgetsJpy(
    episode_soft=1200, episode_hard=1500, monthly_hard=5000, per_shot=400
)


def _evaluate(**overrides):
    kwargs = dict(
        budgets=_BUDGETS,
        month_spent_jpy=0,
        episode_spent_jpy=0,
        shot_spent_jpy=0,
        estimate_jpy=100,
        shot_consecutive_failures=0,
    )
    kwargs.update(overrides)
    return evaluate_pre_flight(**kwargs)


def test_allows_within_all_budgets() -> None:
    decision = _evaluate()
    assert decision.allowed is True
    assert decision.stop_scope is None
    assert decision.warnings == ()


def test_soft_warning_allows_but_warns() -> None:
    decision = _evaluate(episode_spent_jpy=1150, estimate_jpy=100)
    assert decision.allowed is True
    assert decision.stop_scope is None
    assert len(decision.warnings) == 1
    assert "soft" in decision.warnings[0]


def test_monthly_hard_cap_denies() -> None:
    decision = _evaluate(month_spent_jpy=4950, estimate_jpy=100)
    assert decision.allowed is False
    assert decision.stop_scope == "monthly"


def test_episode_hard_cap_denies() -> None:
    decision = _evaluate(episode_spent_jpy=1450, estimate_jpy=100)
    assert decision.allowed is False
    assert decision.stop_scope == "episode"


def test_two_consecutive_failures_stops_shot() -> None:
    decision = _evaluate(shot_consecutive_failures=2)
    assert decision.allowed is False
    assert decision.stop_scope == "shot"
    assert "consecutive failures" in decision.reason


def test_eighty_percent_shot_spend_stops_shot() -> None:
    # per_shot=400, 80% = 320
    decision = _evaluate(shot_spent_jpy=320, estimate_jpy=10)
    assert decision.allowed is False
    assert decision.stop_scope == "shot"
    assert "80%" in decision.reason


def test_shot_cap_exceeded_denies() -> None:
    # spend 300 (< 80% = 320) + estimate 150 = 450 > 400
    decision = _evaluate(shot_spent_jpy=300, estimate_jpy=150)
    assert decision.allowed is False
    assert decision.stop_scope == "shot"
    assert "per-shot budget" in decision.reason


def test_precedence_monthly_beats_episode_and_shot() -> None:
    # every level would trip; monthly must win
    decision = _evaluate(
        month_spent_jpy=5000,
        episode_spent_jpy=1500,
        shot_spent_jpy=400,
        estimate_jpy=100,
        shot_consecutive_failures=5,
    )
    assert decision.stop_scope == "monthly"


def test_precedence_episode_beats_shot() -> None:
    decision = _evaluate(
        episode_spent_jpy=1500,
        shot_spent_jpy=400,
        shot_consecutive_failures=5,
        estimate_jpy=100,
    )
    assert decision.stop_scope == "episode"


def test_exact_cap_is_allowed() -> None:
    # spent + estimate == cap is NOT over the cap
    decision = _evaluate(
        month_spent_jpy=0,
        episode_spent_jpy=1400,
        estimate_jpy=100,  # == episode_hard 1500
        shot_spent_jpy=0,
    )
    assert decision.allowed is True


def test_negative_input_rejected() -> None:
    with pytest.raises(GuardError, match="negative"):
        _evaluate(shot_spent_jpy=-1)


def test_bool_input_rejected() -> None:
    with pytest.raises(GuardError, match="non-negative int"):
        _evaluate(estimate_jpy=True)
