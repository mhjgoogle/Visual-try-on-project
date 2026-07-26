import copy
from datetime import datetime, timezone

import pytest

import ai_video_workflow.orchestration as orchestration_package
import ai_video_workflow.orchestration._models as internal_models
from ai_video_workflow.errors import (
    AiVideoWorkflowError,
    FieldTypeError,
    InvariantViolationError,
)
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus
from ai_video_workflow.orchestration import (
    BaselineMismatchError,
    CanonicalizationError,
    ConflictingProviderResultError,
    ConflictingRequestError,
    CorruptStableRecordError,
    IdempotencyConflictError,
    IllegalProviderTransitionError,
    InvalidOrchestrationInputError,
    InvalidOrchestrationStateError,
    InvalidRecoveryRecordError,
    MissingProjectStateError,
    MissingRecoveryRecordError,
    OrchestrationAction,
    OrchestrationError,
    OutcomeKind,
    PartialCommitConflictError,
    PersistenceExecutionError,
    PersistencePlanningError,
    RecordPhase,
    RecoveryDisposition,
    StaleResultError,
    UnknownProviderSideEffectError,
)
from ai_video_workflow.orchestration._models import (
    ABSENT,
    RECORD_SCHEMA_KIND,
    RECORD_SCHEMA_VERSION,
    _build_envelope,
    _PendingApply,
    _PendingProviderCall,
    _StableStateSnapshot,
)
from ai_video_workflow.orchestration.canonical import (
    _fingerprint,
    _make_snapshot_wrapper,
    _sha256_hex,
    _stable_self_fingerprint,
)
from ai_video_workflow.orchestration.recovery import (
    _parse_record_envelope,
    _restore_artifact_reference,
    _restore_generation_task,
    _restore_provider_instruction,
    _restore_provider_request,
    _restore_provider_result,
    _restore_step_manifest,
    _snapshot_artifact_reference,
    _snapshot_generation_task,
    _snapshot_provider_instruction,
    _snapshot_provider_request,
    _snapshot_provider_result,
    _snapshot_step_manifest,
)
from ai_video_workflow.providers import ProviderError, ProviderStatus
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    ProviderInstruction,
    ProviderRequest,
    ProviderResult,
)

DIRECT_ORCHESTRATION_ERRORS = (
    InvalidOrchestrationInputError,
    InvalidOrchestrationStateError,
    IllegalProviderTransitionError,
    StaleResultError,
    ConflictingProviderResultError,
    ConflictingRequestError,
    IdempotencyConflictError,
    BaselineMismatchError,
    PartialCommitConflictError,
    UnknownProviderSideEffectError,
    MissingRecoveryRecordError,
    MissingProjectStateError,
    InvalidRecoveryRecordError,
    CanonicalizationError,
    PersistencePlanningError,
    PersistenceExecutionError,
)

ALL_ORCHESTRATION_ERRORS = (
    OrchestrationError,
    *DIRECT_ORCHESTRATION_ERRORS,
    CorruptStableRecordError,
)

EXPECTED_EXPORTS = {
    "BaselineMismatchError",
    "CanonicalizationError",
    "ConflictingProviderResultError",
    "ConflictingRequestError",
    "CorruptStableRecordError",
    "IdempotencyConflictError",
    "IllegalProviderTransitionError",
    "InvalidOrchestrationInputError",
    "InvalidOrchestrationStateError",
    "InvalidRecoveryRecordError",
    "MissingProjectStateError",
    "MissingRecoveryRecordError",
    "OrchestrationAction",
    "OrchestrationError",
    "OutcomeKind",
    "PartialCommitConflictError",
    "PersistenceExecutionError",
    "PersistencePlanningError",
    "RecordPhase",
    "RecoveryDisposition",
    "StaleResultError",
    "UnknownProviderSideEffectError",
}


class TestErrorHierarchy:
    def test_orchestration_error_inherits_project_root(self) -> None:
        assert OrchestrationError.__bases__ == (AiVideoWorkflowError,)
        assert issubclass(OrchestrationError, Exception)

    @pytest.mark.parametrize("error_type", DIRECT_ORCHESTRATION_ERRORS)
    def test_direct_errors_inherit_orchestration_error(
        self,
        error_type: type,
    ) -> None:
        assert error_type.__bases__ == (OrchestrationError,)
        assert issubclass(error_type, AiVideoWorkflowError)
        assert issubclass(error_type, Exception)

    def test_corrupt_stable_record_error_nesting(self) -> None:
        assert CorruptStableRecordError.__bases__ == (InvalidRecoveryRecordError,)
        assert issubclass(CorruptStableRecordError, OrchestrationError)

    def test_all_error_classes_are_distinct(self) -> None:
        assert len(set(ALL_ORCHESTRATION_ERRORS)) == len(ALL_ORCHESTRATION_ERRORS)

    def test_orchestration_errors_do_not_shadow_provider_errors(self) -> None:
        for error_type in ALL_ORCHESTRATION_ERRORS:
            assert not issubclass(error_type, ProviderError)
        assert not issubclass(ProviderError, OrchestrationError)

    @pytest.mark.parametrize("error_type", DIRECT_ORCHESTRATION_ERRORS)
    def test_errors_are_catchable_by_common_roots(
        self,
        error_type: type,
    ) -> None:
        with pytest.raises(OrchestrationError):
            raise error_type("boundary failure")
        with pytest.raises(AiVideoWorkflowError):
            raise error_type("boundary failure")

    def test_cause_preservation_through_explicit_chaining(self) -> None:
        low_level = ValueError("bad payload byte")
        try:
            try:
                raise low_level
            except ValueError as exc:
                raise InvalidRecoveryRecordError("record unreadable") from exc
        except InvalidRecoveryRecordError as caught:
            assert caught.__cause__ is low_level


class TestEnums:
    def test_orchestration_action_members(self) -> None:
        assert [member.value for member in OrchestrationAction] == [
            "prepare",
            "submit",
            "poll",
            "report_artifact",
            "collect",
            "replay_result",
            "resume",
        ]

    def test_outcome_kind_members(self) -> None:
        assert [member.value for member in OutcomeKind] == [
            "applied",
            "no_op",
        ]

    def test_record_phase_members(self) -> None:
        assert [member.value for member in RecordPhase] == [
            "stable",
            "provider_call_intent",
            "provider_call_may_have_started",
            "provider_result_unknown",
            "applying",
            "recovery_required",
        ]

    def test_recovery_disposition_members(self) -> None:
        assert [member.value for member in RecoveryDisposition] == [
            "none",
            "safe_auto_retry",
            "manual_reconciliation",
            "conflict",
        ]

    @pytest.mark.parametrize(
        "enum_type",
        [OrchestrationAction, OutcomeKind, RecordPhase, RecoveryDisposition],
    )
    def test_unknown_values_are_rejected(self, enum_type: type) -> None:
        with pytest.raises(ValueError):
            enum_type("not-a-member")

    @pytest.mark.parametrize(
        "enum_type",
        [OrchestrationAction, OutcomeKind, RecordPhase, RecoveryDisposition],
    )
    @pytest.mark.parametrize("value", [True, 0, 1])
    def test_bool_and_int_are_not_members(
        self,
        enum_type: type,
        value: object,
    ) -> None:
        with pytest.raises(ValueError):
            enum_type(value)

    def test_enums_are_distinct_from_existing_status_enums(self) -> None:
        assert RecordPhase is not GenerationTaskStatus
        assert RecordPhase is not ManifestStatus
        assert RecordPhase is not ProviderStatus
        assert not isinstance(RecordPhase.STABLE, ProviderStatus)
        assert not isinstance(ProviderStatus.SUCCEEDED, RecordPhase)


