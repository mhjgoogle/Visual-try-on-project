import copy
from datetime import datetime, timezone

import pytest

import ai_video_workflow.orchestration as orchestration_package
import ai_video_workflow.orchestration.planning as planning_module
from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus
from ai_video_workflow.orchestration import (
    ConflictingProviderResultError,
    ConflictingRequestError,
    IdempotencyConflictError,
    IllegalProviderTransitionError,
    InvalidOrchestrationInputError,
    InvalidOrchestrationStateError,
    OrchestrationAction,
    StaleResultError,
)
from ai_video_workflow.orchestration._models import ABSENT, _ExecutablePlan
from ai_video_workflow.orchestration.canonical import (
    PLAN_PREIMAGE_SCHEMA_VERSION,
    _compute_plan_id,
    _fingerprint,
    _make_plan_preimage,
    _make_snapshot_wrapper,
    _sha256_hex,
    _stable_self_fingerprint,
)
from ai_video_workflow.orchestration.planning import (
    _NoOpDecision,
    _OrchestrationPlanner,
)
from ai_video_workflow.orchestration.recovery import (
    _parse_stable_wrapper,
    _restore_generation_task,
    _restore_step_manifest,
    _snapshot_provider_request,
    _snapshot_provider_result,
)
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    ProviderInstruction,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)

T0 = datetime(2026, 7, 26, 9, 0, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc)
T1_ISO = "2026-07-26T10:00:00.000000+00:00"
T2 = datetime(2026, 7, 26, 11, 0, 0, tzinfo=timezone.utc)
T3 = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)

# Independently computed with hashlib over the exact canonical bytes;
# never regenerated with the functions under test.
VECTOR_PLAN_ID = "18146af8ddfc44d8afdcdd1dec556cbd7bc7b3a3bb859707229a973c7531f9fb"

TASK_FILE_FP = _sha256_hex(b"task-file")
MANIFEST_FILE_FP = _sha256_hex(b"manifest-file")

PLANNER = _OrchestrationPlanner()

ARTIFACT = ArtifactReference(
    reference="staging/task-1/clip.mp4",
    origin=ArtifactOrigin.USER,
    location=ArtifactLocation.STAGING,
)
OTHER_ARTIFACT = ArtifactReference(
    reference="staging/task-1/other.mp4",
    origin=ArtifactOrigin.USER,
    location=ArtifactLocation.STAGING,
)


def make_request(**overrides) -> ProviderRequest:
    base = dict(
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
    base.update(overrides)
    return ProviderRequest(**base)


REQUEST = make_request()
REQUEST_FP = _fingerprint(_snapshot_provider_request(REQUEST))

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


def make_result(
    status: ProviderStatus,
    observed_at: datetime = T2,
    **overrides,
) -> ProviderResult:
    base: dict = dict(
        provider_id="manual",
        task_id="task-1",
        shot_id="shot-1",
        status=status,
        observed_at=observed_at,
    )
    if status is ProviderStatus.NOT_SUBMITTED:
        base["instruction"] = INSTRUCTION
    elif status in (
        ProviderStatus.WAITING_FOR_USER,
        ProviderStatus.PROCESSING,
    ):
        base["external_task_ref"] = "ext-1"
    elif status is ProviderStatus.ARTIFACT_AVAILABLE:
        base["external_task_ref"] = "ext-1"
        base["artifact"] = ARTIFACT
    elif status is ProviderStatus.SUCCEEDED:
        base["external_task_ref"] = "ext-1"
        base["artifact"] = ARTIFACT
        base["completed_at"] = observed_at
    elif status is ProviderStatus.FAILED:
        base["external_task_ref"] = "ext-1"
        base["error_summary"] = "generation failed"
        base["completed_at"] = observed_at
    else:
        base["external_task_ref"] = "ext-1"
        base["completed_at"] = observed_at
    base.update(overrides)
    return ProviderResult(**base)


def make_task(**overrides) -> GenerationTask:
    base = dict(
        task_id="task-1",
        shot_id="shot-1",
        status=GenerationTaskStatus.PENDING,
        created_at=T0,
        updated_at=T0,
    )
    base.update(overrides)
    return GenerationTask(**base)


def make_manifest(**overrides) -> StepManifest:
    base = dict(
        step_name="generation:task-1",
        input_digest="digest-1",
        relevant_config_digest="config-1",
        status=ManifestStatus.PENDING,
        created_at=T0,
    )
    base.update(overrides)
    return StepManifest(**base)


def plan_first_prepare(**overrides) -> _ExecutablePlan:
    kwargs = dict(
        action=OrchestrationAction.PREPARE,
        operation_id="op-1",
        request=REQUEST,
        task=make_task(),
        manifest=make_manifest(),
        stable=None,
        result=make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T1),
        observed_at=T1,
        task_before_fingerprint=TASK_FILE_FP,
        manifest_before_fingerprint=MANIFEST_FILE_FP,
        instruction_before_fingerprint=ABSENT,
    )
    kwargs.update(overrides)
    return PLANNER.plan(**kwargs)


FIRST_PLAN = plan_first_prepare()
STABLE_NOT_SUBMITTED = _parse_stable_wrapper(
    FIRST_PLAN.pending_apply.planned_stable_state_snapshot
)
TASK_AFTER_PREPARE = _restore_generation_task(
    FIRST_PLAN.pending_apply.task_after_snapshot
)
MANIFEST_AFTER_PREPARE = _restore_step_manifest(
    FIRST_PLAN.pending_apply.manifest_after_snapshot
)
INSTRUCTION_TEXT_D = FIRST_PLAN.instruction_after_bytes.decode("utf-8")
INSTRUCTION_FILE_FP = FIRST_PLAN.pending_apply.instruction_after_fingerprint


def make_stable_at(
    status: ProviderStatus,
    observed_at: datetime = T2,
) -> object:
    """Return a stable snapshot whose last result has one status."""
    if status is ProviderStatus.NOT_SUBMITTED:
        return STABLE_NOT_SUBMITTED
    result = make_result(status, observed_at=observed_at)
    plan = PLANNER.plan(
        action=OrchestrationAction.SUBMIT,
        operation_id="op-seed",
        request=REQUEST,
        task=TASK_AFTER_PREPARE,
        manifest=MANIFEST_AFTER_PREPARE,
        stable=STABLE_NOT_SUBMITTED,
        result=result,
        observed_at=observed_at,
        task_before_fingerprint=TASK_FILE_FP,
        manifest_before_fingerprint=MANIFEST_FILE_FP,
        instruction_before_fingerprint=INSTRUCTION_FILE_FP,
        instruction_before_text=INSTRUCTION_TEXT_D,
    )
    return _parse_stable_wrapper(plan.pending_apply.planned_stable_state_snapshot)


