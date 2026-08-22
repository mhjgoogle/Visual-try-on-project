import copy
import json
from collections import OrderedDict
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.errors import (
    FieldTypeError,
    InvariantViolationError,
    JsonDataError,
    MissingFieldError,
)
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import (
    Character,
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.serialization import (
    model_from_dict,
    model_from_json,
    model_to_dict,
    model_to_json,
)

UTC_NOW = datetime(2026, 7, 25, 12, 0, 0, 123, tzinfo=timezone.utc)
UTC_LATER = datetime(2026, 7, 25, 12, 5, 0, 456, tzinfo=timezone.utc)


class UnsupportedModel:
    pass


def sample_models() -> list[object]:
    shared = {"quality": 1}
    return [
        Project(
            project_id="project-001",
            name="短片项目",
            description=None,
            created_at=UTC_NOW,
        ),
        Character(
            character_id="character-001",
            project_id="project-001",
            name="阿里",
            description="主角",
            created_at=UTC_NOW,
        ),
        Scene(
            scene_id="scene-001",
            project_id="project-001",
            sequence=1,
            title="车站",
            description="明亮的车站。",
            created_at=UTC_NOW,
        ),
        Shot(
            shot_id="shot-001",
            scene_id="scene-001",
            sequence=1,
            description="全景镜头。",
            prompt="A wide station shot.",
            duration_seconds=4.0,
            width=1920,
            height=1080,
            frame_rate=24.0,
            created_at=UTC_NOW,
            character_ids=("character-001", "character-002"),
        ),
        GenerationTask(
            task_id="task-001",
            shot_id="shot-001",
            status=GenerationTaskStatus.PENDING,
            created_at=UTC_NOW,
            updated_at=UTC_LATER,
        ),
        VideoAsset(
            asset_id="asset-001",
            shot_id="shot-001",
            source_task_id="task-001",
            path=Path("assets/media/镜头-001.mp4"),
            container_format="mp4",
            duration_seconds=4.0,
            width=1920,
            height=1080,
            frame_rate=24.0,
            version=1,
            validated_at=UTC_LATER,
        ),
        StepManifest(
            step_name="prepare_manual_tasks",
            input_digest="opaque-input",
            relevant_config_digest="opaque-config",
            output_paths=("outputs/镜头-001.json",),
            output_metadata={"a": shared, "b": shared},
            status=ManifestStatus.COMPLETED,
            created_at=UTC_NOW,
            completed_at=UTC_LATER,
            error_summary=None,
            schema_version=1,
        ),
    ]


@pytest.mark.parametrize(
    "model", sample_models(), ids=lambda model: type(model).__name__
)
def test_all_models_round_trip_through_dict(model: object) -> None:
    encoded = model_to_dict(model)  # type: ignore[arg-type]
    decoded = model_from_dict(encoded, type(model))  # type: ignore[arg-type]
    assert decoded == model


@pytest.mark.parametrize(
    "model", sample_models(), ids=lambda model: type(model).__name__
)
def test_all_models_round_trip_through_json(model: object) -> None:
    encoded = model_to_json(model)  # type: ignore[arg-type]
    decoded = model_from_json(encoded, type(model))  # type: ignore[arg-type]
    assert decoded == model


def test_json_preserves_unicode_without_ascii_escaping() -> None:
    text = model_to_json(sample_models()[0])  # type: ignore[arg-type]
    assert "短片项目" in text
    assert "\\u77ed" not in text


def test_json_is_sorted_indented_and_has_exactly_one_trailing_newline() -> None:
    text = model_to_json(sample_models()[0])  # type: ignore[arg-type]
    assert text.startswith('{\n  "created_at":')
    assert '\n  "description": null,' in text
    assert text.endswith("}\n")
    assert not text.endswith("}\n\n")


def test_json_does_not_depend_on_metadata_insertion_order() -> None:
    first = StepManifest(
        step_name="step",
        input_digest="input",
        relevant_config_digest="config",
        status=ManifestStatus.PENDING,
        created_at=UTC_NOW,
        output_metadata={"z": 1, "a": 2},
    )
    second = replace(first, output_metadata={"a": 2, "z": 1})
    assert model_to_json(first) == model_to_json(second)


def test_same_model_produces_identical_text_and_utf8_bytes() -> None:
    model = sample_models()[1]
    first = model_to_json(model)  # type: ignore[arg-type]
    second = model_to_json(model)  # type: ignore[arg-type]
    assert first == second
    assert first.encode("utf-8") == second.encode("utf-8")


def test_datetime_uses_fixed_utc_microsecond_format() -> None:
    project = Project(
        project_id="project-001",
        name="Project",
        created_at=datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc),
    )
    encoded = model_to_dict(project)
    assert encoded["created_at"] == "2026-07-25T12:00:00.000000+00:00"
    decoded = model_from_dict(encoded, Project)
    assert decoded.created_at.tzinfo is not None
    assert decoded.created_at.utcoffset().total_seconds() == 0


