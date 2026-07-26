"""Strict recovery parsing and model restore adapters.

This module turns persisted orchestration record data (already loaded
as plain JSON-compatible mappings) back into validated internal
models. It enforces the strict recovery schema: exact keys, exact
discriminators and versions, strict types, the phase × envelope
invariants, the stable self-fingerprint-first read protocol, and full
rebuild-and-refingerprint verification for every nested snapshot. It
performs no I/O, no Provider calls, and no recovery decisions.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import TypeVar

from ai_video_workflow.errors import (
    AiVideoWorkflowError,
    FieldTypeError,
    InvariantViolationError,
)
from ai_video_workflow.manifest import StepManifest
from ai_video_workflow.models import GenerationTask
from ai_video_workflow.orchestration._models import (
    RECORD_SCHEMA_KIND,
    RECORD_SCHEMA_VERSION,
    _build_envelope,
    _PendingApply,
    _PendingProviderCall,
    _StableStateSnapshot,
    _validate_envelope_parts,
)
from ai_video_workflow.orchestration.canonical import (
    _fingerprint,
    _make_snapshot_wrapper,
    _stable_self_fingerprint,
    _thaw_mapping,
    _validate_snapshot_wrapper,
)
from ai_video_workflow.orchestration.errors import (
    CorruptStableRecordError,
    InvalidRecoveryRecordError,
)
from ai_video_workflow.orchestration.models import (
    OrchestrationAction,
    RecordPhase,
    RecoveryDisposition,
)
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    ProviderCostObservation,
    ProviderInstruction,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)
from ai_video_workflow.serialization import model_from_dict, model_to_dict

_ENVELOPE_KEYS = frozenset({"record_schema", "phase", "stable", "pending"})
_RECORD_SCHEMA_KEYS = frozenset({"kind", "version"})

_STABLE_PAYLOAD_KEYS = frozenset(
    {
        "task_id",
        "shot_id",
        "provider_id",
        "stable_schema_version",
        "version",
        "last_committed_plan_id",
        "last_committed_operation",
        "committed_task_fingerprint",
        "committed_manifest_fingerprint",
        "committed_instruction_fingerprint",
        "committed_request_fingerprint",
        "committed_result_fingerprint",
        "request_snapshot",
        "request_fingerprint",
        "instruction_snapshot",
        "instruction_fingerprint",
        "authoritative_external_task_ref",
        "authoritative_artifact",
        "authoritative_error_summary",
        "authoritative_completed_at",
        "last_result_snapshot",
        "last_result_fingerprint",
        "last_completed_action",
        "legal_actions",
        "preferred_next_action",
        "updated_at",
        "stable_record_fingerprint",
    }
)

_PENDING_CALL_KEYS = frozenset(
    {
        "pending_call_schema_version",
        "variant",
        "operation_id",
        "action",
        "baseline_version",
        "request_snapshot",
        "request_fingerprint",
        "action_input_snapshot",
        "action_input_fingerprint",
        "original_observed_at",
        "original_completed_at",
        "artifact_input",
        "call_phase",
        "call_may_have_started",
        "started_at",
        "recovery_policy",
    }
)

_PENDING_APPLY_KEYS = frozenset(
    {
        "pending_apply_schema_version",
        "variant",
        "operation_id",
        "action",
        "baseline_version",
        "request_snapshot",
        "request_fingerprint",
        "action_input_snapshot",
        "action_input_fingerprint",
        "result_snapshot",
        "result_fingerprint",
        "plan_id",
        "before_fingerprints",
        "task_after_snapshot",
        "task_after_fingerprint",
        "manifest_after_snapshot",
        "manifest_after_fingerprint",
        "instruction_after_text",
        "instruction_after_fingerprint",
        "planned_stable_state_snapshot",
        "planned_stable_state_wrapper_fingerprint",
        "confirmed_writes",
        "recovery_disposition",
        "original_observed_at",
        "post_commit_legal_actions",
        "post_commit_preferred_next_action",
    }
)

_PROVIDER_REQUEST_KEYS = frozenset(
    {
        "provider_id",
        "task_id",
        "shot_id",
        "prompt",
        "duration_seconds",
        "width",
        "height",
        "frame_rate",
        "staging_ref",
        "provider_parameters",
    }
)

_PROVIDER_RESULT_KEYS = frozenset(
    {
        "provider_id",
        "task_id",
        "shot_id",
        "status",
        "observed_at",
        "external_task_ref",
        "artifact",
        "instruction",
        "message",
        "error_summary",
        "completed_at",
        "elapsed_seconds",
        "cost_observation",
    }
)

_PROVIDER_INSTRUCTION_KEYS = frozenset(
    {
        "provider_id",
        "task_id",
        "shot_id",
        "prompt",
        "expected_duration_seconds",
        "expected_width",
        "expected_height",
        "expected_frame_rate",
        "staging_ref",
        "steps",
        "suggested_parameters",
    }
)

_ARTIFACT_REFERENCE_KEYS = frozenset({"reference", "origin", "location"})

_COST_OBSERVATION_KEYS = frozenset({"amount", "unit"})

_UTC_ISO_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$")

_EnumT = TypeVar("_EnumT", bound=Enum)


@dataclass(frozen=True, slots=True)
class _ParsedRecord:
    """Validated in-memory view of one orchestration record envelope."""

    phase: RecordPhase
    stable: _StableStateSnapshot | None
    pending: _PendingProviderCall | _PendingApply | None

    __hash__ = None

    def to_envelope(self) -> dict[str, object]:
        """Return the plain envelope dict for this parsed record."""
        return _build_envelope(self.phase, self.stable, self.pending)


def _parse_record_envelope(data: object) -> _ParsedRecord:
    """Parse and strictly validate one orchestration record envelope."""
    try:
        return _parse_record_envelope_strict(data)
    except InvalidRecoveryRecordError:
        raise
    except (AiVideoWorkflowError, TypeError, ValueError, KeyError) as exc:
        raise InvalidRecoveryRecordError(f"orchestration record: {exc}") from exc


def _parse_record_envelope_strict(data: object) -> _ParsedRecord:
    _require_exact_keys(data, required=_ENVELOPE_KEYS, name="envelope")
    record_schema = data["record_schema"]
    _require_exact_keys(
        record_schema,
        required=_RECORD_SCHEMA_KEYS,
        name="envelope.record_schema",
    )
    kind = record_schema["kind"]
    if type(kind) is not str:
        raise FieldTypeError(
            f"envelope.record_schema.kind: expected string, got {type(kind).__name__}"
        )
    if kind != RECORD_SCHEMA_KIND:
        raise InvariantViolationError(
            f"envelope.record_schema.kind: unknown record kind {kind!r}"
        )
    version = record_schema["version"]
    if type(version) is not int:
        raise FieldTypeError(
            "envelope.record_schema.version: expected a strict int, "
            f"got {type(version).__name__}"
        )
    if version != RECORD_SCHEMA_VERSION:
        raise InvariantViolationError(
            f"envelope.record_schema.version: unsupported record version {version}"
        )
    phase = _parse_enum(data["phase"], RecordPhase, name="envelope.phase")
    stable_value = data["stable"]
    stable = None
    if stable_value is not None:
        stable = _parse_stable_wrapper(stable_value)
    pending_value = data["pending"]
    pending: _PendingProviderCall | _PendingApply | None = None
    if pending_value is not None:
        pending = _parse_pending(pending_value)
    _validate_envelope_parts(phase, stable, pending)
    return _ParsedRecord(phase=phase, stable=stable, pending=pending)


def _parse_stable_wrapper(value: object) -> _StableStateSnapshot:
    """Parse one stable state wrapper with self-fingerprint-first order."""
    wrapper = _validate_snapshot_wrapper(
        value,
        expected_kind="orchestration_stable_state",
        field_name="envelope.stable",
    )
    payload = _thaw_mapping(wrapper["payload"])
    _verify_stable_self_fingerprint(
        payload,
        name="envelope.stable",
        error_type=CorruptStableRecordError,
    )
    return _parse_stable_payload(payload, name="envelope.stable")


def _verify_stable_self_fingerprint(
    payload: Mapping[str, object],
    *,
    name: str,
    error_type: type[InvalidRecoveryRecordError],
) -> None:
    if "stable_record_fingerprint" not in payload:
        raise InvariantViolationError(
            f"{name}: missing required key 'stable_record_fingerprint'"
        )
    persisted = payload["stable_record_fingerprint"]
    if type(persisted) is not str:
        raise FieldTypeError(
            f"{name}.stable_record_fingerprint: expected string, "
            f"got {type(persisted).__name__}"
        )
    recomputed = _stable_self_fingerprint(payload)
    if persisted != recomputed:
        raise error_type(f"{name}: stable record self fingerprint does not verify")


def _parse_stable_payload(
    payload: Mapping[str, object],
    *,
    name: str,
) -> _StableStateSnapshot:
    _require_exact_keys(payload, required=_STABLE_PAYLOAD_KEYS, name=name)
    instruction_snapshot = payload["instruction_snapshot"]
    authoritative_artifact = payload["authoritative_artifact"]
    stable = _StableStateSnapshot(
        task_id=payload["task_id"],
        shot_id=payload["shot_id"],
        provider_id=payload["provider_id"],
        stable_schema_version=payload["stable_schema_version"],
        version=payload["version"],
        last_committed_plan_id=payload["last_committed_plan_id"],
        last_committed_operation=_require_mapping(
            payload["last_committed_operation"],
            name=f"{name}.last_committed_operation",
        ),
        committed_task_fingerprint=payload["committed_task_fingerprint"],
        committed_manifest_fingerprint=payload["committed_manifest_fingerprint"],
        committed_instruction_fingerprint=payload["committed_instruction_fingerprint"],
        committed_request_fingerprint=payload["committed_request_fingerprint"],
        committed_result_fingerprint=payload["committed_result_fingerprint"],
        request_snapshot=_require_mapping(
            payload["request_snapshot"],
            name=f"{name}.request_snapshot",
        ),
        request_fingerprint=payload["request_fingerprint"],
        instruction_snapshot=(
            None
            if instruction_snapshot is None
            else _require_mapping(
                instruction_snapshot,
                name=f"{name}.instruction_snapshot",
            )
        ),
        instruction_fingerprint=payload["instruction_fingerprint"],
        authoritative_external_task_ref=_parse_optional_str(
            payload["authoritative_external_task_ref"],
            name=f"{name}.authoritative_external_task_ref",
        ),
        authoritative_artifact=(
            None
            if authoritative_artifact is None
            else _require_mapping(
                authoritative_artifact,
                name=f"{name}.authoritative_artifact",
            )
        ),
        authoritative_error_summary=_parse_optional_str(
            payload["authoritative_error_summary"],
            name=f"{name}.authoritative_error_summary",
        ),
        authoritative_completed_at=_parse_optional_utc_datetime(
            payload["authoritative_completed_at"],
            name=f"{name}.authoritative_completed_at",
        ),
        last_result_snapshot=_require_mapping(
            payload["last_result_snapshot"],
            name=f"{name}.last_result_snapshot",
        ),
        last_result_fingerprint=payload["last_result_fingerprint"],
        last_completed_action=_parse_enum(
            payload["last_completed_action"],
            OrchestrationAction,
            name=f"{name}.last_completed_action",
        ),
        legal_actions=_parse_action_tuple(
            payload["legal_actions"],
            name=f"{name}.legal_actions",
        ),
        preferred_next_action=_parse_optional_enum(
            payload["preferred_next_action"],
            OrchestrationAction,
            name=f"{name}.preferred_next_action",
        ),
        updated_at=_parse_utc_datetime(
            payload["updated_at"],
            name=f"{name}.updated_at",
        ),
    )
    if stable.stable_record_fingerprint != payload["stable_record_fingerprint"]:
        raise InvariantViolationError(
            f"{name}: reconstructed self fingerprint does not match the persisted value"
        )
    _restore_provider_request(stable.request_snapshot)
    if stable.instruction_snapshot is not None:
        _restore_provider_instruction(stable.instruction_snapshot)
    if stable.authoritative_artifact is not None:
        _restore_artifact_reference(stable.authoritative_artifact)
    _restore_provider_result(stable.last_result_snapshot)
    return stable


def _parse_pending(
    value: object,
) -> _PendingProviderCall | _PendingApply:
    payload = _require_mapping(value, name="envelope.pending")
    if "variant" not in payload:
        raise InvariantViolationError(
            "envelope.pending: missing required key 'variant'"
        )
    variant = payload["variant"]
    if type(variant) is not str:
        raise FieldTypeError(
            f"envelope.pending.variant: expected string, got {type(variant).__name__}"
        )
    if variant == "provider_call":
        return _parse_pending_provider_call(payload)
    if variant == "apply":
        return _parse_pending_apply(payload)
    raise InvariantViolationError(
        f"envelope.pending.variant: unknown pending variant {variant!r}"
    )


def _parse_pending_provider_call(
    payload: Mapping[str, object],
) -> _PendingProviderCall:
    name = "envelope.pending"
    _require_exact_keys(payload, required=_PENDING_CALL_KEYS, name=name)
    pending = _PendingProviderCall(
        operation_id=payload["operation_id"],
        action=_parse_enum(
            payload["action"],
            OrchestrationAction,
            name=f"{name}.action",
        ),
        baseline_version=payload["baseline_version"],
        request_snapshot=_require_mapping(
            payload["request_snapshot"],
            name=f"{name}.request_snapshot",
        ),
        request_fingerprint=payload["request_fingerprint"],
        action_input_snapshot=_require_mapping(
            payload["action_input_snapshot"],
            name=f"{name}.action_input_snapshot",
        ),
        action_input_fingerprint=payload["action_input_fingerprint"],
        original_observed_at=_parse_utc_datetime(
            payload["original_observed_at"],
            name=f"{name}.original_observed_at",
        ),
        original_completed_at=_parse_optional_utc_datetime(
            payload["original_completed_at"],
            name=f"{name}.original_completed_at",
        ),
        artifact_input=(
            None
            if payload["artifact_input"] is None
            else _require_mapping(
                payload["artifact_input"],
                name=f"{name}.artifact_input",
            )
        ),
        call_phase=_parse_enum(
            payload["call_phase"],
            RecordPhase,
            name=f"{name}.call_phase",
        ),
        call_may_have_started=_parse_strict_bool(
            payload["call_may_have_started"],
            name=f"{name}.call_may_have_started",
        ),
        started_at=_parse_utc_datetime(
            payload["started_at"],
            name=f"{name}.started_at",
        ),
        recovery_policy=_parse_enum(
            payload["recovery_policy"],
            RecoveryDisposition,
            name=f"{name}.recovery_policy",
        ),
        pending_call_schema_version=payload["pending_call_schema_version"],
        variant=payload["variant"],
    )
    _restore_provider_request(pending.request_snapshot)
    if pending.artifact_input is not None:
        _restore_artifact_reference(pending.artifact_input)
    return pending


def _parse_pending_apply(payload: Mapping[str, object]) -> _PendingApply:
    name = "envelope.pending"
    _require_exact_keys(payload, required=_PENDING_APPLY_KEYS, name=name)
    instruction_after_text = payload["instruction_after_text"]
    if instruction_after_text is not None and (type(instruction_after_text) is not str):
        raise FieldTypeError(
            f"{name}.instruction_after_text: expected string or null, "
            f"got {type(instruction_after_text).__name__}"
        )
    planned = _require_mapping(
        payload["planned_stable_state_snapshot"],
        name=f"{name}.planned_stable_state_snapshot",
    )
    pending = _PendingApply(
        operation_id=payload["operation_id"],
        action=_parse_enum(
            payload["action"],
            OrchestrationAction,
            name=f"{name}.action",
        ),
        baseline_version=payload["baseline_version"],
        request_snapshot=_require_mapping(
            payload["request_snapshot"],
            name=f"{name}.request_snapshot",
        ),
        request_fingerprint=payload["request_fingerprint"],
        action_input_snapshot=_require_mapping(
            payload["action_input_snapshot"],
            name=f"{name}.action_input_snapshot",
        ),
        action_input_fingerprint=payload["action_input_fingerprint"],
        result_snapshot=_require_mapping(
            payload["result_snapshot"],
            name=f"{name}.result_snapshot",
        ),
        result_fingerprint=payload["result_fingerprint"],
        plan_id=payload["plan_id"],
        before_fingerprints=_require_mapping(
            payload["before_fingerprints"],
            name=f"{name}.before_fingerprints",
        ),
        task_after_snapshot=_require_mapping(
            payload["task_after_snapshot"],
            name=f"{name}.task_after_snapshot",
        ),
        task_after_fingerprint=payload["task_after_fingerprint"],
        manifest_after_snapshot=_require_mapping(
            payload["manifest_after_snapshot"],
            name=f"{name}.manifest_after_snapshot",
        ),
        manifest_after_fingerprint=payload["manifest_after_fingerprint"],
        instruction_after_text=instruction_after_text,
        instruction_after_fingerprint=payload["instruction_after_fingerprint"],
        planned_stable_state_snapshot=planned,
        planned_stable_state_wrapper_fingerprint=payload[
            "planned_stable_state_wrapper_fingerprint"
        ],
        confirmed_writes=_parse_str_tuple(
            payload["confirmed_writes"],
            name=f"{name}.confirmed_writes",
        ),
        recovery_disposition=_parse_enum(
            payload["recovery_disposition"],
            RecoveryDisposition,
            name=f"{name}.recovery_disposition",
        ),
        original_observed_at=_parse_utc_datetime(
            payload["original_observed_at"],
            name=f"{name}.original_observed_at",
        ),
        post_commit_legal_actions=_parse_action_tuple(
            payload["post_commit_legal_actions"],
            name=f"{name}.post_commit_legal_actions",
        ),
        post_commit_preferred_next_action=_parse_optional_enum(
            payload["post_commit_preferred_next_action"],
            OrchestrationAction,
            name=f"{name}.post_commit_preferred_next_action",
        ),
        pending_apply_schema_version=payload["pending_apply_schema_version"],
        variant=payload["variant"],
    )
    _restore_provider_request(pending.request_snapshot)
    _restore_provider_result(pending.result_snapshot)
    _restore_generation_task(pending.task_after_snapshot)
    _restore_step_manifest(pending.manifest_after_snapshot)
    planned_payload = _thaw_mapping(pending.planned_stable_state_snapshot["payload"])
    _parse_stable_payload(
        planned_payload,
        name=f"{name}.planned_stable_state_snapshot",
    )
    return pending


def _snapshot_generation_task(task: GenerationTask) -> Mapping[str, object]:
    """Return the frozen generation_task snapshot wrapper for one task."""
    if type(task) is not GenerationTask:
        raise FieldTypeError(
            f"task: expected GenerationTask, got {type(task).__name__}"
        )
    payload = model_to_dict(task)
    if not isinstance(payload, Mapping):
        raise FieldTypeError(
            f"task: model_to_dict must return a mapping, got {type(payload).__name__}"
        )
    return _make_snapshot_wrapper("generation_task", payload)


def _restore_generation_task(snapshot: object) -> GenerationTask:
    """Rebuild one GenerationTask from its snapshot wrapper and verify."""
    wrapper = _validate_snapshot_wrapper(
        snapshot,
        expected_kind="generation_task",
        field_name="generation_task snapshot",
    )
    payload = _thaw_mapping(wrapper["payload"])
    task = _wrap_restore_errors(
        lambda: model_from_dict(payload, GenerationTask),
        name="generation_task snapshot",
    )
    if type(task) is not GenerationTask:
        raise InvalidRecoveryRecordError(
            "generation_task snapshot: restored value is not a GenerationTask"
        )
    _require_restored_fingerprint(
        wrapper,
        _snapshot_generation_task(task),
        name="generation_task snapshot",
    )
    return task


def _snapshot_step_manifest(manifest: StepManifest) -> Mapping[str, object]:
    """Return the frozen step_manifest snapshot wrapper for one manifest."""
    if type(manifest) is not StepManifest:
        raise FieldTypeError(
            f"manifest: expected StepManifest, got {type(manifest).__name__}"
        )
    payload = model_to_dict(manifest)
    if not isinstance(payload, Mapping):
        raise FieldTypeError(
            "manifest: model_to_dict must return a mapping, "
            f"got {type(payload).__name__}"
        )
    return _make_snapshot_wrapper("step_manifest", payload)


def _restore_step_manifest(snapshot: object) -> StepManifest:
    """Rebuild one StepManifest from its snapshot wrapper and verify."""
    wrapper = _validate_snapshot_wrapper(
        snapshot,
        expected_kind="step_manifest",
        field_name="step_manifest snapshot",
    )
    payload = _thaw_mapping(wrapper["payload"])
    manifest = _wrap_restore_errors(
        lambda: model_from_dict(payload, StepManifest),
        name="step_manifest snapshot",
    )
    if type(manifest) is not StepManifest:
        raise InvalidRecoveryRecordError(
            "step_manifest snapshot: restored value is not a StepManifest"
        )
    _require_restored_fingerprint(
        wrapper,
        _snapshot_step_manifest(manifest),
        name="step_manifest snapshot",
    )
    return manifest


def _snapshot_provider_request(
    request: ProviderRequest,
) -> Mapping[str, object]:
    """Return the frozen provider_request snapshot wrapper."""
    if type(request) is not ProviderRequest:
        raise FieldTypeError(
            f"request: expected ProviderRequest, got {type(request).__name__}"
        )
    return _make_snapshot_wrapper("provider_request", request.to_json_dict())


def _restore_provider_request(snapshot: object) -> ProviderRequest:
    """Rebuild one ProviderRequest via its public constructor and verify."""
    wrapper = _validate_snapshot_wrapper(
        snapshot,
        expected_kind="provider_request",
        field_name="provider_request snapshot",
    )
    name = "provider_request snapshot"
    payload = _thaw_mapping(wrapper["payload"])
    _require_exact_keys(payload, required=_PROVIDER_REQUEST_KEYS, name=name)
    parameters = _require_plain_dict(
        payload["provider_parameters"],
        name=f"{name}.provider_parameters",
    )
    request = _wrap_restore_errors(
        lambda: ProviderRequest(
            provider_id=payload["provider_id"],
            task_id=payload["task_id"],
            shot_id=payload["shot_id"],
            prompt=payload["prompt"],
            duration_seconds=payload["duration_seconds"],
            width=payload["width"],
            height=payload["height"],
            frame_rate=payload["frame_rate"],
            staging_ref=payload["staging_ref"],
            provider_parameters=parameters,
        ),
        name=name,
    )
    _require_restored_fingerprint(
        wrapper,
        _snapshot_provider_request(request),
        name=name,
    )
    return request


def _snapshot_provider_result(result: ProviderResult) -> Mapping[str, object]:
    """Return the frozen provider_result snapshot wrapper."""
    if type(result) is not ProviderResult:
        raise FieldTypeError(
            f"result: expected ProviderResult, got {type(result).__name__}"
        )
    return _make_snapshot_wrapper("provider_result", result.to_json_dict())


def _restore_provider_result(snapshot: object) -> ProviderResult:
    """Rebuild one ProviderResult via its public constructor and verify."""
    wrapper = _validate_snapshot_wrapper(
        snapshot,
        expected_kind="provider_result",
        field_name="provider_result snapshot",
    )
    name = "provider_result snapshot"
    payload = _thaw_mapping(wrapper["payload"])
    _require_exact_keys(payload, required=_PROVIDER_RESULT_KEYS, name=name)
    artifact = payload["artifact"]
    instruction = payload["instruction"]
    cost_observation = payload["cost_observation"]
    result = _wrap_restore_errors(
        lambda: ProviderResult(
            provider_id=payload["provider_id"],
            task_id=payload["task_id"],
            shot_id=payload["shot_id"],
            status=_parse_enum(
                payload["status"],
                ProviderStatus,
                name=f"{name}.status",
            ),
            observed_at=_parse_utc_datetime(
                payload["observed_at"],
                name=f"{name}.observed_at",
            ),
            external_task_ref=payload["external_task_ref"],
            artifact=(
                None
                if artifact is None
                else _artifact_from_plain_dict(
                    artifact,
                    name=f"{name}.artifact",
                )
            ),
            instruction=(
                None
                if instruction is None
                else _instruction_from_plain_dict(
                    instruction,
                    name=f"{name}.instruction",
                )
            ),
            message=payload["message"],
            error_summary=payload["error_summary"],
            completed_at=_parse_optional_utc_datetime(
                payload["completed_at"],
                name=f"{name}.completed_at",
            ),
            elapsed_seconds=payload["elapsed_seconds"],
            cost_observation=(
                None
                if cost_observation is None
                else _cost_observation_from_plain_dict(
                    cost_observation,
                    name=f"{name}.cost_observation",
                )
            ),
        ),
        name=name,
    )
    _require_restored_fingerprint(
        wrapper,
        _snapshot_provider_result(result),
        name=name,
    )
    return result


def _snapshot_provider_instruction(
    instruction: ProviderInstruction,
) -> Mapping[str, object]:
    """Return the frozen provider_instruction snapshot wrapper."""
    if type(instruction) is not ProviderInstruction:
        raise FieldTypeError(
            "instruction: expected ProviderInstruction, "
            f"got {type(instruction).__name__}"
        )
    return _make_snapshot_wrapper(
        "provider_instruction",
        instruction.to_json_dict(),
    )


def _restore_provider_instruction(snapshot: object) -> ProviderInstruction:
    """Rebuild one ProviderInstruction via its constructor and verify."""
    wrapper = _validate_snapshot_wrapper(
        snapshot,
        expected_kind="provider_instruction",
        field_name="provider_instruction snapshot",
    )
    name = "provider_instruction snapshot"
    payload = _thaw_mapping(wrapper["payload"])
    instruction = _wrap_restore_errors(
        lambda: _instruction_from_plain_dict(payload, name=name),
        name=name,
    )
    _require_restored_fingerprint(
        wrapper,
        _snapshot_provider_instruction(instruction),
        name=name,
    )
    return instruction


def _snapshot_artifact_reference(
    artifact: ArtifactReference,
) -> Mapping[str, object]:
    """Return the frozen artifact_reference snapshot wrapper."""
    if type(artifact) is not ArtifactReference:
        raise FieldTypeError(
            f"artifact: expected ArtifactReference, got {type(artifact).__name__}"
        )
    return _make_snapshot_wrapper(
        "artifact_reference",
        artifact.to_json_dict(),
    )


def _restore_artifact_reference(snapshot: object) -> ArtifactReference:
    """Rebuild one ArtifactReference via its constructor and verify."""
    wrapper = _validate_snapshot_wrapper(
        snapshot,
        expected_kind="artifact_reference",
        field_name="artifact_reference snapshot",
    )
    name = "artifact_reference snapshot"
    payload = _thaw_mapping(wrapper["payload"])
    artifact = _wrap_restore_errors(
        lambda: _artifact_from_plain_dict(payload, name=name),
        name=name,
    )
    _require_restored_fingerprint(
        wrapper,
        _snapshot_artifact_reference(artifact),
        name=name,
    )
    return artifact


def _artifact_from_plain_dict(
    value: object,
    *,
    name: str,
) -> ArtifactReference:
    payload = _require_mapping(value, name=name)
    _require_exact_keys(payload, required=_ARTIFACT_REFERENCE_KEYS, name=name)
    return ArtifactReference(
        reference=payload["reference"],
        origin=_parse_enum(
            payload["origin"],
            ArtifactOrigin,
            name=f"{name}.origin",
        ),
        location=_parse_enum(
            payload["location"],
            ArtifactLocation,
            name=f"{name}.location",
        ),
    )


def _instruction_from_plain_dict(
    value: object,
    *,
    name: str,
) -> ProviderInstruction:
    payload = _require_mapping(value, name=name)
    _require_exact_keys(
        payload,
        required=_PROVIDER_INSTRUCTION_KEYS,
        name=name,
    )
    steps = payload["steps"]
    if type(steps) is not list:
        raise FieldTypeError(
            f"{name}.steps: expected JSON array, got {type(steps).__name__}"
        )
    parameters = _require_plain_dict(
        payload["suggested_parameters"],
        name=f"{name}.suggested_parameters",
    )
    return ProviderInstruction(
        provider_id=payload["provider_id"],
        task_id=payload["task_id"],
        shot_id=payload["shot_id"],
        prompt=payload["prompt"],
        expected_duration_seconds=payload["expected_duration_seconds"],
        expected_width=payload["expected_width"],
        expected_height=payload["expected_height"],
        expected_frame_rate=payload["expected_frame_rate"],
        staging_ref=payload["staging_ref"],
        steps=tuple(steps),
        suggested_parameters=parameters,
    )


def _cost_observation_from_plain_dict(
    value: object,
    *,
    name: str,
) -> ProviderCostObservation:
    payload = _require_mapping(value, name=name)
    _require_exact_keys(payload, required=_COST_OBSERVATION_KEYS, name=name)
    return ProviderCostObservation(
        amount=payload["amount"],
        unit=payload["unit"],
    )


def _require_restored_fingerprint(
    original_wrapper: Mapping[str, object],
    restored_wrapper: Mapping[str, object],
    *,
    name: str,
) -> None:
    if _fingerprint(original_wrapper) != _fingerprint(restored_wrapper):
        raise InvalidRecoveryRecordError(
            f"{name}: restored snapshot fingerprint does not match the "
            "persisted snapshot"
        )


def _wrap_restore_errors(constructor, *, name: str):
    try:
        return constructor()
    except InvalidRecoveryRecordError:
        raise
    except (AiVideoWorkflowError, TypeError, ValueError, KeyError) as exc:
        raise InvalidRecoveryRecordError(f"{name}: {exc}") from exc


def _require_exact_keys(
    value: object,
    *,
    required: frozenset[str],
    name: str,
) -> Mapping[str, object]:
    mapping = _require_mapping(value, name=name)
    keys = set()
    for key in mapping:
        if type(key) is not str:
            raise FieldTypeError(
                f"{name}: mapping keys must be strings, got {type(key).__name__}"
            )
        keys.add(key)
    missing = sorted(required - keys)
    if missing:
        raise InvariantViolationError(f"{name}: missing required key {missing[0]!r}")
    unknown = sorted(keys - required)
    if unknown:
        raise InvariantViolationError(f"{name}: unknown key {unknown[0]!r}")
    return mapping


def _require_mapping(value: object, *, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise FieldTypeError(f"{name}: expected mapping, got {type(value).__name__}")
    return value


def _require_plain_dict(value: object, *, name: str) -> dict[str, object]:
    if type(value) is not dict:
        raise FieldTypeError(f"{name}: expected plain dict, got {type(value).__name__}")
    return value


def _parse_enum(value: object, enum_type: type[_EnumT], *, name: str) -> _EnumT:
    if type(value) is not str:
        raise FieldTypeError(
            f"{name}: expected enum value string, got {type(value).__name__}"
        )
    try:
        return enum_type(value)
    except ValueError as exc:
        raise InvariantViolationError(
            f"{name}: invalid {enum_type.__name__} value {value!r}"
        ) from exc


def _parse_optional_enum(
    value: object,
    enum_type: type[_EnumT],
    *,
    name: str,
) -> _EnumT | None:
    if value is None:
        return None
    return _parse_enum(value, enum_type, name=name)


def _parse_action_tuple(
    value: object,
    *,
    name: str,
) -> tuple[OrchestrationAction, ...]:
    if type(value) is not list:
        raise FieldTypeError(f"{name}: expected JSON array, got {type(value).__name__}")
    return tuple(
        _parse_enum(item, OrchestrationAction, name=f"{name}[{index}]")
        for index, item in enumerate(value)
    )


def _parse_str_tuple(value: object, *, name: str) -> tuple[str, ...]:
    if type(value) is not list:
        raise FieldTypeError(f"{name}: expected JSON array, got {type(value).__name__}")
    items: list[str] = []
    for index, item in enumerate(value):
        if type(item) is not str:
            raise FieldTypeError(
                f"{name}[{index}]: expected string, got {type(item).__name__}"
            )
        items.append(item)
    return tuple(items)


def _parse_strict_bool(value: object, *, name: str) -> bool:
    if type(value) is not bool:
        raise FieldTypeError(f"{name}: expected bool, got {type(value).__name__}")
    return value


def _parse_optional_str(value: object, *, name: str) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise FieldTypeError(
            f"{name}: expected string or null, got {type(value).__name__}"
        )
    return value


def _parse_utc_datetime(value: object, *, name: str) -> datetime:
    if type(value) is not str:
        raise FieldTypeError(
            f"{name}: expected UTC datetime string, got {type(value).__name__}"
        )
    if _UTC_ISO_PATTERN.fullmatch(value) is None:
        raise InvariantViolationError(
            f"{name}: expected YYYY-MM-DDTHH:MM:SS.ffffff+00:00"
        )
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise InvariantViolationError(f"{name}: invalid UTC datetime") from exc
    if parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 0:
        raise InvariantViolationError(f"{name}: datetime must have a zero UTC offset")
    return parsed


def _parse_optional_utc_datetime(
    value: object,
    *,
    name: str,
) -> datetime | None:
    if value is None:
        return None
    return _parse_utc_datetime(value, name=name)