def plan_subsequent(
    action: OrchestrationAction,
    result: ProviderResult,
    stable: object,
    **overrides,
) -> object:
    task = _restore_generation_task(FIRST_PLAN.pending_apply.task_after_snapshot)
    kwargs = dict(
        action=action,
        operation_id="op-9",
        request=REQUEST,
        task=task,
        manifest=MANIFEST_AFTER_PREPARE,
        stable=stable,
        result=result,
        observed_at=result.observed_at,
        task_before_fingerprint=TASK_FILE_FP,
        manifest_before_fingerprint=MANIFEST_FILE_FP,
        instruction_before_fingerprint=INSTRUCTION_FILE_FP,
        instruction_before_text=INSTRUCTION_TEXT_D,
    )
    kwargs.update(overrides)
    return PLANNER.plan(**kwargs)


class TestPlanPreimage:
    def test_schema_version_is_a_strict_int_one(self) -> None:
        assert PLAN_PREIMAGE_SCHEMA_VERSION == 1
        assert type(PLAN_PREIMAGE_SCHEMA_VERSION) is int

    def preimage_kwargs(self, **overrides) -> dict:
        base = dict(
            operation_id="op-1",
            action="prepare",
            baseline_version=0,
            request_fingerprint="ab" * 32,
            result_fingerprint="cd" * 32,
            task_before_fingerprint="11" * 32,
            task_after_fingerprint="22" * 32,
            manifest_before_fingerprint="33" * 32,
            manifest_after_fingerprint="44" * 32,
            instruction_before_fingerprint=ABSENT,
            observed_at=T1_ISO,
            completed_at=None,
            artifact_input_fingerprint=ABSENT,
        )
        base.update(overrides)
        return base

    def test_fixed_plan_id_vector(self) -> None:
        preimage = _make_plan_preimage(**self.preimage_kwargs())
        assert _compute_plan_id(preimage) == VECTOR_PLAN_ID

    @pytest.mark.parametrize("version", [0, 2, 999])
    def test_unknown_preimage_version_is_rejected(
        self,
        version: int,
    ) -> None:
        with pytest.raises(InvariantViolationError):
            _make_plan_preimage(
                plan_preimage_schema_version=version,
                **self.preimage_kwargs(),
            )

    @pytest.mark.parametrize("version", [True, False, "1", 1.0])
    def test_bool_and_non_int_preimage_versions_are_rejected(
        self,
        version: object,
    ) -> None:
        with pytest.raises(FieldTypeError):
            _make_plan_preimage(
                plan_preimage_schema_version=version,
                **self.preimage_kwargs(),
            )

    def test_compute_plan_id_requires_exact_keys(self) -> None:
        preimage = dict(_make_plan_preimage(**self.preimage_kwargs()))
        del preimage["observed_at"]
        with pytest.raises(InvariantViolationError):
            _compute_plan_id(preimage)
        preimage = dict(_make_plan_preimage(**self.preimage_kwargs()))
        preimage["extra"] = 1
        with pytest.raises(InvariantViolationError):
            _compute_plan_id(preimage)

    def test_preimage_excludes_plan_id_and_after_instruction_fields(
        self,
    ) -> None:
        keys = set(_make_plan_preimage(**self.preimage_kwargs()).keys())
        for excluded in (
            "plan_id",
            "instruction_after_fingerprint",
            "instruction_after_text",
            "planned_stable_state_wrapper_fingerprint",
            "stable_record_fingerprint",
        ):
            assert excluded not in keys

    def test_preimage_insertion_order_independence(self) -> None:
        first = _make_plan_preimage(**self.preimage_kwargs())
        reordered = dict(reversed(list(first.items())))
        assert _compute_plan_id(first) == _compute_plan_id(reordered)


class TestPlanIdentity:
    def test_plan_id_matches_the_core_preimage_only(self) -> None:
        plan = FIRST_PLAN
        pending = plan.pending_apply
        preimage = _make_plan_preimage(
            operation_id=pending.operation_id,
            action=pending.action.value,
            baseline_version=pending.baseline_version,
            request_fingerprint=pending.request_fingerprint,
            result_fingerprint=pending.result_fingerprint,
            task_before_fingerprint=pending.before_fingerprints["task"],
            task_after_fingerprint=pending.task_after_fingerprint,
            manifest_before_fingerprint=pending.before_fingerprints["manifest"],
            manifest_after_fingerprint=pending.manifest_after_fingerprint,
            instruction_before_fingerprint=pending.before_fingerprints["instruction"],
            observed_at=T1_ISO,
            completed_at=None,
            artifact_input_fingerprint=ABSENT,
        )
        assert plan.plan_id == _compute_plan_id(preimage)

    def test_plan_id_is_acyclic_and_embedded_in_instruction(self) -> None:
        plan = FIRST_PLAN
        text = plan.instruction_after_bytes.decode("utf-8")
        assert f"- plan_id: {plan.plan_id}\n" in text

    def test_instruction_fingerprint_is_stable_after_plan_id(self) -> None:
        first = plan_first_prepare()
        second = plan_first_prepare()
        assert first.plan_id == second.plan_id
        assert (
            first.pending_apply.instruction_after_fingerprint
            == second.pending_apply.instruction_after_fingerprint
        )
        assert first.pending_apply.instruction_after_fingerprint == (
            _sha256_hex(first.instruction_after_bytes)
        )

    def test_planned_stable_fingerprints_do_not_feed_plan_id(self) -> None:
        plan = FIRST_PLAN
        assert plan.pending_apply.planned_stable_state_wrapper_fingerprint
        assert plan.plan_id != (
            plan.pending_apply.planned_stable_state_wrapper_fingerprint
        )
        payload = plan.pending_apply.planned_stable_state_snapshot["payload"]
        assert plan.plan_id != payload["stable_record_fingerprint"]

    def test_repeated_planning_is_deterministic(self) -> None:
        first = plan_first_prepare()
        second = plan_first_prepare()
        assert first.pending_apply == second.pending_apply
        assert first.instruction_after_bytes == second.instruction_after_bytes


