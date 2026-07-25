import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import MappingProxyType

import pytest

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.manifest import ManifestStatus
from ai_video_workflow.models import GenerationTaskStatus
from ai_video_workflow.providers import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    InvalidProviderRequestError,
    InvalidProviderStateError,
    ProviderCostObservation,
    ProviderError,
    ProviderInstruction,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)

OBSERVED_AT = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
EARLIER = OBSERVED_AT - timedelta(seconds=30)
LATER = OBSERVED_AT + timedelta(seconds=30)
NAIVE_AT = datetime(2026, 7, 26, 12, 0, 0)
TOKYO_AT = datetime(2026, 7, 26, 21, 0, 0, tzinfo=timezone(timedelta(hours=9)))

NON_TERMINAL_STATUSES = (
    ProviderStatus.NOT_SUBMITTED,
    ProviderStatus.WAITING_FOR_USER,
    ProviderStatus.PROCESSING,
    ProviderStatus.ARTIFACT_AVAILABLE,
)
TERMINAL_STATUSES = (
    ProviderStatus.SUCCEEDED,
    ProviderStatus.FAILED,
    ProviderStatus.CANCELLED,
)


def make_artifact(**overrides) -> ArtifactReference:
    kwargs = {
        "reference": "staging/task-001/s01_sh001.mp4",
        "origin": ArtifactOrigin.USER,
        "location": ArtifactLocation.STAGING,
    }
    kwargs.update(overrides)
    return ArtifactReference(**kwargs)


def make_cost(**overrides) -> ProviderCostObservation:
    kwargs = {"amount": 1.25, "unit": "USD"}
    kwargs.update(overrides)
    return ProviderCostObservation(**kwargs)


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
        "provider_parameters": {
            "style": "anime",
            "tags": ["cat", "rain"],
            "config": {"steps": 20, "seed": 7},
        },
    }
    kwargs.update(overrides)
    return ProviderRequest(**kwargs)


def make_instruction(**overrides) -> ProviderInstruction:
    kwargs = {
        "provider_id": "manual",
        "task_id": "task-001",
        "shot_id": "shot-001",
        "prompt": "A cat walking on a rainy street",
        "expected_duration_seconds": 4.0,
        "expected_width": 1920,
        "expected_height": 1080,
        "expected_frame_rate": 24.0,
        "staging_ref": "staging/task-001",
        "steps": ("Open the web video tool", "Generate one video"),
        "suggested_parameters": {"style": "anime"},
    }
    kwargs.update(overrides)
    return ProviderInstruction(**kwargs)


def result_kwargs(status: ProviderStatus, **overrides) -> dict:
    kwargs = {
        "provider_id": "manual",
        "task_id": "task-001",
        "shot_id": "shot-001",
        "status": status,
        "observed_at": OBSERVED_AT,
    }
    if status in (ProviderStatus.ARTIFACT_AVAILABLE, ProviderStatus.SUCCEEDED):
        kwargs["artifact"] = make_artifact()
    if status in TERMINAL_STATUSES:
        kwargs["completed_at"] = OBSERVED_AT
    if status is ProviderStatus.FAILED:
        kwargs["error_summary"] = "user reported the generation failed"
    kwargs.update(overrides)
    return kwargs


def make_result(status: ProviderStatus, **overrides) -> ProviderResult:
    return ProviderResult(**result_kwargs(status, **overrides))


class TestEnums:
    def test_artifact_origin_values(self) -> None:
        assert [member.value for member in ArtifactOrigin] == ["user", "provider"]

    def test_artifact_location_values(self) -> None:
        assert [member.value for member in ArtifactLocation] == [
            "external",
            "staging",
        ]

    def test_provider_status_values(self) -> None:
        assert [member.value for member in ProviderStatus] == [
            "not_submitted",
            "waiting_for_user",
            "processing",
            "artifact_available",
            "succeeded",
            "failed",
            "cancelled",
        ]

    def test_provider_status_is_distinct_from_task_status(self) -> None:
        assert ProviderStatus is not GenerationTaskStatus
        assert not isinstance(ProviderStatus.FAILED, GenerationTaskStatus)
        assert not isinstance(GenerationTaskStatus.FAILED, ProviderStatus)

    def test_provider_status_is_distinct_from_manifest_status(self) -> None:
        assert ProviderStatus is not ManifestStatus
        assert not isinstance(ProviderStatus.FAILED, ManifestStatus)
        assert not isinstance(ManifestStatus.FAILED, ProviderStatus)

    @pytest.mark.parametrize("status", TERMINAL_STATUSES)
    def test_terminal_statuses(self, status: ProviderStatus) -> None:
        assert status.is_terminal is True

    @pytest.mark.parametrize("status", NON_TERMINAL_STATUSES)
    def test_non_terminal_statuses(self, status: ProviderStatus) -> None:
        assert status.is_terminal is False

    @pytest.mark.parametrize("status", list(ProviderStatus))
    def test_requires_user_action(self, status: ProviderStatus) -> None:
        expected = status is ProviderStatus.WAITING_FOR_USER
        assert status.requires_user_action is expected


