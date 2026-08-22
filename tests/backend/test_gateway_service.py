"""Command Gateway foundation tests (TASK-030 / ADR-0033).

Covers the unique-write-path guards: unregistered refusal, version-binding
fail-closed, read-only preflight, high-risk secondary confirmation bound to the
preflight digest (+ stale refusal), idempotent submit (no re-execute/re-pay),
unknown-side-effect -> ambiguous (no auto-replay), blocked fail-closed, and the
lifecycle-separation posture. No provider, no network, no payment; registered
STUB commands only (no real write command is wired in TASK-030).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ai_video_workflow.errors import InvariantViolationError
from ai_video_workflow.gateway import (
    BlockedCommandError,
    CommandEnvelope,
    CommandGateway,
    CommandRegistry,
    CommandRisk,
    CommandSpec,
    ConfirmationRequiredError,
    ConfirmationStaleError,
    Preview,
    ReceiptStatus,
    ResolvedTarget,
    UnregisteredCommandError,
    find_receipt,
    read_receipts,
)

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64


def _clock():
    return T0


class FakeResolver:
    def __init__(self, targets=None):
        self._targets = targets if targets is not None else {("asset-a", 1): _DIGEST}

    def resolve_target(self, project_root, *, ref, version):
        digest = self._targets.get((ref, version), "__missing__")
        if digest == "__missing__":
            return ResolvedTarget(exists=False, content_digest=None)
        return ResolvedTarget(exists=True, content_digest=digest)


def _target(ref="asset-a", version=1, digest=_DIGEST):
    return {"ref": ref, "version": version, "content_digest": digest}


def _env(command_id="c-1", name="rerun", target=None, params=None):
    return CommandEnvelope(
        command_id=command_id,
        name=name,
        actor="user",
        params=params or {},
        occurred_at=T0,
        target=target if target is not None else _target(),
    )


class _Applied:
    """Records apply() invocations to assert single-execution / no-replay."""

    def __init__(
        self, *, blockers=(), risk=CommandRisk.LOW, requires_target=True, raises=False
    ):
        self.calls = 0
        self._blockers = tuple(blockers)
        self.spec = CommandSpec(
            name="rerun",
            risk=risk,
            requires_target=requires_target,
            preview=self._preview,
            apply=self._apply,
        )

    def _preview(self, project_root, envelope):
        return Preview(
            inputs={"shot": "shot-1"},
            estimated_cost={"JPY": 1500},
            downstream=("compose",),
            blockers=self._blockers,
        )

    def _apply(self, project_root, envelope):
        self.calls += 1
        if getattr(self, "_raises", False):
            raise RuntimeError("provider blew up /secret/path")
        if getattr(self, "_bad_outcome", False):
            return {"t": T0}  # a datetime is not JSON-serializable
        return {"ran": True, "shot": "shot-1"}


def _gateway(tmp_path, registry, resolver=None):
    return CommandGateway(
        tmp_path,
        registry=registry,
        target_resolver=resolver or FakeResolver(),
        clock=_clock,
    )


def _registry(spec):
    reg = CommandRegistry()
    reg.register(spec)
    return reg


# --- registry / no bypass ----------------------------------------------------


def test_unregistered_command_refused(tmp_path):
    gw = _gateway(tmp_path, CommandRegistry())
    with pytest.raises(UnregisteredCommandError):
        gw.submit(_env())
    assert read_receipts(tmp_path) == ()


def test_duplicate_registration_refused(tmp_path):
    applied = _Applied()
    reg = _registry(applied.spec)
    with pytest.raises(InvariantViolationError):
        reg.register(applied.spec)


# --- version binding fail-closed ---------------------------------------------


def test_non_sha256_target_digest_refused(tmp_path):
    with pytest.raises(InvariantViolationError):
        _env(target={"ref": "asset-a", "version": 1, "content_digest": "Z" * 64})


def test_missing_target_refused(tmp_path):
    applied = _Applied()
    gw = _gateway(tmp_path, _registry(applied.spec))
    env = CommandEnvelope(
        command_id="c-1",
        name="rerun",
        actor="user",
        params={},
        occurred_at=T0,
        target=None,
    )
    from ai_video_workflow.gateway import TargetBindingError

    with pytest.raises(TargetBindingError):
        gw.submit(env)
    assert applied.calls == 0


def test_stale_target_refused(tmp_path):
    applied = _Applied()
    gw = _gateway(
        tmp_path, _registry(applied.spec), FakeResolver({("asset-a", 1): _DIGEST2})
    )
    from ai_video_workflow.gateway import TargetBindingError

    with pytest.raises(TargetBindingError):
        gw.submit(_env(target=_target(digest=_DIGEST)))
    assert applied.calls == 0


# --- preflight + high-risk confirmation --------------------------------------


def test_preflight_is_read_only_and_digests(tmp_path):
    applied = _Applied(risk=CommandRisk.HIGH)
    gw = _gateway(tmp_path, _registry(applied.spec))
    pf = gw.preflight(_env())
    assert pf.is_high_risk is True
    assert pf.preview.estimated_cost == {"JPY": 1500}
    assert applied.calls == 0  # preflight never applies
    assert isinstance(pf.preflight_digest, str) and len(pf.preflight_digest) == 64


def test_high_risk_requires_confirmation(tmp_path):
    applied = _Applied(risk=CommandRisk.HIGH)
    gw = _gateway(tmp_path, _registry(applied.spec))
    with pytest.raises(ConfirmationRequiredError):
        gw.submit(_env())
    assert applied.calls == 0


def test_high_risk_stale_confirmation_refused(tmp_path):
    applied = _Applied(risk=CommandRisk.HIGH)
    gw = _gateway(tmp_path, _registry(applied.spec))
    with pytest.raises(ConfirmationStaleError):
        gw.submit(_env(), confirmation="deadbeef")
    assert applied.calls == 0


def test_high_risk_with_matching_confirmation_runs(tmp_path):
    applied = _Applied(risk=CommandRisk.HIGH)
    gw = _gateway(tmp_path, _registry(applied.spec))
    pf = gw.preflight(_env())
    receipt = gw.submit(_env(), confirmation=pf.preflight_digest)
    assert receipt.status is ReceiptStatus.COMPLETED
    assert applied.calls == 1


# --- blocked fail-closed -----------------------------------------------------


def test_blocked_command_refused_and_retryable(tmp_path):
    applied = _Applied(blockers=("over budget",))
    gw = _gateway(tmp_path, _registry(applied.spec))
    with pytest.raises(BlockedCommandError):
        gw.submit(_env())
    assert applied.calls == 0
    # no receipt persisted -> retryable once the blocker clears
    assert read_receipts(tmp_path) == ()


# --- idempotency / no double-pay ---------------------------------------------


def test_submit_is_idempotent_no_reexecute(tmp_path):
    applied = _Applied()
    gw = _gateway(tmp_path, _registry(applied.spec))
    first = gw.submit(_env(command_id="c-1"))
    second = gw.submit(_env(command_id="c-1"))
    assert first.status is ReceiptStatus.COMPLETED
    assert second.command_id == first.command_id
    assert applied.calls == 1  # second submit did NOT re-execute
    assert len(read_receipts(tmp_path)) == 1


def test_apply_failure_is_ambiguous_and_not_replayed(tmp_path):
    applied = _Applied()
    applied._raises = True
    gw = _gateway(tmp_path, _registry(applied.spec))
    receipt = gw.submit(_env(command_id="c-1"))
    assert receipt.status is ReceiptStatus.AMBIGUOUS
    assert receipt.outcome is None
    assert "/secret/path" not in (receipt.reason or "")  # sanitized
    # resubmit returns the ambiguous receipt; apply() is NOT called again
    again = gw.submit(_env(command_id="c-1"))
    assert again.status is ReceiptStatus.AMBIGUOUS
    assert applied.calls == 1


def test_interrupted_attempt_resolves_ambiguous_no_replay(tmp_path):
    # simulate a crash after the write-ahead ATTEMPTING marker but before the
    # completed receipt: a resubmit must NOT re-execute (unknown side effect)
    from ai_video_workflow.gateway import (
        CommandReceipt,
        append_receipt,
        request_digest,
    )

    # the marker must carry the SAME request digest as the resubmit, else the
    # resubmit is a conflict rather than an idempotent recovery
    rd = request_digest("rerun", "user", _target(), {})
    append_receipt(
        tmp_path,
        CommandReceipt("c-1", "rerun", rd, ReceiptStatus.ATTEMPTING, None, None, T0),
    )
    applied = _Applied()
    gw = _gateway(tmp_path, _registry(applied.spec))
    receipt = gw.submit(_env(command_id="c-1"))
    assert receipt.status is ReceiptStatus.AMBIGUOUS
    assert applied.calls == 0  # never re-executed


def test_command_id_reuse_for_different_request_conflicts(tmp_path):
    from ai_video_workflow.gateway import CommandIdConflictError

    applied = _Applied()
    gw = _gateway(tmp_path, _registry(applied.spec))
    gw.submit(_env(command_id="c-1", params={"a": 1}))
    with pytest.raises(CommandIdConflictError):
        gw.submit(_env(command_id="c-1", params={"a": 2}))  # same id, diff request
    assert applied.calls == 1  # the conflicting resubmit did NOT run


def test_non_json_outcome_is_ambiguous_not_replayed(tmp_path):
    applied = _Applied()
    applied._bad_outcome = True
    gw = _gateway(tmp_path, _registry(applied.spec))
    receipt = gw.submit(_env(command_id="c-1"))
    assert receipt.status is ReceiptStatus.AMBIGUOUS  # apply ran, outcome unpersistable
    assert applied.calls == 1
    # resubmit does not re-run
    again = gw.submit(_env(command_id="c-1"))
    assert again.status is ReceiptStatus.AMBIGUOUS
    assert applied.calls == 1


def test_tampered_receipt_line_fails_closed(tmp_path):
    from ai_video_workflow.gateway import CorruptReceiptLogError, receipt_log_path

    p = receipt_log_path(tmp_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    # a NaN in the outcome is non-standard JSON and must be refused, not accepted
    p.write_text(
        '{"schema_version":1,"command_id":"c-1","name":"rerun","status":"completed",'
        '"outcome":{"x":NaN},"reason":null,"occurred_at":"2026-08-03T08:00:00.000000+00:00"}\n',
        encoding="utf-8",
    )
    with pytest.raises(CorruptReceiptLogError):
        read_receipts(tmp_path)


def test_receipt_recoverable_across_gateway_instances(tmp_path):
    applied = _Applied()
    _gateway(tmp_path, _registry(applied.spec)).submit(_env(command_id="c-1"))
    # a fresh Gateway (e.g. a new client/process) recovers the receipt
    assert find_receipt(tmp_path, "c-1").status is ReceiptStatus.COMPLETED


# --- no-target commands ------------------------------------------------------


def test_command_without_target_requirement(tmp_path):
    applied = _Applied(requires_target=False)
    gw = _gateway(tmp_path, _registry(applied.spec))
    env = CommandEnvelope(
        command_id="c-1",
        name="rerun",
        actor="user",
        params={},
        occurred_at=T0,
        target=None,
    )
    receipt = gw.submit(env)
    assert receipt.status is ReceiptStatus.COMPLETED
    assert applied.calls == 1