class TestFingerprintInputs:
    def test_request_fingerprint_is_over_the_full_wrapper(self) -> None:
        wrapper = _snapshot_provider_request(REQUEST)
        assert FIRST_PLAN.pending_apply.request_fingerprint == (_fingerprint(wrapper))
        assert FIRST_PLAN.pending_apply.request_fingerprint != (
            _fingerprint(dict(wrapper["payload"]))
        )

    def test_result_fingerprint_is_over_the_full_wrapper(self) -> None:
        result = make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T1)
        assert FIRST_PLAN.pending_apply.result_fingerprint == (
            _fingerprint(_snapshot_provider_result(result))
        )

    def test_after_fingerprints_are_over_snapshot_wrappers(self) -> None:
        pending = FIRST_PLAN.pending_apply
        assert pending.task_after_fingerprint == _fingerprint(
            pending.task_after_snapshot
        )
        assert pending.manifest_after_fingerprint == _fingerprint(
            pending.manifest_after_snapshot
        )

    def test_instruction_after_fingerprint_is_over_exact_bytes(self) -> None:
        assert FIRST_PLAN.pending_apply.instruction_after_fingerprint == (
            _sha256_hex(FIRST_PLAN.instruction_after_bytes)
        )

    def test_stable_self_fingerprint_excludes_itself(self) -> None:
        payload = dict(
            FIRST_PLAN.pending_apply.planned_stable_state_snapshot["payload"]
        )
        assert payload["stable_record_fingerprint"] == (
            _stable_self_fingerprint(payload)
        )

    def test_action_input_fingerprint_is_over_the_wrapper(self) -> None:
        wrapper, fingerprint = PLANNER.action_input_fingerprint(
            observed_at=T1,
            artifact=None,
            completed_at=None,
            result_fingerprint=None,
        )
        assert fingerprint == _fingerprint(wrapper)
        assert FIRST_PLAN.pending_apply.action_input_fingerprint == (fingerprint)

    def test_artifact_input_fingerprint_uses_absent_marker(self) -> None:
        stable = make_stable_at(ProviderStatus.ARTIFACT_AVAILABLE)
        plan = plan_subsequent(
            OrchestrationAction.COLLECT,
            make_result(ProviderStatus.SUCCEEDED, observed_at=T3),
            stable,
            artifact_input=ARTIFACT,
            completed_at_input=T3,
        )
        expected = _fingerprint(
            _make_snapshot_wrapper("artifact_reference", ARTIFACT.to_json_dict())
        )
        preimage = _make_plan_preimage(
            operation_id=plan.pending_apply.operation_id,
            action=plan.pending_apply.action.value,
            baseline_version=plan.pending_apply.baseline_version,
            request_fingerprint=plan.pending_apply.request_fingerprint,
            result_fingerprint=plan.pending_apply.result_fingerprint,
            task_before_fingerprint=TASK_FILE_FP,
            task_after_fingerprint=plan.pending_apply.task_after_fingerprint,
            manifest_before_fingerprint=MANIFEST_FILE_FP,
            manifest_after_fingerprint=(plan.pending_apply.manifest_after_fingerprint),
            instruction_before_fingerprint=INSTRUCTION_FILE_FP,
            observed_at=T3.isoformat(timespec="microseconds"),
            completed_at=T3.isoformat(timespec="microseconds"),
            artifact_input_fingerprint=expected,
        )
        assert plan.plan_id == _compute_plan_id(preimage)


class TestRequestConsistency:
    def test_unchanged_request_matches_the_stable_fingerprint(self) -> None:
        rebuilt = PLANNER.check_request_consistency(REQUEST, STABLE_NOT_SUBMITTED)
        assert rebuilt == STABLE_NOT_SUBMITTED.request_fingerprint

    @pytest.mark.parametrize(
        "overrides",
        [
            {"prompt": "a different cat"},
            {"width": 1920},
            {"provider_parameters": {"style": "oil"}},
            {"staging_ref": "staging/other"},
        ],
        ids=["prompt", "dimensions", "parameters", "staging"],
    )
    def test_request_drift_raises_conflicting_request_error(
        self,
        overrides: dict,
    ) -> None:
        with pytest.raises(ConflictingRequestError):
            PLANNER.check_request_consistency(
                make_request(**overrides),
                STABLE_NOT_SUBMITTED,
            )

    def test_first_operation_skips_the_comparison(self) -> None:
        rebuilt = PLANNER.check_request_consistency(
            make_request(prompt="anything"), None
        )
        assert len(rebuilt) == 64