class TestPublicExports:
    def test_all_matches_expected_exports(self) -> None:
        assert set(orchestration_package.__all__) == EXPECTED_EXPORTS

    def test_every_declared_export_is_importable(self) -> None:
        for name in orchestration_package.__all__:
            assert hasattr(orchestration_package, name)

    def test_internal_utilities_are_not_exported(self) -> None:
        for name in (
            "_canonical_json_bytes",
            "_fingerprint",
            "_sha256_hex",
            "_freeze_value",
            "_freeze_mapping",
            "_thaw_value",
            "_thaw_mapping",
        ):
            assert name not in orchestration_package.__all__

    def test_later_step_types_are_not_exported_yet(self) -> None:
        for name in (
            "ProviderOrchestrator",
            "OrchestrationContext",
            "OrchestrationOutcome",
            "OrchestrationPlan",
            "OrchestrationRecord",
            "ResumeAssessment",
        ):
            assert name not in orchestration_package.__all__
            assert not hasattr(orchestration_package, name)


# --- Step B fixtures: deterministic record-layer test data -----------------

T0 = datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc)
T0_ISO = "2026-07-26T10:00:00.000000+00:00"
T1 = datetime(2026, 7, 26, 11, 0, 0, tzinfo=timezone.utc)
T1_ISO = "2026-07-26T11:00:00.000000+00:00"

# Independently computed with hashlib over the exact UTF-8 bytes;
# never regenerated with the function under test.
VECTOR_INSTRUCTION_BYTES = (
    "d0e443ba68d18b5449ecd7c4579f971722aec21c7563d17d8dc3f16deec2b77f"
)

OTHER_HEX = "ab" * 32

REQUEST = ProviderRequest(
    provider_id="manual",
    task_id="task-1",
    shot_id="shot-1",
    prompt="a cat",
    duration_seconds=4.0,
    width=1280,
    height=720,
    frame_rate=24.0,
    staging_ref="staging/task-1",
    provider_parameters={"style": "anime"},
)
INSTRUCTION = ProviderInstruction(
    provider_id="manual",
    task_id="task-1",
    shot_id="shot-1",
    prompt="a cat",
    expected_duration_seconds=4.0,
    expected_width=1280,
    expected_height=720,
    expected_frame_rate=24.0,
    staging_ref="staging/task-1",
    steps=("open tool", "generate"),
    suggested_parameters={"style": "anime"},
)
RESULT = ProviderResult(
    provider_id="manual",
    task_id="task-1",
    shot_id="shot-1",
    status=ProviderStatus.NOT_SUBMITTED,
    observed_at=T0,
    instruction=INSTRUCTION,
)
ARTIFACT = ArtifactReference(
    reference="staging/task-1/clip.mp4",
    origin=ArtifactOrigin.USER,
    location=ArtifactLocation.STAGING,
)
TASK_AFTER = GenerationTask(
    task_id="task-1",
    shot_id="shot-1",
    status=GenerationTaskStatus.PENDING,
    created_at=T0,
    updated_at=T0,
    provider_id="manual",
)
MANIFEST_AFTER = StepManifest(
    step_name="generation:task-1",
    input_digest="digest-1",
    relevant_config_digest="config-1",
    status=ManifestStatus.PENDING,
    created_at=T0,
    output_metadata={"orchestration": {"schema": 1}},
)

REQUEST_WRAPPER = _snapshot_provider_request(REQUEST)
REQUEST_FP = _fingerprint(REQUEST_WRAPPER)
INSTRUCTION_WRAPPER = _snapshot_provider_instruction(INSTRUCTION)
INSTRUCTION_FP = _fingerprint(INSTRUCTION_WRAPPER)
RESULT_WRAPPER = _snapshot_provider_result(RESULT)
RESULT_FP = _fingerprint(RESULT_WRAPPER)
ARTIFACT_WRAPPER = _snapshot_artifact_reference(ARTIFACT)
TASK_AFTER_WRAPPER = _snapshot_generation_task(TASK_AFTER)
TASK_AFTER_FP = _fingerprint(TASK_AFTER_WRAPPER)
MANIFEST_AFTER_WRAPPER = _snapshot_step_manifest(MANIFEST_AFTER)
MANIFEST_AFTER_FP = _fingerprint(MANIFEST_AFTER_WRAPPER)

INSTRUCTION_TEXT = "# Manual Video Generation Task\n"
INSTRUCTION_TEXT_FP = _sha256_hex(INSTRUCTION_TEXT.encode("utf-8"))

PLAN_ID = _sha256_hex(b"plan-1")
TASK_BEFORE_FP = _sha256_hex(b"task-before")
MANIFEST_BEFORE_FP = _sha256_hex(b"manifest-before")


def make_action_input_wrapper(
    observed_at: str = T0_ISO,
    artifact: dict | None = None,
    completed_at: str | None = None,
    result_fingerprint: str | None = None,
) -> dict:
    wrapper = _make_snapshot_wrapper(
        "action_input",
        {
            "observed_at": observed_at,
            "artifact": artifact,
            "completed_at": completed_at,
            "result_fingerprint": result_fingerprint,
        },
    )
    return {
        "snapshot_kind": wrapper["snapshot_kind"],
        "snapshot_version": wrapper["snapshot_version"],
        "payload": dict(wrapper["payload"]),
    }


ACTION_INPUT_WRAPPER = make_action_input_wrapper()
ACTION_INPUT_FP = _fingerprint(ACTION_INPUT_WRAPPER)


def stable_kwargs(**overrides) -> dict:
    base = dict(
        task_id="task-1",
        shot_id="shot-1",
        provider_id="manual",
        version=1,
        last_committed_plan_id=PLAN_ID,
        last_committed_operation={
            "operation_id": "op-1",
            "action": "prepare",
            "request_fingerprint": REQUEST_FP,
            "action_input_fingerprint": ACTION_INPUT_FP,
            "observed_at": T0_ISO,
        },
        committed_task_fingerprint=TASK_AFTER_FP,
        committed_manifest_fingerprint=MANIFEST_AFTER_FP,
        committed_instruction_fingerprint=INSTRUCTION_TEXT_FP,
        committed_request_fingerprint=REQUEST_FP,
        committed_result_fingerprint=RESULT_FP,
        request_snapshot=REQUEST_WRAPPER,
        request_fingerprint=REQUEST_FP,
        instruction_snapshot=INSTRUCTION_WRAPPER,
        instruction_fingerprint=INSTRUCTION_FP,
        authoritative_external_task_ref=None,
        authoritative_artifact=None,
        authoritative_error_summary=None,
        authoritative_completed_at=None,
        last_result_snapshot=RESULT_WRAPPER,
        last_result_fingerprint=RESULT_FP,
        last_completed_action=OrchestrationAction.PREPARE,
        legal_actions=(OrchestrationAction.SUBMIT,),
        preferred_next_action=OrchestrationAction.SUBMIT,
        updated_at=T0,
    )
    base.update(overrides)
    return base


def make_stable(**overrides) -> _StableStateSnapshot:
    return _StableStateSnapshot(**stable_kwargs(**overrides))


