"""Command Gateway: the single approved write-command entry point (TASK-030).

A transport-agnostic application service (ADR-0033) through which every write
command enters the core — centralizing version binding, preflight + secondary
confirmation, idempotency/recovery, and fail-closed admission, then calling only
approved application/Orchestrator entries (never a Provider, never a direct
business-file write). Its sole persistent product is the durable, command_id-
keyed receipt log. TASK-030 is the foundation; no real write command is wired
yet (registered specs only).
"""

from __future__ import annotations

from ai_video_workflow.gateway.commands import (
    CommandEnvelope,
    CommandRegistry,
    CommandRisk,
    CommandSpec,
    Preview,
)
from ai_video_workflow.gateway.errors import (
    BlockedCommandError,
    CommandIdConflictError,
    ConfirmationRequiredError,
    ConfirmationStaleError,
    CorruptReceiptLogError,
    GatewayError,
    GatewayReceiptError,
    TargetBindingError,
    UnregisteredCommandError,
)
from ai_video_workflow.gateway.receipts import (
    CommandReceipt,
    ReceiptStatus,
    append_receipt,
    find_receipt,
    preflight_digest,
    read_receipts,
    receipt_from_envelope,
    receipt_log_path,
    request_digest,
)
from ai_video_workflow.gateway.service import (
    CommandGateway,
    Preflight,
    ResolvedTarget,
    TargetResolver,
)

__all__ = [
    "BlockedCommandError",
    "CommandEnvelope",
    "CommandGateway",
    "CommandIdConflictError",
    "CommandReceipt",
    "CommandRegistry",
    "CommandRisk",
    "CommandSpec",
    "ConfirmationRequiredError",
    "ConfirmationStaleError",
    "CorruptReceiptLogError",
    "GatewayError",
    "GatewayReceiptError",
    "Preflight",
    "Preview",
    "ReceiptStatus",
    "ResolvedTarget",
    "TargetBindingError",
    "TargetResolver",
    "UnregisteredCommandError",
    "append_receipt",
    "find_receipt",
    "preflight_digest",
    "read_receipts",
    "receipt_from_envelope",
    "receipt_log_path",
    "request_digest",
]