class TestArtifactReference:
    def test_valid_construction(self) -> None:
        artifact = make_artifact()
        assert artifact.reference == "staging/task-001/s01_sh001.mp4"
        assert artifact.origin is ArtifactOrigin.USER
        assert artifact.location is ArtifactLocation.STAGING

    def test_opaque_reference_allows_url_characters(self) -> None:
        reference = "https://example.com/v?id=1#frag:2"
        artifact = make_artifact(reference=reference)
        assert artifact.reference == reference

    @pytest.mark.parametrize(
        "reference",
        ["", "   ", " leading", "trailing ", "nul\x00byte", "line\nbreak", "\t"],
    )
    def test_invalid_reference_values(self, reference: str) -> None:
        with pytest.raises(InvariantViolationError):
            make_artifact(reference=reference)

    def test_reference_requires_string(self) -> None:
        with pytest.raises(FieldTypeError):
            make_artifact(reference=Path("staging/a.mp4"))

    def test_origin_rejects_plain_string(self) -> None:
        with pytest.raises(FieldTypeError):
            make_artifact(origin="user")

    def test_location_rejects_plain_string(self) -> None:
        with pytest.raises(FieldTypeError):
            make_artifact(location="staging")

    def test_to_json_dict_uses_enum_values(self) -> None:
        data = make_artifact().to_json_dict()
        assert data == {
            "reference": "staging/task-001/s01_sh001.mp4",
            "origin": "user",
            "location": "staging",
        }


class TestProviderCostObservation:
    def test_valid_construction_and_to_json_dict(self) -> None:
        cost = make_cost()
        assert cost.amount == 1.25
        assert cost.unit == "USD"
        assert cost.to_json_dict() == {"amount": 1.25, "unit": "USD"}

    def test_zero_amount_is_valid(self) -> None:
        assert make_cost(amount=0.0).amount == 0.0

    @pytest.mark.parametrize("amount", [True, False, 3, 0])
    def test_amount_rejects_bool_and_int(self, amount: object) -> None:
        with pytest.raises(FieldTypeError):
            make_cost(amount=amount)

    @pytest.mark.parametrize(
        "amount",
        [float("nan"), float("inf"), float("-inf"), -0.5],
    )
    def test_amount_rejects_non_finite_and_negative(self, amount: float) -> None:
        with pytest.raises(InvariantViolationError):
            make_cost(amount=amount)

    @pytest.mark.parametrize("unit", ["", "  ", " USD", "USD ", "U\x00SD"])
    def test_unit_text_invariants(self, unit: str) -> None:
        with pytest.raises(InvariantViolationError):
            make_cost(unit=unit)

    def test_unit_requires_string(self) -> None:
        with pytest.raises(FieldTypeError):
            make_cost(unit=5)


