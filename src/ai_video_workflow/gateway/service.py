"""The Command Gateway application service (ADR-0033 / TASK-030).

A transport-agnostic application service that is the SINGLE write-command entry
point into the core (ADR-0010 decision 2). CLI and (future) Workspace backend
share this same API; there is no bypass. It centralizes, in one chokepoint:

- **Unique write path + unique writer (P1/P2).** It only invokes an approved
  command spec's ``apply`` (an already-approved application/Orchestrator entry);
  it never calls a Provider or writes business files. Its only persistent
  product is the durable receipt log.
- **Version binding fail-closed (P3).** A write command's target
  (ref + version + content_digest) must resolve to a matching authoritative
  fact; stale/drift is refused, never silently overwritten.
- **Preflight + secondary confirmation (P4).** ``preflight`` returns read-only
  facts (inputs / estimated cost / downstream / blockers) and a digest; a
  HIGH-risk ``submit`` must carry a confirmation equal to that digest, and a
  drifted preflight refuses it.
- **Idempotency / recovery / no double-pay (P5).** A command_id already having
  a receipt returns it instead of re-executing; an ``apply`` that raises yields
  an AMBIGUOUS receipt (unknown side effect) that is never auto-replayed.
- **Fail-closed admission (P7).** Unregistered / blocked / missing-or-stale
  target / missing-or-stale confirmation are all typed refusals.

The Gateway does NOT own the core execution lifecycle (P6): closing a client
neither cancels nor corrupts committed work. TASK-030 wires no real write
command; specs are exercised with registered stubs.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from ai_video_workflow._fslock import flock_exclusive
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
    TargetBindingError,
)
from ai_video_workflow.gateway.receipts import (
    CommandReceipt,
    ReceiptStatus,
    append_receipt,
    find_receipt,
    preflight_digest,
    request_digest,
)
from ai_video_workflow.security import resolve_within_root
from ai_video_workflow.validation import validate_json_compatible

_LOCK_RELATIVE = Path("gateway/receipts/.lock")


@dataclass(frozen=True, slots=True)
class ResolvedTarget:
    exists: bool
    content_digest: str | None


class TargetResolver(Protocol):
    """Read-only resolver of a target's authoritative content digest."""

    def resolve_target(
        self, project_root: Path, *, ref: str, version: int
    ) -> ResolvedTarget: ...


@dataclass(frozen=True, slots=True)
class Preflight:
    """A command's read-only preflight result plus its binding digest."""

    command_id: str
    name: str
    preview: Preview
    preflight_digest: str
    is_high_risk: bool