def test_path_and_tuple_fields_restore_their_python_types() -> None:
    shot = sample_models()[3]
    asset = sample_models()[5]
    decoded_shot = model_from_json(
        model_to_json(shot),  # type: ignore[arg-type]
        Shot,
    )
    decoded_asset = model_from_json(
        model_to_json(asset),  # type: ignore[arg-type]
        VideoAsset,
    )
    assert isinstance(decoded_shot.character_ids, tuple)
    assert decoded_shot.character_ids == ("character-001", "character-002")
    assert isinstance(decoded_asset.path, Path)
    assert decoded_asset.path == Path("assets/media/镜头-001.mp4")


def test_generation_task_and_manifest_statuses_are_parsed_separately() -> None:
    task_data = model_to_dict(sample_models()[4])  # type: ignore[arg-type]
    manifest_data = model_to_dict(sample_models()[6])  # type: ignore[arg-type]
    assert (
        model_from_dict(task_data, GenerationTask).status
        is GenerationTaskStatus.PENDING
    )
    assert (
        model_from_dict(manifest_data, StepManifest).status is ManifestStatus.COMPLETED
    )

    task_data["status"] = "completed"
    with pytest.raises(FieldTypeError, match="GenerationTask.status"):
        model_from_dict(task_data, GenerationTask)
    manifest_data["status"] = "in_progress"
    with pytest.raises(FieldTypeError, match="StepManifest.status"):
        model_from_dict(manifest_data, StepManifest)


def test_serialization_outputs_all_optional_fields_including_none() -> None:
    task_data = model_to_dict(sample_models()[4])  # type: ignore[arg-type]
    assert task_data["completed_at"] is None
    assert task_data["provider_id"] is None
    assert task_data["input_parameters_ref"] is None
    assert task_data["external_task_ref"] is None
    assert task_data["current_artifact_ref"] is None
    assert task_data["error_summary"] is None


def test_shared_metadata_round_trip_preserves_value_semantics() -> None:
    manifest = sample_models()[6]
    decoded = model_from_json(
        model_to_json(manifest),  # type: ignore[arg-type]
        StepManifest,
    )
    assert decoded.output_metadata == {
        "a": {"quality": 1},
        "b": {"quality": 1},
    }


def test_dict_subclass_metadata_serializes_without_modifying_input() -> None:
    nested = OrderedDict([("k", 1), ("label", "value")])
    metadata = OrderedDict([("nested", nested), ("enabled", True)])
    manifest = StepManifest(
        step_name="step",
        input_digest="input",
        relevant_config_digest="config",
        status=ManifestStatus.PENDING,
        created_at=UTC_NOW,
        output_metadata=metadata,
    )

    encoded_dict = model_to_dict(manifest)
    encoded_json = model_to_json(manifest)
    decoded = model_from_json(encoded_json, StepManifest)

    assert encoded_dict["output_metadata"] == metadata
    assert decoded.output_metadata == {
        "enabled": True,
        "nested": {"k": 1, "label": "value"},
    }
    assert manifest.output_metadata is metadata
    assert manifest.output_metadata["nested"] is nested
    assert metadata == OrderedDict([("nested", nested), ("enabled", True)])


@pytest.mark.parametrize("invalid_value", [float("nan"), float("inf")])
def test_serialization_rejects_metadata_mutated_to_non_finite_number(
    invalid_value: float,
) -> None:
    metadata: dict[str, object] = {}
    manifest = StepManifest(
        step_name="step",
        input_digest="input",
        relevant_config_digest="config",
        status=ManifestStatus.PENDING,
        created_at=UTC_NOW,
        output_metadata=metadata,
    )
    metadata["invalid"] = invalid_value
    with pytest.raises(
        InvariantViolationError,
        match="StepManifest.output_metadata.invalid",
    ):
        model_to_json(manifest)


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_json_parser_rejects_non_finite_numbers(constant: str) -> None:
    text = model_to_json(sample_models()[0])  # type: ignore[arg-type]
    text = text.replace("null", constant)
    with pytest.raises(JsonDataError, match="non-finite"):
        model_from_json(text, Project)