class TestProviderRequest:
    def test_valid_full_construction(self) -> None:
        request = make_request()
        assert request.provider_id == "manual"
        assert request.task_id == "task-001"
        assert request.shot_id == "shot-001"
        assert request.prompt == "A cat walking on a rainy street"
        assert request.duration_seconds == 4.0
        assert request.width == 1920
        assert request.height == 1080
        assert request.frame_rate == 24.0
        assert request.staging_ref == "staging/task-001"
        assert request.provider_parameters["style"] == "anime"

    def test_staging_ref_defaults_to_none(self) -> None:
        request = make_request(staging_ref=None)
        assert request.staging_ref is None

    def test_parameters_default_to_empty_mapping(self) -> None:
        request = make_request(provider_parameters=None)
        assert dict(request.provider_parameters) == {}

    @pytest.mark.parametrize("value", [True, False, 4])
    def test_duration_rejects_bool_and_int(self, value: object) -> None:
        with pytest.raises(FieldTypeError):
            make_request(duration_seconds=value)

    @pytest.mark.parametrize("value", [True, False, 24])
    def test_frame_rate_rejects_bool_and_int(self, value: object) -> None:
        with pytest.raises(FieldTypeError):
            make_request(frame_rate=value)

    @pytest.mark.parametrize("value", [True, False])
    def test_width_and_height_reject_bool(self, value: bool) -> None:
        with pytest.raises(FieldTypeError):
            make_request(width=value)
        with pytest.raises(FieldTypeError):
            make_request(height=value)

    @pytest.mark.parametrize("value", [0, -1])
    def test_width_and_height_reject_non_positive(self, value: int) -> None:
        with pytest.raises(InvariantViolationError):
            make_request(width=value)
        with pytest.raises(InvariantViolationError):
            make_request(height=value)

    def test_parameters_reject_arbitrary_mapping(self) -> None:
        with pytest.raises(FieldTypeError):
            make_request(provider_parameters=MappingProxyType({"a": 1}))

    @pytest.mark.parametrize(
        "value",
        [
            Path("relative/path"),
            datetime(2026, 7, 26, tzinfo=timezone.utc),
            ArtifactOrigin.USER,
            (1, 2),
            {1, 2},
            b"bytes",
            object(),
        ],
    )
    def test_parameters_reject_unsupported_value_types(self, value: object) -> None:
        with pytest.raises(FieldTypeError):
            make_request(provider_parameters={"value": value})

    def test_parameters_reject_non_string_keys(self) -> None:
        with pytest.raises(FieldTypeError):
            make_request(provider_parameters={1: "one"})

    @pytest.mark.parametrize("value", [float("nan"), float("inf")])
    def test_parameters_reject_non_finite_floats(self, value: float) -> None:
        with pytest.raises(InvariantViolationError):
            make_request(provider_parameters={"value": value})

    def test_parameters_reject_cyclic_structures(self) -> None:
        cyclic: dict = {"inner": {}}
        cyclic["inner"]["self"] = cyclic
        with pytest.raises(InvariantViolationError):
            make_request(provider_parameters=cyclic)

    def test_defensive_copy_isolates_caller_mutation(self) -> None:
        params = {"tags": ["cat"], "config": {"steps": 20}}
        request = make_request(provider_parameters=params)
        params["tags"].append("dog")
        params["config"]["steps"] = 99
        params["extra"] = True
        assert request.provider_parameters["tags"] == ("cat",)
        assert request.provider_parameters["config"]["steps"] == 20
        assert "extra" not in request.provider_parameters

    def test_parameters_return_read_only_proxy(self) -> None:
        request = make_request()
        assert isinstance(request.provider_parameters, MappingProxyType)
        assert isinstance(
            request.provider_parameters["config"],
            MappingProxyType,
        )

    def test_nested_lists_frozen_to_tuples(self) -> None:
        request = make_request()
        assert request.provider_parameters["tags"] == ("cat", "rain")
        assert type(request.provider_parameters["tags"]) is tuple

    def test_read_only_mapping_rejects_assignment(self) -> None:
        request = make_request()
        with pytest.raises(TypeError):
            request.provider_parameters["style"] = "noir"

    def test_equal_requests_from_distinct_containers(self) -> None:
        first = make_request(
            provider_parameters={"tags": ["cat"], "config": {"steps": 20}},
        )
        second = make_request(
            provider_parameters={"tags": ["cat"], "config": {"steps": 20}},
        )
        assert first == second
        assert first != make_request(provider_parameters={"tags": ["dog"]})

    def test_hash_raises_type_error(self) -> None:
        with pytest.raises(TypeError):
            hash(make_request())

    def test_to_json_dict_returns_plain_containers(self) -> None:
        data = make_request().to_json_dict()
        assert type(data) is dict
        assert type(data["provider_parameters"]) is dict
        assert type(data["provider_parameters"]["tags"]) is list
        assert type(data["provider_parameters"]["config"]) is dict

    def test_mutating_to_json_dict_result_does_not_leak(self) -> None:
        request = make_request()
        snapshot = request.to_json_dict()
        data = request.to_json_dict()
        data["provider_parameters"]["tags"].append("mutated")
        data["provider_parameters"]["config"]["steps"] = -1
        assert request.to_json_dict() == snapshot

    def test_to_json_dict_is_json_serializable(self) -> None:
        assert json.loads(json.dumps(make_request().to_json_dict()))