def pending_call_kwargs(**overrides) -> dict:
    action_input = make_action_input_wrapper(observed_at=T1_ISO)
    base = dict(
        operation_id="op-2",
        action=OrchestrationAction.SUBMIT,
        baseline_version=1,
        request_snapshot=REQUEST_WRAPPER,
        request_fingerprint=REQUEST_FP,
        action_input_snapshot=action_input,
        action_input_fingerprint=_fingerprint(action_input),
        original_observed_at=T1,
        original_completed_at=None,
        artifact_input=None,
        call_phase=RecordPhase.PROVIDER_CALL_INTENT,
        call_may_have_started=False,
        started_at=T1,
        recovery_policy=RecoveryDisposition.MANUAL_RECONCILIATION,
    )
    base.update(overrides)
    return base


def make_pending_call(**overrides) -> _PendingProviderCall:
    return _PendingProviderCall(**pending_call_kwargs(**overrides))


def make_planned(**overrides) -> _StableStateSnapshot:
    return make_stable(**overrides)


def pending_apply_kwargs(
    planned: _StableStateSnapshot | None = None,
    **overrides,
) -> dict:
    if planned is None:
        planned = make_planned()
    planned_wrapper = planned.to_wrapper()
    base = dict(
        operation_id="op-1",
        action=OrchestrationAction.PREPARE,
        baseline_version=0,
        request_snapshot=REQUEST_WRAPPER,
        request_fingerprint=REQUEST_FP,
        action_input_snapshot=ACTION_INPUT_WRAPPER,
        action_input_fingerprint=ACTION_INPUT_FP,
        result_snapshot=RESULT_WRAPPER,
        result_fingerprint=RESULT_FP,
        plan_id=PLAN_ID,
        before_fingerprints={
            "task": TASK_BEFORE_FP,
            "manifest": MANIFEST_BEFORE_FP,
            "instruction": ABSENT,
            "stable_record": ABSENT,
        },
        task_after_snapshot=TASK_AFTER_WRAPPER,
        task_after_fingerprint=TASK_AFTER_FP,
        manifest_after_snapshot=MANIFEST_AFTER_WRAPPER,
        manifest_after_fingerprint=MANIFEST_AFTER_FP,
        instruction_after_text=INSTRUCTION_TEXT,
        instruction_after_fingerprint=INSTRUCTION_TEXT_FP,
        planned_stable_state_snapshot=planned_wrapper,
        planned_stable_state_wrapper_fingerprint=_fingerprint(planned_wrapper),
        confirmed_writes=(),
        recovery_disposition=RecoveryDisposition.SAFE_AUTO_RETRY,
        original_observed_at=T0,
        post_commit_legal_actions=(OrchestrationAction.SUBMIT,),
        post_commit_preferred_next_action=OrchestrationAction.SUBMIT,
    )
    base.update(overrides)
    return base


def make_pending_apply(**overrides) -> _PendingApply:
    return _PendingApply(**pending_apply_kwargs(**overrides))


def make_subsequent_pending_apply(stable: _StableStateSnapshot) -> _PendingApply:
    planned = make_planned(
        version=stable.version + 1,
        last_committed_operation={
            "operation_id": "op-3",
            "action": "poll",
            "request_fingerprint": REQUEST_FP,
            "action_input_fingerprint": _fingerprint(
                make_action_input_wrapper(observed_at=T1_ISO)
            ),
            "observed_at": T1_ISO,
        },
    )
    action_input = make_action_input_wrapper(observed_at=T1_ISO)
    return make_pending_apply(
        planned=planned,
        operation_id="op-3",
        action=OrchestrationAction.POLL,
        baseline_version=stable.version,
        action_input_snapshot=action_input,
        action_input_fingerprint=_fingerprint(action_input),
        before_fingerprints={
            "task": TASK_BEFORE_FP,
            "manifest": MANIFEST_BEFORE_FP,
            "instruction": INSTRUCTION_TEXT_FP,
            "stable_record": stable.stable_record_fingerprint,
        },
        original_observed_at=T1,
    )


def tampered(envelope: dict) -> dict:
    return copy.deepcopy(envelope)


# --- Step B tests: stable state snapshot ------------------------------------


class TestStableStateSnapshot:
    def test_valid_construction_and_exact_fields(self) -> None:
        stable = make_stable()
        assert stable.task_id == "task-1"
        assert stable.version == 1
        assert stable.stable_schema_version == 1
        assert stable.last_completed_action is OrchestrationAction.PREPARE
        assert stable.legal_actions == (OrchestrationAction.SUBMIT,)
        assert stable.request_fingerprint == REQUEST_FP

    def test_self_fingerprint_is_derived_not_caller_supplied(self) -> None:
        stable = make_stable()
        forged = _StableStateSnapshot(
            **stable_kwargs(),
            stable_record_fingerprint=OTHER_HEX,
        )
        assert forged.stable_record_fingerprint == (stable.stable_record_fingerprint)
        assert forged.stable_record_fingerprint != OTHER_HEX

    def test_self_fingerprint_excludes_itself(self) -> None:
        stable = make_stable()
        payload = stable.to_payload()
        reduced = {
            key: value
            for key, value in payload.items()
            if key != "stable_record_fingerprint"
        }
        assert stable.stable_record_fingerprint == _fingerprint(reduced)
        assert stable.stable_record_fingerprint != _fingerprint(payload)

    def test_version_below_one_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_stable(version=0)

    @pytest.mark.parametrize("version", [True, "1", 1.0])
    def test_non_strict_int_version_is_rejected(self, version: object) -> None:
        with pytest.raises(FieldTypeError):
            make_stable(version=version)

    def test_unknown_stable_schema_version_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_stable(stable_schema_version=2)

    def test_missing_instruction_requires_absent_marker(self) -> None:
        stable = make_stable(
            instruction_snapshot=None,
            instruction_fingerprint=ABSENT,
            committed_instruction_fingerprint=ABSENT,
        )
        assert stable.instruction_snapshot is None
        with pytest.raises(InvariantViolationError):
            make_stable(
                instruction_snapshot=None,
                instruction_fingerprint=INSTRUCTION_FP,
            )

    @pytest.mark.parametrize(
        "field_name",
        ["request_fingerprint", "last_result_fingerprint"],
    )
    def test_snapshot_fingerprint_mismatch_is_rejected(
        self,
        field_name: str,
    ) -> None:
        with pytest.raises(InvariantViolationError):
            make_stable(**{field_name: OTHER_HEX})

    def test_committed_operation_requires_exact_keys(self) -> None:
        operation = dict(stable_kwargs()["last_committed_operation"])
        operation["extra"] = 1
        with pytest.raises(InvariantViolationError):
            make_stable(last_committed_operation=operation)
        operation = dict(stable_kwargs()["last_committed_operation"])
        del operation["observed_at"]
        with pytest.raises(InvariantViolationError):
            make_stable(last_committed_operation=operation)

    def test_legal_actions_must_follow_enum_order_without_duplicates(
        self,
    ) -> None:
        stable = make_stable(
            legal_actions=(
                OrchestrationAction.POLL,
                OrchestrationAction.COLLECT,
            ),
            preferred_next_action=OrchestrationAction.POLL,
        )
        assert stable.legal_actions[0] is OrchestrationAction.POLL
        with pytest.raises(InvariantViolationError):
            make_stable(
                legal_actions=(
                    OrchestrationAction.COLLECT,
                    OrchestrationAction.POLL,
                ),
                preferred_next_action=OrchestrationAction.POLL,
            )
        with pytest.raises(InvariantViolationError):
            make_stable(
                legal_actions=(
                    OrchestrationAction.SUBMIT,
                    OrchestrationAction.SUBMIT,
                ),
            )

    def test_preferred_action_must_be_legal_or_none(self) -> None:
        stable = make_stable(preferred_next_action=None)
        assert stable.preferred_next_action is None
        with pytest.raises(InvariantViolationError):
            make_stable(preferred_next_action=OrchestrationAction.COLLECT)

    def test_naive_datetime_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_stable(updated_at=datetime(2026, 7, 26, 10, 0, 0))

    def test_equal_inputs_produce_equal_snapshots_and_fingerprints(
        self,
    ) -> None:
        first = make_stable()
        second = make_stable()
        assert first == second
        assert first.stable_record_fingerprint == (second.stable_record_fingerprint)

    def test_insertion_order_of_wrapper_payload_does_not_matter(self) -> None:
        payload = dict(REQUEST_WRAPPER["payload"])
        reordered_payload = dict(reversed(list(payload.items())))
        reordered_wrapper = {
            "snapshot_kind": "provider_request",
            "snapshot_version": 1,
            "payload": reordered_payload,
        }
        stable = make_stable(request_snapshot=reordered_wrapper)
        assert stable.stable_record_fingerprint == (
            make_stable().stable_record_fingerprint
        )

    def test_models_are_unhashable(self) -> None:
        with pytest.raises(TypeError):
            hash(make_stable())
        with pytest.raises(TypeError):
            hash(make_pending_call())
        with pytest.raises(TypeError):
            hash(make_pending_apply())

    def test_deep_immutability_and_mutation_isolation(self) -> None:
        request_wrapper = {
            "snapshot_kind": "provider_request",
            "snapshot_version": 1,
            "payload": dict(REQUEST_WRAPPER["payload"]),
        }
        request_wrapper["payload"]["provider_parameters"] = dict(
            request_wrapper["payload"]["provider_parameters"]
        )
        stable = make_stable(request_snapshot=request_wrapper)
        reference_fp = stable.stable_record_fingerprint
        request_wrapper["payload"]["prompt"] = "mutated"
        request_wrapper["payload"]["provider_parameters"]["style"] = "oil"
        assert stable.request_snapshot["payload"]["prompt"] == "a cat"
        assert stable.stable_record_fingerprint == reference_fp
        with pytest.raises(TypeError):
            stable.request_snapshot["payload"] = {}
        with pytest.raises(TypeError):
            stable.request_snapshot["payload"]["prompt"] = "x"
        payload = stable.to_payload()
        payload["task_id"] = "task-other"
        assert stable.to_payload()["task_id"] == "task-1"