def test_json_syntax_error_is_classified_and_preserves_cause() -> None:
    with pytest.raises(JsonDataError) as captured:
        model_from_json('{"project_id":', Project)
    assert isinstance(captured.value.__cause__, json.JSONDecodeError)


@pytest.mark.parametrize("text", ["[]", '"text"', "null", "1"])
def test_non_object_top_level_json_is_rejected(text: str) -> None:
    with pytest.raises(JsonDataError, match="Project"):
        model_from_json(text, Project)


def test_missing_required_field_is_classified() -> None:
    data = model_to_dict(sample_models()[0])  # type: ignore[arg-type]
    del data["project_id"]
    with pytest.raises(MissingFieldError, match="Project.project_id"):
        model_from_dict(data, Project)


def test_unknown_field_is_rejected() -> None:
    data = model_to_dict(sample_models()[0])  # type: ignore[arg-type]
    data["unexpected"] = True
    with pytest.raises(FieldTypeError, match="Project.unexpected"):
        model_from_dict(data, Project)


def test_field_type_error_includes_model_and_field_path() -> None:
    data = model_to_dict(sample_models()[0])  # type: ignore[arg-type]
    data["project_id"] = 1
    with pytest.raises(FieldTypeError, match="Project.project_id"):
        model_from_dict(data, Project)


def test_invalid_enum_value_is_classified() -> None:
    data = model_to_dict(sample_models()[4])  # type: ignore[arg-type]
    data["status"] = "provider-specific-status"
    with pytest.raises(FieldTypeError, match="GenerationTask.status"):
        model_from_dict(data, GenerationTask)


@pytest.mark.parametrize(
    "invalid_datetime",
    [
        "2026-07-25T12:00:00.000000",
        "2026-07-25T12:00:00.000000+09:00",
        "2026-07-25T12:00:00+00:00",
        "2026-07-25T12:00:00.00000+00:00",
    ],
)
def test_datetime_parser_rejects_non_canonical_or_non_utc_values(
    invalid_datetime: str,
) -> None:
    data = model_to_dict(sample_models()[0])  # type: ignore[arg-type]
    data["created_at"] = invalid_datetime
    with pytest.raises(InvariantViolationError, match="Project.created_at"):
        model_from_dict(data, Project)


def test_json_integer_is_not_coerced_to_strict_float() -> None:
    data = model_to_dict(sample_models()[3])  # type: ignore[arg-type]
    data["duration_seconds"] = 4
    with pytest.raises(FieldTypeError, match="Shot.duration_seconds"):
        model_from_dict(data, Shot)


def test_local_model_invariant_error_keeps_its_category_and_path() -> None:
    data = model_to_dict(sample_models()[0])  # type: ignore[arg-type]
    data["name"] = "   "
    with pytest.raises(InvariantViolationError, match="Project.name"):
        model_from_dict(data, Project)


def test_defaulted_fields_follow_explicit_model_defaults() -> None:
    project_data = model_to_dict(sample_models()[0])  # type: ignore[arg-type]
    del project_data["description"]
    assert model_from_dict(project_data, Project).description is None

    shot_data = model_to_dict(sample_models()[3])  # type: ignore[arg-type]
    del shot_data["character_ids"]
    assert model_from_dict(shot_data, Shot).character_ids == ()


def test_unsupported_model_instance_and_type_are_rejected() -> None:
    with pytest.raises(FieldTypeError, match="UnsupportedModel"):
        model_to_dict(UnsupportedModel())  # type: ignore[arg-type]
    with pytest.raises(FieldTypeError, match="UnsupportedModel"):
        model_from_dict({}, UnsupportedModel)  # type: ignore[type-var]
    with pytest.raises(FieldTypeError, match="UnsupportedModel"):
        model_from_json("{}", UnsupportedModel)  # type: ignore[type-var]


