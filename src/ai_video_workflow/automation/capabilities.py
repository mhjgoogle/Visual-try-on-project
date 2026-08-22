"""The WFM3 automation command-capability registry (TASK-038 / ADR-0040).

WFM3 automation is an ORCHESTRATION layer above the Command Gateway (ADR-0033): it
only COMPOSES already-approved application/Orchestrator commands, each applied one
at a time through the Gateway → Orchestrator boundary. It never calls a Provider or
writes business files, and it invents no execution layer (ADR-0010 decisions 1/2/3).

This module is the versioned, SINGLE-SOURCE capability registry (ADR-0040): each
capability declares the Gateway command it composes (which MUST exist in the
ADR-0033 Gateway command registry — same source, no second truth), the real L0–S7
I/O-baseline step it implements, its input/output contract descriptors, whether it
ends in a human gate, its recovery semantics and its risk tier. Fail-closed:

* an unregistered capability is refused (:class:`CapabilityNotRegisteredError`);
* a capability whose Gateway command is not registered is a second-source error
  (:func:`verify_same_source`);
* a :class:`CapabilitySnapshot` bound to a drifted registry version/digest fails
  closed (:class:`CapabilityDriftError`, ADR-0010 decision 6) — a stale binding
  never keeps auto-executing;
* the control operations pause / vendor-cancel / allowlisted-skip are UNSUPPORTED
  by default and are never faked as a state; they surface only once the core
  contract defines their billing/state/downstream effects.

Contract layer only: it declares the capability→command→step bindings and the
control dispositions; it does NOT wire real apply handlers or a CLI (ADR-0040
"Not decided here"), and it approves nothing on the user's behalf.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ai_video_workflow.automation.errors import (
    CapabilityDriftError,
    CapabilityNotRegisteredError,
    SecondSourceError,
    UnsupportedControlError,
)
from ai_video_workflow.creative import catalog as _creative_catalog
from ai_video_workflow.digests import config_digest
from ai_video_workflow.gateway.commands import CommandRegistry, CommandRisk
from ai_video_workflow.postproduction import catalog as _pp_catalog

CAPABILITY_REGISTRY_SCHEMA = "wfm3-capability-registry-v1"

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")

# Control operations that MUST NOT be invented as UI/automation states until the
# core contract defines their billing, state and downstream effects (ADR-0040 /
# ADR-0033 / AGENTS.md). Default disposition: unsupported (with a reason).
CONTROL_PAUSE = "pause"
CONTROL_CANCEL = "cancel"
CONTROL_SKIP = "skip"
_CONTROL_OPS = (CONTROL_PAUSE, CONTROL_CANCEL, CONTROL_SKIP)

# The S4 asset-manufacturing step ids (semantic I/O baseline §7). S4 has no Python
# catalog module (media generation is TASK-035), so the automation layer keeps an
# explicit allowlist to bind capabilities to REAL baseline steps fail-closed.
_S4_STEP_IDS = frozenset(f"S4-T0{i}" for i in range(1, 9))


def _baseline_step_ids() -> frozenset[str]:
    creative = {row.step_id for row in _creative_catalog.steps()}
    postproduction = {row.step_id for row in _pp_catalog.steps()}
    return frozenset(creative | postproduction | _S4_STEP_IDS)


@dataclass(frozen=True, slots=True)
class ControlDisposition:
    """Whether a control operation is supported, and why not if unsupported."""

    op: str
    supported: bool
    reason: str


@dataclass(frozen=True, slots=True)
class Capability:
    """One WFM3 automation capability bound to a Gateway command + baseline step."""

    capability_id: str
    title: str
    gateway_command: str  # MUST be a registered ADR-0033 Gateway command
    step_id: str  # a real L0–S7 I/O-baseline step
    input_contract: str  # descriptor of the required input binding
    output_contract: str  # descriptor of the produced output identity
    recovery: str  # durable-receipt / safe-replay semantics descriptor
    risk: CommandRisk
    human_gate: bool = False  # ends in a user final judgement (not automated)

    def __post_init__(self) -> None:
        for name in ("capability_id", "gateway_command"):
            if not _ID_RE.match(getattr(self, name)):
                raise SecondSourceError(f"{name} invalid: {getattr(self, name)!r}")
        if self.step_id not in _baseline_step_ids():
            raise SecondSourceError(
                f"capability {self.capability_id!r} binds unknown baseline step "
                f"{self.step_id!r}"
            )
        for name in ("title", "input_contract", "output_contract", "recovery"):
            if not (
                isinstance(getattr(self, name), str) and getattr(self, name).strip()
            ):
                raise SecondSourceError(f"{name} must be a non-empty string")
        if not isinstance(self.risk, CommandRisk):
            raise SecondSourceError("risk must be a CommandRisk")
        if not isinstance(self.human_gate, bool):
            raise SecondSourceError("human_gate must be a bool")

    def digest(self) -> str:
        return config_digest(
            {
                "capability_id": self.capability_id,
                "title": self.title,
                "gateway_command": self.gateway_command,
                "step_id": self.step_id,
                "input_contract": self.input_contract,
                "output_contract": self.output_contract,
                "recovery": self.recovery,
                "risk": self.risk.value,
                "human_gate": self.human_gate,
            }
        )


@dataclass(frozen=True, slots=True)
class CapabilitySnapshot:
    """A durable, version-bound reference to a capability.

    Resolving it against the current registry fails closed if the registry version
    or the capability's digest drifted, so a stale binding never auto-executes.
    """

    capability_id: str
    registry_version: int
    capability_digest: str


class CapabilityRegistry:
    """The versioned, single-source WFM3 capability registry (fail-closed)."""

    __slots__ = ("_version", "_caps")

    def __init__(self, version: int) -> None:
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise SecondSourceError("registry version must be a positive int")
        self._version = version
        self._caps: dict[str, Capability] = {}

    @property
    def version(self) -> int:
        return self._version

    def register(self, capability: Capability) -> None:
        if capability.capability_id in self._caps:
            raise SecondSourceError(
                f"capability {capability.capability_id!r} is already registered"
            )
        self._caps[capability.capability_id] = capability

    def get(self, capability_id: str) -> Capability:
        cap = self._caps.get(capability_id)
        if cap is None:
            raise CapabilityNotRegisteredError(
                f"capability {capability_id!r} is not registered (refused)"
            )
        return cap

    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._caps))

    def registry_digest(self) -> str:
        """A deterministic digest over the whole registry (version + all caps)."""
        return config_digest(
            {
                "schema": CAPABILITY_REGISTRY_SCHEMA,
                "version": self._version,
                "capabilities": [
                    self._caps[cid].digest() for cid in sorted(self._caps)
                ],
            }
        )

    def snapshot(self, capability_id: str) -> CapabilitySnapshot:
        cap = self.get(capability_id)
        return CapabilitySnapshot(capability_id, self._version, cap.digest())

    def resolve(self, snapshot: CapabilitySnapshot) -> Capability:
        """Resolve a snapshot, failing closed on any version/digest drift."""
        if snapshot.registry_version != self._version:
            raise CapabilityDriftError(
                f"capability snapshot targets registry v{snapshot.registry_version}, "
                f"current is v{self._version}; stale binding refused"
            )
        cap = self.get(snapshot.capability_id)
        if cap.digest() != snapshot.capability_digest:
            raise CapabilityDriftError(
                f"capability {snapshot.capability_id!r} changed since the snapshot; "
                "stale binding refused"
            )
        return cap

    def verify_same_source(self, gateway_registry: CommandRegistry) -> None:
        """Every capability's Gateway command MUST exist in the Gateway registry —
        the capability registry stays same-source, never a second truth."""
        approved = set(gateway_registry.names())
        for cid in sorted(self._caps):
            command = self._caps[cid].gateway_command
            if command not in approved:
                raise SecondSourceError(
                    f"capability {cid!r} names Gateway command {command!r} which is "
                    "not in the approved Gateway registry (second source refused)"
                )


def control_disposition(op: str) -> ControlDisposition:
    """The support decision for a control operation — unsupported, never faked."""
    if op not in _CONTROL_OPS:
        raise UnsupportedControlError(f"unknown control operation: {op!r}")
    return ControlDisposition(
        op=op,
        supported=False,
        reason=(
            f"{op!r} is unsupported: the core contract has not defined its billing, "
            "state and downstream effects; it must not be faked as a UI/automation "
            "state (ADR-0040 / AGENTS.md)."
        ),
    )


def control_ops() -> tuple[str, ...]:
    return _CONTROL_OPS


# The fixed WFM3 automation duties (ADR-0040): each COMPOSES a Gateway command and
# binds a real baseline step. Gateway command names mirror the approved registry
# (same source); real apply handlers/schema are ADR-0040 "Not decided here".
_WFM3_CAPABILITIES: tuple[Capability, ...] = (
    Capability(
        "project_create",
        "项目创建",
        "create_project",
        "Project-Init",
        "user profile inputs + budget constraints",
        "immutable project_profile v1",
        "durable receipt; idempotent by project id; no partial profile",
        CommandRisk.LOW,
    ),
    Capability(
        "stage_validate",
        "阶段校验",
        "validate_stage",
        "S3-T06",
        "stage lock inputs + prior-step digests",
        "preflight_report (pass/blockers)",
        "read-only preflight; safe to re-run; no state written on failure",
        CommandRisk.LOW,
    ),
    Capability(
        "task_packet",
        "任务包生成",
        "compile_task_packets",
        "S3-T02",
        "shot_list + locks (screenplay/av_design)",
        "shot_card packets, versioned",
        "idempotent recompile by shot digest; supersede, never overwrite",
        CommandRisk.LOW,
    ),
    Capability(
        "submit",
        "提交生成",
        "submit_generation",
        "S4-T05",
        "task packet + provider plan + budget reservation",
        "operation/attempt records",
        "durable receipt; unknown side effect NOT auto-replayed; reservation guarded",
        CommandRisk.HIGH,
    ),
    Capability(
        "collect",
        "回收结果",
        "collect_generation",
        "S4-T05",
        "operation record + provider result",
        "candidate assets + cost facts",
        "idempotent by operation id; retained candidates never deleted on replay",
        CommandRisk.LOW,
    ),
    Capability(
        "proxy",
        "代理与预览",
        "build_proxy",
        "S4-T07",
        "approved assets + proxy profile",
        "proxy assets + preview manifest",
        "derived + deletable/rebuildable; never replaces the formal asset",
        CommandRisk.LOW,
    ),
    Capability(
        "qc",
        "技术 QC",
        "run_technical_qc",
        "S6-T03",
        "master candidate + format lock",
        "technical_qc conclusion (derived)",
        "read-only over authoritative media; rebuildable; no master mutation",
        CommandRisk.LOW,
    ),
    Capability(
        "package",
        "发布打包",
        "build_release_package",
        "S6-T05",
        "approved master + passed QC set + metadata",
        "versioned platform package",
        "no overwrite of an existing package; references precise master digest",
        CommandRisk.HIGH,
    ),
)


def wfm3_capabilities() -> tuple[Capability, ...]:
    return _WFM3_CAPABILITIES


def required_gateway_commands() -> tuple[str, ...]:
    """The Gateway command names the WFM3 capabilities compose (sorted, unique).

    A deployment's ADR-0033 Gateway registry MUST provide exactly these (same
    source); :meth:`CapabilityRegistry.verify_same_source` enforces it.
    """
    return tuple(sorted({c.gateway_command for c in _WFM3_CAPABILITIES}))


def build_wfm3_registry(version: int = 1) -> CapabilityRegistry:
    """Build the fixed WFM3 automation capability registry."""
    registry = CapabilityRegistry(version)
    for capability in _WFM3_CAPABILITIES:
        registry.register(capability)
    return registry