class TestTimeAuthority:
    def test_older_observation_is_stale(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        with pytest.raises(StaleResultError):
            PLANNER.assess_observation(
                stable,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T1),
            )

    def test_equal_observation_with_equal_payload_is_noop(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        assert (
            PLANNER.assess_observation(
                stable,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T2),
            )
            == "noop"
        )

    def test_equal_observation_with_conflicting_payload_is_conflict(
        self,
    ) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        with pytest.raises(ConflictingProviderResultError):
            PLANNER.assess_observation(
                stable,
                make_result(
                    ProviderStatus.WAITING_FOR_USER,
                    observed_at=T2,
                    message="different",
                ),
            )

    def test_newer_legal_observation_applies(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        assert (
            PLANNER.assess_observation(
                stable,
                make_result(ProviderStatus.PROCESSING, observed_at=T3),
            )
            == "apply"
        )

    def test_newer_regressing_observation_is_illegal(self) -> None:
        stable = make_stable_at(ProviderStatus.ARTIFACT_AVAILABLE)
        with pytest.raises(IllegalProviderTransitionError):
            PLANNER.assess_observation(
                stable,
                make_result(ProviderStatus.PROCESSING, observed_at=T3),
            )

    def test_waiting_and_processing_are_bidirectional(self) -> None:
        stable = make_stable_at(ProviderStatus.PROCESSING)
        assert (
            PLANNER.assess_observation(
                stable,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
            )
            == "apply"
        )

    def test_equal_observation_replay_is_a_noop_plan(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        decision = plan_subsequent(
            OrchestrationAction.POLL,
            make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T2),
            stable,
        )
        assert isinstance(decision, _NoOpDecision)
        assert decision.reason == "equal_observation_replay"


ACTION_STATUS_LEGALITY = []
for action, legal in (
    (OrchestrationAction.PREPARE, {ProviderStatus.NOT_SUBMITTED}),
    (
        OrchestrationAction.SUBMIT,
        set(ProviderStatus) - {ProviderStatus.NOT_SUBMITTED},
    ),
    (
        OrchestrationAction.POLL,
        set(ProviderStatus) - {ProviderStatus.NOT_SUBMITTED},
    ),
    (
        OrchestrationAction.REPORT_ARTIFACT,
        set(ProviderStatus) - {ProviderStatus.NOT_SUBMITTED},
    ),
    (OrchestrationAction.COLLECT, {ProviderStatus.SUCCEEDED}),
    (OrchestrationAction.REPLAY_RESULT, set(ProviderStatus)),
):
    for status in ProviderStatus:
        ACTION_STATUS_LEGALITY.append((action, status, status in legal))


class TestResultStatusMatrix:
    @pytest.mark.parametrize(
        ("action", "status", "legal"),
        ACTION_STATUS_LEGALITY,
        ids=[
            f"{action.value}-{status.value}-{'legal' if legal else 'illegal'}"
            for action, status, legal in ACTION_STATUS_LEGALITY
        ],
    )
    def test_full_action_status_table(
        self,
        action: OrchestrationAction,
        status: ProviderStatus,
        legal: bool,
    ) -> None:
        result = make_result(status)
        if legal:
            PLANNER.validate_result_status(action, result)
        else:
            with pytest.raises(IllegalProviderTransitionError):
                PLANNER.validate_result_status(action, result)

    def test_submit_may_return_terminal_and_available_statuses(self) -> None:
        for status in (
            ProviderStatus.FAILED,
            ProviderStatus.CANCELLED,
            ProviderStatus.SUCCEEDED,
            ProviderStatus.ARTIFACT_AVAILABLE,
        ):
            PLANNER.validate_result_status(
                OrchestrationAction.SUBMIT, make_result(status)
            )


class TestTaskAfterMatrix:
    def plan_for_status(self, status: ProviderStatus) -> GenerationTask:
        if status is ProviderStatus.NOT_SUBMITTED:
            return TASK_AFTER_PREPARE
        stable = STABLE_NOT_SUBMITTED
        plan = plan_subsequent(
            OrchestrationAction.SUBMIT,
            make_result(status, observed_at=T3),
            stable,
        )
        return _restore_generation_task(plan.pending_apply.task_after_snapshot)

    @pytest.mark.parametrize(
        ("status", "expected_task_status"),
        [
            (ProviderStatus.NOT_SUBMITTED, GenerationTaskStatus.PENDING),
            (
                ProviderStatus.WAITING_FOR_USER,
                GenerationTaskStatus.IN_PROGRESS,
            ),
            (ProviderStatus.PROCESSING, GenerationTaskStatus.IN_PROGRESS),
            (
                ProviderStatus.ARTIFACT_AVAILABLE,
                GenerationTaskStatus.IN_PROGRESS,
            ),
            (ProviderStatus.SUCCEEDED, GenerationTaskStatus.DONE),
            (ProviderStatus.FAILED, GenerationTaskStatus.FAILED),
            (ProviderStatus.CANCELLED, GenerationTaskStatus.CANCELLED),
        ],
        ids=[status.value for status in ProviderStatus],
    )
    def test_status_mapping_and_fields(
        self,
        status: ProviderStatus,
        expected_task_status: GenerationTaskStatus,
    ) -> None:
        task_after = self.plan_for_status(status)
        assert task_after.status is expected_task_status
        assert task_after.provider_id == "manual"
        terminal = status in (
            ProviderStatus.SUCCEEDED,
            ProviderStatus.FAILED,
            ProviderStatus.CANCELLED,
        )
        if terminal:
            assert task_after.completed_at is not None
        else:
            assert task_after.completed_at is None
        if status is ProviderStatus.FAILED:
            assert task_after.error_summary == "generation failed"
        else:
            assert task_after.error_summary is None
        if status is ProviderStatus.NOT_SUBMITTED:
            assert task_after.external_task_ref is None
            assert task_after.updated_at == T1
        else:
            assert task_after.external_task_ref == "ext-1"
            assert task_after.updated_at == T3
        if status in (
            ProviderStatus.ARTIFACT_AVAILABLE,
            ProviderStatus.SUCCEEDED,
        ):
            assert task_after.current_artifact_ref == ARTIFACT.reference
        else:
            assert task_after.current_artifact_ref is None

    def test_cancelled_requires_completed_at_and_forbids_error(self) -> None:
        task_after = self.plan_for_status(ProviderStatus.CANCELLED)
        assert task_after.status is GenerationTaskStatus.CANCELLED
        assert task_after.completed_at == T3
        assert task_after.error_summary is None

    def test_stale_observed_at_is_rejected(self) -> None:
        with pytest.raises(StaleResultError):
            plan_first_prepare(
                task=make_task(updated_at=T1),
                result=make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T1),
                observed_at=T1,
            )


class TestManifestAfterMatrix:
    def manifest_for_status(self, status: ProviderStatus) -> StepManifest:
        if status is ProviderStatus.NOT_SUBMITTED:
            return MANIFEST_AFTER_PREPARE
        plan = plan_subsequent(
            OrchestrationAction.SUBMIT,
            make_result(status, observed_at=T3),
            STABLE_NOT_SUBMITTED,
            manifest=make_manifest(
                output_paths=("existing/clip.mp4",),
                output_metadata={"keep": {"nested": 1}},
            ),
        )
        return _restore_step_manifest(plan.pending_apply.manifest_after_snapshot)

    @pytest.mark.parametrize(
        "status",
        list(ProviderStatus),
        ids=[status.value for status in ProviderStatus],
    )
    def test_five_field_matrix(self, status: ProviderStatus) -> None:
        manifest_after = self.manifest_for_status(status)
        if status is ProviderStatus.FAILED:
            assert manifest_after.status is ManifestStatus.FAILED
            assert manifest_after.completed_at == T3
            assert manifest_after.error_summary == "generation failed"
        else:
            assert manifest_after.status is ManifestStatus.PENDING
            assert manifest_after.completed_at is None
            assert manifest_after.error_summary is None
        metadata = manifest_after.output_metadata["orchestration"]
        assert metadata["provider_status"] == status.value
        if status is not ProviderStatus.NOT_SUBMITTED:
            assert manifest_after.output_paths == ("existing/clip.mp4",)
            assert manifest_after.output_metadata["keep"] == {"nested": 1}
        if status is ProviderStatus.CANCELLED:
            assert metadata["cancelled"] is True
        if status is ProviderStatus.SUCCEEDED:
            assert metadata["handoff"] == ARTIFACT.to_json_dict()

    def test_output_paths_are_never_extended(self) -> None:
        manifest_after = self.manifest_for_status(ProviderStatus.SUCCEEDED)
        assert manifest_after.output_paths == ("existing/clip.mp4",)

    def test_orchestration_key_is_replaced_not_merged(self) -> None:
        plan = plan_subsequent(
            OrchestrationAction.SUBMIT,
            make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
            STABLE_NOT_SUBMITTED,
            manifest=make_manifest(
                output_metadata={
                    "orchestration": {"old": "value"},
                    "keep": True,
                }
            ),
        )
        manifest_after = _restore_step_manifest(
            plan.pending_apply.manifest_after_snapshot
        )
        assert "old" not in manifest_after.output_metadata["orchestration"]
        assert manifest_after.output_metadata["keep"] is True

    def test_terminal_manifest_cannot_be_updated(self) -> None:
        failed_manifest = make_manifest(
            status=ManifestStatus.FAILED,
            completed_at=T1,
            error_summary="already failed",
        )
        with pytest.raises(InvalidOrchestrationStateError):
            plan_subsequent(
                OrchestrationAction.SUBMIT,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                STABLE_NOT_SUBMITTED,
                manifest=failed_manifest,
            )


