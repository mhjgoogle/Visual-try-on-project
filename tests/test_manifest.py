from dataclasses import fields, replace
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path

import pytest

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTaskStatus

UTC_NOW = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
UTC_LATER = datetime(2026, 7, 25, 12, 5, tzinfo=timezone.utc)


class ExampleEnum(Enum):
    VALUE = "value"


class ExampleObject:
    pass


def make_manifest(
    *,
    status: ManifestStatus = ManifestStatus.PENDING,
    output_paths: tuple[str, ...] = (),
    output_metadata: dict[str, object] | None = None,
    completed_at: datetime | None = None,
    error_summary: str | None = None,
) -> StepManifest:
    arguments = {}
    if output_metadata is not None:
        arguments["output_metadata"] = output_metadata
    return StepManifest(
        step_name="prepare_manual_tasks",
        input_digest="opaque-input-digest",
        relevant_config_digest="opaque-config-digest",
        status=status,
        created_at=UTC_NOW,
        schema_version=1,
        output_paths=output_paths,
        completed_at=completed_at,
        error_summary=error_summary,
        **arguments,
    )


def test_step_manifest_constructs_with_valid_data() -> None:
    metadata = {"shots": 2, "labels": ["ready", None]}
    manifest = make_manifest(output_metadata=metadata)
    assert manifest.step_name == "prepare_manual_tasks"
    assert manifest.output_metadata is metadata


def test_manifest_status_is_distinct_from_generation_task_status() -> None:
    assert ManifestStatus is not GenerationTaskStatus
    with pytest.raises(FieldTypeError, match="status"):
        replace(make_manifest(), status=GenerationTaskStatus.PENDING)


def test_manifest_status_is_minimal_and_provider_agnostic() -> None:
    assert {status.value for status in ManifestStatus} == {
        "pending",
        "completed",
        "failed",
    }
    assert ManifestStatus.COMPLETED.value == "completed"
    assert "waiting_for_user" not in ManifestStatus._value2member_map_
    assert "asset_available" not in ManifestStatus._value2member_map_


def test_step_manifest_has_exact_required_fields() -> None:
    assert {field.name for field in fields(StepManifest)} == {
        "step_name",
        "input_digest",
        "relevant_config_digest",
        "output_paths",
        "output_metadata",
        "status",
        "created_at",
        "completed_at",
        "error_summary",
        "schema_version",
    }


@pytest.mark.parametrize(
    ("invalid_value", "expected_error"),
    [
        (1, FieldTypeError),
        ("", InvariantViolationError),
        ("   ", InvariantViolationError),
        (" leading", InvariantViolationError),
        ("trailing ", InvariantViolationError),
    ],
)
def test_step_name_rejects_invalid_values(
    invalid_value: object, expected_error: type[Exception]
) -> None:
    with pytest.raises(expected_error, match="step_name"):
        replace(make_manifest(), step_name=invalid_value)


@pytest.mark.parametrize("field_name", ["input_digest", "relevant_config_digest"])
@pytest.mark.parametrize(
    ("invalid_value", "expected_error"),
    [
        (1, FieldTypeError),
        ("", InvariantViolationError),
        ("   ", InvariantViolationError),
        (" padded ", InvariantViolationError),
    ],
)
def test_digest_fields_reject_invalid_values(
    field_name: str,
    invalid_value: object,
    expected_error: type[Exception],
) -> None:
    with pytest.raises(expected_error, match=field_name):
        replace(make_manifest(), **{field_name: invalid_value})


def test_digest_fields_remain_opaque_and_unchanged() -> None:
    input_digest = "future-algorithm:value/with:opaque-syntax"
    config_digest = "another-format::still-opaque"
    manifest = replace(
        make_manifest(),
        input_digest=input_digest,
        relevant_config_digest=config_digest,
    )
    assert manifest.input_digest is input_digest
    assert manifest.relevant_config_digest is config_digest


def test_output_paths_preserve_order_and_input_reference() -> None:
    paths = ("outputs/z.mp4", "outputs/a.json")
    manifest = make_manifest(output_paths=paths)
    assert manifest.output_paths is paths
    assert manifest.output_paths == ("outputs/z.mp4", "outputs/a.json")


@pytest.mark.parametrize(
    "invalid_paths",
    [
        ["outputs/video.mp4"],
        {("outputs/video.mp4")},
        "outputs/video.mp4",
        (Path("outputs/video.mp4"),),
        (1,),
    ],
)
def test_output_paths_reject_invalid_collection_or_item_types(
    invalid_paths: object,
) -> None:
    with pytest.raises(FieldTypeError, match="output_paths"):
        replace(make_manifest(), output_paths=invalid_paths)


