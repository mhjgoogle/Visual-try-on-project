"""Tests for the WFM3 automation capability registry (TASK-038 / ADR-0040)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ai_video_workflow.automation import capabilities as cap
from ai_video_workflow.automation.errors import (
    CapabilityDriftError,
    CapabilityNotRegisteredError,
    SecondSourceError,
    UnsupportedControlError,
)
from ai_video_workflow.gateway.commands import (
    CommandRegistry,
    CommandRisk,
    CommandSpec,
    Preview,
)

T0 = datetime(2026, 8, 4, 10, 0, 0, tzinfo=timezone.utc)


def _stub_gateway(names) -> CommandRegistry:
    """A Gateway registry with the given command names as approved stub specs
    (mirrors TASK-030's stub-command foundation)."""
    registry = CommandRegistry()
    for name in names:
        registry.register(
            CommandSpec(
                name=name,
                risk=CommandRisk.LOW,
                preview=lambda project_root, envelope: Preview({}, None, (), ()),
                apply=lambda project_root, envelope: {},
                requires_target=False,
            )
        )
    return registry


# --- registry basics ---------------------------------------------------------


def test_wfm3_registry_has_the_fixed_duties() -> None:
    r = cap.build_wfm3_registry()
    assert set(r.ids()) == {
        "project_create",
        "stage_validate",
        "task_packet",
        "submit",
        "collect",
        "proxy",
        "qc",
        "package",
    }


def test_unregistered_capability_refused() -> None:
    r = cap.build_wfm3_registry()
    with pytest.raises(CapabilityNotRegisteredError):
        r.get("does_not_exist")


def test_every_capability_binds_a_real_baseline_step() -> None:
    baseline = cap._baseline_step_ids()
    for c in cap.wfm3_capabilities():
        assert c.step_id in baseline


def test_capability_with_unknown_step_is_rejected() -> None:
    with pytest.raises(SecondSourceError):
        cap.Capability(
            "bad", "x", "some_cmd", "S9-T99", "in", "out", "rec", CommandRisk.LOW
        )


# --- same-source with the Gateway registry (no second truth) -----------------


def test_same_source_ok_when_gateway_has_all_commands() -> None:
    r = cap.build_wfm3_registry()
    gateway = _stub_gateway(cap.required_gateway_commands())
    r.verify_same_source(gateway)  # no raise


def test_same_source_fails_when_a_command_is_missing() -> None:
    r = cap.build_wfm3_registry()
    missing = [n for n in cap.required_gateway_commands() if n != "submit_generation"]
    gateway = _stub_gateway(missing)
    with pytest.raises(SecondSourceError):
        r.verify_same_source(gateway)


# --- version drift fail-closed (ADR-0010 decision 6) -------------------------


def test_snapshot_resolves_then_fails_closed_on_version_drift() -> None:
    r1 = cap.build_wfm3_registry(version=1)
    snap = r1.snapshot("submit")
    assert r1.resolve(snap).capability_id == "submit"
    # a newer registry version invalidates the stale snapshot
    r2 = cap.build_wfm3_registry(version=2)
    with pytest.raises(CapabilityDriftError):
        r2.resolve(snap)


def test_snapshot_fails_closed_on_capability_digest_drift() -> None:
    r = cap.build_wfm3_registry(version=1)
    snap = r.snapshot("qc")
    # a registry of the same version but a changed capability digest is drift
    tampered = cap.CapabilityRegistry(1)
    for c in cap.wfm3_capabilities():
        if c.capability_id == "qc":
            c = cap.Capability(
                c.capability_id,
                c.title,
                c.gateway_command,
                c.step_id,
                c.input_contract,
                "CHANGED OUTPUT CONTRACT",
                c.recovery,
                c.risk,
            )
        tampered.register(c)
    with pytest.raises(CapabilityDriftError):
        tampered.resolve(snap)


# --- pause/cancel/skip are unsupported, never faked --------------------------


def test_control_ops_are_all_unsupported_with_reason() -> None:
    for op in cap.control_ops():
        disp = cap.control_disposition(op)
        assert disp.supported is False
        assert disp.reason  # a stated reason, not a faked state
    assert set(cap.control_ops()) == {"pause", "cancel", "skip"}


def test_unknown_control_op_rejected() -> None:
    with pytest.raises(UnsupportedControlError):
        cap.control_disposition("resume")


# --- risk / human gate declarations ------------------------------------------


def test_paid_duties_are_high_risk_and_creative_gates_are_not_automated() -> None:
    r = cap.build_wfm3_registry()
    assert r.get("submit").risk is CommandRisk.HIGH
    assert r.get("package").risk is CommandRisk.HIGH
    # no automation capability claims to REPLACE a human creative gate: none of
    # the fixed duties is a human_gate step (approvals stay with the user).
    assert all(not c.human_gate for c in cap.wfm3_capabilities())


def test_registry_digest_is_deterministic_and_version_sensitive() -> None:
    assert (
        cap.build_wfm3_registry(1).registry_digest()
        == cap.build_wfm3_registry(1).registry_digest()
    )
    assert (
        cap.build_wfm3_registry(1).registry_digest()
        != cap.build_wfm3_registry(2).registry_digest()
    )
