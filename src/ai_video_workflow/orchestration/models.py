"""Public orchestration enums and summary models."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.manifest import StepManifest
from ai_video_workflow.models import GenerationTask
from ai_video_workflow.orchestration.canonical import (
    _freeze_mapping,
    _thaw_mapping,
)
from ai_video_workflow.providers.models import (
    ArtifactReference,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)


class OrchestrationAction(str, Enum):
    """One orchestration-level action on a generation task."""

    PREPARE = "prepare"
    SUBMIT = "submit"
    POLL = "poll"
    REPORT_ARTIFACT = "report_artifact"
    COLLECT = "collect"
    REPLAY_RESULT = "replay_result"
    RESUME = "resume"


class OutcomeKind(str, Enum):
    """Whether an orchestration action applied changes or was a no-op."""

    APPLIED = "applied"
    NO_OP = "no_op"


class RecordPhase(str, Enum):
    """Durable phase of one orchestration record envelope."""

    STABLE = "stable"
    PROVIDER_CALL_INTENT = "provider_call_intent"
    PROVIDER_CALL_MAY_HAVE_STARTED = "provider_call_may_have_started"
    PROVIDER_RESULT_UNKNOWN = "provider_result_unknown"
    APPLYING = "applying"
    RECOVERY_REQUIRED = "recovery_required"


class RecoveryDisposition(str, Enum):
    """How a recovery situation may proceed."""

    NONE = "none"
    SAFE_AUTO_RETRY = "safe_auto_retry"
    MANUAL_RECONCILIATION = "manual_reconciliation"
    CONFLICT = "conflict"


@dataclass(frozen=True, slots=True)
class OrchestrationContext:
    """One immutable orchestration request context (§6.1 input)."""

    project_root: Path
    request: ProviderRequest
    task: GenerationTask
    manifest: StepManifest

    __hash__ = None

    def __post_init__(self) -> None:
        if not isinstance(self.project_root, Path):
            raise FieldTypeError(
                f"project_root: expected Path, got {type(self.project_root).__name__}"
            )
        if type(self.request) is not ProviderRequest:
            raise FieldTypeError(
                f"request: expected ProviderRequest, got {type(self.request).__name__}"
            )
        if type(self.task) is not GenerationTask:
            raise FieldTypeError(
                f"task: expected GenerationTask, got {type(self.task).__name__}"
            )
        if type(self.manifest) is not StepManifest:
            raise FieldTypeError(
                f"manifest: expected StepManifest, got {type(self.manifest).__name__}"
            )


@dataclass(frozen=True, slots=True)
class OrchestrationPlan:
    """Deeply frozen, non-executable public summary of one apply plan (§10.2).

    Carries frozen snapshot wrappers and fingerprint maps only; it never
    exposes a mutable model instance and cannot be executed. The
    internal executor uses `_ExecutablePlan`, never this summary.
    """

    plan_id: str
    operation_id: str
    action: OrchestrationAction
    task_id: str
    shot_id: str
    provider_id: str
    baseline_version: int
    request_fingerprint: str
    result_fingerprint: str
    before_fingerprints: Mapping[str, str]
    after_fingerprints: Mapping[str, str]
    task_after_snapshot: Mapping[str, object]
    manifest_after_snapshot: Mapping[str, object]
    instruction_fingerprint: str
    legal_actions: tuple[OrchestrationAction, ...]
    preferred_next_action: OrchestrationAction | None
    artifact_handoff: ArtifactReference | None

    __hash__ = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "before_fingerprints", _freeze_mapping(dict(self.before_fingerprints))
        )
        object.__setattr__(
            self, "after_fingerprints", _freeze_mapping(dict(self.after_fingerprints))
        )
        object.__setattr__(
            self, "task_after_snapshot", _freeze_mapping(dict(self.task_after_snapshot))
        )
        object.__setattr__(
            self,
            "manifest_after_snapshot",
            _freeze_mapping(dict(self.manifest_after_snapshot)),
        )
        object.__setattr__(self, "legal_actions", tuple(self.legal_actions))
        if self.artifact_handoff is not None and (
            type(self.artifact_handoff) is not ArtifactReference
        ):
            raise FieldTypeError(
                "artifact_handoff: expected ArtifactReference or None, "
                f"got {type(self.artifact_handoff).__name__}"
            )

    def to_json_dict(self) -> dict[str, object]:
        """Return a new JSON-compatible dictionary for this plan summary."""
        return {
            "plan_id": self.plan_id,
            "operation_id": self.operation_id,
            "action": self.action.value,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "provider_id": self.provider_id,
            "baseline_version": self.baseline_version,
            "request_fingerprint": self.request_fingerprint,
            "result_fingerprint": self.result_fingerprint,
            "before_fingerprints": dict(self.before_fingerprints),
            "after_fingerprints": dict(self.after_fingerprints),
            "task_after_snapshot": _thaw_mapping(self.task_after_snapshot),
            "manifest_after_snapshot": _thaw_mapping(self.manifest_after_snapshot),
            "instruction_fingerprint": self.instruction_fingerprint,
            "legal_actions": [action.value for action in self.legal_actions],
            "preferred_next_action": (
                None
                if self.preferred_next_action is None
                else self.preferred_next_action.value
            ),
            "artifact_handoff": (
                None
                if self.artifact_handoff is None
                else self.artifact_handoff.to_json_dict()
            ),
        }


@dataclass(frozen=True, slots=True)
class OrchestrationRecord:
    """Public read-only summary snapshot of the durable record (§6.3).

    Not the durable envelope: it is never used for persistence, CAS, or
    recovery. Identity fields always come from the observed task; stable
    fields from the committed stable snapshot; pending fields from the
    pending variant. No fingerprint, confirmed_writes, or full Provider
    payload is exposed.
    """

    exists: bool
    phase: RecordPhase | None
    task_id: str
    shot_id: str | None
    provider_id: str | None
    stable_version: int | None
    last_completed_action: OrchestrationAction | None
    provider_status: ProviderStatus | None
    pending_operation_id: str | None
    pending_action: OrchestrationAction | None
    pending_plan_id: str | None

    __hash__ = None

    def to_json_dict(self) -> dict[str, object]:
        """Return a new JSON dict of exactly 11 keys (§6.3)."""
        return {
            "exists": self.exists,
            "phase": None if self.phase is None else self.phase.value,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "provider_id": self.provider_id,
            "stable_version": self.stable_version,
            "last_completed_action": (
                None
                if self.last_completed_action is None
                else self.last_completed_action.value
            ),
            "provider_status": (
                None if self.provider_status is None else self.provider_status.value
            ),
            "pending_operation_id": self.pending_operation_id,
            "pending_action": (
                None if self.pending_action is None else self.pending_action.value
            ),
            "pending_plan_id": self.pending_plan_id,
        }


@dataclass(frozen=True, slots=True)
class ResumeAssessment:
    """Read-only assessment of one task's resumable orchestration state.

    ``phase`` is ``None`` only for the ∅ no-record initial state (§17.2
    ∅ resume row); ``provider_id`` is the intended provider from the
    request context and is always present.
    """

    task_id: str
    shot_id: str
    provider_id: str
    phase: RecordPhase | None
    last_completed_action: OrchestrationAction | None
    legal_actions: tuple[OrchestrationAction, ...]
    preferred_next_action: OrchestrationAction | None
    is_terminal: bool
    requires_manual_reconciliation: bool
    disposition: RecoveryDisposition

    def __post_init__(self) -> None:
        object.__setattr__(self, "legal_actions", tuple(self.legal_actions))


@dataclass(frozen=True, slots=True)
class OrchestrationOutcome:
    """Public outcome of one orchestration action (§6.2)."""

    kind: OutcomeKind
    plan: OrchestrationPlan | None
    no_op_reason: str | None
    record: OrchestrationRecord
    legal_actions: tuple[OrchestrationAction, ...]
    preferred_next_action: OrchestrationAction | None
    provider_result: ProviderResult | None
    artifact_handoff: ArtifactReference | None

    __hash__ = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "legal_actions", tuple(self.legal_actions))

    @property
    def updated_task(self) -> GenerationTask | None:
        """Rebuild a fresh GenerationTask from the plan snapshot (§16.4).

        Returns None for a NO_OP outcome. Each access rebuilds a new
        instance through the approved recovery adapter (imported at
        function level, the only approved lazy-import point).
        """
        if self.plan is None:
            return None
        from ai_video_workflow.orchestration.recovery import (
            _restore_generation_task,
        )

        return _restore_generation_task(self.plan.task_after_snapshot)

    @property
    def updated_manifest(self) -> StepManifest | None:
        """Rebuild a fresh StepManifest from the plan snapshot (§16.4)."""
        if self.plan is None:
            return None
        from ai_video_workflow.orchestration.recovery import (
            _restore_step_manifest,
        )

        return _restore_step_manifest(self.plan.manifest_after_snapshot)