class TestStickyMerge:
    def test_none_from_none_preserves(self) -> None:
        payload = FIRST_PLAN.pending_apply.planned_stable_state_snapshot["payload"]
        assert payload["authoritative_external_task_ref"] is None
        assert payload["authoritative_artifact"] is None

    def test_value_from_none_is_set(self) -> None:
        plan = plan_subsequent(
            OrchestrationAction.SUBMIT,
            make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
            STABLE_NOT_SUBMITTED,
        )
        payload = plan.pending_apply.planned_stable_state_snapshot["payload"]
        assert payload["authoritative_external_task_ref"] == "ext-1"

    def test_none_result_preserves_existing_value(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        plan = plan_subsequent(
            OrchestrationAction.POLL,
            make_result(
                ProviderStatus.PROCESSING,
                observed_at=T3,
                external_task_ref=None,
            ),
            stable,
        )
        payload = plan.pending_apply.planned_stable_state_snapshot["payload"]
        assert payload["authoritative_external_task_ref"] == "ext-1"

    def test_same_value_is_a_clean_no_change(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        plan = plan_subsequent(
            OrchestrationAction.POLL,
            make_result(ProviderStatus.PROCESSING, observed_at=T3),
            stable,
        )
        payload = plan.pending_apply.planned_stable_state_snapshot["payload"]
        assert payload["authoritative_external_task_ref"] == "ext-1"

    def test_different_external_ref_is_a_legal_replacement(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        plan = plan_subsequent(
            OrchestrationAction.POLL,
            make_result(
                ProviderStatus.PROCESSING,
                observed_at=T3,
                external_task_ref="ext-2",
            ),
            stable,
        )
        payload = plan.pending_apply.planned_stable_state_snapshot["payload"]
        assert payload["authoritative_external_task_ref"] == "ext-2"

    def test_conflicting_artifact_is_rejected(self) -> None:
        stable = make_stable_at(ProviderStatus.ARTIFACT_AVAILABLE)
        with pytest.raises(ConflictingProviderResultError):
            plan_subsequent(
                OrchestrationAction.POLL,
                make_result(
                    ProviderStatus.ARTIFACT_AVAILABLE,
                    observed_at=T3,
                    artifact=OTHER_ARTIFACT,
                ),
                stable,
            )

    def test_instruction_from_non_prepare_is_illegal(self) -> None:
        stable = make_stable_at(ProviderStatus.WAITING_FOR_USER)
        result = ProviderResult(
            provider_id="manual",
            task_id="task-1",
            shot_id="shot-1",
            status=ProviderStatus.NOT_SUBMITTED,
            observed_at=T3,
            instruction=INSTRUCTION,
        )
        with pytest.raises(
            (
                IllegalProviderTransitionError,
                InvalidOrchestrationStateError,
            )
        ):
            plan_subsequent(OrchestrationAction.POLL, result, stable)

    def test_terminal_change_is_a_conflict(self) -> None:
        stable = make_stable_at(ProviderStatus.SUCCEEDED)
        with pytest.raises(ConflictingProviderResultError):
            plan_subsequent(
                OrchestrationAction.REPLAY_RESULT,
                make_result(ProviderStatus.FAILED, observed_at=T3),
                stable,
            )


class TestLegalActions:
    @pytest.mark.parametrize(
        ("status", "expected_legal", "expected_preferred"),
        [
            (
                ProviderStatus.NOT_SUBMITTED,
                (OrchestrationAction.SUBMIT,),
                OrchestrationAction.SUBMIT,
            ),
            (
                ProviderStatus.WAITING_FOR_USER,
                (
                    OrchestrationAction.POLL,
                    OrchestrationAction.REPORT_ARTIFACT,
                    OrchestrationAction.COLLECT,
                ),
                OrchestrationAction.POLL,
            ),
            (
                ProviderStatus.PROCESSING,
                (
                    OrchestrationAction.POLL,
                    OrchestrationAction.REPORT_ARTIFACT,
                ),
                OrchestrationAction.POLL,
            ),
            (
                ProviderStatus.ARTIFACT_AVAILABLE,
                (
                    OrchestrationAction.POLL,
                    OrchestrationAction.REPORT_ARTIFACT,
                    OrchestrationAction.COLLECT,
                ),
                OrchestrationAction.COLLECT,
            ),
            (ProviderStatus.SUCCEEDED, (), None),
            (ProviderStatus.FAILED, (), None),
            (ProviderStatus.CANCELLED, (), None),
        ],
        ids=[status.value for status in ProviderStatus],
    )
    def test_stable_rows(self, status, expected_legal, expected_preferred):
        stable = make_stable_at(status)
        legal, preferred = PLANNER.legal_actions_for(stable)
        assert legal == expected_legal
        assert preferred == expected_preferred

    def test_empty_state_row(self) -> None:
        legal, preferred = PLANNER.legal_actions_for(None)
        assert legal == (OrchestrationAction.PREPARE,)
        assert preferred is OrchestrationAction.PREPARE

    def test_waiting_has_multiple_legal_actions(self) -> None:
        legal, _ = PLANNER.legal_actions_for(
            make_stable_at(ProviderStatus.WAITING_FOR_USER)
        )
        assert len(legal) == 3
        assert type(legal) is tuple


class TestAdmission:
    def test_actions_without_stable_are_rejected(self) -> None:
        for action in (
            OrchestrationAction.SUBMIT,
            OrchestrationAction.POLL,
            OrchestrationAction.COLLECT,
        ):
            with pytest.raises(InvalidOrchestrationStateError):
                plan_first_prepare(
                    action=action,
                    result=make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T1),
                )

    def test_repeated_prepare_is_a_noop(self) -> None:
        decision = plan_subsequent(
            OrchestrationAction.PREPARE,
            make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T3),
            STABLE_NOT_SUBMITTED,
        )
        assert isinstance(decision, _NoOpDecision)
        assert decision.reason == "repeated_prepare"
        assert decision.legal_actions == (OrchestrationAction.SUBMIT,)

    def test_illegal_state_action_combinations_are_rejected(self) -> None:
        stable = make_stable_at(ProviderStatus.PROCESSING)
        with pytest.raises(InvalidOrchestrationStateError):
            plan_subsequent(
                OrchestrationAction.COLLECT,
                make_result(ProviderStatus.SUCCEEDED, observed_at=T3),
                stable,
            )

    def test_collect_on_succeeded_with_equal_artifact_is_noop(self) -> None:
        stable = make_stable_at(ProviderStatus.SUCCEEDED)
        decision = plan_subsequent(
            OrchestrationAction.COLLECT,
            make_result(ProviderStatus.SUCCEEDED, observed_at=T3),
            stable,
            artifact_input=ARTIFACT,
        )
        assert isinstance(decision, _NoOpDecision)
        assert decision.reason == "already_collected"

    def test_collect_on_succeeded_with_conflicting_artifact_raises(
        self,
    ) -> None:
        stable = make_stable_at(ProviderStatus.SUCCEEDED)
        with pytest.raises(ConflictingProviderResultError):
            plan_subsequent(
                OrchestrationAction.COLLECT,
                make_result(ProviderStatus.SUCCEEDED, observed_at=T3),
                stable,
                artifact_input=OTHER_ARTIFACT,
            )

    def test_terminal_replay_with_equal_result_is_noop(self) -> None:
        stable = make_stable_at(ProviderStatus.SUCCEEDED, observed_at=T2)
        decision = plan_subsequent(
            OrchestrationAction.REPLAY_RESULT,
            make_result(ProviderStatus.SUCCEEDED, observed_at=T2),
            stable,
        )
        assert isinstance(decision, _NoOpDecision)
        assert decision.reason == "terminal_replay"

    def test_same_operation_id_with_different_input_conflicts(self) -> None:
        with pytest.raises(IdempotencyConflictError):
            plan_subsequent(
                OrchestrationAction.SUBMIT,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                STABLE_NOT_SUBMITTED,
                operation_id="op-1",
            )

    def test_committed_identity_replay_is_a_noop(self) -> None:
        decision = plan_subsequent(
            OrchestrationAction.PREPARE,
            make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T1),
            STABLE_NOT_SUBMITTED,
            operation_id="op-1",
            observed_at=T1,
        )
        assert isinstance(decision, _NoOpDecision)
        assert decision.reason == "committed_operation_replay"


