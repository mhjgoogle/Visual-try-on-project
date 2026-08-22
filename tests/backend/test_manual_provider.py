from datetime import datetime, timedelta, timezone

import pytest

import ai_video_workflow.providers as providers_package
import ai_video_workflow.providers.manual as manual_module
from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.providers import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    InvalidProviderRequestError,
    InvalidProviderStateError,
    ManualVideoProvider,
    MissingArtifactReferenceError,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
    VideoProvider,
)

# Distinct aware-UTC timestamps per lifecycle call so a test fails if an
# implementation wrongly inherits the previous result's observed_at
# instead of using the explicitly passed one.
OBSERVED_AT = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
PREPARED_AT = OBSERVED_AT
SUBMITTED_AT = OBSERVED_AT + timedelta(minutes=1)
WAITING_POLLED_AT = OBSERVED_AT + timedelta(minutes=2)
AVAILABLE_POLLED_AT = OBSERVED_AT + timedelta(minutes=3)
REPOLLED_AT = OBSERVED_AT + timedelta(minutes=4)
COLLECTED_AT = OBSERVED_AT + timedelta(minutes=5)
EARLIER = COLLECTED_AT - timedelta(seconds=30)
LATER = COLLECTED_AT + timedelta(seconds=30)
NAIVE_AT = datetime(2026, 7, 26, 12, 0, 0)
TOKYO_AT = datetime(2026, 7, 26, 21, 0, 0, tzinfo=timezone(timedelta(hours=9)))

MANUAL_STATUSES = {
    ProviderStatus.NOT_SUBMITTED,
    ProviderStatus.WAITING_FOR_USER,
    ProviderStatus.ARTIFACT_AVAILABLE,
    ProviderStatus.SUCCEEDED,
}

SUBMIT_FORBIDDEN_STATUSES = (
    ProviderStatus.WAITING_FOR_USER,
    ProviderStatus.PROCESSING,
    ProviderStatus.ARTIFACT_AVAILABLE,
    ProviderStatus.SUCCEEDED,
    ProviderStatus.FAILED,
    ProviderStatus.CANCELLED,
)

PROGRESS_FORBIDDEN_STATUSES = (
    ProviderStatus.NOT_SUBMITTED,
    ProviderStatus.PROCESSING,
    ProviderStatus.SUCCEEDED,
    ProviderStatus.FAILED,
    ProviderStatus.CANCELLED,
)

IMPOSSIBLE_FIELD_VALUES = {
    "external_task_ref": "remote/job-1",
    "message": "unexpected note",
    "elapsed_seconds": 1.5,
    "cost_observation": None,  # replaced lazily to avoid import-order issues
}

FORBIDDEN_FILESYSTEM_TARGETS = (
    "pathlib.Path.exists",
    "os.path.exists",
    "glob.glob",
    "pathlib.Path.glob",
    "pathlib.Path.rglob",
    "os.walk",
    "os.scandir",
    "os.listdir",
    "builtins.open",
    "pathlib.Path.open",
)


def make_request(**overrides) -> ProviderRequest:
    kwargs = {
        "provider_id": "manual",
        "task_id": "task-001",
        "shot_id": "shot-001",
        "prompt": "A cat walking on a rainy street",
        "duration_seconds": 4.0,
        "width": 1920,
        "height": 1080,
        "frame_rate": 24.0,
        "staging_ref": "staging/task-001",
        "provider_parameters": {"style": "anime", "tags": ["cat", "rain"]},
    }
    kwargs.update(overrides)
    return ProviderRequest(**kwargs)


def make_artifact(**overrides) -> ArtifactReference:
    kwargs = {
        "reference": "staging/task-001/s01_sh001.mp4",
        "origin": ArtifactOrigin.USER,
        "location": ArtifactLocation.STAGING,
    }
    kwargs.update(overrides)
    return ArtifactReference(**kwargs)


