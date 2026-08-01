"""Typed errors for the vendor-neutral budget layer (TASK-B3)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class BudgetError(AiVideoWorkflowError):
    """Base error for the WFM1 budget layer."""


class FxError(BudgetError):
    """Raised when a currency conversion cannot be performed."""


class QuoteError(BudgetError):
    """Raised when no catalog price matches the requested generation spec."""


class LedgerError(BudgetError):
    """Raised when spend cannot be aggregated from the event log."""


class GuardError(BudgetError):
    """Raised when a pre-flight budget check receives invalid inputs."""


class ReservationError(BudgetError):
    """Raised when a budget reservation is invalid or cannot be recorded."""