class TestIdentityAlignment:
    def test_first_prepare_requires_task_provider_id_none(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(task=make_task(provider_id="manual"))

    def test_first_prepare_with_none_provider_id_is_legal(self) -> None:
        assert isinstance(FIRST_PLAN, _ExecutablePlan)
        assert TASK_AFTER_PREPARE.provider_id == "manual"

    def test_task_identity_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(
                task=make_task(task_id="task-other", shot_id="shot-1"),
            )

    def test_result_identity_mismatch_is_rejected(self) -> None:
        result = ProviderResult(
            provider_id="other",
            task_id="task-1",
            shot_id="shot-1",
            status=ProviderStatus.NOT_SUBMITTED,
            observed_at=T1,
        )
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(result=result)

    def test_manifest_association_is_enforced(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(
                manifest=make_manifest(step_name="generation:task-other"),
            )


class TestExecutablePlanContract:
    def test_exact_fields_and_identity(self) -> None:
        plan = FIRST_PLAN
        assert plan.plan_id == plan.pending_apply.plan_id
        assert plan.operation_id == "op-1"
        assert plan.action is OrchestrationAction.PREPARE
        assert plan.task_id == "task-1"
        assert plan.shot_id == "shot-1"
        assert plan.provider_id == "manual"
        assert plan.baseline_version == 0
        assert plan.artifact_handoff is None

    def test_plan_is_frozen_and_unhashable(self) -> None:
        with pytest.raises(AttributeError):
            FIRST_PLAN.plan_id = "x"
        with pytest.raises(TypeError):
            hash(FIRST_PLAN)

    def test_identity_mismatch_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            _ExecutablePlan(
                plan_id=_sha256_hex(b"other"),
                operation_id=FIRST_PLAN.operation_id,
                action=FIRST_PLAN.action,
                task_id=FIRST_PLAN.task_id,
                shot_id=FIRST_PLAN.shot_id,
                provider_id=FIRST_PLAN.provider_id,
                baseline_version=FIRST_PLAN.baseline_version,
                pending_apply=FIRST_PLAN.pending_apply,
                instruction_after_bytes=FIRST_PLAN.instruction_after_bytes,
                artifact_handoff=None,
            )

    def test_instruction_bytes_pairing_is_enforced(self) -> None:
        with pytest.raises(InvariantViolationError):
            _ExecutablePlan(
                plan_id=FIRST_PLAN.plan_id,
                operation_id=FIRST_PLAN.operation_id,
                action=FIRST_PLAN.action,
                task_id=FIRST_PLAN.task_id,
                shot_id=FIRST_PLAN.shot_id,
                provider_id=FIRST_PLAN.provider_id,
                baseline_version=FIRST_PLAN.baseline_version,
                pending_apply=FIRST_PLAN.pending_apply,
                instruction_after_bytes=None,
                artifact_handoff=None,
            )
        with pytest.raises(InvariantViolationError):
            _ExecutablePlan(
                plan_id=FIRST_PLAN.plan_id,
                operation_id=FIRST_PLAN.operation_id,
                action=FIRST_PLAN.action,
                task_id=FIRST_PLAN.task_id,
                shot_id=FIRST_PLAN.shot_id,
                provider_id=FIRST_PLAN.provider_id,
                baseline_version=FIRST_PLAN.baseline_version,
                pending_apply=FIRST_PLAN.pending_apply,
                instruction_after_bytes=b"tampered bytes",
                artifact_handoff=None,
            )

    def test_collect_plan_carries_the_artifact_handoff(self) -> None:
        stable = make_stable_at(ProviderStatus.ARTIFACT_AVAILABLE)
        plan = plan_subsequent(
            OrchestrationAction.COLLECT,
            make_result(ProviderStatus.SUCCEEDED, observed_at=T3),
            stable,
            artifact_input=ARTIFACT,
            completed_at_input=T3,
        )
        assert plan.artifact_handoff is not None
        assert plan.artifact_handoff["payload"] == ARTIFACT.to_json_dict()

    def test_planning_does_not_mutate_inputs(self) -> None:
        request = make_request()
        task = make_task()
        manifest = make_manifest(output_metadata={"keep": [1, 2]})
        request_before = request.to_json_dict()
        task_before = copy.deepcopy(task)
        manifest_metadata_before = copy.deepcopy(manifest.output_metadata)
        PLANNER.plan(
            action=OrchestrationAction.PREPARE,
            operation_id="op-1",
            request=request,
            task=task,
            manifest=manifest,
            stable=None,
            result=make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T1),
            observed_at=T1,
            task_before_fingerprint=TASK_FILE_FP,
            manifest_before_fingerprint=MANIFEST_FILE_FP,
            instruction_before_fingerprint=ABSENT,
        )
        assert request.to_json_dict() == request_before
        assert task == task_before
        assert manifest.output_metadata == manifest_metadata_before

    def test_failed_planning_preserves_inputs(self) -> None:
        manifest = make_manifest(output_metadata={"keep": [1, 2]})
        before = copy.deepcopy(manifest.output_metadata)
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(
                manifest=make_manifest(step_name="generation:task-other"),
            )
        assert manifest.output_metadata == before

    def test_resume_is_not_plannable(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(action=OrchestrationAction.RESUME)

    def test_planning_symbols_are_not_exported(self) -> None:
        for name in (
            "_OrchestrationPlanner",
            "_ExecutablePlan",
            "_NoOpDecision",
            "PLAN_PREIMAGE_SCHEMA_VERSION",
        ):
            assert name not in orchestration_package.__all__

    def test_planning_module_has_no_provider_or_io_imports(self) -> None:
        import ai_video_workflow.orchestration.planning as module

        assert not hasattr(module, "os")
        assert not hasattr(module, "Path")
        assert not hasattr(module, "VideoProvider")
        assert planning_module is module


class TestReviewFixes:
    def test_subsequent_op_preserves_committed_instruction_fingerprint(
        self,
    ) -> None:
        plan = plan_subsequent(
            OrchestrationAction.SUBMIT,
            make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
            STABLE_NOT_SUBMITTED,
        )
        pending = plan.pending_apply
        assert pending.instruction_after_fingerprint == INSTRUCTION_FILE_FP
        assert pending.instruction_after_text == INSTRUCTION_TEXT_D
        assert plan.instruction_after_bytes == INSTRUCTION_TEXT_D.encode("utf-8")
        payload = pending.planned_stable_state_snapshot["payload"]
        assert payload["committed_instruction_fingerprint"] == (INSTRUCTION_FILE_FP)
        assert payload["committed_instruction_fingerprint"] == (
            STABLE_NOT_SUBMITTED.committed_instruction_fingerprint
        )

    def test_missing_instruction_carry_text_is_rejected(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_subsequent(
                OrchestrationAction.SUBMIT,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                STABLE_NOT_SUBMITTED,
                instruction_before_text=None,
            )

    def test_carry_fingerprint_must_match_the_committed_one(self) -> None:
        other_text = "# Some Other File\n"
        with pytest.raises(InvalidOrchestrationInputError):
            plan_subsequent(
                OrchestrationAction.SUBMIT,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                STABLE_NOT_SUBMITTED,
                instruction_before_text=other_text,
                instruction_before_fingerprint=_sha256_hex(other_text.encode("utf-8")),
            )

    def test_carry_text_must_match_the_before_fingerprint(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_subsequent(
                OrchestrationAction.SUBMIT,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                STABLE_NOT_SUBMITTED,
                instruction_before_text="tampered text\n",
            )

    def test_first_prepare_rejects_existing_instruction_file(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(
                instruction_before_fingerprint=_sha256_hex(b"leftover"),
            )

    def test_first_prepare_rejects_manifest_orchestration_trace(
        self,
    ) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(
                manifest=make_manifest(
                    output_metadata={"orchestration": {"stale": True}}
                ),
            )

    def test_terminal_manifest_allows_equal_terminal_replay(self) -> None:
        stable = make_stable_at(ProviderStatus.FAILED, observed_at=T2)
        failed_manifest = make_manifest(
            status=ManifestStatus.FAILED,
            completed_at=T2,
            error_summary="generation failed",
        )
        task = _restore_generation_task(FIRST_PLAN.pending_apply.task_after_snapshot)
        decision = PLANNER.plan(
            action=OrchestrationAction.REPLAY_RESULT,
            operation_id="op-9",
            request=REQUEST,
            task=task,
            manifest=failed_manifest,
            stable=stable,
            result=make_result(ProviderStatus.FAILED, observed_at=T2),
            observed_at=T2,
            task_before_fingerprint=TASK_FILE_FP,
            manifest_before_fingerprint=MANIFEST_FILE_FP,
            instruction_before_fingerprint=INSTRUCTION_FILE_FP,
            instruction_before_text=INSTRUCTION_TEXT_D,
        )
        assert isinstance(decision, _NoOpDecision)
        assert decision.reason == "terminal_replay"

    def test_terminal_manifest_still_blocks_state_updates(self) -> None:
        failed_manifest = make_manifest(
            status=ManifestStatus.FAILED,
            completed_at=T2,
            error_summary="generation failed",
        )
        with pytest.raises(InvalidOrchestrationStateError):
            plan_subsequent(
                OrchestrationAction.SUBMIT,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                STABLE_NOT_SUBMITTED,
                manifest=failed_manifest,
            )

    def test_non_collect_plan_must_not_carry_a_handoff(self) -> None:
        handoff = _make_snapshot_wrapper("artifact_reference", ARTIFACT.to_json_dict())
        with pytest.raises(InvariantViolationError):
            _ExecutablePlan(
                plan_id=FIRST_PLAN.plan_id,
                operation_id=FIRST_PLAN.operation_id,
                action=FIRST_PLAN.action,
                task_id=FIRST_PLAN.task_id,
                shot_id=FIRST_PLAN.shot_id,
                provider_id=FIRST_PLAN.provider_id,
                baseline_version=FIRST_PLAN.baseline_version,
                pending_apply=FIRST_PLAN.pending_apply,
                instruction_after_bytes=FIRST_PLAN.instruction_after_bytes,
                artifact_handoff=handoff,
            )

    def collect_plan(self) -> _ExecutablePlan:
        stable = make_stable_at(ProviderStatus.ARTIFACT_AVAILABLE)
        return plan_subsequent(
            OrchestrationAction.COLLECT,
            make_result(ProviderStatus.SUCCEEDED, observed_at=T3),
            stable,
            artifact_input=ARTIFACT,
            completed_at_input=T3,
        )

    def test_successful_collect_plan_requires_a_handoff(self) -> None:
        plan = self.collect_plan()
        with pytest.raises(InvariantViolationError):
            _ExecutablePlan(
                plan_id=plan.plan_id,
                operation_id=plan.operation_id,
                action=plan.action,
                task_id=plan.task_id,
                shot_id=plan.shot_id,
                provider_id=plan.provider_id,
                baseline_version=plan.baseline_version,
                pending_apply=plan.pending_apply,
                instruction_after_bytes=plan.instruction_after_bytes,
                artifact_handoff=None,
            )

    def test_handoff_must_equal_the_pending_result_artifact(self) -> None:
        plan = self.collect_plan()
        wrong_handoff = _make_snapshot_wrapper(
            "artifact_reference", OTHER_ARTIFACT.to_json_dict()
        )
        with pytest.raises(InvariantViolationError):
            _ExecutablePlan(
                plan_id=plan.plan_id,
                operation_id=plan.operation_id,
                action=plan.action,
                task_id=plan.task_id,
                shot_id=plan.shot_id,
                provider_id=plan.provider_id,
                baseline_version=plan.baseline_version,
                pending_apply=plan.pending_apply,
                instruction_after_bytes=plan.instruction_after_bytes,
                artifact_handoff=wrong_handoff,
            )

    def test_split_observed_at_is_rejected(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_subsequent(
                OrchestrationAction.SUBMIT,
                make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                STABLE_NOT_SUBMITTED,
                observed_at=T2,
            )

    def test_split_completed_at_is_rejected(self) -> None:
        stable = make_stable_at(ProviderStatus.ARTIFACT_AVAILABLE)
        with pytest.raises(InvalidOrchestrationInputError):
            plan_subsequent(
                OrchestrationAction.COLLECT,
                make_result(ProviderStatus.SUCCEEDED, observed_at=T3),
                stable,
                artifact_input=ARTIFACT,
                completed_at_input=T2,
            )

    def test_replay_cannot_introduce_an_instruction(self) -> None:
        bare_prepare = plan_first_prepare(
            result=make_result(
                ProviderStatus.NOT_SUBMITTED,
                observed_at=T1,
                instruction=None,
            ),
        )
        stable_without_instruction = _parse_stable_wrapper(
            bare_prepare.pending_apply.planned_stable_state_snapshot
        )
        assert stable_without_instruction.instruction_snapshot is None
        task = _restore_generation_task(bare_prepare.pending_apply.task_after_snapshot)
        manifest = _restore_step_manifest(
            bare_prepare.pending_apply.manifest_after_snapshot
        )
        with pytest.raises(IllegalProviderTransitionError):
            PLANNER.plan(
                action=OrchestrationAction.REPLAY_RESULT,
                operation_id="op-9",
                request=REQUEST,
                task=task,
                manifest=manifest,
                stable=stable_without_instruction,
                result=make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T3),
                observed_at=T3,
                task_before_fingerprint=TASK_FILE_FP,
                manifest_before_fingerprint=MANIFEST_FILE_FP,
                instruction_before_fingerprint=ABSENT,
                instruction_before_text=None,
            )

    def test_equivalent_replay_instruction_is_still_accepted(self) -> None:
        decision = plan_subsequent(
            OrchestrationAction.REPLAY_RESULT,
            make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T1),
            STABLE_NOT_SUBMITTED,
            observed_at=T1,
        )
        assert isinstance(decision, _NoOpDecision)
        assert decision.reason == "equal_observation_replay"


class TestCarryOverStableCoupling:
    def stable_without_instruction(self):
        bare_prepare = plan_first_prepare(
            result=make_result(
                ProviderStatus.NOT_SUBMITTED,
                observed_at=T1,
                instruction=None,
            ),
        )
        return _parse_stable_wrapper(
            bare_prepare.pending_apply.planned_stable_state_snapshot
        ), bare_prepare

    def test_absent_committed_rejects_claimed_instruction_file(self) -> None:
        stable, bare_prepare = self.stable_without_instruction()
        assert stable.committed_instruction_fingerprint == ABSENT
        task = _restore_generation_task(bare_prepare.pending_apply.task_after_snapshot)
        manifest = _restore_step_manifest(
            bare_prepare.pending_apply.manifest_after_snapshot
        )
        with pytest.raises(InvalidOrchestrationInputError):
            PLANNER.plan(
                action=OrchestrationAction.SUBMIT,
                operation_id="op-9",
                request=REQUEST,
                task=task,
                manifest=manifest,
                stable=stable,
                result=make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                observed_at=T3,
                task_before_fingerprint=TASK_FILE_FP,
                manifest_before_fingerprint=MANIFEST_FILE_FP,
                instruction_before_fingerprint=_sha256_hex(b"phantom"),
                instruction_before_text=None,
            )

    def test_absent_committed_rejects_provided_text(self) -> None:
        stable, bare_prepare = self.stable_without_instruction()
        task = _restore_generation_task(bare_prepare.pending_apply.task_after_snapshot)
        manifest = _restore_step_manifest(
            bare_prepare.pending_apply.manifest_after_snapshot
        )
        phantom_text = "# Phantom Instruction\n"
        with pytest.raises(InvalidOrchestrationInputError):
            PLANNER.plan(
                action=OrchestrationAction.SUBMIT,
                operation_id="op-9",
                request=REQUEST,
                task=task,
                manifest=manifest,
                stable=stable,
                result=make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
                observed_at=T3,
                task_before_fingerprint=TASK_FILE_FP,
                manifest_before_fingerprint=MANIFEST_FILE_FP,
                instruction_before_fingerprint=_sha256_hex(
                    phantom_text.encode("utf-8")
                ),
                instruction_before_text=phantom_text,
            )

    def test_absent_committed_carry_over_still_plans(self) -> None:
        stable, bare_prepare = self.stable_without_instruction()
        task = _restore_generation_task(bare_prepare.pending_apply.task_after_snapshot)
        manifest = _restore_step_manifest(
            bare_prepare.pending_apply.manifest_after_snapshot
        )
        plan = PLANNER.plan(
            action=OrchestrationAction.SUBMIT,
            operation_id="op-9",
            request=REQUEST,
            task=task,
            manifest=manifest,
            stable=stable,
            result=make_result(ProviderStatus.WAITING_FOR_USER, observed_at=T3),
            observed_at=T3,
            task_before_fingerprint=TASK_FILE_FP,
            manifest_before_fingerprint=MANIFEST_FILE_FP,
            instruction_before_fingerprint=ABSENT,
            instruction_before_text=None,
        )
        assert isinstance(plan, _ExecutablePlan)
        assert plan.pending_apply.instruction_after_fingerprint == ABSENT
        assert plan.instruction_after_bytes is None
        payload = plan.pending_apply.planned_stable_state_snapshot["payload"]
        assert payload["committed_instruction_fingerprint"] == ABSENT

    def test_first_prepare_rejects_provided_text(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            plan_first_prepare(
                instruction_before_text="# Leftover Instruction\n",
            )

    def test_stale_before_fingerprint_is_rejected_even_with_valid_text(
        self,
    ) -> None:
        other_text = "# Some Other File\n"
        with pytest.raises(InvalidOrchestrationInputError):
            plan_subsequent(
                OrchestrationAction.REPLAY_RESULT,
                make_result(ProviderStatus.NOT_SUBMITTED, observed_at=T1),
                STABLE_NOT_SUBMITTED,
                instruction_before_fingerprint=_sha256_hex(other_text.encode("utf-8")),
                instruction_before_text=other_text,
            )
