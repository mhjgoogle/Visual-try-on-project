"""Pre-flight budget guard: decide *before* a generation call (TASK-B3).

A pure function over integer yen: given the budget thresholds, what has
already been spent (this month, this episode, this shot), the estimate
for the pending call, and the shot's consecutive-failure count, decide
whether the call may proceed. Nothing here performs I/O, reads the
catalog, or knows any vendor — the ledger supplies the spent figures and
the estimator supplies the estimate.

Decision precedence (highest first):

1. monthly hard cap    -> deny (scope "monthly")
2. episode hard cap    -> deny (scope "episode")
3. per-shot stop       -> deny (scope "shot") on any of:
      - >= 2 consecutive failures,
      - spend already at/over 80% of the per-shot budget,
      - spend + estimate would exceed the per-shot budget
4. episode soft cap    -> allow, with a warning

Hard/stop checks are *pre-flight*: "already spent + this estimate" must
not exceed the cap, so the call is refused before any money is spent. A
shot-scope stop halts only that shot; other shots are unaffected.
"""

from __future__ import annotations

from dataclasses import dataclass

from ai_video_workflow.budget.errors import GuardError
from ai_video_workflow.config.project_config import BudgetsJpy

SHOT_STOP_FAILURE_THRESHOLD = 2
SHOT_STOP_SPEND_FRACTION_PCT = 80


@dataclass(frozen=True, slots=True)
class GuardDecision:
    """The pre-flight verdict for one pending generation call."""

    allowed: bool
    stop_scope: str | None
    reason: str | None
    warnings: tuple[str, ...]


def evaluate_pre_flight(
    *,
    budgets: BudgetsJpy,
    month_spent_jpy: int,
    episode_spent_jpy: int,
    shot_spent_jpy: int,
    estimate_jpy: int,
    shot_consecutive_failures: int,
) -> GuardDecision:
    """Return whether the pending call may proceed under the budget rules."""
    _require_non_negative_int(month_spent_jpy, "month_spent_jpy")
    _require_non_negative_int(episode_spent_jpy, "episode_spent_jpy")
    _require_non_negative_int(shot_spent_jpy, "shot_spent_jpy")
    _require_non_negative_int(estimate_jpy, "estimate_jpy")
    _require_non_negative_int(shot_consecutive_failures, "shot_consecutive_failures")

    # 1. monthly hard cap
    if month_spent_jpy + estimate_jpy > budgets.monthly_hard:
        return _deny(
            "monthly",
            f"monthly spend {month_spent_jpy} + estimate {estimate_jpy} "
            f"exceeds monthly hard cap {budgets.monthly_hard}",
        )

    # 2. episode hard cap
    if episode_spent_jpy + estimate_jpy > budgets.episode_hard:
        return _deny(
            "episode",
            f"episode spend {episode_spent_jpy} + estimate {estimate_jpy} "
            f"exceeds episode hard cap {budgets.episode_hard}",
        )

    # 3. per-shot stop conditions
    if shot_consecutive_failures >= SHOT_STOP_FAILURE_THRESHOLD:
        return _deny(
            "shot",
            f"shot has {shot_consecutive_failures} consecutive failures "
            f"(>= {SHOT_STOP_FAILURE_THRESHOLD}); stop and redesign the shot",
        )
    if shot_spent_jpy * 100 >= budgets.per_shot * SHOT_STOP_SPEND_FRACTION_PCT:
        return _deny(
            "shot",
            f"shot spend {shot_spent_jpy} has reached "
            f"{SHOT_STOP_SPEND_FRACTION_PCT}% of per-shot budget "
            f"{budgets.per_shot}; stop this shot",
        )
    if shot_spent_jpy + estimate_jpy > budgets.per_shot:
        return _deny(
            "shot",
            f"shot spend {shot_spent_jpy} + estimate {estimate_jpy} "
            f"exceeds per-shot budget {budgets.per_shot}",
        )

    # 4. episode soft cap -> warn, but allow
    warnings: list[str] = []
    if episode_spent_jpy + estimate_jpy > budgets.episode_soft:
        warnings.append(
            f"episode spend {episode_spent_jpy} + estimate {estimate_jpy} "
            f"exceeds episode soft budget {budgets.episode_soft}"
        )
    return GuardDecision(
        allowed=True, stop_scope=None, reason=None, warnings=tuple(warnings)
    )


def _deny(scope: str, reason: str) -> GuardDecision:
    return GuardDecision(allowed=False, stop_scope=scope, reason=reason, warnings=())


def _require_non_negative_int(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GuardError(f"{name}: expected a non-negative int")
    if value < 0:
        raise GuardError(f"{name}: must not be negative")
