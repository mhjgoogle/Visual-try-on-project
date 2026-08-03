"""Durable Command Gateway receipt/outcome store + preflight digest (ADR-0033).

The Gateway's only persistent product is its receipt/outcome log — an
append-only JSONL at ``gateway/receipts/log.jsonl`` (ADR-0001 fourth amendment)
with a single writer, built on the shared hardened append-only primitives. It
is command_id-keyed and read first-wins, so a resubmitted or concurrent command
returns its existing receipt instead of re-executing or re-paying (ADR-0033 P5).
The Gateway is never a second BUSINESS writer — this store holds only receipts.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path

from ai_video_workflow.appendlog import (
    append_line,
    read_text,
    resolve_log_path,
    split_complete_lines,
)
from ai_video_workflow.digests import config_digest
from ai_video_workflow.errors import (
    AiVideoWorkflowError,
    FieldTypeError,
    InvariantViolationError,
)
from ai_video_workflow.gateway.commands import Preview
from ai_video_workflow.gateway.errors import CorruptReceiptLogError, GatewayReceiptError
from ai_video_workflow.manifest import JsonCompatibleValue
from ai_video_workflow.validation import (
    validate_json_compatible,
    validate_stable_id,
    validate_utc_datetime,
)


def _reject_json_constant(value: str) -> None:
    raise InvariantViolationError(
        f"receipt: non-standard JSON constant {value!r} is not allowed"
    )


_LOG_RELATIVE = ("gateway", "receipts", "log.jsonl")
_SCHEMA_VERSION = 1


class ReceiptStatus(str, Enum):
    """Disposition of a submitted command.

    ``attempting`` is a write-ahead marker appended BEFORE apply(); a resubmit
    that finds only an ``attempting`` marker (apply crashed, or its receipt
    could not be persisted) resolves to AMBIGUOUS and is never auto-replayed.
    The other three are terminal.
    """

    ATTEMPTING = "attempting"  # WAL marker: apply is about to run
    COMPLETED = "completed"  # apply() ran and returned an outcome
    REJECTED = "rejected"  # fail-closed admission refusal (never ran)
    AMBIGUOUS = "ambiguous"  # unknown side effect; NOT auto-replayed


_TERMINAL_STATUSES = frozenset(
    {ReceiptStatus.COMPLETED, ReceiptStatus.REJECTED, ReceiptStatus.AMBIGUOUS}
)


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

_ENVELOPE_KEYS = frozenset(
    {
        "schema_version",
        "command_id",
        "name",
        "request_digest",
        "status",
        "outcome",
        "reason",
        "occurred_at",
    }
)


@dataclass(frozen=True, slots=True)
class CommandReceipt:
    """The durable, idempotent outcome of one submitted command.

    ``request_digest`` binds this receipt to the exact request identity
    (name/actor/target/params); the Gateway uses it so a reused command_id for a
    DIFFERENT command is a conflict, not a stolen/suppressed outcome.
    """

    command_id: str
    name: str
    request_digest: str
    status: ReceiptStatus
    outcome: dict[str, JsonCompatibleValue] | None
    reason: str | None
    occurred_at: datetime

    def __post_init__(self) -> None:
        validate_stable_id(self.command_id, field_name="command_id")
        validate_stable_id(self.name, field_name="name")
        if (
            not isinstance(self.request_digest, str)
            or _SHA256_RE.match(self.request_digest) is None
        ):
            raise InvariantViolationError(
                "request_digest: expected a lowercase hex SHA-256 digest"
            )
        if not isinstance(self.status, ReceiptStatus):
            raise FieldTypeError("status: expected ReceiptStatus")
        validate_utc_datetime(self.occurred_at, field_name="occurred_at")

    def to_envelope(self) -> dict[str, JsonCompatibleValue]:
        return {
            "schema_version": _SCHEMA_VERSION,
            "command_id": self.command_id,
            "name": self.name,
            "request_digest": self.request_digest,
            "status": self.status.value,
            "outcome": self.outcome,
            "reason": self.reason,
            "occurred_at": self.occurred_at.isoformat(timespec="microseconds"),
        }


def receipt_from_envelope(envelope: object) -> CommandReceipt:
    if not isinstance(envelope, dict) or frozenset(envelope) != _ENVELOPE_KEYS:
        raise InvariantViolationError("receipt envelope: unexpected key set")
    if envelope["schema_version"] != _SCHEMA_VERSION:
        raise InvariantViolationError("receipt: unsupported schema_version")
    try:
        status = ReceiptStatus(envelope["status"])
    except (ValueError, TypeError) as exc:
        raise InvariantViolationError(
            f"status: unknown {envelope['status']!r}"
        ) from exc
    outcome = envelope["outcome"]
    if outcome is not None:
        if not isinstance(outcome, dict):
            raise FieldTypeError("outcome: expected dict or null")
        # strict integrity: a stored outcome must be JSON-compatible (this also
        # rejects any non-finite float that slipped through parsing).
        validate_json_compatible(outcome, path="outcome")
    occurred = envelope["occurred_at"]
    if not isinstance(occurred, str):
        raise FieldTypeError("occurred_at: expected ISO string")
    try:
        parsed = datetime.fromisoformat(occurred)
    except ValueError as exc:
        raise InvariantViolationError("occurred_at: not ISO-8601") from exc
    return CommandReceipt(
        command_id=envelope["command_id"],
        name=envelope["name"],
        request_digest=envelope["request_digest"],
        status=status,
        outcome=outcome,
        reason=envelope["reason"],
        occurred_at=validate_utc_datetime(parsed, field_name="occurred_at"),
    )


def receipt_log_path(project_root: Path) -> Path:
    return resolve_log_path(project_root, _LOG_RELATIVE)


def append_receipt(project_root: Path, receipt: CommandReceipt) -> None:
    if not isinstance(receipt, CommandReceipt):
        raise GatewayReceiptError("receipt: expected CommandReceipt")
    line = (
        json.dumps(
            receipt.to_envelope(), ensure_ascii=False, sort_keys=True, allow_nan=False
        )
        + "\n"
    ).encode("utf-8")
    append_line(project_root, _LOG_RELATIVE, line, GatewayReceiptError)


def _read_raw(project_root: Path) -> list[CommandReceipt]:
    """Every complete receipt line in append order (NO dedup — WAL needs all)."""
    text = read_text(project_root, _LOG_RELATIVE, GatewayReceiptError)
    if not text:
        return []
    records: list[CommandReceipt] = []
    for index, segment in enumerate(split_complete_lines(text), start=1):
        try:
            obj = json.loads(segment, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, InvariantViolationError) as exc:
            raise CorruptReceiptLogError(
                f"receipt log line {index}: invalid JSON"
            ) from exc
        try:
            records.append(receipt_from_envelope(obj))
        except AiVideoWorkflowError as exc:
            raise CorruptReceiptLogError(f"receipt log line {index}: {exc}") from exc
    return records


def _collapse(records: list[CommandReceipt]) -> CommandReceipt:
    """The effective receipt for one command_id's records (WAL semantics).

    A terminal record wins first-seen. If ONLY an ``attempting`` marker exists,
    the apply was interrupted before its receipt landed — resolve to AMBIGUOUS
    (manual resolution), never re-execute.
    """
    for r in records:
        if r.status in _TERMINAL_STATUSES:
            return r
    marker = records[0]
    return CommandReceipt(
        command_id=marker.command_id,
        name=marker.name,
        request_digest=marker.request_digest,
        status=ReceiptStatus.AMBIGUOUS,
        outcome=None,
        reason="command was interrupted mid-apply; manual resolution required",
        occurred_at=marker.occurred_at,
    )


def read_receipts(project_root: Path) -> tuple[CommandReceipt, ...]:
    """One effective (WAL-collapsed) receipt per command_id, first-seen order."""
    by_id: dict[str, list[CommandReceipt]] = {}
    order: list[str] = []
    for r in _read_raw(project_root):
        if r.command_id not in by_id:
            order.append(r.command_id)
        by_id.setdefault(r.command_id, []).append(r)
    return tuple(_collapse(by_id[cid]) for cid in order)


def find_receipt(project_root: Path, command_id: str) -> CommandReceipt | None:
    """Return the effective (idempotent, WAL-collapsed) receipt for ``command_id``."""
    records = [r for r in _read_raw(project_root) if r.command_id == command_id]
    return _collapse(records) if records else None


def request_digest(name: str, actor: str, target: object, params: object) -> str:
    """A digest binding a command_id to its exact request identity (idempotency)."""
    return config_digest(
        {"name": name, "actor": actor, "target": target, "params": params}
    )


def preflight_digest(
    command_name: str,
    target: object,
    preview: Preview,
) -> str:
    """A deterministic digest over the command's read-only preflight facts.

    A high-risk confirmation must carry this digest; if the recomputed preflight
    differs at submit (inputs, cost, downstream, blockers, or the bound target
    changed), the confirmation is stale and refused (ADR-0033 P4).
    """
    return config_digest(
        {
            "command": command_name,
            "target": target,
            "inputs": dict(preview.inputs),
            "estimated_cost": (
                dict(preview.estimated_cost)
                if preview.estimated_cost is not None
                else None
            ),
            "downstream": list(preview.downstream),
            "blockers": list(preview.blockers),
        }
    )