# --- Step B tests: pending provider call ------------------------------------


class TestPendingProviderCall:
    def test_valid_construction_and_payload(self) -> None:
        pending = make_pending_call()
        payload = pending.to_payload()
        assert payload["variant"] == "provider_call"
        assert payload["pending_call_schema_version"] == 1
        assert payload["action"] == "submit"
        assert payload["call_phase"] == "provider_call_intent"
        assert payload["call_may_have_started"] is False

    @pytest.mark.parametrize(
        "action",
        [
            OrchestrationAction.PREPARE,
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.REPLAY_RESULT,
            OrchestrationAction.RESUME,
        ],
    )
    def test_only_submit_and_collect_are_allowed(
        self,
        action: OrchestrationAction,
    ) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(action=action)

    def test_baseline_zero_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(baseline_version=0)

    def test_unknown_pending_call_schema_version_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(pending_call_schema_version=2)
        with pytest.raises(FieldTypeError):
            make_pending_call(pending_call_schema_version=True)

    def test_unknown_variant_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(variant="mystery")

    @pytest.mark.parametrize(
        ("call_phase", "call_may_have_started"),
        [
            (RecordPhase.PROVIDER_CALL_INTENT, True),
            (RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED, False),
            (RecordPhase.PROVIDER_RESULT_UNKNOWN, False),
        ],
    )
    def test_call_phase_boolean_mismatch_is_rejected(
        self,
        call_phase: RecordPhase,
        call_may_have_started: bool,
    ) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(
                call_phase=call_phase,
                call_may_have_started=call_may_have_started,
            )

    def test_non_call_phase_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(
                call_phase=RecordPhase.APPLYING,
                call_may_have_started=True,
            )

    def test_bool_as_int_is_not_accepted_for_flag(self) -> None:
        with pytest.raises(FieldTypeError):
            make_pending_call(call_may_have_started=0)

    def test_duplicated_observed_at_mismatch_is_rejected(self) -> None:
        action_input = make_action_input_wrapper(observed_at=T0_ISO)
        with pytest.raises(InvariantViolationError):
            make_pending_call(
                action_input_snapshot=action_input,
                action_input_fingerprint=_fingerprint(action_input),
            )

    def test_duplicated_completed_at_mismatch_is_rejected(self) -> None:
        action_input = make_action_input_wrapper(
            observed_at=T1_ISO,
            completed_at=T0_ISO,
        )
        with pytest.raises(InvariantViolationError):
            make_pending_call(
                action_input_snapshot=action_input,
                action_input_fingerprint=_fingerprint(action_input),
                original_completed_at=None,
            )

    def test_duplicated_artifact_mismatch_is_rejected(self) -> None:
        artifact_payload = {
            "snapshot_kind": "artifact_reference",
            "snapshot_version": 1,
            "payload": dict(ARTIFACT_WRAPPER["payload"]),
        }
        action_input = make_action_input_wrapper(
            observed_at=T1_ISO,
            artifact=artifact_payload,
        )
        with pytest.raises(InvariantViolationError):
            make_pending_call(
                action_input_snapshot=action_input,
                action_input_fingerprint=_fingerprint(action_input),
                artifact_input=None,
            )

    def test_pre_call_result_fingerprint_must_be_null(self) -> None:
        action_input = make_action_input_wrapper(
            observed_at=T1_ISO,
            result_fingerprint=RESULT_FP,
        )
        with pytest.raises(InvariantViolationError):
            make_pending_call(
                action_input_snapshot=action_input,
                action_input_fingerprint=_fingerprint(action_input),
            )

    def test_request_fingerprint_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(request_fingerprint=OTHER_HEX)

    def test_action_input_fingerprint_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_call(action_input_fingerprint=OTHER_HEX)


# --- Step B tests: pending apply ---------------------------------------------