def make_snapshot(status: ProviderStatus, **overrides) -> ProviderResult:
    """Build a matrix-valid ProviderResult snapshot for any status."""
    kwargs = {
        "provider_id": "manual",
        "task_id": "task-001",
        "shot_id": "shot-001",
        "status": status,
        "observed_at": OBSERVED_AT,
    }
    if status in (ProviderStatus.ARTIFACT_AVAILABLE, ProviderStatus.SUCCEEDED):
        kwargs["artifact"] = make_artifact()
    if status.is_terminal:
        kwargs["completed_at"] = OBSERVED_AT
    if status is ProviderStatus.FAILED:
        kwargs["error_summary"] = "reported failure"
    kwargs.update(overrides)
    return ProviderResult(**kwargs)


def make_waiting(provider: ManualVideoProvider, request: ProviderRequest):
    prepared = provider.prepare(request, observed_at=PREPARED_AT)
    return provider.submit(request, prepared, observed_at=SUBMITTED_AT)


def make_available(provider, request, artifact):
    waiting = make_waiting(provider, request)
    return provider.poll(
        request,
        waiting,
        observed_at=AVAILABLE_POLLED_AT,
        reported_artifact=artifact,
    )


def impossible_field_value(field_name: str):
    if field_name == "cost_observation":
        return providers_package.ProviderCostObservation(amount=1.0, unit="USD")
    return IMPOSSIBLE_FIELD_VALUES[field_name]


def assert_propagation(
    result: ProviderResult,
    request: ProviderRequest,
    *,
    status: ProviderStatus,
    observed_at: datetime,
    artifact: ArtifactReference | None = None,
    expect_instruction: bool = False,
    completed_at: datetime | None = None,
) -> None:
    """Assert all thirteen result fields against the propagation table."""
    assert result.provider_id == "manual"
    assert result.task_id == request.task_id
    assert result.shot_id == request.shot_id
    assert result.status is status
    assert result.observed_at == observed_at
    assert result.external_task_ref is None
    assert result.artifact is artifact
    assert (result.instruction is not None) is expect_instruction
    assert result.message is None
    assert result.error_summary is None
    assert result.completed_at == completed_at
    assert result.elapsed_seconds is None
    assert result.cost_observation is None


def _make_tripwire(target: str):
    def tripwire(*args, **kwargs):
        pytest.fail(f"forbidden filesystem call: {target}")

    return tripwire


def _arm_filesystem_tripwires(scoped) -> None:
    for target in FORBIDDEN_FILESYSTEM_TARGETS:
        scoped.setattr(target, _make_tripwire(target))


class TestIdentity:
    def test_is_video_provider(self) -> None:
        assert isinstance(ManualVideoProvider(), VideoProvider)

    def test_provider_id_value(self) -> None:
        assert ManualVideoProvider().provider_id == "manual"

    def test_provider_id_is_read_only_property(self) -> None:
        provider = ManualVideoProvider()
        with pytest.raises(AttributeError):
            provider.provider_id = "other"

    def test_provider_id_cannot_be_overridden_low_level(self) -> None:
        provider = ManualVideoProvider()
        with pytest.raises(AttributeError):
            object.__setattr__(provider, "provider_id", "other")
        assert provider.provider_id == "manual"

    def test_declares_empty_slots_and_no_state(self) -> None:
        assert ManualVideoProvider.__slots__ == ()
        assert VideoProvider.__slots__ == ()
        assert "__init__" not in vars(ManualVideoProvider)

    def test_instance_has_no_dict(self) -> None:
        provider = ManualVideoProvider()
        assert not hasattr(provider, "__dict__")

    def test_arbitrary_state_attributes_are_rejected(self) -> None:
        provider = ManualVideoProvider()
        with pytest.raises(AttributeError):
            provider.some_state = "value"
        with pytest.raises(AttributeError):
            object.__setattr__(provider, "some_state", "value")
        with pytest.raises(AttributeError):
            provider.provider_id = "other"
        with pytest.raises(AttributeError):
            object.__setattr__(provider, "provider_id", "other")
        assert provider.provider_id == "manual"
        assert not hasattr(provider, "__dict__")
        assert not hasattr(provider, "some_state")

    def test_repeated_reads_are_stable(self) -> None:
        provider = ManualVideoProvider()
        assert {provider.provider_id for _ in range(5)} == {"manual"}