def test_serialization_does_not_modify_model_or_metadata() -> None:
    shared = {"k": [2, 1]}
    metadata = {"b": shared, "a": shared}
    manifest = StepManifest(
        step_name="step",
        input_digest="input",
        relevant_config_digest="config",
        status=ManifestStatus.PENDING,
        created_at=UTC_NOW,
        output_metadata=metadata,
    )
    before = copy.deepcopy(metadata)

    model_to_dict(manifest)
    model_to_json(manifest)

    assert manifest.output_metadata is metadata
    assert manifest.output_metadata["a"] is shared
    assert manifest.output_metadata["b"] is shared
    assert metadata == before


def _cancelled_task(**overrides: object) -> GenerationTask:
    kwargs: dict[str, object] = {
        "task_id": "task-002",
        "shot_id": "shot-001",
        "status": GenerationTaskStatus.CANCELLED,
        "created_at": UTC_NOW,
        "updated_at": UTC_LATER,
        "completed_at": UTC_LATER,
        "provider_id": "manual",
        "external_task_ref": "remote/job-001",
        "current_artifact_ref": "staging/shot-001.mp4",
    }
    kwargs.update(overrides)
    return GenerationTask(**kwargs)  # type: ignore[arg-type]


def test_cancelled_task_encodes_expected_fields() -> None:
    encoded = model_to_dict(_cancelled_task())
    assert encoded["status"] == "cancelled"
    assert encoded["completed_at"] == UTC_LATER.isoformat(timespec="microseconds")
    assert encoded["error_summary"] is None
    assert encoded["external_task_ref"] == "remote/job-001"
    assert encoded["current_artifact_ref"] == "staging/shot-001.mp4"


def test_cancelled_task_round_trips_through_dict_and_json() -> None:
    task = _cancelled_task()
    assert model_from_dict(model_to_dict(task), GenerationTask) == task
    assert model_from_json(model_to_json(task), GenerationTask) == task


def test_cancelled_task_restores_through_existing_parse_path() -> None:
    # The registry is unchanged: the new status value is handled by the
    # existing GenerationTask parse path alone.
    decoded = model_from_dict(model_to_dict(_cancelled_task()), GenerationTask)
    assert decoded.status is GenerationTaskStatus.CANCELLED


def test_cancelled_json_without_completed_at_is_rejected() -> None:
    encoded = model_to_dict(_cancelled_task())
    encoded["completed_at"] = None
    with pytest.raises(InvariantViolationError, match="completed_at"):
        model_from_dict(encoded, GenerationTask)


def test_cancelled_json_with_error_summary_is_rejected() -> None:
    encoded = model_to_dict(_cancelled_task())
    encoded["error_summary"] = "Cancelled by user."
    with pytest.raises(InvariantViolationError, match="error_summary"):
        model_from_dict(encoded, GenerationTask)


@pytest.mark.parametrize(
    ("status", "expected_value", "completed_at", "error_summary"),
    [
        (GenerationTaskStatus.PENDING, "pending", None, None),
        (GenerationTaskStatus.IN_PROGRESS, "in_progress", None, None),
        (GenerationTaskStatus.DONE, "done", UTC_LATER, None),
        (
            GenerationTaskStatus.FAILED,
            "failed",
            UTC_LATER,
            "Generation failed.",
        ),
    ],
)
def test_legacy_statuses_round_trip_without_migration(
    status: GenerationTaskStatus,
    expected_value: str,
    completed_at: datetime | None,
    error_summary: str | None,
) -> None:
    # Existing persisted data never contains "cancelled"; each of the four
    # legacy status values must keep its string value, encode its
    # status-specific fields, and parse exactly as before with no migration.
    task = GenerationTask(
        task_id="task-003",
        shot_id="shot-001",
        status=status,
        created_at=UTC_NOW,
        updated_at=UTC_LATER,
        completed_at=completed_at,
        error_summary=error_summary,
    )

    encoded = model_to_dict(task)
    assert encoded["status"] == expected_value
    assert encoded["completed_at"] == (
        None
        if completed_at is None
        else completed_at.isoformat(timespec="microseconds")
    )
    assert encoded["error_summary"] == error_summary

    decoded = model_from_dict(encoded, GenerationTask)
    assert decoded == task
    assert decoded.status is status
    assert decoded.completed_at == completed_at
    assert decoded.error_summary == error_summary

    json_decoded = model_from_json(model_to_json(task), GenerationTask)
    assert json_decoded == task
    assert json_decoded.status is status
    assert json_decoded.completed_at == completed_at
    assert json_decoded.error_summary == error_summary
