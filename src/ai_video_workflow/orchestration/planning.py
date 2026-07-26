"""Pure orchestration planning core.

`_OrchestrationPlanner` is the zero-I/O, zero-clock decision core:
it validates identity and request consistency, applies the approved
lifecycle admission and provider-return matrices, enforces the time
authority and sticky-merge rules, constructs the after payloads for
the task and manifest, computes the acyclic plan identity, renders
the instruction bytes through the approved renderer, and assembles
the internal `_ExecutablePlan`. It never touches the filesystem,
never calls a Provider, and never advances durable record phases.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus
from ai_video_workflow.orchestration._models import (
    ABSENT,
    _ExecutablePlan,
    _PendingApply,
    _StableStateSnapshot,
)
from ai_video_workflow.orchestration.canonical import (
    _compute_plan_id,
    _fingerprint,
    _make_plan_preimage,
    _make_snapshot_wrapper,
    _sha256_hex,
)
from ai_video_workflow.orchestration.errors import (
    ConflictingProviderResultError,
    ConflictingRequestError,
    IdempotencyConflictError,
    IllegalProviderTransitionError,
    InvalidOrchestrationInputError,
    InvalidOrchestrationStateError,
    StaleResultError,
)
from ai_video_workflow.orchestration.instructions import (
    _render_instruction_bytes,
)
from ai_video_workflow.orchestration.models import (
    OrchestrationAction,
    RecoveryDisposition,
)
from ai_video_workflow.providers.models import (
    ArtifactReference,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)
from ai_video_workflow.serialization import model_to_dict
from ai_video_workflow.validation import (
    validate_stable_id,
    validate_utc_datetime,
)

ORCHESTRATION_METADATA_KEY = "orchestration"
ORCHESTRATION_METADATA_SCHEMA_VERSION = 1

_STATUS_TO_TASK_STATUS = {
    ProviderStatus.NOT_SUBMITTED: GenerationTaskStatus.PENDING,
    ProviderStatus.WAITING_FOR_USER: GenerationTaskStatus.IN_PROGRESS,
    ProviderStatus.PROCESSING: GenerationTaskStatus.IN_PROGRESS,
    ProviderStatus.ARTIFACT_AVAILABLE: GenerationTaskStatus.IN_PROGRESS,
    ProviderStatus.SUCCEEDED: GenerationTaskStatus.DONE,
    ProviderStatus.FAILED: GenerationTaskStatus.FAILED,
    ProviderStatus.CANCELLED: GenerationTaskStatus.CANCELLED,
}

_STATE_RANK = {
    ProviderStatus.NOT_SUBMITTED: 0,
    ProviderStatus.WAITING_FOR_USER: 1,
    ProviderStatus.PROCESSING: 1,
    ProviderStatus.ARTIFACT_AVAILABLE: 2,
    ProviderStatus.SUCCEEDED: 3,
    ProviderStatus.FAILED: 3,
    ProviderStatus.CANCELLED: 3,
}

_TERMINAL_PROVIDER_STATUSES = frozenset(
    {
        ProviderStatus.SUCCEEDED,
        ProviderStatus.FAILED,
        ProviderStatus.CANCELLED,
    }
)

_LEGAL_ACTIONS_BY_STATUS: dict[
    ProviderStatus,
    tuple[tuple[OrchestrationAction, ...], OrchestrationAction | None],
] = {
    ProviderStatus.NOT_SUBMITTED: (
        (OrchestrationAction.SUBMIT,),
        OrchestrationAction.SUBMIT,
    ),
    ProviderStatus.WAITING_FOR_USER: (
        (
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
        ),
        OrchestrationAction.POLL,
    ),
    ProviderStatus.PROCESSING: (
        (OrchestrationAction.POLL, OrchestrationAction.REPORT_ARTIFACT),
        OrchestrationAction.POLL,
    ),
    ProviderStatus.ARTIFACT_AVAILABLE: (
        (
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
        ),
        OrchestrationAction.COLLECT,
    ),
    ProviderStatus.SUCCEEDED: ((), None),
    ProviderStatus.FAILED: ((), None),
    ProviderStatus.CANCELLED: ((), None),
}

_EMPTY_STATE_LEGAL_ACTIONS = (OrchestrationAction.PREPARE,)
_EMPTY_STATE_PREFERRED = OrchestrationAction.PREPARE

_LEGAL_RESULT_STATUSES_BY_ACTION = {
    OrchestrationAction.PREPARE: frozenset({ProviderStatus.NOT_SUBMITTED}),
    OrchestrationAction.SUBMIT: frozenset(
        set(ProviderStatus) - {ProviderStatus.NOT_SUBMITTED}
    ),
    OrchestrationAction.POLL: frozenset(
        set(ProviderStatus) - {ProviderStatus.NOT_SUBMITTED}
    ),
    OrchestrationAction.REPORT_ARTIFACT: frozenset(
        set(ProviderStatus) - {ProviderStatus.NOT_SUBMITTED}
    ),
    OrchestrationAction.COLLECT: frozenset({ProviderStatus.SUCCEEDED}),
    OrchestrationAction.REPLAY_RESULT: frozenset(set(ProviderStatus)),
}

_ADMISSIBLE_ACTIONS_BY_STATUS = {
    ProviderStatus.NOT_SUBMITTED: frozenset(
        {OrchestrationAction.SUBMIT, OrchestrationAction.REPLAY_RESULT}
    ),
    ProviderStatus.WAITING_FOR_USER: frozenset(
        {
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
            OrchestrationAction.REPLAY_RESULT,
        }
    ),
    ProviderStatus.PROCESSING: frozenset(
        {
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.REPLAY_RESULT,
        }
    ),
    ProviderStatus.ARTIFACT_AVAILABLE: frozenset(
        {
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
            OrchestrationAction.REPLAY_RESULT,
        }
    ),
    ProviderStatus.SUCCEEDED: frozenset(
        {OrchestrationAction.COLLECT, OrchestrationAction.REPLAY_RESULT}
    ),
    ProviderStatus.FAILED: frozenset({OrchestrationAction.REPLAY_RESULT}),
    ProviderStatus.CANCELLED: frozenset({OrchestrationAction.REPLAY_RESULT}),
}


@dataclass(frozen=True, slots=True)
class _NoOpDecision:
    """Pure planning decision: no Provider call, no persistence."""

    reason: str
    legal_actions: tuple[OrchestrationAction, ...]
    preferred_next_action: OrchestrationAction | None


class _OrchestrationPlanner:
    """Stateless, pure planning core for orchestration actions."""

    __slots__ = ()

    def legal_actions_for(
        self,
        stable: _StableStateSnapshot | None,
    ) -> tuple[tuple[OrchestrationAction, ...], OrchestrationAction | None]:
        """Return the legal actions and preferred action for one state."""
        if stable is None:
            return _EMPTY_STATE_LEGAL_ACTIONS, _EMPTY_STATE_PREFERRED
        return _LEGAL_ACTIONS_BY_STATUS[_stable_provider_status(stable)]

    def check_request_consistency(
        self,
        request: ProviderRequest,
        stable: _StableStateSnapshot | None,
    ) -> str:
        """Return the rebuilt request fingerprint after consistency checks."""
        if type(request) is not ProviderRequest:
            raise FieldTypeError(
                f"request: expected ProviderRequest, got {type(request).__name__}"
            )
        rebuilt = _fingerprint(
            _make_snapshot_wrapper("provider_request", request.to_json_dict())
        )
        if stable is not None and rebuilt != stable.request_fingerprint:
            raise ConflictingRequestError(
                "request: rebuilt request fingerprint does not match the "
                "committed stable request fingerprint"
            )
        return rebuilt

    def action_input_fingerprint(
        self,
        *,
        observed_at: datetime,
        artifact: ArtifactReference | None,
        completed_at: datetime | None,
        result_fingerprint: str | None,
    ) -> tuple[object, str]:
        """Return the frozen action_input wrapper and its fingerprint."""
        wrapper = _action_input_wrapper(
            observed_at=observed_at,
            artifact=artifact,
            completed_at=completed_at,
            result_fingerprint=result_fingerprint,
        )
        return wrapper, _fingerprint(wrapper)

    def assess_observation(
        self,
        stable: _StableStateSnapshot,
        result: ProviderResult,
    ) -> str:
        """Classify one observation as noop or apply per time authority."""
        previous_observed_at = _parse_iso(
            stable.last_result_snapshot["payload"]["observed_at"]
        )
        if result.observed_at < previous_observed_at:
            raise StaleResultError("observed_at: older than the committed observation")
        result_fingerprint = _fingerprint(
            _make_snapshot_wrapper("provider_result", result.to_json_dict())
        )
        if result.observed_at == previous_observed_at:
            if result_fingerprint == stable.last_result_fingerprint:
                return "noop"
            raise ConflictingProviderResultError(
                "result: conflicting payload for an equal observation time"
            )
        previous_status = _stable_provider_status(stable)
        if _STATE_RANK[result.status] < _STATE_RANK[previous_status]:
            raise IllegalProviderTransitionError(
                f"status: transition from {previous_status.value} to "
                f"{result.status.value} regresses the lifecycle"
            )
        return "apply"

    def validate_result_status(
        self,
        action: OrchestrationAction,
        result: ProviderResult,
    ) -> None:
        """Reject provider return statuses illegal for one action."""
        legal = _LEGAL_RESULT_STATUSES_BY_ACTION.get(action)
        if legal is None:
            raise InvalidOrchestrationInputError(
                f"action: {action.value} does not accept provider results"
            )
        if result.status not in legal:
            raise IllegalProviderTransitionError(
                f"status: {result.status.value} is not a legal provider "
                f"return status for action {action.value}"
            )

    def plan(
        self,
        *,
        action: OrchestrationAction,
        operation_id: str,
        request: ProviderRequest,
        task: GenerationTask,
        manifest: StepManifest,
        stable: _StableStateSnapshot | None,
        result: ProviderResult,
        observed_at: datetime,
        artifact_input: ArtifactReference | None = None,
        completed_at_input: datetime | None = None,
        task_before_fingerprint: str,
        manifest_before_fingerprint: str,
        instruction_before_fingerprint: str,
        instruction_before_text: str | None = None,
    ) -> _ExecutablePlan | _NoOpDecision:
        """Build the executable plan (or a no-op decision) for one action.

        All inputs are explicit; the planner reads no state, calls no
        Provider, and derives no paths. File before-fingerprints (and
        the current instruction file text, when one exists) are
        supplied by the caller.
        """
        _validate_plan_inputs(
            action=action,
            operation_id=operation_id,
            request=request,
            task=task,
            manifest=manifest,
            stable=stable,
            result=result,
            observed_at=observed_at,
            artifact_input=artifact_input,
            completed_at_input=completed_at_input,
            task_before_fingerprint=task_before_fingerprint,
            manifest_before_fingerprint=manifest_before_fingerprint,
            instruction_before_fingerprint=instruction_before_fingerprint,
            instruction_before_text=instruction_before_text,
        )
        request_fingerprint = self.check_request_consistency(request, stable)
        result_wrapper = _make_snapshot_wrapper(
            "provider_result", result.to_json_dict()
        )
        result_fingerprint = _fingerprint(result_wrapper)
        action_input_snapshot, action_input_fingerprint = self.action_input_fingerprint(
            observed_at=observed_at,
            artifact=artifact_input,
            completed_at=completed_at_input,
            result_fingerprint=(
                result_fingerprint
                if action is OrchestrationAction.REPLAY_RESULT
                else None
            ),
        )
        legal_now, preferred_now = self.legal_actions_for(stable)
        if stable is not None:
            operation = stable.last_committed_operation
            if operation_id == operation["operation_id"]:
                same_identity = (
                    action.value == operation["action"]
                    and request_fingerprint == operation["request_fingerprint"]
                    and action_input_fingerprint
                    == operation["action_input_fingerprint"]
                )
                if same_identity:
                    return _NoOpDecision(
                        reason="committed_operation_replay",
                        legal_actions=legal_now,
                        preferred_next_action=preferred_now,
                    )
                raise IdempotencyConflictError(
                    "operation_id: reused with different action or inputs"
                )
        decision = _admit(action, stable, result, artifact_input)
        if decision is not None:
            return _NoOpDecision(
                reason=decision,
                legal_actions=legal_now,
                preferred_next_action=preferred_now,
            )
        self.validate_result_status(action, result)
        if stable is not None:
            if self.assess_observation(stable, result) == "noop":
                return _NoOpDecision(
                    reason="equal_observation_replay",
                    legal_actions=legal_now,
                    preferred_next_action=preferred_now,
                )
        if manifest.status is not ManifestStatus.PENDING:
            raise InvalidOrchestrationStateError(
                "manifest.status: a terminal manifest cannot be updated"
            )
        merged = _sticky_merge(action, stable, result)
        task_after = _build_task_after(task, request, result, merged)
        manifest_after = _build_manifest_after(
            manifest,
            result,
            operation_id=operation_id,
            action=action,
        )
        task_after_wrapper = _make_snapshot_wrapper(
            "generation_task", model_to_dict(task_after)
        )
        task_after_fingerprint = _fingerprint(task_after_wrapper)
        manifest_after_wrapper = _make_snapshot_wrapper(
            "step_manifest", model_to_dict(manifest_after)
        )
        manifest_after_fingerprint = _fingerprint(manifest_after_wrapper)
        artifact_input_fingerprint = (
            ABSENT
            if artifact_input is None
            else _fingerprint(_artifact_wrapper(artifact_input))
        )
        baseline_version = 0 if stable is None else stable.version
        preimage = _make_plan_preimage(
            operation_id=operation_id,
            action=action.value,
            baseline_version=baseline_version,
            request_fingerprint=request_fingerprint,
            result_fingerprint=result_fingerprint,
            task_before_fingerprint=task_before_fingerprint,
            task_after_fingerprint=task_after_fingerprint,
            manifest_before_fingerprint=manifest_before_fingerprint,
            manifest_after_fingerprint=manifest_after_fingerprint,
            instruction_before_fingerprint=instruction_before_fingerprint,
            observed_at=_iso(observed_at),
            completed_at=_optional_iso(completed_at_input),
            artifact_input_fingerprint=artifact_input_fingerprint,
        )
        plan_id = _compute_plan_id(preimage)
        instruction_bytes: bytes | None = None
        instruction_after_text: str | None = None
        instruction_after_fingerprint = ABSENT
        instruction_snapshot_after = (
            None if stable is None else stable.instruction_snapshot
        )
        instruction_snapshot_fingerprint = (
            ABSENT if stable is None else stable.instruction_fingerprint
        )
        if action is OrchestrationAction.PREPARE and (result.instruction is not None):
            instruction_bytes = _render_instruction_bytes(
                result.instruction,
                operation_id=operation_id,
                plan_id=plan_id,
                request_fingerprint=request_fingerprint,
            )
            instruction_after_text = instruction_bytes.decode("utf-8")
            instruction_after_fingerprint = _sha256_hex(instruction_bytes)
            instruction_snapshot_after = _make_snapshot_wrapper(
                "provider_instruction", result.instruction.to_json_dict()
            )
            instruction_snapshot_fingerprint = _fingerprint(instruction_snapshot_after)
        elif instruction_before_text is not None:
            instruction_bytes = instruction_before_text.encode("utf-8")
            instruction_after_text = instruction_before_text
            instruction_after_fingerprint = instruction_before_fingerprint
        new_status = result.status
        post_legal, post_preferred = _LEGAL_ACTIONS_BY_STATUS[new_status]
        request_wrapper = _make_snapshot_wrapper(
            "provider_request", request.to_json_dict()
        )
        planned_stable = _StableStateSnapshot(
            task_id=task.task_id,
            shot_id=task.shot_id,
            provider_id=request.provider_id,
            version=baseline_version + 1,
            last_committed_plan_id=plan_id,
            last_committed_operation={
                "operation_id": operation_id,
                "action": action.value,
                "request_fingerprint": request_fingerprint,
                "action_input_fingerprint": action_input_fingerprint,
                "observed_at": _iso(observed_at),
            },
            committed_task_fingerprint=task_after_fingerprint,
            committed_manifest_fingerprint=manifest_after_fingerprint,
            committed_instruction_fingerprint=instruction_after_fingerprint,
            committed_request_fingerprint=request_fingerprint,
            committed_result_fingerprint=result_fingerprint,
            request_snapshot=request_wrapper,
            request_fingerprint=request_fingerprint,
            instruction_snapshot=instruction_snapshot_after,
            instruction_fingerprint=instruction_snapshot_fingerprint,
            authoritative_external_task_ref=merged.external_task_ref,
            authoritative_artifact=merged.artifact,
            authoritative_error_summary=merged.error_summary,
            authoritative_completed_at=merged.completed_at,
            last_result_snapshot=result_wrapper,
            last_result_fingerprint=result_fingerprint,
            last_completed_action=action,
            legal_actions=post_legal,
            preferred_next_action=post_preferred,
            updated_at=result.observed_at,
        )
        planned_wrapper = planned_stable.to_wrapper()
        pending_apply = _PendingApply(
            operation_id=operation_id,
            action=action,
            baseline_version=baseline_version,
            request_snapshot=request_wrapper,
            request_fingerprint=request_fingerprint,
            action_input_snapshot=action_input_snapshot,
            action_input_fingerprint=action_input_fingerprint,
            result_snapshot=result_wrapper,
            result_fingerprint=result_fingerprint,
            plan_id=plan_id,
            before_fingerprints={
                "task": task_before_fingerprint,
                "manifest": manifest_before_fingerprint,
                "instruction": instruction_before_fingerprint,
                "stable_record": (
                    ABSENT if stable is None else stable.stable_record_fingerprint
                ),
            },
            task_after_snapshot=task_after_wrapper,
            task_after_fingerprint=task_after_fingerprint,
            manifest_after_snapshot=manifest_after_wrapper,
            manifest_after_fingerprint=manifest_after_fingerprint,
            instruction_after_text=instruction_after_text,
            instruction_after_fingerprint=instruction_after_fingerprint,
            planned_stable_state_snapshot=planned_wrapper,
            planned_stable_state_wrapper_fingerprint=_fingerprint(planned_wrapper),
            confirmed_writes=(),
            recovery_disposition=RecoveryDisposition.SAFE_AUTO_RETRY,
            original_observed_at=observed_at,
            post_commit_legal_actions=post_legal,
            post_commit_preferred_next_action=post_preferred,
        )
        artifact_handoff = None
        if (
            action is OrchestrationAction.COLLECT
            and result.status is ProviderStatus.SUCCEEDED
            and result.artifact is not None
        ):
            artifact_handoff = _artifact_wrapper(result.artifact)
        return _ExecutablePlan(
            plan_id=plan_id,
            operation_id=operation_id,
            action=action,
            task_id=task.task_id,
            shot_id=task.shot_id,
            provider_id=request.provider_id,
            baseline_version=baseline_version,
            pending_apply=pending_apply,
            instruction_after_bytes=instruction_bytes,
            artifact_handoff=artifact_handoff,
        )


@dataclass(frozen=True, slots=True)
class _MergedAuthoritativeState:
    external_task_ref: str | None
    artifact: object
    error_summary: str | None
    completed_at: datetime | None


def _validate_plan_inputs(
    *,
    action: OrchestrationAction,
    operation_id: str,
    request: ProviderRequest,
    task: GenerationTask,
    manifest: StepManifest,
    stable: _StableStateSnapshot | None,
    result: ProviderResult,
    observed_at: datetime,
    artifact_input: ArtifactReference | None,
    completed_at_input: datetime | None,
    task_before_fingerprint: str,
    manifest_before_fingerprint: str,
    instruction_before_fingerprint: str,
    instruction_before_text: str | None,
) -> None:
    if not isinstance(action, OrchestrationAction):
        raise FieldTypeError(
            f"action: expected OrchestrationAction, got {type(action).__name__}"
        )
    if action is OrchestrationAction.RESUME:
        raise InvalidOrchestrationInputError(
            "action: resume is an assessment, not a plannable action"
        )
    validate_stable_id(operation_id, field_name="operation_id")
    if type(request) is not ProviderRequest:
        raise FieldTypeError(
            f"request: expected ProviderRequest, got {type(request).__name__}"
        )
    if type(task) is not GenerationTask:
        raise FieldTypeError(
            f"task: expected GenerationTask, got {type(task).__name__}"
        )
    if type(manifest) is not StepManifest:
        raise FieldTypeError(
            f"manifest: expected StepManifest, got {type(manifest).__name__}"
        )
    if stable is not None and not isinstance(stable, _StableStateSnapshot):
        raise FieldTypeError(
            "stable: expected _StableStateSnapshot or None, "
            f"got {type(stable).__name__}"
        )
    if type(result) is not ProviderResult:
        raise FieldTypeError(
            f"result: expected ProviderResult, got {type(result).__name__}"
        )
    validate_utc_datetime(observed_at, field_name="observed_at")
    if observed_at != result.observed_at:
        raise InvalidOrchestrationInputError(
            "observed_at: must equal result.observed_at (single time authority)"
        )
    if artifact_input is not None and (type(artifact_input) is not ArtifactReference):
        raise FieldTypeError(
            "artifact_input: expected ArtifactReference or None, "
            f"got {type(artifact_input).__name__}"
        )
    if completed_at_input is not None:
        validate_utc_datetime(
            completed_at_input,
            field_name="completed_at_input",
        )
        if completed_at_input != result.completed_at:
            raise InvalidOrchestrationInputError(
                "completed_at_input: must equal result.completed_at "
                "(single time authority)"
            )
    _validate_file_fingerprint(
        task_before_fingerprint,
        field_name="task_before_fingerprint",
        allow_absent=False,
    )
    _validate_file_fingerprint(
        manifest_before_fingerprint,
        field_name="manifest_before_fingerprint",
        allow_absent=False,
    )
    _validate_file_fingerprint(
        instruction_before_fingerprint,
        field_name="instruction_before_fingerprint",
        allow_absent=True,
    )
    if instruction_before_text is not None:
        if type(instruction_before_text) is not str:
            raise FieldTypeError(
                "instruction_before_text: expected string or None, "
                f"got {type(instruction_before_text).__name__}"
            )
        if instruction_before_fingerprint == ABSENT:
            raise InvalidOrchestrationInputError(
                "instruction_before_text: provided while the instruction "
                "file fingerprint is absent"
            )
        if (
            _sha256_hex(instruction_before_text.encode("utf-8"))
            != instruction_before_fingerprint
        ):
            raise InvalidOrchestrationInputError(
                "instruction_before_text: does not match the instruction "
                "file fingerprint"
            )
    _validate_identity_alignment(request, task, stable, result)
    _validate_instruction_carry_over(
        stable,
        instruction_before_fingerprint=instruction_before_fingerprint,
        instruction_before_text=instruction_before_text,
    )
    if stable is None:
        if instruction_before_fingerprint != ABSENT:
            raise InvalidOrchestrationInputError(
                "instruction_before_fingerprint: an existing instruction "
                "file is an orchestration trace; the first prepare "
                "requires a missing instruction file"
            )
        if ORCHESTRATION_METADATA_KEY in manifest.output_metadata:
            raise InvalidOrchestrationInputError(
                "manifest.output_metadata: an orchestration key is an "
                "orchestration trace; the first prepare requires a "
                "manifest without it"
            )
    if manifest.step_name != f"generation:{task.task_id}":
        raise InvalidOrchestrationInputError(
            "manifest.step_name: must equal generation:<task_id>"
        )


def _validate_instruction_carry_over(
    stable: _StableStateSnapshot | None,
    *,
    instruction_before_fingerprint: str,
    instruction_before_text: str | None,
) -> None:
    """Enforce the instruction carry-over input contract.

    With any existing stable the instruction file must stay coupled
    to the stable state: the before fingerprint must equal the
    committed instruction fingerprint (including the ABSENT case),
    and the carried text is required exactly when a file is
    committed. First-operation rules are enforced by the no-trace
    preconditions.
    """
    if stable is None:
        return
    committed = stable.committed_instruction_fingerprint
    if instruction_before_fingerprint != committed:
        raise InvalidOrchestrationInputError(
            "instruction_before_fingerprint: must equal the committed "
            "instruction file fingerprint (including the absent marker)"
        )
    if committed == ABSENT:
        if instruction_before_text is not None:
            raise InvalidOrchestrationInputError(
                "instruction_before_text: no instruction file is "
                "committed for this task"
            )
        return
    if instruction_before_text is None:
        raise InvalidOrchestrationInputError(
            "instruction_before_text: required to preserve the committed "
            "instruction file fingerprint"
        )


def _validate_identity_alignment(
    request: ProviderRequest,
    task: GenerationTask,
    stable: _StableStateSnapshot | None,
    result: ProviderResult,
) -> None:
    if task.task_id != request.task_id:
        raise InvalidOrchestrationInputError("task.task_id: must equal request.task_id")
    if task.shot_id != request.shot_id:
        raise InvalidOrchestrationInputError("task.shot_id: must equal request.shot_id")
    if (
        result.provider_id != request.provider_id
        or result.task_id != request.task_id
        or result.shot_id != request.shot_id
    ):
        raise InvalidOrchestrationInputError(
            "result: provider_id, task_id, and shot_id must match the request identity"
        )
    if stable is None:
        if task.provider_id is not None:
            raise InvalidOrchestrationInputError(
                "task.provider_id: must be None before the first prepare"
            )
        return
    if task.provider_id != request.provider_id:
        raise InvalidOrchestrationInputError(
            "task.provider_id: must equal request.provider_id"
        )
    if (
        stable.task_id != task.task_id
        or stable.shot_id != task.shot_id
        or stable.provider_id != request.provider_id
    ):
        raise InvalidOrchestrationInputError(
            "stable: task_id, shot_id, and provider_id must match the "
            "request and task identity"
        )


def _admit(
    action: OrchestrationAction,
    stable: _StableStateSnapshot | None,
    result: ProviderResult,
    artifact_input: ArtifactReference | None,
) -> str | None:
    """Apply the STABLE-row admission matrix; return a no-op reason."""
    if stable is None:
        if action is OrchestrationAction.PREPARE:
            return None
        raise InvalidOrchestrationStateError(
            f"action: {action.value} requires an existing stable state"
        )
    status = _stable_provider_status(stable)
    if action is OrchestrationAction.PREPARE:
        if status is ProviderStatus.NOT_SUBMITTED:
            return "repeated_prepare"
        raise InvalidOrchestrationStateError(
            f"action: prepare is illegal in state {status.value}"
        )
    if status is ProviderStatus.SUCCEEDED and (action is OrchestrationAction.COLLECT):
        if artifact_input is None:
            return "already_collected"
        provided = artifact_input.to_json_dict()
        authoritative = (
            None
            if stable.authoritative_artifact is None
            else dict(stable.authoritative_artifact["payload"])
        )
        if provided == authoritative:
            return "already_collected"
        raise ConflictingProviderResultError(
            "artifact: conflicts with the authoritative collected handoff"
        )
    if status in _TERMINAL_PROVIDER_STATUSES and (
        action is OrchestrationAction.REPLAY_RESULT
    ):
        replay_fingerprint = _fingerprint(
            _make_snapshot_wrapper("provider_result", result.to_json_dict())
        )
        if replay_fingerprint == stable.last_result_fingerprint:
            return "terminal_replay"
        raise ConflictingProviderResultError(
            "result: conflicting replay for a terminal state"
        )
    if action not in _ADMISSIBLE_ACTIONS_BY_STATUS[status]:
        raise InvalidOrchestrationStateError(
            f"action: {action.value} is illegal in state {status.value}"
        )
    return None


def _sticky_merge(
    action: OrchestrationAction,
    stable: _StableStateSnapshot | None,
    result: ProviderResult,
) -> _MergedAuthoritativeState:
    """Apply the sticky merge matrix to the authoritative fields."""
    if result.instruction is not None and (action is not OrchestrationAction.PREPARE):
        if (
            action is not OrchestrationAction.REPLAY_RESULT
            or stable is None
            or stable.instruction_fingerprint == ABSENT
        ):
            raise IllegalProviderTransitionError(
                "instruction: only prepare may introduce an instruction"
            )
        replay_instruction_fingerprint = _fingerprint(
            _make_snapshot_wrapper(
                "provider_instruction",
                result.instruction.to_json_dict(),
            )
        )
        if replay_instruction_fingerprint != stable.instruction_fingerprint:
            raise ConflictingProviderResultError(
                "instruction: conflicts with the committed instruction"
            )
    previous_external = (
        None if stable is None else stable.authoritative_external_task_ref
    )
    previous_artifact = (
        None
        if stable is None or stable.authoritative_artifact is None
        else dict(stable.authoritative_artifact["payload"])
    )
    previous_error = None if stable is None else stable.authoritative_error_summary
    previous_completed = None if stable is None else stable.authoritative_completed_at
    external = previous_external
    if result.external_task_ref is not None:
        external = result.external_task_ref
    artifact = previous_artifact
    if result.artifact is not None:
        incoming = result.artifact.to_json_dict()
        if previous_artifact is not None and incoming != previous_artifact:
            raise ConflictingProviderResultError(
                "artifact: conflicts with the authoritative artifact"
            )
        artifact = incoming
    error_summary = previous_error
    if result.error_summary is not None:
        if previous_error is not None and (result.error_summary != previous_error):
            raise ConflictingProviderResultError(
                "error_summary: conflicts with the authoritative error"
            )
        error_summary = result.error_summary
    completed_at = previous_completed
    if result.completed_at is not None:
        if previous_completed is not None and (
            result.completed_at != previous_completed
        ):
            raise ConflictingProviderResultError(
                "completed_at: conflicts with the authoritative completion time"
            )
        completed_at = result.completed_at
    artifact_wrapper = (
        None
        if artifact is None
        else _make_snapshot_wrapper("artifact_reference", artifact)
    )
    return _MergedAuthoritativeState(
        external_task_ref=external,
        artifact=artifact_wrapper,
        error_summary=error_summary,
        completed_at=completed_at,
    )


def _build_task_after(
    task: GenerationTask,
    request: ProviderRequest,
    result: ProviderResult,
    merged: _MergedAuthoritativeState,
) -> GenerationTask:
    """Build the after task per the seven-field matrix."""
    if result.observed_at <= task.updated_at:
        raise StaleResultError(
            "observed_at: must be strictly newer than the task updated_at"
        )
    status = _STATUS_TO_TASK_STATUS[result.status]
    terminal = result.status in _TERMINAL_PROVIDER_STATUSES
    external_task_ref = task.external_task_ref
    if result.external_task_ref is not None:
        external_task_ref = result.external_task_ref
    current_artifact_ref = task.current_artifact_ref
    if result.artifact is not None:
        current_artifact_ref = result.artifact.reference
    return GenerationTask(
        task_id=task.task_id,
        shot_id=task.shot_id,
        status=status,
        created_at=task.created_at,
        updated_at=result.observed_at,
        completed_at=result.completed_at if terminal else None,
        provider_id=request.provider_id,
        input_parameters_ref=task.input_parameters_ref,
        external_task_ref=external_task_ref,
        current_artifact_ref=current_artifact_ref,
        error_summary=(
            result.error_summary if result.status is ProviderStatus.FAILED else None
        ),
    )


def _build_manifest_after(
    manifest: StepManifest,
    result: ProviderResult,
    *,
    operation_id: str,
    action: OrchestrationAction,
) -> StepManifest:
    """Build the after manifest per the five-field matrix."""
    metadata = {
        key: value
        for key, value in manifest.output_metadata.items()
        if key != ORCHESTRATION_METADATA_KEY
    }
    metadata[ORCHESTRATION_METADATA_KEY] = _orchestration_metadata(
        result,
        operation_id=operation_id,
        action=action,
    )
    failed = result.status is ProviderStatus.FAILED
    return StepManifest(
        step_name=manifest.step_name,
        input_digest=manifest.input_digest,
        relevant_config_digest=manifest.relevant_config_digest,
        status=ManifestStatus.FAILED if failed else manifest.status,
        created_at=manifest.created_at,
        schema_version=manifest.schema_version,
        output_paths=manifest.output_paths,
        output_metadata=metadata,
        completed_at=result.completed_at if failed else manifest.completed_at,
        error_summary=result.error_summary if failed else (manifest.error_summary),
    )


def _orchestration_metadata(
    result: ProviderResult,
    *,
    operation_id: str,
    action: OrchestrationAction,
) -> dict[str, object]:
    """Return the deterministic orchestration metadata section.

    The section never contains the plan_id or the instruction after
    fingerprint: both depend on this manifest payload through the
    acyclic computation order.
    """
    metadata: dict[str, object] = {
        "schema_version": ORCHESTRATION_METADATA_SCHEMA_VERSION,
        "operation_id": operation_id,
        "action": action.value,
        "provider_id": result.provider_id,
        "provider_status": result.status.value,
        "observed_at": _iso(result.observed_at),
    }
    if result.external_task_ref is not None:
        metadata["external_task_ref"] = result.external_task_ref
    if result.artifact is not None:
        metadata["artifact"] = result.artifact.to_json_dict()
    if result.status is ProviderStatus.SUCCEEDED and (result.artifact is not None):
        metadata["handoff"] = result.artifact.to_json_dict()
    if result.status is ProviderStatus.CANCELLED:
        metadata["cancelled"] = True
    if result.status is ProviderStatus.FAILED and (result.error_summary is not None):
        metadata["error_summary"] = result.error_summary
    return metadata


def _stable_provider_status(stable: _StableStateSnapshot) -> ProviderStatus:
    return ProviderStatus(stable.last_result_snapshot["payload"]["status"])


def _action_input_wrapper(
    *,
    observed_at: datetime,
    artifact: ArtifactReference | None,
    completed_at: datetime | None,
    result_fingerprint: str | None,
) -> object:
    return _make_snapshot_wrapper(
        "action_input",
        {
            "observed_at": _iso(observed_at),
            "artifact": (None if artifact is None else _thawed_artifact(artifact)),
            "completed_at": _optional_iso(completed_at),
            "result_fingerprint": result_fingerprint,
        },
    )


def _artifact_wrapper(artifact: ArtifactReference) -> object:
    return _make_snapshot_wrapper("artifact_reference", artifact.to_json_dict())


def _thawed_artifact(artifact: ArtifactReference) -> dict[str, object]:
    return {
        "snapshot_kind": "artifact_reference",
        "snapshot_version": 1,
        "payload": artifact.to_json_dict(),
    }


def _validate_file_fingerprint(
    value: object,
    *,
    field_name: str,
    allow_absent: bool,
) -> None:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if allow_absent and value == ABSENT:
        return
    if len(value) != 64 or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise InvariantViolationError(
            f"{field_name}: expected a lowercase 64-character hex digest"
        )


def _parse_iso(value: object) -> datetime:
    if type(value) is not str:
        raise InvariantViolationError(
            "observed_at: stable observation time must be a string"
        )
    return datetime.fromisoformat(value)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="microseconds")


def _optional_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _iso(value)
