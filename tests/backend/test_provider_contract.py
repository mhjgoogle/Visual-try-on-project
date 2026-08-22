import inspect
from datetime import datetime, timezone
from typing import get_type_hints

import pytest

import ai_video_workflow.providers as providers_package
from ai_video_workflow.errors import (
    AiVideoWorkflowError,
    FieldTypeError,
    InvariantViolationError,
)
from ai_video_workflow.providers import (
    ArtifactReference,
    InvalidProviderRequestError,
    InvalidProviderStateError,
    MissingArtifactReferenceError,
    ProviderError,
    ProviderInstruction,
    ProviderOperationError,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
    VideoProvider,
)

OBSERVED_AT = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
PROVIDER_ID = "test-provider"

EXPECTED_EXPORTS = {
    "ArtifactLocation",
    "ArtifactOrigin",
    "ArtifactReference",
    "InvalidProviderRequestError",
    "InvalidProviderStateError",
    "ManualVideoProvider",
    "MissingArtifactReferenceError",
    "ProviderCostObservation",
    "ProviderError",
    "ProviderInstruction",
    "ProviderOperationError",
    "ProviderRequest",
    "ProviderResult",
    "ProviderStatus",
    "VideoProvider",
}


def make_request(**overrides) -> ProviderRequest:
    kwargs = {
        "provider_id": PROVIDER_ID,
        "task_id": "task-001",
        "shot_id": "shot-001",
        "prompt": "A cat walking on a rainy street",
        "duration_seconds": 4.0,
        "width": 1920,
        "height": 1080,
        "frame_rate": 24.0,
        "staging_ref": "staging/task-001",
    }
    kwargs.update(overrides)
    return ProviderRequest(**kwargs)


def make_instruction(**overrides) -> ProviderInstruction:
    kwargs = {
        "provider_id": PROVIDER_ID,
        "task_id": "task-001",
        "shot_id": "shot-001",
        "prompt": "A cat walking on a rainy street",
        "expected_duration_seconds": 4.0,
        "expected_width": 1920,
        "expected_height": 1080,
        "expected_frame_rate": 24.0,
        "staging_ref": "staging/task-001",
        "steps": ("Open the web video tool", "Generate one video"),
    }
    kwargs.update(overrides)
    return ProviderInstruction(**kwargs)


def make_result(**overrides) -> ProviderResult:
    kwargs = {
        "provider_id": PROVIDER_ID,
        "task_id": "task-001",
        "shot_id": "shot-001",
        "status": ProviderStatus.PROCESSING,
        "observed_at": OBSERVED_AT,
    }
    kwargs.update(overrides)
    return ProviderResult(**kwargs)


class CompleteProvider(VideoProvider):
    """Minimal complete implementation without any manual semantics."""

    def __init__(self, provider_id_value: str = PROVIDER_ID) -> None:
        self._provider_id_value = provider_id_value

    @property
    def provider_id(self) -> str:
        return self._provider_id_value

    def _canned_result(self, request, observed_at):
        return ProviderResult(
            provider_id=self._provider_id_value,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.PROCESSING,
            observed_at=observed_at,
        )

    def prepare(self, request, *, observed_at):
        return self._canned_result(request, observed_at)

    def submit(self, request, prepared, *, observed_at):
        return self._canned_result(request, observed_at)

    def poll(self, request, current, *, observed_at, reported_artifact=None):
        return self._canned_result(request, observed_at)

    def collect(
        self,
        request,
        current,
        *,
        artifact=None,
        observed_at,
        completed_at=None,
    ):
        return self._canned_result(request, observed_at)

    def check_alignment(self, request, result) -> None:
        return self._validate_alignment(request, result)


def _stub_prepare(self, request, *, observed_at):
    return None


def _stub_submit(self, request, prepared, *, observed_at):
    return None


def _stub_poll(self, request, current, *, observed_at, reported_artifact=None):
    return None


def _stub_collect(
    self,
    request,
    current,
    *,
    artifact=None,
    observed_at,
    completed_at=None,
):
    return None


def make_incomplete_provider_class(missing: str) -> type:
    members = {
        "provider_id": property(lambda self: PROVIDER_ID),
        "prepare": _stub_prepare,
        "submit": _stub_submit,
        "poll": _stub_poll,
        "collect": _stub_collect,
    }
    del members[missing]
    return type(f"MissingMember_{missing}", (VideoProvider,), members)


