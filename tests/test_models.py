from dataclasses import fields, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.models import (
    Character,
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
    VideoAsset,
)

UTC_NOW = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
UTC_LATER = datetime(2026, 7, 25, 12, 5, tzinfo=timezone.utc)


def make_project() -> Project:
    return Project(
        project_id="project-001",
        name="Demo Project",
        description="A minimal project.",
        created_at=UTC_NOW,
    )


def make_character() -> Character:
    return Character(
        character_id="character-001",
        project_id="project-001",
        name="Ari",
        description="The lead character.",
        created_at=UTC_NOW,
    )


def make_scene() -> Scene:
    return Scene(
        scene_id="scene-001",
        project_id="project-001",
        sequence=1,
        title="Arrival",
        description="Ari enters the station.",
        created_at=UTC_NOW,
    )


def make_shot(*, character_ids: tuple[str, ...] = ()) -> Shot:
    return Shot(
        shot_id="shot-001",
        scene_id="scene-001",
        sequence=1,
        description="A wide establishing shot.",
        prompt="Wide shot of Ari entering a bright station.",
        duration_seconds=4.0,
        width=1920,
        height=1080,
        frame_rate=24.0,
        created_at=UTC_NOW,
        character_ids=character_ids,
    )


def make_task(
    *,
    status: GenerationTaskStatus = GenerationTaskStatus.PENDING,
    completed_at: datetime | None = None,
    error_summary: str | None = None,
) -> GenerationTask:
    return GenerationTask(
        task_id="task-001",
        shot_id="shot-001",
        provider_id="manual",
        status=status,
        input_parameters_ref="tasks/task-001-input.json",
        current_artifact_ref="staging/shot-001.mp4",
        created_at=UTC_NOW,
        updated_at=UTC_LATER,
        completed_at=completed_at,
        error_summary=error_summary,
    )


def make_asset(*, path: Path = Path("assets/media/shot-001-v1.mp4")) -> VideoAsset:
    return VideoAsset(
        asset_id="asset-001",
        shot_id="shot-001",
        source_task_id="task-001",
        path=path,
        container_format="mp4",
        duration_seconds=4.0,
        width=1920,
        height=1080,
        frame_rate=24.0,
        version=1,
        validated_at=UTC_LATER,
    )


def test_all_six_models_construct_with_valid_data() -> None:
    assert make_project().project_id == "project-001"
    assert make_character().project_id == "project-001"
    assert make_scene().project_id == "project-001"
    assert make_shot().scene_id == "scene-001"
    assert make_task().shot_id == "shot-001"
    assert make_asset().source_task_id == "task-001"


@pytest.mark.parametrize(
    ("instance", "id_field"),
    [
        (make_project(), "project_id"),
        (make_character(), "character_id"),
        (make_scene(), "scene_id"),
        (make_shot(), "shot_id"),
        (make_task(), "task_id"),
        (make_asset(), "asset_id"),
    ],
)
@pytest.mark.parametrize("invalid_id", ["", "   ", " leading", "line\nbreak", 1])
def test_each_model_validates_its_primary_id(
    instance: object, id_field: str, invalid_id: object
) -> None:
    with pytest.raises((FieldTypeError, InvariantViolationError)):
        replace(instance, **{id_field: invalid_id})