class TestProviderInstruction:
    def test_valid_construction(self) -> None:
        instruction = make_instruction()
        assert instruction.provider_id == "manual"
        assert instruction.steps == (
            "Open the web video tool",
            "Generate one video",
        )
        assert instruction.suggested_parameters["style"] == "anime"

    def test_steps_reject_list(self) -> None:
        with pytest.raises(FieldTypeError):
            make_instruction(steps=["Open the tool"])

    def test_steps_reject_empty_tuple(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_instruction(steps=())

    @pytest.mark.parametrize("step", ["", "  ", " lead", "trail "])
    def test_steps_reject_invalid_text(self, step: str) -> None:
        with pytest.raises(InvariantViolationError):
            make_instruction(steps=("Valid step", step))

    def test_suggested_parameters_frozen_like_request(self) -> None:
        params = {"style": "anime", "tags": ["cat"]}
        instruction = make_instruction(suggested_parameters=params)
        params["tags"].append("dog")
        assert isinstance(instruction.suggested_parameters, MappingProxyType)
        assert instruction.suggested_parameters["tags"] == ("cat",)
        with pytest.raises(TypeError):
            instruction.suggested_parameters["style"] = "noir"

    def test_suggested_parameters_reject_arbitrary_mapping(self) -> None:
        with pytest.raises(FieldTypeError):
            make_instruction(suggested_parameters=MappingProxyType({"a": 1}))

    def test_equal_instructions_from_distinct_containers(self) -> None:
        first = make_instruction(suggested_parameters={"tags": ["cat"]})
        second = make_instruction(suggested_parameters={"tags": ["cat"]})
        assert first == second

    def test_hash_raises_type_error(self) -> None:
        with pytest.raises(TypeError):
            hash(make_instruction())

    def test_to_json_dict_returns_plain_containers(self) -> None:
        data = make_instruction().to_json_dict()
        assert type(data["steps"]) is list
        assert type(data["suggested_parameters"]) is dict
        assert json.loads(json.dumps(data))


class TestProviderResultMatrix:
    @pytest.mark.parametrize("status", list(ProviderStatus))
    def test_valid_combination_for_every_status(
        self,
        status: ProviderStatus,
    ) -> None:
        result = make_result(status)
        assert result.status is status
        assert result.is_terminal is status.is_terminal
        assert result.requires_user_action is status.requires_user_action

    def test_not_submitted_allows_instruction(self) -> None:
        result = make_result(
            ProviderStatus.NOT_SUBMITTED,
            instruction=make_instruction(),
        )
        assert result.instruction is not None

    @pytest.mark.parametrize(
        "status",
        [
            ProviderStatus.NOT_SUBMITTED,
            ProviderStatus.WAITING_FOR_USER,
            ProviderStatus.PROCESSING,
            ProviderStatus.FAILED,
            ProviderStatus.CANCELLED,
        ],
    )
    def test_artifact_forbidden(self, status: ProviderStatus) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(status, artifact=make_artifact())

    @pytest.mark.parametrize(
        "status",
        [ProviderStatus.ARTIFACT_AVAILABLE, ProviderStatus.SUCCEEDED],
    )
    def test_artifact_required(self, status: ProviderStatus) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(status, artifact=None)

    @pytest.mark.parametrize(
        "status",
        [
            status
            for status in ProviderStatus
            if status is not ProviderStatus.NOT_SUBMITTED
        ],
    )
    def test_instruction_forbidden_outside_not_submitted(
        self,
        status: ProviderStatus,
    ) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(status, instruction=make_instruction())

    def test_external_task_ref_forbidden_for_not_submitted(self) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(
                ProviderStatus.NOT_SUBMITTED,
                external_task_ref="remote/job-1",
            )

    @pytest.mark.parametrize(
        "status",
        [
            status
            for status in ProviderStatus
            if status is not ProviderStatus.NOT_SUBMITTED
        ],
    )
    def test_external_task_ref_optional_elsewhere(
        self,
        status: ProviderStatus,
    ) -> None:
        result = make_result(status, external_task_ref="remote/job-1")
        assert result.external_task_ref == "remote/job-1"

    def test_failed_requires_error_summary(self) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(ProviderStatus.FAILED, error_summary=None)

    @pytest.mark.parametrize(
        "status",
        [status for status in ProviderStatus if status is not ProviderStatus.FAILED],
    )
    def test_error_summary_forbidden_when_not_failed(
        self,
        status: ProviderStatus,
    ) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(status, error_summary="unexpected failure text")

    @pytest.mark.parametrize("status", NON_TERMINAL_STATUSES)
    def test_completed_at_forbidden_for_non_terminal(
        self,
        status: ProviderStatus,
    ) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(status, completed_at=OBSERVED_AT)

    @pytest.mark.parametrize("status", TERMINAL_STATUSES)
    def test_completed_at_required_for_terminal(
        self,
        status: ProviderStatus,
    ) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(status, completed_at=None)

    @pytest.mark.parametrize("status", list(ProviderStatus))
    def test_message_optional_everywhere(self, status: ProviderStatus) -> None:
        result = make_result(status, message="current lifecycle note")
        assert result.message == "current lifecycle note"

    @pytest.mark.parametrize("status", list(ProviderStatus))
    def test_elapsed_seconds_optional_everywhere(
        self,
        status: ProviderStatus,
    ) -> None:
        result = make_result(status, elapsed_seconds=0.0)
        assert result.elapsed_seconds == 0.0

    @pytest.mark.parametrize("status", list(ProviderStatus))
    def test_cost_observation_optional_everywhere(
        self,
        status: ProviderStatus,
    ) -> None:
        result = make_result(status, cost_observation=make_cost())
        assert result.cost_observation == make_cost()

    def test_matrix_violation_error_type(self) -> None:
        with pytest.raises(InvalidProviderStateError) as exc_info:
            make_result(ProviderStatus.PROCESSING, artifact=make_artifact())
        assert isinstance(exc_info.value, ProviderError)


class TestProviderResultTime:
    def test_completed_before_observed_is_valid(self) -> None:
        result = make_result(ProviderStatus.CANCELLED, completed_at=EARLIER)
        assert result.completed_at == EARLIER

    def test_completed_equal_to_observed_is_valid(self) -> None:
        result = make_result(ProviderStatus.SUCCEEDED, completed_at=OBSERVED_AT)
        assert result.completed_at == OBSERVED_AT

    def test_completed_after_observed_is_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_result(ProviderStatus.SUCCEEDED, completed_at=LATER)

    def test_naive_observed_at_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_result(ProviderStatus.PROCESSING, observed_at=NAIVE_AT)

    def test_naive_completed_at_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_result(ProviderStatus.CANCELLED, completed_at=NAIVE_AT)

    def test_non_utc_observed_at_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_result(ProviderStatus.PROCESSING, observed_at=TOKYO_AT)

    def test_non_utc_completed_at_rejected(self) -> None:
        with pytest.raises(InvariantViolationError):
            make_result(ProviderStatus.CANCELLED, completed_at=TOKYO_AT)

    def test_observed_at_requires_datetime(self) -> None:
        with pytest.raises(FieldTypeError):
            make_result(
                ProviderStatus.PROCESSING,
                observed_at="2026-07-26T12:00:00+00:00",
            )

    @pytest.mark.parametrize(
        "value",
        [True, 3, -0.5, float("nan"), float("inf")],
    )
    def test_elapsed_seconds_invalid_values(self, value: object) -> None:
        expected = (
            FieldTypeError if type(value) is not float else InvariantViolationError
        )
        with pytest.raises(expected):
            make_result(ProviderStatus.PROCESSING, elapsed_seconds=value)


class TestProviderResultFields:
    def test_status_rejects_plain_string(self) -> None:
        with pytest.raises(FieldTypeError):
            make_result("processing")

    def test_status_rejects_other_status_enums(self) -> None:
        with pytest.raises(FieldTypeError):
            make_result(GenerationTaskStatus.FAILED)

    def test_artifact_rejects_wrong_type(self) -> None:
        with pytest.raises(FieldTypeError):
            make_result(ProviderStatus.SUCCEEDED, artifact="staging/a.mp4")

    def test_instruction_rejects_wrong_type(self) -> None:
        with pytest.raises(FieldTypeError):
            make_result(ProviderStatus.NOT_SUBMITTED, instruction="do it by hand")

    def test_cost_observation_rejects_wrong_type(self) -> None:
        with pytest.raises(FieldTypeError):
            make_result(ProviderStatus.PROCESSING, cost_observation={"amount": 1.0})

    def test_aligned_instruction_is_kept_unchanged(self) -> None:
        instruction = make_instruction()
        result = make_result(
            ProviderStatus.NOT_SUBMITTED,
            instruction=instruction,
        )
        assert result.instruction is instruction

    @pytest.mark.parametrize(
        "overrides",
        [
            {"provider_id": "other-provider"},
            {"task_id": "task-999"},
            {"shot_id": "shot-999"},
            {
                "provider_id": "other-provider",
                "task_id": "task-999",
                "shot_id": "shot-999",
            },
        ],
    )
    def test_misaligned_instruction_ids_are_rejected(
        self,
        overrides: dict,
    ) -> None:
        instruction = make_instruction(**overrides)
        with pytest.raises(InvalidProviderRequestError):
            make_result(ProviderStatus.NOT_SUBMITTED, instruction=instruction)

    def test_aligned_instruction_still_rejected_outside_not_submitted(
        self,
    ) -> None:
        with pytest.raises(InvalidProviderStateError):
            make_result(
                ProviderStatus.WAITING_FOR_USER,
                instruction=make_instruction(),
            )

    def test_alignment_does_not_affect_instruction_construction(self) -> None:
        instruction = make_instruction(task_id="task-999")
        assert instruction.task_id == "task-999"

    def test_alignment_does_not_affect_to_json_dict(self) -> None:
        result = make_result(
            ProviderStatus.NOT_SUBMITTED,
            instruction=make_instruction(),
        )
        data = result.to_json_dict()
        assert data["instruction"]["task_id"] == "task-001"

    def test_to_json_dict_full_result(self) -> None:
        result = make_result(
            ProviderStatus.SUCCEEDED,
            external_task_ref="remote/job-1",
            message="collected",
            elapsed_seconds=1.5,
            cost_observation=make_cost(),
        )
        data = result.to_json_dict()
        assert data["status"] == "succeeded"
        assert data["observed_at"] == "2026-07-26T12:00:00.000000+00:00"
        assert data["completed_at"] == "2026-07-26T12:00:00.000000+00:00"
        assert data["artifact"]["origin"] == "user"
        assert data["cost_observation"] == {"amount": 1.25, "unit": "USD"}
        assert json.loads(json.dumps(data))


class TestConstructionErrorChannels:
    def test_missing_required_arguments_raise_type_error(self) -> None:
        with pytest.raises(TypeError):
            ProviderRequest(provider_id="manual")
        with pytest.raises(TypeError):
            ArtifactReference()
        with pytest.raises(TypeError):
            ProviderCostObservation(amount=1.0)
        with pytest.raises(TypeError):
            ProviderResult(provider_id="manual", task_id="task-001")
        with pytest.raises(TypeError):
            ProviderInstruction(provider_id="manual")

    def test_type_and_invariant_errors_are_distinguishable(self) -> None:
        with pytest.raises(FieldTypeError):
            make_request(width="wide")
        with pytest.raises(InvariantViolationError):
            make_request(width=0)
        assert not issubclass(FieldTypeError, InvariantViolationError)
        assert not issubclass(InvariantViolationError, FieldTypeError)

    def test_stable_id_validation_for_result_ids(self) -> None:
        with pytest.raises(FieldTypeError):
            make_result(ProviderStatus.PROCESSING, provider_id=5)
        with pytest.raises(InvariantViolationError):
            make_result(ProviderStatus.PROCESSING, task_id=" task ")


class TestJsonSerializationBoundary:
    def test_all_five_types_serialize_to_json(self) -> None:
        payloads = [
            make_request().to_json_dict(),
            make_instruction().to_json_dict(),
            make_artifact().to_json_dict(),
            make_cost().to_json_dict(),
            make_result(
                ProviderStatus.NOT_SUBMITTED,
                instruction=make_instruction(),
            ).to_json_dict(),
        ]
        for payload in payloads:
            assert json.loads(json.dumps(payload)) == payload