class TestAbstractContract:
    def test_video_provider_is_abc(self) -> None:
        assert inspect.isabstract(VideoProvider)
        assert issubclass(VideoProvider, object)

    def test_direct_instantiation_fails(self) -> None:
        with pytest.raises(TypeError):
            VideoProvider()

    def test_abstract_members_are_exactly_five(self) -> None:
        assert VideoProvider.__abstractmethods__ == frozenset(
            {"provider_id", "prepare", "submit", "poll", "collect"}
        )

    @pytest.mark.parametrize(
        "missing",
        ["provider_id", "prepare", "submit", "poll", "collect"],
    )
    def test_incomplete_subclass_cannot_instantiate(self, missing: str) -> None:
        incomplete_class = make_incomplete_provider_class(missing)
        with pytest.raises(TypeError):
            incomplete_class()

    def test_complete_subclass_instantiates(self) -> None:
        provider = CompleteProvider()
        assert isinstance(provider, VideoProvider)
        assert provider.provider_id == PROVIDER_ID

    def test_provider_id_is_abstract_property(self) -> None:
        descriptor = inspect.getattr_static(VideoProvider, "provider_id")
        assert isinstance(descriptor, property)
        assert getattr(descriptor.fget, "__isabstractmethod__", False) is True

    def test_validate_alignment_is_not_abstract(self) -> None:
        assert "_validate_alignment" not in VideoProvider.__abstractmethods__
        assert callable(VideoProvider._validate_alignment)

    def test_video_provider_declares_empty_slots(self) -> None:
        assert VideoProvider.__slots__ == ()


POSITIONAL = inspect.Parameter.POSITIONAL_OR_KEYWORD
KEYWORD_ONLY = inspect.Parameter.KEYWORD_ONLY
EMPTY = inspect.Parameter.empty
NO_ANNOTATION = object()


def assert_exact_signature(method, expected_params, expected_return) -> None:
    """Assert every parameter of an approved contract method.

    ``expected_params`` is a list of (name, kind, default, resolved
    annotation) covering ALL parameters including ``self``; the resolved
    annotation is compared through typing.get_type_hints, not through
    future-annotations strings.
    """
    signature = inspect.signature(method)
    params = list(signature.parameters.values())
    hints = get_type_hints(method)
    assert [param.name for param in params] == [
        expected[0] for expected in expected_params
    ]
    for param, (name, kind, default, annotation) in zip(
        params,
        expected_params,
        strict=True,
    ):
        assert param.name == name
        assert param.kind is kind
        assert param.default is default
        assert param.kind is not inspect.Parameter.VAR_POSITIONAL
        assert param.kind is not inspect.Parameter.VAR_KEYWORD
        if annotation is NO_ANNOTATION:
            assert name not in hints
        else:
            assert hints[name] == annotation
    assert hints["return"] == expected_return


class TestMethodSignatures:
    def test_prepare_signature(self) -> None:
        assert_exact_signature(
            VideoProvider.prepare,
            [
                ("self", POSITIONAL, EMPTY, NO_ANNOTATION),
                ("request", POSITIONAL, EMPTY, ProviderRequest),
                ("observed_at", KEYWORD_ONLY, EMPTY, datetime),
            ],
            ProviderResult,
        )

    def test_submit_signature(self) -> None:
        assert_exact_signature(
            VideoProvider.submit,
            [
                ("self", POSITIONAL, EMPTY, NO_ANNOTATION),
                ("request", POSITIONAL, EMPTY, ProviderRequest),
                ("prepared", POSITIONAL, EMPTY, ProviderResult),
                ("observed_at", KEYWORD_ONLY, EMPTY, datetime),
            ],
            ProviderResult,
        )

    def test_poll_signature(self) -> None:
        assert_exact_signature(
            VideoProvider.poll,
            [
                ("self", POSITIONAL, EMPTY, NO_ANNOTATION),
                ("request", POSITIONAL, EMPTY, ProviderRequest),
                ("current", POSITIONAL, EMPTY, ProviderResult),
                ("observed_at", KEYWORD_ONLY, EMPTY, datetime),
                (
                    "reported_artifact",
                    KEYWORD_ONLY,
                    None,
                    ArtifactReference | None,
                ),
            ],
            ProviderResult,
        )

    def test_collect_signature(self) -> None:
        assert_exact_signature(
            VideoProvider.collect,
            [
                ("self", POSITIONAL, EMPTY, NO_ANNOTATION),
                ("request", POSITIONAL, EMPTY, ProviderRequest),
                ("current", POSITIONAL, EMPTY, ProviderResult),
                ("artifact", KEYWORD_ONLY, None, ArtifactReference | None),
                ("observed_at", KEYWORD_ONLY, EMPTY, datetime),
                ("completed_at", KEYWORD_ONLY, None, datetime | None),
            ],
            ProviderResult,
        )