@pytest.mark.parametrize(
    ("instance", "field_name", "invalid_value", "expected_error"),
    [
        (make_scene(), "sequence", 0, InvariantViolationError),
        (make_scene(), "sequence", -1, InvariantViolationError),
        (make_scene(), "sequence", True, FieldTypeError),
        (make_shot(), "sequence", 0, InvariantViolationError),
        (make_shot(), "sequence", True, FieldTypeError),
        (make_shot(), "duration_seconds", 0.0, InvariantViolationError),
        (make_shot(), "duration_seconds", -1.0, InvariantViolationError),
        (make_shot(), "duration_seconds", float("nan"), InvariantViolationError),
        (make_shot(), "duration_seconds", float("inf"), InvariantViolationError),
        (make_shot(), "duration_seconds", float("-inf"), InvariantViolationError),
        (make_shot(), "duration_seconds", 4, FieldTypeError),
        (make_shot(), "duration_seconds", True, FieldTypeError),
        (make_shot(), "width", 0, InvariantViolationError),
        (make_shot(), "width", -1, InvariantViolationError),
        (make_shot(), "width", True, FieldTypeError),
        (make_shot(), "height", 0, InvariantViolationError),
        (make_shot(), "height", -1, InvariantViolationError),
        (make_shot(), "height", True, FieldTypeError),
        (make_shot(), "frame_rate", 0.0, InvariantViolationError),
        (make_shot(), "frame_rate", -1.0, InvariantViolationError),
        (make_shot(), "frame_rate", float("nan"), InvariantViolationError),
        (make_shot(), "frame_rate", float("inf"), InvariantViolationError),
        (make_shot(), "frame_rate", float("-inf"), InvariantViolationError),
        (make_shot(), "frame_rate", 24, FieldTypeError),
        (make_shot(), "frame_rate", True, FieldTypeError),
        (make_asset(), "version", 0, InvariantViolationError),
        (make_asset(), "version", True, FieldTypeError),
        (make_asset(), "width", 0, InvariantViolationError),
        (make_asset(), "width", -1, InvariantViolationError),
        (make_asset(), "width", True, FieldTypeError),
        (make_asset(), "height", 0, InvariantViolationError),
        (make_asset(), "height", -1, InvariantViolationError),
        (make_asset(), "height", True, FieldTypeError),
        (make_asset(), "duration_seconds", float("nan"), InvariantViolationError),
        (make_asset(), "duration_seconds", float("inf"), InvariantViolationError),
        (make_asset(), "duration_seconds", float("-inf"), InvariantViolationError),
        (make_asset(), "duration_seconds", 4, FieldTypeError),
        (make_asset(), "frame_rate", float("nan"), InvariantViolationError),
        (make_asset(), "frame_rate", float("inf"), InvariantViolationError),
        (make_asset(), "frame_rate", float("-inf"), InvariantViolationError),
        (make_asset(), "frame_rate", 24, FieldTypeError),
    ],
)
def test_models_reject_invalid_numeric_fields_with_specific_error_types(
    instance: object,
    field_name: str,
    invalid_value: object,
    expected_error: type[Exception],
) -> None:
    with pytest.raises(expected_error, match=field_name):
        replace(instance, **{field_name: invalid_value})


@pytest.mark.parametrize(
    ("instance", "reference_field"),
    [
        (make_character(), "project_id"),
        (make_scene(), "project_id"),
        (make_shot(), "scene_id"),
        (make_task(), "shot_id"),
        (make_asset(), "shot_id"),
        (make_asset(), "source_task_id"),
    ],
)
@pytest.mark.parametrize("invalid_id", ["", "   ", " padded ", "line\nbreak"])
def test_models_reject_invalid_reference_id_strings(
    instance: object, reference_field: str, invalid_id: str
) -> None:
    with pytest.raises(InvariantViolationError, match=reference_field):
        replace(instance, **{reference_field: invalid_id})


@pytest.mark.parametrize(
    ("instance", "time_field"),
    [
        (make_project(), "created_at"),
        (make_character(), "created_at"),
        (make_scene(), "created_at"),
        (make_shot(), "created_at"),
        (make_task(), "created_at"),
        (make_asset(), "validated_at"),
    ],
)
@pytest.mark.parametrize(
    "invalid_time",
    [
        datetime(2026, 7, 25, 12, 0),
        datetime(2026, 7, 25, 12, 0, tzinfo=timezone(timedelta(hours=9))),
    ],
)
def test_model_times_must_be_timezone_aware_utc(
    instance: object, time_field: str, invalid_time: datetime
) -> None:
    with pytest.raises(InvariantViolationError):
        replace(instance, **{time_field: invalid_time})


def test_shot_character_ids_are_immutable_and_not_shared_mutable_defaults() -> None:
    first = make_shot()
    second = replace(first, shot_id="shot-002")
    assert first.character_ids == ()
    assert second.character_ids == ()
    assert isinstance(first.character_ids, tuple)


def test_shot_accepts_ordered_unique_character_ids_without_modifying_them() -> None:
    character_ids = ("character-002", "character-001")
    shot = make_shot(character_ids=character_ids)
    assert shot.character_ids is character_ids


def test_shot_rejects_duplicate_character_ids_without_deduplicating() -> None:
    character_ids = ("character-001", "character-001")
    with pytest.raises(InvariantViolationError, match="duplicate"):
        make_shot(character_ids=character_ids)
    assert character_ids == ("character-001", "character-001")


def test_shot_rejects_mutable_character_id_collection() -> None:
    with pytest.raises(FieldTypeError):
        make_shot(character_ids=["character-001"])  # type: ignore[arg-type]


def test_models_reject_embedded_associated_objects() -> None:
    with pytest.raises(FieldTypeError):
        replace(make_character(), project_id=make_project())
    with pytest.raises(FieldTypeError):
        replace(make_shot(), scene_id=make_scene())
    with pytest.raises(FieldTypeError):
        replace(make_task(), shot_id=make_shot())


def test_generation_task_status_is_local_and_provider_agnostic() -> None:
    assert {status.value for status in GenerationTaskStatus} == {
        "pending",
        "in_progress",
        "done",
        "failed",
    }
    assert "waiting_for_user" not in GenerationTaskStatus._value2member_map_
    assert "asset_available" not in GenerationTaskStatus._value2member_map_