@pytest.mark.parametrize("invalid_path", ["", "   ", " padded "])
def test_output_paths_reject_invalid_path_strings(invalid_path: str) -> None:
    with pytest.raises(InvariantViolationError, match=r"output_paths\[0\]"):
        make_manifest(output_paths=(invalid_path,))


def test_output_paths_reject_duplicates_without_deduplicating() -> None:
    paths = ("outputs/video.mp4", "outputs/video.mp4")
    with pytest.raises(InvariantViolationError, match="duplicate"):
        make_manifest(output_paths=paths)
    assert paths == ("outputs/video.mp4", "outputs/video.mp4")


def test_output_paths_do_not_require_existing_files(tmp_path: Path) -> None:
    missing_path = str(tmp_path / "does-not-exist.mp4")
    manifest = make_manifest(output_paths=(missing_path,))
    assert manifest.output_paths == (missing_path,)
    assert not Path(missing_path).exists()


def test_empty_output_paths_follow_status_rules() -> None:
    assert make_manifest().output_paths == ()
    assert (
        make_manifest(
            status=ManifestStatus.FAILED,
            completed_at=UTC_LATER,
            error_summary="Step failed before producing output.",
        ).output_paths
        == ()
    )
    with pytest.raises(InvariantViolationError, match="output_paths"):
        make_manifest(
            status=ManifestStatus.COMPLETED,
            completed_at=UTC_LATER,
        )


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,
        False,
        0,
        -3,
        1.5,
        "text",
        [],
        {},
    ],
)
def test_output_metadata_accepts_json_compatible_basic_values(
    value: object,
) -> None:
    metadata = {"value": value}
    assert make_manifest(output_metadata=metadata).output_metadata is metadata


def test_output_metadata_accepts_deep_json_compatible_values() -> None:
    metadata = {
        "frames": [
            {"index": 0, "scores": [0.0, 1.0], "accepted": True},
            {"index": 1, "note": None},
        ]
    }
    manifest = make_manifest(output_metadata=metadata)
    assert manifest.output_metadata is metadata


def test_output_metadata_accepts_shared_non_cyclic_structure() -> None:
    shared = {"k": 1}
    metadata = {
        "a": shared,
        "b": shared,
    }

    manifest = make_manifest(output_metadata=metadata)

    assert manifest.output_metadata is metadata
    assert manifest.output_metadata["a"] is shared
    assert manifest.output_metadata["b"] is shared
    assert shared == {"k": 1}


@pytest.mark.parametrize(
    "invalid_value",
    [float("nan"), float("inf"), float("-inf")],
)
def test_output_metadata_rejects_non_finite_floats(
    invalid_value: float,
) -> None:
    with pytest.raises(InvariantViolationError, match="output_metadata.value"):
        make_manifest(output_metadata={"value": invalid_value})


def test_output_metadata_rejects_non_string_mapping_keys() -> None:
    with pytest.raises(FieldTypeError, match="output_metadata"):
        make_manifest(output_metadata={1: "value"})  # type: ignore[dict-item]


@pytest.mark.parametrize(
    "invalid_value",
    [
        Path("output.mp4"),
        UTC_NOW,
        ExampleEnum.VALUE,
        ExampleObject(),
        ("tuple",),
        {"set"},
        b"bytes",
    ],
)
def test_output_metadata_rejects_non_json_types(invalid_value: object) -> None:
    with pytest.raises(FieldTypeError, match="output_metadata.value"):
        make_manifest(output_metadata={"value": invalid_value})


def test_output_metadata_rejects_cyclic_containers() -> None:
    cyclic: list[object] = []
    cyclic.append(cyclic)
    with pytest.raises(InvariantViolationError, match=r"output_metadata.value\[0\]"):
        make_manifest(output_metadata={"value": cyclic})


def test_output_metadata_reports_nested_invalid_value_path() -> None:
    metadata = {"frames": [{"path": Path("frame.png")}]}
    with pytest.raises(
        FieldTypeError,
        match=r"output_metadata\.frames\[0\]\.path",
    ):
        make_manifest(output_metadata=metadata)