class TestValidateAlignment:
    def test_fully_aligned_returns_none(self) -> None:
        provider = CompleteProvider()
        assert provider.check_alignment(make_request(), make_result()) is None

    def test_request_provider_id_mismatch(self) -> None:
        provider = CompleteProvider()
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(
                make_request(provider_id="other-provider"),
                make_result(),
            )

    def test_result_provider_id_mismatch(self) -> None:
        provider = CompleteProvider()
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(
                make_request(),
                make_result(provider_id="other-provider"),
            )

    def test_task_id_mismatch(self) -> None:
        provider = CompleteProvider()
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(
                make_request(),
                make_result(task_id="task-999"),
            )

    def test_shot_id_mismatch(self) -> None:
        provider = CompleteProvider()
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(
                make_request(),
                make_result(shot_id="shot-999"),
            )

    def test_multiple_id_mismatch(self) -> None:
        provider = CompleteProvider()
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(
                make_request(),
                make_result(
                    provider_id="other-provider",
                    task_id="task-999",
                    shot_id="shot-999",
                ),
            )

    def test_request_type_error(self) -> None:
        provider = CompleteProvider()
        with pytest.raises(FieldTypeError):
            provider.check_alignment({"provider_id": PROVIDER_ID}, make_result())

    def test_result_type_error(self) -> None:
        provider = CompleteProvider()
        with pytest.raises(FieldTypeError):
            provider.check_alignment(make_request(), {"status": "processing"})

    def test_blank_provider_property_id_rejected(self) -> None:
        provider = CompleteProvider(provider_id_value="")
        with pytest.raises(InvariantViolationError):
            provider.check_alignment(make_request(), make_result())

    def test_non_string_provider_property_id_rejected(self) -> None:
        provider = CompleteProvider(provider_id_value=5)
        with pytest.raises(FieldTypeError):
            provider.check_alignment(make_request(), make_result())

    def test_alignment_does_not_modify_request(self) -> None:
        provider = CompleteProvider()
        request = make_request()
        snapshot = request.to_json_dict()
        provider.check_alignment(request, make_result())
        assert request.to_json_dict() == snapshot

    def test_alignment_does_not_modify_result(self) -> None:
        provider = CompleteProvider()
        result = make_result()
        snapshot = result.to_json_dict()
        provider.check_alignment(make_request(), result)
        assert result.to_json_dict() == snapshot

    def test_alignment_does_not_replace_instruction(self) -> None:
        provider = CompleteProvider()
        instruction = make_instruction()
        result = make_result(
            status=ProviderStatus.NOT_SUBMITTED,
            instruction=instruction,
        )
        provider.check_alignment(make_request(), result)
        assert result.instruction is instruction

    def test_result_with_aligned_instruction_passes(self) -> None:
        provider = CompleteProvider()
        result = make_result(
            status=ProviderStatus.NOT_SUBMITTED,
            instruction=make_instruction(),
        )
        assert provider.check_alignment(make_request(), result) is None

    def test_result_construction_still_rejects_misaligned_instruction(
        self,
    ) -> None:
        with pytest.raises(InvalidProviderRequestError):
            make_result(
                status=ProviderStatus.NOT_SUBMITTED,
                instruction=make_instruction(task_id="task-999"),
            )


