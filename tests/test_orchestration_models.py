import pytest

import ai_video_workflow.orchestration as orchestration_package
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.manifest import ManifestStatus
from ai_video_workflow.models import GenerationTaskStatus
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
from ai_video_workflow.providers import ProviderError, ProviderStatus

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