class TestPendingApply:
    def test_valid_first_prepare_construction(self) -> None:
        pending = make_pending_apply()
        assert pending.baseline_version == 0
        assert pending.before_fingerprints["stable_record"] == ABSENT
        payload = pending.to_payload()
        assert payload["variant"] == "apply"
        assert payload["pending_apply_schema_version"] == 1

    def test_resume_never_produces_a_pending_apply(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(action=OrchestrationAction.RESUME)

    def test_unknown_pending_apply_schema_version_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(pending_apply_schema_version=2)
        with pytest.raises(FieldTypeError):
            make_pending_apply(pending_apply_schema_version=True)

    def test_result_fingerprint_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(result_fingerprint=OTHER_HEX)

    def test_task_after_fingerprint_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(task_after_fingerprint=OTHER_HEX)

    def test_manifest_after_fingerprint_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(manifest_after_fingerprint=OTHER_HEX)

    def test_instruction_bytes_fingerprint_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(instruction_after_fingerprint=OTHER_HEX)

    def test_instruction_bytes_fingerprint_uses_exact_utf8_bytes(
        self,
    ) -> None:
        assert INSTRUCTION_TEXT_FP == VECTOR_INSTRUCTION_BYTES
        pending = make_pending_apply()
        assert pending.instruction_after_fingerprint == (VECTOR_INSTRUCTION_BYTES)

    def test_missing_instruction_uses_absent_pair(self) -> None:
        planned = make_planned(
            instruction_snapshot=None,
            instruction_fingerprint=ABSENT,
            committed_instruction_fingerprint=ABSENT,
        )
        pending = make_pending_apply(
            planned=planned,
            instruction_after_text=None,
            instruction_after_fingerprint=ABSENT,
        )
        assert pending.instruction_after_text is None
        with pytest.raises(InvariantViolationError):
            make_pending_apply(
                instruction_after_text=None,
                instruction_after_fingerprint=INSTRUCTION_TEXT_FP,
            )

    def test_planned_wrapper_fingerprint_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(
                planned_stable_state_wrapper_fingerprint=OTHER_HEX,
            )

    def test_planned_embedded_self_fingerprint_mismatch_is_rejected(
        self,
    ) -> None:
        planned_wrapper = make_planned().to_wrapper()
        tampered_payload = dict(planned_wrapper["payload"])
        tampered_payload["stable_record_fingerprint"] = OTHER_HEX
        tampered_wrapper = {
            "snapshot_kind": "orchestration_stable_state",
            "snapshot_version": 1,
            "payload": tampered_payload,
        }
        with pytest.raises(InvariantViolationError):
            make_pending_apply(
                planned_stable_state_snapshot=tampered_wrapper,
                planned_stable_state_wrapper_fingerprint=_fingerprint(tampered_wrapper),
            )

    def test_two_planned_fingerprints_are_independent(self) -> None:
        pending = make_pending_apply()
        embedded = pending.planned_stable_state_snapshot["payload"][
            "stable_record_fingerprint"
        ]
        wrapper_fp = pending.planned_stable_state_wrapper_fingerprint
        assert embedded != wrapper_fp
        assert wrapper_fp == _fingerprint(pending.planned_stable_state_snapshot)

    def test_planned_committed_fingerprint_mismatch_is_rejected(self) -> None:
        planned = make_planned(committed_task_fingerprint=OTHER_HEX)
        with pytest.raises(InvariantViolationError):
            make_pending_apply(planned=planned)

    def test_planned_operation_identity_mismatch_is_rejected(self) -> None:
        operation = dict(stable_kwargs()["last_committed_operation"])
        operation["operation_id"] = "op-other"
        planned = make_planned(last_committed_operation=operation)
        with pytest.raises(InvariantViolationError):
            make_pending_apply(planned=planned)

    def test_planned_plan_id_mismatch_is_rejected(self) -> None:
        planned = make_planned(last_committed_plan_id=_sha256_hex(b"other"))
        with pytest.raises(InvariantViolationError):
            make_pending_apply(planned=planned)

    def test_planned_version_must_be_baseline_plus_one(self) -> None:
        planned = make_planned(version=2)
        with pytest.raises(InvariantViolationError):
            make_pending_apply(planned=planned)

    @pytest.mark.parametrize("forbidden", ["phase", "pending", "record_schema"])
    def test_planned_payload_must_not_contain_envelope_fields(
        self,
        forbidden: str,
    ) -> None:
        planned_wrapper = make_planned().to_wrapper()
        tampered_payload = dict(planned_wrapper["payload"])
        tampered_payload[forbidden] = "anything"
        tampered_wrapper = {
            "snapshot_kind": "orchestration_stable_state",
            "snapshot_version": 1,
            "payload": tampered_payload,
        }
        with pytest.raises(InvariantViolationError):
            make_pending_apply(
                planned_stable_state_snapshot=tampered_wrapper,
                planned_stable_state_wrapper_fingerprint=_fingerprint(tampered_wrapper),
            )

    def test_post_commit_legal_actions_must_match_planned(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(
                post_commit_legal_actions=(
                    OrchestrationAction.POLL,
                    OrchestrationAction.COLLECT,
                ),
                post_commit_preferred_next_action=OrchestrationAction.POLL,
            )

    def test_post_commit_preferred_must_match_planned(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_pending_apply(post_commit_preferred_next_action=None)

    def test_first_operation_requires_absent_stable_record_before(
        self,
    ) -> None:
        before = {
            "task": TASK_BEFORE_FP,
            "manifest": MANIFEST_BEFORE_FP,
            "instruction": ABSENT,
            "stable_record": _sha256_hex(b"stable"),
        }
        with pytest.raises(InvariantViolationError):
            make_pending_apply(before_fingerprints=before)

    def test_absent_marker_and_integer_zero_are_not_interchangeable(
        self,
    ) -> None:
        before = {
            "task": TASK_BEFORE_FP,
            "manifest": MANIFEST_BEFORE_FP,
            "instruction": ABSENT,
            "stable_record": 0,
        }
        with pytest.raises(InvariantViolationError):
            make_pending_apply(before_fingerprints=before)
        with pytest.raises(FieldTypeError):
            make_pending_apply(baseline_version=ABSENT)

    def test_before_fingerprints_require_exact_keys(self) -> None:
        before = {
            "task": TASK_BEFORE_FP,
            "manifest": MANIFEST_BEFORE_FP,
            "instruction": ABSENT,
        }
        with pytest.raises(InvariantViolationError):
            make_pending_apply(before_fingerprints=before)

    def test_confirmed_writes_allow_only_known_targets_without_dup(
        self,
    ) -> None:
        pending = make_pending_apply(confirmed_writes=("task", "manifest"))
        assert pending.confirmed_writes == ("task", "manifest")
        with pytest.raises(InvariantViolationError):
            make_pending_apply(confirmed_writes=("task", "task"))
        with pytest.raises(InvariantViolationError):
            make_pending_apply(confirmed_writes=("record",))

    def test_action_input_observed_at_must_match_original(self) -> None:
        action_input = make_action_input_wrapper(observed_at=T1_ISO)
        with pytest.raises(InvariantViolationError):
            make_pending_apply(
                action_input_snapshot=action_input,
                action_input_fingerprint=_fingerprint(action_input),
            )


# --- Step B tests: envelope construction and round-trips --------------------


def all_phase_scenarios() -> list[tuple[str, RecordPhase, object, object]]:
    stable = make_stable()
    call_intent = make_pending_call()
    call_started = make_pending_call(
        call_phase=RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
        call_may_have_started=True,
    )
    call_unknown = make_pending_call(
        call_phase=RecordPhase.PROVIDER_RESULT_UNKNOWN,
        call_may_have_started=True,
    )
    first_apply = make_pending_apply()
    subsequent_apply = make_subsequent_pending_apply(stable)
    return [
        ("stable", RecordPhase.STABLE, stable, None),
        ("intent", RecordPhase.PROVIDER_CALL_INTENT, stable, call_intent),
        (
            "may_have_started",
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
            stable,
            call_started,
        ),
        (
            "result_unknown",
            RecordPhase.PROVIDER_RESULT_UNKNOWN,
            stable,
            call_unknown,
        ),
        ("first_applying", RecordPhase.APPLYING, None, first_apply),
        (
            "subsequent_applying",
            RecordPhase.APPLYING,
            stable,
            subsequent_apply,
        ),
        ("recovery_with_stable", RecordPhase.RECOVERY_REQUIRED, stable, None),
        (
            "recovery_first_prepare",
            RecordPhase.RECOVERY_REQUIRED,
            None,
            first_apply,
        ),
    ]


class TestEnvelope:
    @pytest.mark.parametrize(
        ("label", "phase", "stable", "pending"),
        all_phase_scenarios(),
        ids=[scenario[0] for scenario in all_phase_scenarios()],
    )
    def test_round_trip_for_every_phase(
        self,
        label: str,
        phase: RecordPhase,
        stable: object,
        pending: object,
    ) -> None:
        envelope = _build_envelope(phase, stable, pending)
        assert envelope["record_schema"] == {
            "kind": RECORD_SCHEMA_KIND,
            "version": RECORD_SCHEMA_VERSION,
        }
        parsed = _parse_record_envelope(envelope)
        assert parsed.phase is phase
        assert parsed.stable == stable
        assert parsed.pending == pending
        assert parsed.to_envelope() == envelope

    def test_stable_phase_with_pending_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            _build_envelope(
                RecordPhase.STABLE,
                make_stable(),
                make_pending_call(),
            )

    def test_stable_phase_requires_stable(self) -> None:
        with pytest.raises(InvariantViolationError):
            _build_envelope(RecordPhase.STABLE, None, None)

    def test_applying_with_pending_call_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            _build_envelope(
                RecordPhase.APPLYING,
                make_stable(),
                make_pending_call(),
            )

    def test_call_intent_with_pending_apply_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            _build_envelope(
                RecordPhase.PROVIDER_CALL_INTENT,
                make_stable(),
                make_pending_apply(),
            )

    def test_call_phase_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            _build_envelope(
                RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
                make_stable(),
                make_pending_call(),
            )

    @pytest.mark.parametrize(
        "phase",
        [
            RecordPhase.PROVIDER_CALL_INTENT,
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
            RecordPhase.PROVIDER_RESULT_UNKNOWN,
        ],
    )
    def test_provider_call_phases_require_stable(
        self,
        phase: RecordPhase,
    ) -> None:
        pending = make_pending_call(
            call_phase=phase,
            call_may_have_started=(phase is not RecordPhase.PROVIDER_CALL_INTENT),
        )
        with pytest.raises(InvariantViolationError):
            _build_envelope(phase, None, pending)

    def test_applying_null_stable_requires_first_prepare_baseline(
        self,
    ) -> None:
        stable = make_stable()
        subsequent = make_subsequent_pending_apply(stable)
        with pytest.raises(InvariantViolationError):
            _build_envelope(RecordPhase.APPLYING, None, subsequent)

    def test_pending_baseline_must_match_stable_version(self) -> None:
        stable = make_stable(version=2)
        with pytest.raises(InvariantViolationError):
            _build_envelope(
                RecordPhase.PROVIDER_CALL_INTENT,
                stable,
                make_pending_call(baseline_version=1),
            )

    def test_recovery_required_null_stable_requires_first_apply(self) -> None:
        with pytest.raises(InvariantViolationError):
            _build_envelope(RecordPhase.RECOVERY_REQUIRED, None, None)
        with pytest.raises(InvariantViolationError):
            _build_envelope(
                RecordPhase.RECOVERY_REQUIRED,
                None,
                make_pending_call(),
            )


# --- Step B tests: strict recovery parser -----------------------------------


class TestStrictRecoveryParser:
    def test_missing_envelope_key_is_rejected(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        del envelope["phase"]
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_unknown_envelope_key_is_rejected(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["extra"] = True
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_record_schema_requires_exact_keys(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["record_schema"] = {"kind": RECORD_SCHEMA_KIND}
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_unknown_record_kind_is_rejected(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["record_schema"] = {"kind": "mystery_record", "version": 1}
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    @pytest.mark.parametrize("version", [0, 2, True, "1"])
    def test_unknown_or_non_strict_record_version_is_rejected(
        self,
        version: object,
    ) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["record_schema"] = {
            "kind": RECORD_SCHEMA_KIND,
            "version": version,
        }
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_unknown_phase_value_is_rejected(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["phase"] = "exploding"
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_non_mapping_input_is_rejected(self) -> None:
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope("not-a-record")

    @pytest.mark.parametrize(
        "phase_value",
        [
            "provider_call_intent",
            "provider_call_may_have_started",
            "provider_result_unknown",
        ],
    )
    def test_provider_call_phase_with_null_stable_is_rejected(
        self,
        phase_value: str,
    ) -> None:
        pending = make_pending_call(
            call_phase=RecordPhase(phase_value),
            call_may_have_started=(phase_value != "provider_call_intent"),
        )
        envelope = _build_envelope(
            RecordPhase(phase_value),
            make_stable(),
            pending,
        )
        envelope["stable"] = None
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_applying_null_stable_is_only_legal_for_first_prepare(
        self,
    ) -> None:
        stable = make_stable()
        subsequent = make_subsequent_pending_apply(stable)
        envelope = _build_envelope(RecordPhase.APPLYING, stable, subsequent)
        envelope["stable"] = None
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_stable_phase_with_pending_payload_is_rejected(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["pending"] = make_pending_call().to_payload()
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_applying_with_provider_call_variant_is_rejected(self) -> None:
        stable = make_stable()
        envelope = _build_envelope(
            RecordPhase.PROVIDER_CALL_INTENT,
            stable,
            make_pending_call(),
        )
        envelope["phase"] = "applying"
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_unknown_pending_variant_is_rejected(self) -> None:
        stable = make_stable()
        envelope = _build_envelope(
            RecordPhase.PROVIDER_CALL_INTENT,
            stable,
            make_pending_call(),
        )
        envelope["pending"]["variant"] = "mystery"
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    @pytest.mark.parametrize("version", [0, 2, True])
    def test_unknown_pending_schema_versions_are_rejected(
        self,
        version: object,
    ) -> None:
        stable = make_stable()
        call_envelope = _build_envelope(
            RecordPhase.PROVIDER_CALL_INTENT,
            stable,
            make_pending_call(),
        )
        call_envelope["pending"]["pending_call_schema_version"] = version
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(call_envelope)
        apply_envelope = _build_envelope(
            RecordPhase.APPLYING,
            None,
            make_pending_apply(),
        )
        apply_envelope["pending"]["pending_apply_schema_version"] = version
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(apply_envelope)

    def test_stable_snapshot_unknown_version_is_rejected(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["stable"]["snapshot_version"] = 2
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_pre_call_payload_must_not_contain_result_or_plan(self) -> None:
        stable = make_stable()
        for forbidden_key, value in (
            ("plan_id", PLAN_ID),
            ("result_snapshot", dict(RESULT_WRAPPER)),
            ("result_fingerprint", RESULT_FP),
            ("task_after_snapshot", dict(TASK_AFTER_WRAPPER)),
            ("instruction_after_text", INSTRUCTION_TEXT),
            ("planned_stable_state_snapshot", {}),
        ):
            envelope = _build_envelope(
                RecordPhase.PROVIDER_CALL_INTENT,
                stable,
                make_pending_call(),
            )
            envelope["pending"][forbidden_key] = value
            with pytest.raises(InvalidRecoveryRecordError):
                _parse_record_envelope(envelope)

    @pytest.mark.parametrize(
        "required_key",
        [
            "plan_id",
            "result_snapshot",
            "task_after_snapshot",
            "manifest_after_snapshot",
            "planned_stable_state_snapshot",
            "before_fingerprints",
        ],
    )
    def test_post_result_payload_requires_plan_and_after(
        self,
        required_key: str,
    ) -> None:
        envelope = _build_envelope(
            RecordPhase.APPLYING,
            None,
            make_pending_apply(),
        )
        del envelope["pending"][required_key]
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_wrong_enum_value_is_rejected_with_cause(self) -> None:
        stable = make_stable()
        envelope = _build_envelope(
            RecordPhase.PROVIDER_CALL_INTENT,
            stable,
            make_pending_call(),
        )
        envelope["pending"]["recovery_policy"] = "explode"
        with pytest.raises(InvalidRecoveryRecordError) as exc_info:
            _parse_record_envelope(envelope)
        assert exc_info.value.__cause__ is not None

    def test_wrong_datetime_is_rejected(self) -> None:
        stable = make_stable()
        envelope = _build_envelope(
            RecordPhase.PROVIDER_CALL_INTENT,
            stable,
            make_pending_call(),
        )
        envelope["pending"]["started_at"] = "2026-07-26 11:00:00"
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_bool_is_rejected_where_int_is_required(self) -> None:
        envelope = _build_envelope(
            RecordPhase.APPLYING,
            None,
            make_pending_apply(),
        )
        envelope["pending"]["baseline_version"] = False
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_underlying_cause_is_preserved(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["record_schema"] = {"kind": True, "version": 1}
        with pytest.raises(InvalidRecoveryRecordError) as exc_info:
            _parse_record_envelope(envelope)
        assert isinstance(exc_info.value.__cause__, AiVideoWorkflowError)


class TestStableSelfFingerprintProtocol:
    def test_valid_stable_record_parses(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        parsed = _parse_record_envelope(envelope)
        assert parsed.stable == make_stable()

    def test_content_tampering_raises_corrupt_stable_record(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["stable"]["payload"]["version"] = 7
        with pytest.raises(CorruptStableRecordError):
            _parse_record_envelope(envelope)

    def test_fingerprint_field_tampering_raises_corrupt_stable_record(
        self,
    ) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["stable"]["payload"]["stable_record_fingerprint"] = OTHER_HEX
        with pytest.raises(CorruptStableRecordError):
            _parse_record_envelope(envelope)

    def test_schema_valid_but_wrong_self_fingerprint_is_corrupt(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["stable"]["payload"]["stable_record_fingerprint"] = _sha256_hex(
            b"still-valid-hex-but-wrong"
        )
        with pytest.raises(CorruptStableRecordError):
            _parse_record_envelope(envelope)

    def test_self_fingerprint_is_verified_before_field_parsing(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["stable"]["payload"]["last_completed_action"] = "explode"
        with pytest.raises(CorruptStableRecordError):
            _parse_record_envelope(envelope)

    def test_corrupt_stable_record_error_is_not_rewrapped(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        envelope["stable"]["payload"]["version"] = 7
        with pytest.raises(CorruptStableRecordError) as exc_info:
            _parse_record_envelope(envelope)
        assert type(exc_info.value) is CorruptStableRecordError


class TestRestoreAdapters:
    def test_provider_request_round_trip(self) -> None:
        restored = _restore_provider_request(REQUEST_WRAPPER)
        assert type(restored) is ProviderRequest
        assert restored == REQUEST
        assert _fingerprint(_snapshot_provider_request(restored)) == (REQUEST_FP)

    def test_provider_result_round_trip(self) -> None:
        restored = _restore_provider_result(RESULT_WRAPPER)
        assert type(restored) is ProviderResult
        assert _fingerprint(_snapshot_provider_result(restored)) == RESULT_FP

    def test_provider_instruction_round_trip(self) -> None:
        restored = _restore_provider_instruction(INSTRUCTION_WRAPPER)
        assert type(restored) is ProviderInstruction
        assert _fingerprint(_snapshot_provider_instruction(restored)) == (
            INSTRUCTION_FP
        )

    def test_artifact_reference_round_trip(self) -> None:
        restored = _restore_artifact_reference(ARTIFACT_WRAPPER)
        assert type(restored) is ArtifactReference
        assert restored == ARTIFACT

    def test_generation_task_round_trip(self) -> None:
        restored = _restore_generation_task(TASK_AFTER_WRAPPER)
        assert type(restored) is GenerationTask
        assert restored == TASK_AFTER
        assert _fingerprint(_snapshot_generation_task(restored)) == (TASK_AFTER_FP)

    def test_step_manifest_round_trip(self) -> None:
        restored = _restore_step_manifest(MANIFEST_AFTER_WRAPPER)
        assert type(restored) is StepManifest
        assert restored == MANIFEST_AFTER
        assert _fingerprint(_snapshot_step_manifest(restored)) == (MANIFEST_AFTER_FP)

    def test_generation_task_invariants_are_rerun_on_restore(self) -> None:
        payload = dict(TASK_AFTER_WRAPPER["payload"])
        payload["error_summary"] = "boom"
        wrapper = {
            "snapshot_kind": "generation_task",
            "snapshot_version": 1,
            "payload": payload,
        }
        with pytest.raises(InvalidRecoveryRecordError) as exc_info:
            _restore_generation_task(wrapper)
        assert exc_info.value.__cause__ is not None

    def test_step_manifest_invariants_are_rerun_on_restore(self) -> None:
        payload = dict(MANIFEST_AFTER_WRAPPER["payload"])
        payload["error_summary"] = "boom"
        wrapper = {
            "snapshot_kind": "step_manifest",
            "snapshot_version": 1,
            "payload": payload,
        }
        with pytest.raises(InvalidRecoveryRecordError):
            _restore_step_manifest(wrapper)

    def test_unknown_payload_key_is_rejected_on_restore(self) -> None:
        payload = dict(TASK_AFTER_WRAPPER["payload"])
        payload["surprise"] = 1
        wrapper = {
            "snapshot_kind": "generation_task",
            "snapshot_version": 1,
            "payload": payload,
        }
        with pytest.raises(InvalidRecoveryRecordError):
            _restore_generation_task(wrapper)

    def test_snapshot_functions_reject_wrong_model_types(self) -> None:
        with pytest.raises(FieldTypeError):
            _snapshot_generation_task(MANIFEST_AFTER)
        with pytest.raises(FieldTypeError):
            _snapshot_step_manifest(TASK_AFTER)
        with pytest.raises(FieldTypeError):
            _snapshot_provider_request(RESULT)

    def test_restore_rejects_wrong_wrapper_kind(self) -> None:
        with pytest.raises(InvariantViolationError):
            _restore_generation_task(MANIFEST_AFTER_WRAPPER)

    def test_restore_rejects_non_mapping_snapshot(self) -> None:
        with pytest.raises(FieldTypeError):
            _restore_generation_task("not-a-wrapper")

    def test_after_snapshot_fingerprint_mismatch_is_rejected_in_parse(
        self,
    ) -> None:
        envelope = _build_envelope(
            RecordPhase.APPLYING,
            None,
            make_pending_apply(),
        )
        envelope["pending"]["task_after_fingerprint"] = OTHER_HEX
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_instruction_text_reencoding_is_byte_exact(self) -> None:
        nfc_text = "café\n"
        nfd_text = "café\n"
        assert _sha256_hex(nfc_text.encode("utf-8")) != (
            _sha256_hex(nfd_text.encode("utf-8"))
        )
        pending = make_pending_apply(
            instruction_after_text=nfc_text,
            instruction_after_fingerprint=_sha256_hex(nfc_text.encode("utf-8")),
            planned=make_planned(
                committed_instruction_fingerprint=_sha256_hex(nfc_text.encode("utf-8"))
            ),
        )
        assert pending.instruction_after_text == nfc_text


class TestStepBBoundaries:
    def test_executable_plan_is_not_implemented_in_step_b(self) -> None:
        assert not hasattr(internal_models, "_ExecutablePlan")

    def test_step_b_symbols_are_not_exported(self) -> None:
        for name in (
            "_StableStateSnapshot",
            "_PendingProviderCall",
            "_PendingApply",
            "_build_envelope",
            "_parse_record_envelope",
            "_restore_generation_task",
            "ABSENT",
        ):
            assert name not in orchestration_package.__all__

    def test_package_exports_are_unchanged_since_step_a(self) -> None:
        assert set(orchestration_package.__all__) == EXPECTED_EXPORTS

    def test_parsed_record_and_models_are_pure_data(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        first = _parse_record_envelope(envelope)
        second = _parse_record_envelope(copy.deepcopy(envelope))
        assert first == second
        assert first.to_envelope() == second.to_envelope()


# --- Step B review fixes: first-prepare action, calendar time, versions -----

NON_PREPARE_OPERATION_ACTIONS = (
    OrchestrationAction.SUBMIT,
    OrchestrationAction.POLL,
    OrchestrationAction.REPORT_ARTIFACT,
    OrchestrationAction.COLLECT,
    OrchestrationAction.REPLAY_RESULT,
)


def make_non_prepare_first_apply(
    action: OrchestrationAction,
) -> _PendingApply:
    operation = dict(stable_kwargs()["last_committed_operation"])
    operation["action"] = action.value
    planned = make_planned(last_committed_operation=operation)
    return make_pending_apply(planned=planned, action=action)


def stable_envelope_with_payload(payload: dict) -> dict:
    envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
    payload = dict(payload)
    payload["stable_record_fingerprint"] = _stable_self_fingerprint(payload)
    envelope["stable"]["payload"] = payload
    return envelope


class TestFirstPrepareOnlyNullStable:
    @pytest.mark.parametrize("action", NON_PREPARE_OPERATION_ACTIONS)
    def test_applying_null_stable_rejects_non_prepare_actions(
        self,
        action: OrchestrationAction,
    ) -> None:
        pending = make_non_prepare_first_apply(action)
        with pytest.raises(InvariantViolationError):
            _build_envelope(RecordPhase.APPLYING, None, pending)

    @pytest.mark.parametrize("action", NON_PREPARE_OPERATION_ACTIONS)
    def test_recovery_required_null_stable_rejects_non_prepare_actions(
        self,
        action: OrchestrationAction,
    ) -> None:
        pending = make_non_prepare_first_apply(action)
        with pytest.raises(InvariantViolationError):
            _build_envelope(RecordPhase.RECOVERY_REQUIRED, None, pending)

    @pytest.mark.parametrize("action", NON_PREPARE_OPERATION_ACTIONS)
    @pytest.mark.parametrize(
        "phase_value",
        ["applying", "recovery_required"],
    )
    def test_parser_rejects_non_prepare_null_stable_envelopes(
        self,
        action: OrchestrationAction,
        phase_value: str,
    ) -> None:
        pending = make_non_prepare_first_apply(action)
        envelope = {
            "record_schema": {
                "kind": RECORD_SCHEMA_KIND,
                "version": RECORD_SCHEMA_VERSION,
            },
            "phase": phase_value,
            "stable": None,
            "pending": pending.to_payload(),
        }
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    def test_first_prepare_null_stable_still_round_trips(self) -> None:
        pending = make_pending_apply()
        envelope = _build_envelope(RecordPhase.APPLYING, None, pending)
        parsed = _parse_record_envelope(envelope)
        assert parsed.pending == pending


class TestCalendarSemanticDatetime:
    INVALID_CALENDAR_VALUES = [
        "2026-99-99T99:99:99.000000+00:00",
        "2026-13-01T00:00:00.000000+00:00",
        "2026-02-30T00:00:00.000000+00:00",
        "2026-07-26T24:00:00.000000+00:00",
        "2026-07-26T00:60:00.000000+00:00",
    ]

    @pytest.mark.parametrize("bad_value", INVALID_CALENDAR_VALUES)
    def test_committed_operation_rejects_invalid_calendar_time(
        self,
        bad_value: str,
    ) -> None:
        operation = dict(stable_kwargs()["last_committed_operation"])
        operation["observed_at"] = bad_value
        with pytest.raises(InvariantViolationError):
            make_stable(last_committed_operation=operation)

    @pytest.mark.parametrize("bad_value", INVALID_CALENDAR_VALUES)
    def test_parser_rejects_invalid_calendar_time_with_valid_self_fp(
        self,
        bad_value: str,
    ) -> None:
        payload = make_stable().to_payload()
        payload["last_committed_operation"]["observed_at"] = bad_value
        envelope = stable_envelope_with_payload(payload)
        with pytest.raises(InvalidRecoveryRecordError):
            _parse_record_envelope(envelope)

    @pytest.mark.parametrize("bad_value", INVALID_CALENDAR_VALUES)
    def test_action_input_rejects_invalid_calendar_time(
        self,
        bad_value: str,
    ) -> None:
        action_input = make_action_input_wrapper(observed_at=bad_value)
        with pytest.raises(InvariantViolationError):
            make_pending_call(
                action_input_snapshot=action_input,
                action_input_fingerprint=_fingerprint(action_input),
            )


class TestStableSchemaVersionParsing:
    @pytest.mark.parametrize("version", [0, 2, 999])
    def test_unknown_stable_schema_version_is_rejected_by_parser(
        self,
        version: int,
    ) -> None:
        payload = make_stable().to_payload()
        payload["stable_schema_version"] = version
        envelope = stable_envelope_with_payload(payload)
        with pytest.raises(InvalidRecoveryRecordError) as exc_info:
            _parse_record_envelope(envelope)
        assert not isinstance(exc_info.value, CorruptStableRecordError)

    @pytest.mark.parametrize("version", [True, False, "1"])
    def test_non_strict_int_stable_schema_version_is_rejected_by_parser(
        self,
        version: object,
    ) -> None:
        payload = make_stable().to_payload()
        payload["stable_schema_version"] = version
        envelope = stable_envelope_with_payload(payload)
        with pytest.raises(InvalidRecoveryRecordError) as exc_info:
            _parse_record_envelope(envelope)
        assert not isinstance(exc_info.value, CorruptStableRecordError)

    def test_persisted_schema_version_is_passed_through(self) -> None:
        envelope = _build_envelope(RecordPhase.STABLE, make_stable(), None)
        parsed = _parse_record_envelope(envelope)
        assert parsed.stable.stable_schema_version == 1