class TestDefensiveInstructionAlignment:
    """Defensive base-class re-check of instruction identity.

    ProviderResult construction already rejects misaligned instructions,
    so these tests corrupt a fully valid frozen instruction afterwards
    with object.__setattr__. That low-level write is used ONLY to
    simulate corrupted or non-standard-source data (e.g. a damaged
    object from a future deserialization boundary); production code must
    never modify frozen models this way. What these tests verify is
    exactly the defensive boundary of VideoProvider._validate_alignment.
    """

    @staticmethod
    def _make_valid_pair():
        instruction = make_instruction()
        result = make_result(
            status=ProviderStatus.NOT_SUBMITTED,
            instruction=instruction,
        )
        return result, instruction

    @pytest.mark.parametrize(
        "corruption",
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
    def test_corrupted_instruction_ids_are_rejected(
        self,
        corruption: dict,
    ) -> None:
        provider = CompleteProvider()
        result, instruction = self._make_valid_pair()
        for field_name, corrupted_value in corruption.items():
            object.__setattr__(instruction, field_name, corrupted_value)
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(make_request(), result)

    def test_fully_valid_instruction_still_passes(self) -> None:
        provider = CompleteProvider()
        result, _ = self._make_valid_pair()
        assert provider.check_alignment(make_request(), result) is None

    def test_request_unchanged_after_defensive_failure(self) -> None:
        provider = CompleteProvider()
        result, instruction = self._make_valid_pair()
        object.__setattr__(instruction, "task_id", "task-999")
        request = make_request()
        snapshot = request.to_json_dict()
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(request, result)
        assert request.to_json_dict() == snapshot

    def test_result_is_not_repaired_after_defensive_failure(self) -> None:
        provider = CompleteProvider()
        result, instruction = self._make_valid_pair()
        object.__setattr__(instruction, "shot_id", "shot-999")
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(make_request(), result)
        assert result.instruction.shot_id == "shot-999"

    def test_corrupted_instruction_is_not_replaced(self) -> None:
        provider = CompleteProvider()
        result, instruction = self._make_valid_pair()
        object.__setattr__(instruction, "provider_id", "other-provider")
        with pytest.raises(InvalidProviderRequestError):
            provider.check_alignment(make_request(), result)
        assert result.instruction is instruction
        assert result.instruction.provider_id == "other-provider"


CONCRETE_PROVIDER_ERRORS = (
    InvalidProviderRequestError,
    InvalidProviderStateError,
    MissingArtifactReferenceError,
    ProviderOperationError,
)


class TestProviderErrorTree:
    def test_provider_error_directly_inherits_project_root(self) -> None:
        assert ProviderError.__bases__ == (AiVideoWorkflowError,)
        assert issubclass(ProviderError, AiVideoWorkflowError)
        assert issubclass(ProviderError, Exception)

    @pytest.mark.parametrize("error_type", CONCRETE_PROVIDER_ERRORS)
    def test_concrete_errors_directly_inherit_provider_error(
        self,
        error_type: type,
    ) -> None:
        assert error_type.__bases__ == (ProviderError,)
        assert issubclass(error_type, ProviderError)
        assert issubclass(error_type, AiVideoWorkflowError)
        assert issubclass(error_type, Exception)

    def test_five_error_classes_are_distinct_objects(self) -> None:
        classes = {ProviderError, *CONCRETE_PROVIDER_ERRORS}
        assert len(classes) == 5

    @pytest.mark.parametrize("first", CONCRETE_PROVIDER_ERRORS)
    @pytest.mark.parametrize("second", CONCRETE_PROVIDER_ERRORS)
    def test_concrete_errors_are_not_interchangeable(
        self,
        first: type,
        second: type,
    ) -> None:
        if first is second:
            assert issubclass(first, second)
        else:
            assert not issubclass(first, second)
            assert not issubclass(second, first)

    @pytest.mark.parametrize("error_type", CONCRETE_PROVIDER_ERRORS)
    def test_instances_are_distinguishable_and_root_catchable(
        self,
        error_type: type,
    ) -> None:
        instance = error_type("provider boundary failure")
        assert isinstance(instance, error_type)
        assert isinstance(instance, ProviderError)
        assert isinstance(instance, AiVideoWorkflowError)
        for other_type in CONCRETE_PROVIDER_ERRORS:
            if other_type is not error_type:
                assert not isinstance(instance, other_type)
        with pytest.raises(AiVideoWorkflowError):
            raise error_type("caught by the common project root")
        with pytest.raises(ProviderError):
            raise error_type("caught by the provider root")


class TestPublicExports:
    def test_video_provider_is_exported(self) -> None:
        assert providers_package.VideoProvider is VideoProvider

    def test_all_matches_expected_exports(self) -> None:
        assert set(providers_package.__all__) == EXPECTED_EXPORTS

    def test_every_declared_export_is_importable(self) -> None:
        for name in providers_package.__all__:
            assert hasattr(providers_package, name)

    def test_manual_video_provider_is_exported(self) -> None:
        assert "ManualVideoProvider" in providers_package.__all__
        assert hasattr(providers_package, "ManualVideoProvider")

    def test_manual_video_provider_is_the_manual_module_class(self) -> None:
        from ai_video_workflow.providers.manual import ManualVideoProvider

        assert providers_package.ManualVideoProvider is ManualVideoProvider

    def test_step_a_exports_are_still_present(self) -> None:
        for name in EXPECTED_EXPORTS - {"ManualVideoProvider", "VideoProvider"}:
            assert hasattr(providers_package, name)


class TestArtifactReferenceAnnotationImport:
    def test_artifact_reference_is_usable_in_contract(self) -> None:
        artifact = ArtifactReference(
            reference="staging/task-001/s01_sh001.mp4",
            origin=providers_package.ArtifactOrigin.USER,
            location=providers_package.ArtifactLocation.STAGING,
        )
        assert artifact.reference == "staging/task-001/s01_sh001.mp4"
