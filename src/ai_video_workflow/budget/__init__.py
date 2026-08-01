"""Vendor-neutral budget layer (TASK-B3).

Public API:

- ``fx``: locked-FX conversion to integer yen, rounded up;
- ``quote``: original-currency price from the global catalog;
- ``estimate``: catalog price -> FX -> yen, with a dual-currency audit;
- ``ledger``: derived yen spend recomputed from the QCD event log;
- ``guard``: pure pre-flight allow/deny under the budget thresholds.

Nothing here emits a QCD event, constructs a provider, reads a
credential, or mutates business state; cost facts stay in the QCD log
(read-only) and every amount is an integer minor unit.
"""

from __future__ import annotations

from ai_video_workflow.budget.account import (
    AccountMonthLedger,
    account_outstanding_holds,
    read_account_month_spent,
)
from ai_video_workflow.budget.errors import (
    BudgetError,
    FxError,
    GuardError,
    LedgerError,
    QuoteError,
    ReservationError,
)
from ai_video_workflow.budget.estimate import CostEstimate, estimate_generation_cost
from ai_video_workflow.budget.fx import convert_to_base_minor, minor_unit_exponent
from ai_video_workflow.budget.guard import (
    SHOT_STOP_FAILURE_THRESHOLD,
    SHOT_STOP_SPEND_FRACTION_PCT,
    GuardDecision,
    evaluate_pre_flight,
)
from ai_video_workflow.budget.ledger import (
    BudgetLedger,
    build_ledger,
    month_key_jst,
    read_ledger,
)
from ai_video_workflow.budget.lock import account_budget_lock
from ai_video_workflow.budget.quote import Quote, quote_original
from ai_video_workflow.budget.reservation import (
    COMMITTED,
    HELD,
    NEEDS_RECONCILIATION,
    RELEASED,
    HeldSummary,
    ReconcileResult,
    Reservation,
    commit_reservation,
    hold_reservation,
    list_reservations,
    load_reservation,
    mark_needs_reconciliation,
    outstanding_holds,
    reconcile_reservations,
    record_external_task_ref,
    release_reservation,
    shot_consecutive_failures,
)

__all__ = [
    "COMMITTED",
    "HELD",
    "NEEDS_RECONCILIATION",
    "RELEASED",
    "SHOT_STOP_FAILURE_THRESHOLD",
    "SHOT_STOP_SPEND_FRACTION_PCT",
    "AccountMonthLedger",
    "BudgetError",
    "account_budget_lock",
    "account_outstanding_holds",
    "BudgetLedger",
    "CostEstimate",
    "FxError",
    "GuardDecision",
    "GuardError",
    "HeldSummary",
    "LedgerError",
    "Quote",
    "QuoteError",
    "ReconcileResult",
    "Reservation",
    "ReservationError",
    "build_ledger",
    "commit_reservation",
    "convert_to_base_minor",
    "estimate_generation_cost",
    "evaluate_pre_flight",
    "hold_reservation",
    "list_reservations",
    "load_reservation",
    "mark_needs_reconciliation",
    "minor_unit_exponent",
    "month_key_jst",
    "outstanding_holds",
    "quote_original",
    "read_account_month_spent",
    "read_ledger",
    "reconcile_reservations",
    "record_external_task_ref",
    "release_reservation",
    "shot_consecutive_failures",
]