class TestPrepare:
    def test_valid_path(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        result = provider.prepare(request, observed_at=PREPARED_AT)
        assert_propagation(
            result,
            request,
            status=ProviderStatus.NOT_SUBMITTED,
            observed_at=PREPARED_AT,
            expect_instruction=True,
        )

    def test_request_type_error(self) -> None:
        with pytest.raises(FieldTypeError):
            ManualVideoProvider().prepare(
                {"provider_id": "manual"},
                observed_at=PREPARED_AT,
            )

    def test_provider_id_mismatch(self) -> None:
        with pytest.raises(InvalidProviderRequestError):
            ManualVideoProvider().prepare(
                make_request(provider_id="cloud"),
                observed_at=PREPARED_AT,
            )

    def test_missing_staging_ref(self) -> None:
        with pytest.raises(InvalidProviderRequestError):
            ManualVideoProvider().prepare(
                make_request(staging_ref=None),
                observed_at=PREPARED_AT,
            )

    def test_instruction_fields_are_complete(self) -> None:
        request = make_request()
        instruction = (
            ManualVideoProvider()
            .prepare(
                request,
                observed_at=PREPARED_AT,
            )
            .instruction
        )
        assert instruction.provider_id == "manual"
        assert instruction.task_id == request.task_id
        assert instruction.shot_id == request.shot_id
        assert instruction.prompt == request.prompt
        assert instruction.expected_duration_seconds == request.duration_seconds
        assert instruction.expected_width == request.width
        assert instruction.expected_height == request.height
        assert instruction.expected_frame_rate == request.frame_rate
        assert instruction.staging_ref == request.staging_ref

    def test_steps_are_stable_and_non_empty(self) -> None:
        provider = ManualVideoProvider()
        first = provider.prepare(make_request(), observed_at=PREPARED_AT)
        second = provider.prepare(make_request(), observed_at=PREPARED_AT)
        steps = first.instruction.steps
        assert type(steps) is tuple
        assert len(steps) > 0
        assert all(type(step) is str and step for step in steps)
        assert steps == second.instruction.steps

    def test_suggested_parameters_are_thawed_and_refrozen(self) -> None:
        request = make_request(
            provider_parameters={"style": "anime", "tags": ["cat"]},
        )
        instruction = (
            ManualVideoProvider()
            .prepare(
                request,
                observed_at=PREPARED_AT,
            )
            .instruction
        )
        assert dict(instruction.suggested_parameters) == {
            "style": "anime",
            "tags": ("cat",),
        }
        with pytest.raises(TypeError):
            instruction.suggested_parameters["style"] = "noir"

    def test_same_request_yields_equal_instruction(self) -> None:
        provider = ManualVideoProvider()
        first = provider.prepare(make_request(), observed_at=PREPARED_AT)
        second = provider.prepare(make_request(), observed_at=PREPARED_AT)
        assert first.instruction == second.instruction

    def test_request_is_not_modified(self) -> None:
        request = make_request()
        snapshot = request.to_json_dict()
        ManualVideoProvider().prepare(request, observed_at=PREPARED_AT)
        assert request.to_json_dict() == snapshot


class TestSubmit:
    def test_valid_path(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        result = provider.submit(request, prepared, observed_at=SUBMITTED_AT)
        assert_propagation(
            result,
            request,
            status=ProviderStatus.WAITING_FOR_USER,
            observed_at=SUBMITTED_AT,
        )
        assert result.requires_user_action is True

    @pytest.mark.parametrize("status", SUBMIT_FORBIDDEN_STATUSES)
    def test_all_forbidden_precondition_statuses(
        self,
        status: ProviderStatus,
    ) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        current = make_snapshot(status)
        snapshot = current.to_json_dict()
        with pytest.raises(InvalidProviderStateError):
            provider.submit(request, current, observed_at=SUBMITTED_AT)
        assert current.to_json_dict() == snapshot

    def test_missing_instruction(self) -> None:
        provider = ManualVideoProvider()
        bare_prepared = make_snapshot(ProviderStatus.NOT_SUBMITTED)
        with pytest.raises(InvalidProviderStateError):
            provider.submit(
                make_request(),
                bare_prepared,
                observed_at=SUBMITTED_AT,
            )

    def test_identity_mismatch(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        with pytest.raises(InvalidProviderRequestError):
            provider.submit(
                make_request(task_id="task-999"),
                prepared,
                observed_at=SUBMITTED_AT,
            )

    @pytest.mark.parametrize(
        "field_name",
        ["message", "elapsed_seconds", "cost_observation"],
    )
    def test_rejects_impossible_snapshot_fields(self, field_name: str) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        instruction = provider.prepare(
            request,
            observed_at=PREPARED_AT,
        ).instruction
        tainted = make_snapshot(
            ProviderStatus.NOT_SUBMITTED,
            instruction=instruction,
            **{field_name: impossible_field_value(field_name)},
        )
        with pytest.raises(InvalidProviderRequestError):
            provider.submit(request, tainted, observed_at=SUBMITTED_AT)

    def test_rejects_corrupted_external_task_ref_snapshot(self) -> None:
        """Reject, never silently clean, a corrupted prepared snapshot.

        A normal NOT_SUBMITTED ProviderResult forbids external_task_ref,
        so this test corrupts a fully valid prepared snapshot with
        object.__setattr__ ONLY to simulate corrupted, non-standard, or
        future-deserialization input; production code must never modify
        frozen models this way. It verifies the manual boundary rejects
        the damaged snapshot instead of silently cleaning or repairing
        it.
        """
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        instruction = prepared.instruction
        object.__setattr__(
            prepared,
            "external_task_ref",
            "external-task-corrupted",
        )
        snapshot = prepared.to_json_dict()
        with pytest.raises(InvalidProviderRequestError):
            provider.submit(request, prepared, observed_at=SUBMITTED_AT)
        assert prepared.external_task_ref == "external-task-corrupted"
        assert prepared.instruction is instruction
        assert prepared.to_json_dict() == snapshot

    def test_prepared_is_not_modified(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        instruction = prepared.instruction
        snapshot = prepared.to_json_dict()
        provider.submit(request, prepared, observed_at=SUBMITTED_AT)
        assert prepared.to_json_dict() == snapshot
        assert prepared.instruction is instruction


class TestPoll:
    def test_waiting_without_reported_artifact(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        result = provider.poll(request, waiting, observed_at=WAITING_POLLED_AT)
        assert_propagation(
            result,
            request,
            status=ProviderStatus.WAITING_FOR_USER,
            observed_at=WAITING_POLLED_AT,
        )

    def test_waiting_with_reported_artifact(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        reported = make_artifact()
        result = provider.poll(
            request,
            waiting,
            observed_at=WAITING_POLLED_AT,
            reported_artifact=reported,
        )
        assert_propagation(
            result,
            request,
            status=ProviderStatus.ARTIFACT_AVAILABLE,
            observed_at=WAITING_POLLED_AT,
            artifact=reported,
        )
        assert result.artifact is reported

    def test_available_without_reported_is_idempotent(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        result = provider.poll(request, available, observed_at=REPOLLED_AT)
        assert_propagation(
            result,
            request,
            status=ProviderStatus.ARTIFACT_AVAILABLE,
            observed_at=REPOLLED_AT,
            artifact=available.artifact,
        )
        assert result.artifact is available.artifact

    def test_available_with_equal_reported_keeps_canonical(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        equal_but_distinct = make_artifact()
        assert equal_but_distinct is not available.artifact
        result = provider.poll(
            request,
            available,
            observed_at=REPOLLED_AT,
            reported_artifact=equal_but_distinct,
        )
        assert_propagation(
            result,
            request,
            status=ProviderStatus.ARTIFACT_AVAILABLE,
            observed_at=REPOLLED_AT,
            artifact=available.artifact,
        )
        assert result.artifact is available.artifact
        assert result.artifact is not equal_but_distinct

    def test_available_with_conflicting_reported(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        with pytest.raises(InvalidProviderRequestError):
            provider.poll(
                request,
                available,
                observed_at=REPOLLED_AT,
                reported_artifact=make_artifact(reference="staging/other.mp4"),
            )

    @pytest.mark.parametrize("status", PROGRESS_FORBIDDEN_STATUSES)
    def test_all_forbidden_precondition_statuses(
        self,
        status: ProviderStatus,
    ) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        current = make_snapshot(status)
        snapshot = current.to_json_dict()
        with pytest.raises(InvalidProviderStateError):
            provider.poll(request, current, observed_at=WAITING_POLLED_AT)
        assert current.to_json_dict() == snapshot

    def test_reported_artifact_type_error(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        with pytest.raises(FieldTypeError):
            provider.poll(
                request,
                waiting,
                observed_at=WAITING_POLLED_AT,
                reported_artifact="staging/a.mp4",
            )

    def test_identity_mismatch(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        with pytest.raises(InvalidProviderRequestError):
            provider.poll(
                make_request(shot_id="shot-999"),
                waiting,
                observed_at=WAITING_POLLED_AT,
            )

    @pytest.mark.parametrize(
        "field_name",
        ["external_task_ref", "message", "elapsed_seconds", "cost_observation"],
    )
    def test_rejects_impossible_snapshot_fields(self, field_name: str) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        tainted = make_snapshot(
            ProviderStatus.WAITING_FOR_USER,
            **{field_name: impossible_field_value(field_name)},
        )
        with pytest.raises(InvalidProviderRequestError):
            provider.poll(request, tainted, observed_at=WAITING_POLLED_AT)

    def test_current_is_not_modified(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        snapshot = waiting.to_json_dict()
        provider.poll(request, waiting, observed_at=WAITING_POLLED_AT)
        assert waiting.to_json_dict() == snapshot


class TestCollect:
    def test_waiting_with_explicit_artifact(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        explicit = make_artifact()
        result = provider.collect(
            request,
            waiting,
            artifact=explicit,
            observed_at=COLLECTED_AT,
        )
        assert_propagation(
            result,
            request,
            status=ProviderStatus.SUCCEEDED,
            observed_at=COLLECTED_AT,
            artifact=explicit,
            completed_at=COLLECTED_AT,
        )
        assert result.artifact is explicit

    def test_waiting_without_artifact(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        with pytest.raises(MissingArtifactReferenceError):
            provider.collect(request, waiting, observed_at=COLLECTED_AT)

    def test_available_without_explicit_artifact(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        result = provider.collect(request, available, observed_at=COLLECTED_AT)
        assert_propagation(
            result,
            request,
            status=ProviderStatus.SUCCEEDED,
            observed_at=COLLECTED_AT,
            artifact=available.artifact,
            completed_at=COLLECTED_AT,
        )
        assert result.artifact is available.artifact

    def test_available_with_equal_artifact_keeps_canonical(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        equal_but_distinct = make_artifact()
        result = provider.collect(
            request,
            available,
            artifact=equal_but_distinct,
            observed_at=COLLECTED_AT,
        )
        assert_propagation(
            result,
            request,
            status=ProviderStatus.SUCCEEDED,
            observed_at=COLLECTED_AT,
            artifact=available.artifact,
            completed_at=COLLECTED_AT,
        )
        assert result.artifact is available.artifact
        assert result.artifact is not equal_but_distinct

    def test_available_with_conflicting_artifact(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        with pytest.raises(InvalidProviderRequestError):
            provider.collect(
                request,
                available,
                artifact=make_artifact(reference="staging/other.mp4"),
                observed_at=COLLECTED_AT,
            )

    @pytest.mark.parametrize("status", PROGRESS_FORBIDDEN_STATUSES)
    def test_all_forbidden_precondition_statuses(
        self,
        status: ProviderStatus,
    ) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        current = make_snapshot(status)
        snapshot = current.to_json_dict()
        with pytest.raises(InvalidProviderStateError):
            provider.collect(
                request,
                current,
                artifact=make_artifact(),
                observed_at=COLLECTED_AT,
            )
        assert current.to_json_dict() == snapshot

    def test_artifact_type_error(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        with pytest.raises(FieldTypeError):
            provider.collect(
                request,
                waiting,
                artifact="staging/a.mp4",
                observed_at=COLLECTED_AT,
            )

    def test_identity_mismatch(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        with pytest.raises(InvalidProviderRequestError):
            provider.collect(
                make_request(provider_id="manual", task_id="task-999"),
                waiting,
                artifact=make_artifact(),
                observed_at=COLLECTED_AT,
            )

    @pytest.mark.parametrize(
        "field_name",
        ["external_task_ref", "message", "elapsed_seconds", "cost_observation"],
    )
    def test_rejects_impossible_snapshot_fields(self, field_name: str) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        tainted = make_snapshot(
            ProviderStatus.WAITING_FOR_USER,
            **{field_name: impossible_field_value(field_name)},
        )
        with pytest.raises(InvalidProviderRequestError):
            provider.collect(
                request,
                tainted,
                artifact=make_artifact(),
                observed_at=COLLECTED_AT,
            )

    def test_explicit_completed_at_is_used_verbatim(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        explicit = make_artifact()
        result = provider.collect(
            request,
            waiting,
            artifact=explicit,
            observed_at=COLLECTED_AT,
            completed_at=EARLIER,
        )
        assert_propagation(
            result,
            request,
            status=ProviderStatus.SUCCEEDED,
            observed_at=COLLECTED_AT,
            artifact=explicit,
            completed_at=EARLIER,
        )

    def test_default_completed_at_is_observed_at(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        explicit = make_artifact()
        result = provider.collect(
            request,
            waiting,
            artifact=explicit,
            observed_at=COLLECTED_AT,
        )
        assert_propagation(
            result,
            request,
            status=ProviderStatus.SUCCEEDED,
            observed_at=COLLECTED_AT,
            artifact=explicit,
            completed_at=COLLECTED_AT,
        )

    def test_completed_at_equal_to_observed_is_valid(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        result = provider.collect(
            request,
            waiting,
            artifact=make_artifact(),
            observed_at=COLLECTED_AT,
            completed_at=COLLECTED_AT,
        )
        assert result.completed_at == COLLECTED_AT

    @pytest.mark.parametrize(
        "completed_at",
        [LATER, NAIVE_AT, TOKYO_AT],
    )
    def test_invalid_completed_at_is_rejected(self, completed_at) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        with pytest.raises(InvariantViolationError):
            provider.collect(
                request,
                waiting,
                artifact=make_artifact(),
                observed_at=COLLECTED_AT,
                completed_at=completed_at,
            )

    def test_current_is_not_modified(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        snapshot = available.to_json_dict()
        provider.collect(request, available, observed_at=COLLECTED_AT)
        assert available.to_json_dict() == snapshot


class TestLifecycleBoundaries:
    def test_manual_only_produces_four_statuses(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        waiting = provider.submit(request, prepared, observed_at=SUBMITTED_AT)
        still_waiting = provider.poll(
            request,
            waiting,
            observed_at=WAITING_POLLED_AT,
        )
        available = provider.poll(
            request,
            waiting,
            observed_at=AVAILABLE_POLLED_AT,
            reported_artifact=make_artifact(),
        )
        collected = provider.collect(
            request,
            available,
            observed_at=COLLECTED_AT,
        )
        produced = {
            prepared.status,
            waiting.status,
            still_waiting.status,
            available.status,
            collected.status,
        }
        assert produced == MANUAL_STATUSES

    def test_lifecycle_results_use_call_specific_observed_at(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        waiting = provider.submit(request, prepared, observed_at=SUBMITTED_AT)
        available = provider.poll(
            request,
            waiting,
            observed_at=AVAILABLE_POLLED_AT,
            reported_artifact=make_artifact(),
        )
        collected = provider.collect(
            request,
            available,
            observed_at=COLLECTED_AT,
        )
        assert prepared.observed_at == PREPARED_AT
        assert waiting.observed_at == SUBMITTED_AT
        assert available.observed_at == AVAILABLE_POLLED_AT
        assert collected.observed_at == COLLECTED_AT

    def test_all_results_follow_field_limits(self) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        waiting = provider.submit(request, prepared, observed_at=SUBMITTED_AT)
        available = provider.poll(
            request,
            waiting,
            observed_at=AVAILABLE_POLLED_AT,
            reported_artifact=make_artifact(),
        )
        collected = provider.collect(
            request,
            available,
            observed_at=COLLECTED_AT,
        )
        for result in (prepared, waiting, available, collected):
            assert result.external_task_ref is None
            assert result.message is None
            assert result.error_summary is None
            assert result.elapsed_seconds is None
            assert result.cost_observation is None

    def test_module_has_no_external_or_business_dependencies(self) -> None:
        namespace = vars(manual_module)
        banned = (
            "os",
            "pathlib",
            "Path",
            "glob",
            "subprocess",
            "shutil",
            "socket",
            "urllib",
            "requests",
            "http",
            "VideoAsset",
            "GenerationTask",
            "StepManifest",
        )
        for name in banned:
            assert name not in namespace


class TestFilesystemProhibition:
    def test_prepare_never_touches_filesystem(self, monkeypatch) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        with monkeypatch.context() as scoped:
            _arm_filesystem_tripwires(scoped)
            result = provider.prepare(request, observed_at=PREPARED_AT)
        assert result.status is ProviderStatus.NOT_SUBMITTED

    def test_submit_never_touches_filesystem(self, monkeypatch) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        prepared = provider.prepare(request, observed_at=PREPARED_AT)
        with monkeypatch.context() as scoped:
            _arm_filesystem_tripwires(scoped)
            result = provider.submit(request, prepared, observed_at=SUBMITTED_AT)
        assert result.status is ProviderStatus.WAITING_FOR_USER

    def test_poll_never_touches_filesystem(self, monkeypatch) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        waiting = make_waiting(provider, request)
        with monkeypatch.context() as scoped:
            _arm_filesystem_tripwires(scoped)
            result = provider.poll(
                request,
                waiting,
                observed_at=WAITING_POLLED_AT,
            )
        assert result.status is ProviderStatus.WAITING_FOR_USER

    def test_collect_never_touches_filesystem(self, monkeypatch) -> None:
        provider = ManualVideoProvider()
        request = make_request()
        available = make_available(provider, request, make_artifact())
        with monkeypatch.context() as scoped:
            _arm_filesystem_tripwires(scoped)
            result = provider.collect(
                request,
                available,
                observed_at=COLLECTED_AT,
            )
        assert result.status is ProviderStatus.SUCCEEDED


class TestPublicExports:
    def test_manual_video_provider_is_exported(self) -> None:
        assert providers_package.ManualVideoProvider is ManualVideoProvider
        assert "ManualVideoProvider" in providers_package.__all__

    def test_video_provider_still_exported(self) -> None:
        assert providers_package.VideoProvider is VideoProvider

    def test_every_declared_export_is_importable(self) -> None:
        for name in providers_package.__all__:
            assert hasattr(providers_package, name)