def test_output_metadata_must_be_a_dict() -> None:
    with pytest.raises(FieldTypeError, match="output_metadata"):
        make_manifest(output_metadata=["metadata"])  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("invalid_version", "expected_error"),
    [
        ("1", FieldTypeError),
        (1.0, FieldTypeError),
        (True, FieldTypeError),
        (0, InvariantViolationError),
        (-1, InvariantViolationError),
    ],
)
def test_schema_version_rejects_invalid_values(
    invalid_version: object, expected_error: type[Exception]
) -> None:
    with pytest.raises(expected_error, match="schema_version"):
        replace(make_manifest(), schema_version=invalid_version)


@pytest.mark.parametrize(
    "time_field",
    ["created_at", "completed_at"],
)
@pytest.mark.parametrize(
    "invalid_time",
    [
        datetime(2026, 7, 25, 12, 0),
        datetime(2026, 7, 25, 12, 0, tzinfo=timezone(timedelta(hours=9))),
    ],
)
def test_manifest_times_must_be_timezone_aware_utc(
    time_field: str, invalid_time: datetime
) -> None:
    manifest = make_manifest(
        status=ManifestStatus.COMPLETED,
        output_paths=("outputs/video.mp4",),
        completed_at=UTC_LATER,
    )
    with pytest.raises(InvariantViolationError, match=time_field):
        replace(manifest, **{time_field: invalid_time})


def test_completed_at_must_not_precede_created_at() -> None:
    with pytest.raises(InvariantViolationError, match="completed_at"):
        make_manifest(
            status=ManifestStatus.COMPLETED,
            output_paths=("outputs/video.mp4",),
            completed_at=UTC_NOW - timedelta(seconds=1),
        )


def test_completed_status_requires_time_and_forbids_error() -> None:
    completed = make_manifest(
        status=ManifestStatus.COMPLETED,
        output_paths=("outputs/video.mp4",),
        completed_at=UTC_LATER,
    )
    assert completed.error_summary is None
    with pytest.raises(InvariantViolationError, match="completed_at"):
        make_manifest(
            status=ManifestStatus.COMPLETED,
            output_paths=("outputs/video.mp4",),
        )
    with pytest.raises(InvariantViolationError, match="error_summary"):
        replace(completed, error_summary="Unexpected error.")


def test_failed_status_requires_time_and_non_empty_error() -> None:
    failed = make_manifest(
        status=ManifestStatus.FAILED,
        completed_at=UTC_LATER,
        error_summary="External operation failed.",
    )
    assert failed.completed_at == UTC_LATER
    with pytest.raises(InvariantViolationError, match="completed_at"):
        make_manifest(
            status=ManifestStatus.FAILED,
            error_summary="External operation failed.",
        )
    with pytest.raises(InvariantViolationError, match="error_summary"):
        make_manifest(
            status=ManifestStatus.FAILED,
            completed_at=UTC_LATER,
        )
    with pytest.raises(InvariantViolationError, match="error_summary"):
        make_manifest(
            status=ManifestStatus.FAILED,
            completed_at=UTC_LATER,
            error_summary="   ",
        )


def test_non_terminal_status_forbids_completion_time_and_error() -> None:
    with pytest.raises(InvariantViolationError, match="completed_at"):
        make_manifest(status=ManifestStatus.PENDING, completed_at=UTC_LATER)
    with pytest.raises(InvariantViolationError, match="error_summary"):
        make_manifest(
            status=ManifestStatus.PENDING,
            error_summary="Unexpected error.",
        )


def test_validation_preserves_caller_owned_inputs() -> None:
    paths = ("outputs/b.mp4", "outputs/a.mp4")
    frames = [{"index": 2}, {"index": 1}]
    metadata = {"frames": frames}
    manifest = make_manifest(output_paths=paths, output_metadata=metadata)
    assert manifest.output_paths is paths
    assert manifest.output_metadata is metadata
    assert manifest.output_metadata["frames"] is frames
    assert paths == ("outputs/b.mp4", "outputs/a.mp4")
    assert metadata == {"frames": [{"index": 2}, {"index": 1}]}


def test_default_metadata_is_not_shared_between_instances() -> None:
    first = make_manifest()
    second = make_manifest()
    assert first.output_metadata == {}
    assert second.output_metadata == {}
    assert first.output_metadata is not second.output_metadata
    assert isinstance(first.output_paths, tuple)


def test_manifest_does_not_implement_later_step_behavior() -> None:
    manifest = make_manifest()
    for name in (
        "calculate_digest",
        "should_skip",
        "save",
        "load",
        "transition_to",
    ):
        assert not hasattr(manifest, name)