class CommandGateway:
    """The single approved write-command entry point for one project."""

    def __init__(
        self,
        project_root: Path,
        *,
        registry: CommandRegistry,
        target_resolver: TargetResolver,
        clock: Callable[[], datetime],
    ) -> None:
        self._project_root = project_root
        self._registry = registry
        self._resolver = target_resolver
        self._clock = clock

    # --- read-only preflight ---------------------------------------------

    def preflight(self, envelope: CommandEnvelope) -> Preflight:
        spec = self._registry.get(envelope.name)
        self._verify_target(spec, envelope)
        preview = spec.preview(self._project_root, envelope)
        digest = preflight_digest(envelope.name, self._plain_target(envelope), preview)
        return Preflight(
            command_id=envelope.command_id,
            name=envelope.name,
            preview=preview,
            preflight_digest=digest,
            is_high_risk=spec.risk is CommandRisk.HIGH,
        )

    # --- idempotent, fail-closed submit ----------------------------------

    def submit(
        self, envelope: CommandEnvelope, *, confirmation: str | None = None
    ) -> CommandReceipt:
        # A per-project exclusive lock makes the whole lookup -> WAL -> apply ->
        # receipt sequence one critical section, so concurrent submits of the
        # same command_id serialize (the second sees the first's receipt) and
        # can never both execute / double-pay (ADR-0033 P5).
        lock_fd = self._acquire_lock()
        try:
            return self._submit_locked(envelope, confirmation)
        finally:
            os.close(lock_fd)  # releases the flock

    def _submit_locked(
        self, envelope: CommandEnvelope, confirmation: str | None
    ) -> CommandReceipt:
        req_digest = request_digest(
            envelope.name,
            envelope.actor,
            self._plain_target(envelope),
            dict(envelope.params),
        )
        # Idempotency / recovery: a command_id that already has a receipt (or an
        # interrupted-attempt marker, collapsed to AMBIGUOUS) is returned as-is —
        # never re-executed or re-paid (ADR-0033 P5) — but ONLY for the SAME
        # request. A different request under the same id is a fail-closed
        # conflict, so a reused/guessed id can neither steal nor suppress it.
        existing = find_receipt(self._project_root, envelope.command_id)
        if existing is not None:
            if existing.request_digest != req_digest:
                raise CommandIdConflictError(
                    f"command_id {envelope.command_id!r} was already used for a "
                    "different command; use a fresh command_id"
                )
            return existing

        spec = self._registry.get(envelope.name)  # unregistered -> fail-closed
        self._verify_target(spec, envelope)  # target binding -> fail-closed
        preview = spec.preview(self._project_root, envelope)

        # Admission failures happen BEFORE the write-ahead marker: they raise
        # (no marker/receipt), so the command is retryable once the blocker
        # clears — never a stale persisted rejection.
        if preview.blockers:
            raise BlockedCommandError(
                f"command {envelope.name!r} is blocked: {'; '.join(preview.blockers)}"
            )
        if spec.risk is CommandRisk.HIGH:
            digest = preflight_digest(
                envelope.name, self._plain_target(envelope), preview
            )
            if confirmation is None:
                raise ConfirmationRequiredError(
                    f"high-risk command {envelope.name!r} requires a confirmation "
                    "bound to its preflight digest"
                )
            if confirmation != digest:
                raise ConfirmationStaleError(
                    f"confirmation for {envelope.name!r} is stale (preflight changed); "
                    "re-preflight and confirm again"
                )

        # Write-ahead: mark ATTEMPTING BEFORE apply(). If a crash (or a failure
        # to persist the completed receipt — e.g. a non-serializable outcome)
        # occurs after apply, a resubmit finds this marker and resolves to
        # AMBIGUOUS instead of re-executing the already-applied command.
        self._append(envelope, req_digest, ReceiptStatus.ATTEMPTING, None, None)

        try:
            outcome = dict(spec.apply(self._project_root, envelope))
            # a non-JSON outcome would fail to persist AFTER apply already ran;
            # validate here so that case is treated as an unknown side effect.
            validate_json_compatible(outcome, path="outcome")
        except Exception as exc:  # noqa: BLE001 - deliberately fail-safe
            return self._append(
                envelope,
                req_digest,
                ReceiptStatus.AMBIGUOUS,
                None,
                f"apply failed ({type(exc).__name__}); manual resolution required",
            )
        return self._append(
            envelope, req_digest, ReceiptStatus.COMPLETED, outcome, None
        )

    # --- internals -------------------------------------------------------

    def _append(
        self,
        envelope: CommandEnvelope,
        req_digest: str,
        status: ReceiptStatus,
        outcome: dict | None,
        reason: str | None,
    ) -> CommandReceipt:
        receipt = CommandReceipt(
            command_id=envelope.command_id,
            name=envelope.name,
            request_digest=req_digest,
            status=status,
            outcome=outcome,
            reason=reason,
            occurred_at=self._clock(),
        )
        append_receipt(self._project_root, receipt)
        return receipt

    def _acquire_lock(self) -> int:
        lock_path = resolve_within_root(self._project_root, _LOCK_RELATIVE)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            lock_path.parent.chmod(0o700)
        except OSError:
            pass
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        flock_exclusive(fd)  # released by os.close(fd) (ADR-0049 shim)
        return fd

    def _verify_target(self, spec: CommandSpec, envelope: CommandEnvelope) -> None:
        if not spec.requires_target:
            return
        target = envelope.target
        if target is None:
            raise TargetBindingError(
                f"command {envelope.name!r} requires a target (ref+version+digest)"
            )
        fact = self._resolver.resolve_target(
            self._project_root,
            ref=str(target["ref"]),
            version=int(target["version"]),
        )
        if not fact.exists:
            raise TargetBindingError(
                f"target {target['ref']!r} v{target['version']} does not resolve to "
                "an authoritative fact; refusing to act on a missing target"
            )
        if fact.content_digest != target["content_digest"]:
            raise TargetBindingError(
                f"target {target['ref']!r} v{target['version']} content_digest is "
                "stale; refusing to overwrite a drifted version"
            )

    @staticmethod
    def _plain_target(envelope: CommandEnvelope) -> dict | None:
        return dict(envelope.target) if envelope.target is not None else None
