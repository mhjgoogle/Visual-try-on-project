"""Typed errors for the Command Gateway (ADR-0033 / TASK-030).

Every admission failure is a typed, fail-closed error — the Gateway never
guesses, never silently overwrites, and never re-executes/re-pays on ambiguity.
"""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class GatewayError(AiVideoWorkflowError):
    """Base error for the Command Gateway."""


class UnregisteredCommandError(GatewayError):
    """Raised when a command name is not in the approved registry (fail-closed)."""


class TargetBindingError(GatewayError):
    """Raised when a write command's target is missing, malformed, or stale."""


class BlockedCommandError(GatewayError):
    """Raised when preflight found blockers (unapproved / over-budget / ...)."""


class ConfirmationRequiredError(GatewayError):
    """Raised when a high-risk command is submitted without a confirmation."""


class ConfirmationStaleError(GatewayError):
    """Raised when a confirmation's preflight digest no longer matches."""


class CommandIdConflictError(GatewayError):
    """Raised when a command_id is reused for a DIFFERENT command request.

    Idempotency binds command_id to the exact request (name/actor/target/params);
    a resubmit whose request digest differs is a key-reuse conflict, refused
    fail-closed so it can neither steal another command's outcome nor block it.
    """


class GatewayReceiptError(GatewayError):
    """Base error for the durable receipt store IO / integrity."""


class CorruptReceiptLogError(GatewayReceiptError):
    """Raised when a complete receipt line cannot be strictly parsed."""