def test_generation_task_public_fields_exclude_history_qcd_and_asset_id() -> None:
    field_names = {field.name for field in fields(GenerationTask)}
    forbidden = {
        "asset_id",
        "video_asset_id",
        "assets",
        "manual_ratings",
        "redo_history",
        "cost_history",
        "qcd_events",
        "qcd_summary",
        "provider_result",
        "provider_history",
    }
    assert field_names.isdisjoint(forbidden)


def test_current_artifact_ref_is_an_opaque_external_or_staging_reference() -> None:
    reference = "asset-looking-value-that-does-not-exist"
    task = replace(make_task(), current_artifact_ref=reference)
    assert task.current_artifact_ref is reference


def test_video_asset_uses_single_direction_source_task_reference() -> None:
    asset_fields = {field.name for field in fields(VideoAsset)}
    task_fields = {field.name for field in fields(GenerationTask)}
    assert "source_task_id" in asset_fields
    assert "asset_id" not in task_fields
    assert "video_asset_id" not in task_fields


def test_video_asset_does_not_require_the_media_file_to_exist() -> None:
    missing_path = Path("does/not/exist/video.mp4")
    asset = make_asset(path=missing_path)
    assert asset.path is missing_path
    assert not missing_path.exists()


@pytest.mark.parametrize(
    ("status", "completed_at", "error_summary"),
    [
        (GenerationTaskStatus.PENDING, None, None),
        (GenerationTaskStatus.IN_PROGRESS, None, None),
        (GenerationTaskStatus.DONE, UTC_LATER, None),
        (GenerationTaskStatus.FAILED, UTC_LATER, "Generation failed."),
    ],
)
def test_generation_task_accepts_consistent_status_fields(
    status: GenerationTaskStatus,
    completed_at: datetime | None,
    error_summary: str | None,
) -> None:
    assert (
        make_task(
            status=status,
            completed_at=completed_at,
            error_summary=error_summary,
        ).status
        is status
    )


@pytest.mark.parametrize(
    ("status", "completed_at", "error_summary"),
    [
        (GenerationTaskStatus.PENDING, UTC_LATER, None),
        (GenerationTaskStatus.IN_PROGRESS, UTC_LATER, None),
        (GenerationTaskStatus.DONE, None, None),
        (GenerationTaskStatus.DONE, UTC_LATER, "Unexpected error."),
        (GenerationTaskStatus.FAILED, None, "Generation failed."),
        (GenerationTaskStatus.FAILED, UTC_LATER, None),
    ],
)
def test_generation_task_rejects_inconsistent_status_fields(
    status: GenerationTaskStatus,
    completed_at: datetime | None,
    error_summary: str | None,
) -> None:
    with pytest.raises(InvariantViolationError):
        make_task(
            status=status,
            completed_at=completed_at,
            error_summary=error_summary,
        )


def test_generation_task_rejects_invalid_time_order() -> None:
    with pytest.raises(InvariantViolationError, match="updated_at"):
        replace(make_task(), updated_at=UTC_NOW - timedelta(seconds=1))
    with pytest.raises(InvariantViolationError, match="completed_at"):
        make_task(
            status=GenerationTaskStatus.DONE,
            completed_at=UTC_NOW - timedelta(seconds=1),
        )


def test_models_preserve_valid_text_and_path_inputs() -> None:
    name = "Demo Project"
    path = Path("assets/media/shot-001-v1.mp4")
    project = replace(make_project(), name=name)
    asset = make_asset(path=path)
    assert project.name is name
    assert asset.path is path


def test_public_field_sets_do_not_include_later_step_responsibilities() -> None:
    expected = {
        Project: {"project_id", "name", "created_at", "description"},
        Character: {
            "character_id",
            "project_id",
            "name",
            "description",
            "created_at",
        },
        Scene: {
            "scene_id",
            "project_id",
            "sequence",
            "title",
            "description",
            "created_at",
        },
        Shot: {
            "shot_id",
            "scene_id",
            "sequence",
            "description",
            "prompt",
            "duration_seconds",
            "width",
            "height",
            "frame_rate",
            "created_at",
            "character_ids",
        },
        GenerationTask: {
            "task_id",
            "shot_id",
            "status",
            "created_at",
            "updated_at",
            "completed_at",
            "provider_id",
            "input_parameters_ref",
            "external_task_ref",
            "current_artifact_ref",
            "error_summary",
        },
        VideoAsset: {
            "asset_id",
            "shot_id",
            "source_task_id",
            "path",
            "container_format",
            "duration_seconds",
            "width",
            "height",
            "frame_rate",
            "version",
            "validated_at",
        },
    }
    for model, field_names in expected.items():
        assert {field.name for field in fields(model)} == field_names
