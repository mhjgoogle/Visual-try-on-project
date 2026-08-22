"""Explicit deterministic JSON conversion for approved persisted models."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import TypeAlias, TypeVar, cast

from ai_video_workflow.errors import (
    DataValidationError,
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
from ai_video_workflow.validation import (
    validate_json_compatible,
    validate_utc_datetime,
)

JsonValue: TypeAlias = (
    None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
)
JsonObject: TypeAlias = dict[str, JsonValue]
SupportedModel: TypeAlias = (
    Project | Character | Scene | Shot | GenerationTask | VideoAsset | StepManifest
)
ModelT = TypeVar(
    "ModelT",
    Project,
    Character,
    Scene,
    Shot,
    GenerationTask,
    VideoAsset,
    StepManifest,
)
EnumT = TypeVar("EnumT", bound=Enum)

_UTC_DATETIME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$"
)


def model_to_dict(model: SupportedModel) -> JsonObject:
    """Convert one approved model to a JSON-compatible dictionary."""
    if type(model) is Project:
        return _project_to_dict(cast(Project, model))
    if type(model) is Character:
        return _character_to_dict(cast(Character, model))
    if type(model) is Scene:
        return _scene_to_dict(cast(Scene, model))
    if type(model) is Shot:
        return _shot_to_dict(cast(Shot, model))
    if type(model) is GenerationTask:
        return _generation_task_to_dict(cast(GenerationTask, model))
    if type(model) is VideoAsset:
        return _video_asset_to_dict(cast(VideoAsset, model))
    if type(model) is StepManifest:
        return _step_manifest_to_dict(cast(StepManifest, model))
    raise FieldTypeError(f"model: unsupported model type {type(model).__name__}")


def model_from_dict(data: object, model_type: type[ModelT]) -> ModelT:
    """Construct one approved model from a strict JSON-compatible dictionary."""
    if model_type is Project:
        return cast(ModelT, _project_from_dict(data))
    if model_type is Character:
        return cast(ModelT, _character_from_dict(data))
    if model_type is Scene:
        return cast(ModelT, _scene_from_dict(data))
    if model_type is Shot:
        return cast(ModelT, _shot_from_dict(data))
    if model_type is GenerationTask:
        return cast(ModelT, _generation_task_from_dict(data))
    if model_type is VideoAsset:
        return cast(ModelT, _video_asset_from_dict(data))
    if model_type is StepManifest:
        return cast(ModelT, _step_manifest_from_dict(data))
    model_name = getattr(model_type, "__name__", type(model_type).__name__)
    raise FieldTypeError(f"model_type: unsupported model type {model_name}")


def model_to_json(model: SupportedModel) -> str:
    """Serialize one approved model using the deterministic JSON contract."""
    return (
        json.dumps(
            model_to_dict(model),
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    )


def model_from_json(text: object, model_type: type[ModelT]) -> ModelT:
    """Parse strict JSON text and construct one approved model."""
    model_name = _supported_model_name(model_type)
    if type(text) is not str:
        raise FieldTypeError(
            f"{model_name}: expected JSON text string, got {type(text).__name__}"
        )
    try:
        data = json.loads(text, parse_constant=_reject_json_constant)
    except json.JSONDecodeError as exc:
        raise JsonDataError(
            f"{model_name}: invalid JSON syntax at line {exc.lineno}, "
            f"column {exc.colno}"
        ) from exc
    if type(data) is not dict:
        raise JsonDataError(f"{model_name}: top-level JSON value must be an object")
    return model_from_dict(data, model_type)


def _project_to_dict(model: Project) -> JsonObject:
    return {
        "project_id": model.project_id,
        "name": model.name,
        "created_at": _format_datetime(model.created_at, "Project.created_at"),
        "description": model.description,
    }


def _character_to_dict(model: Character) -> JsonObject:
    return {
        "character_id": model.character_id,
        "project_id": model.project_id,
        "name": model.name,
        "description": model.description,
        "created_at": _format_datetime(model.created_at, "Character.created_at"),
    }


def _scene_to_dict(model: Scene) -> JsonObject:
    return {
        "scene_id": model.scene_id,
        "project_id": model.project_id,
        "sequence": model.sequence,
        "title": model.title,
        "description": model.description,
        "created_at": _format_datetime(model.created_at, "Scene.created_at"),
    }


def _shot_to_dict(model: Shot) -> JsonObject:
    return {
        "shot_id": model.shot_id,
        "scene_id": model.scene_id,
        "sequence": model.sequence,
        "description": model.description,
        "prompt": model.prompt,
        "duration_seconds": model.duration_seconds,
        "width": model.width,
        "height": model.height,
        "frame_rate": model.frame_rate,
        "created_at": _format_datetime(model.created_at, "Shot.created_at"),
        "character_ids": list(model.character_ids),
    }


def _generation_task_to_dict(model: GenerationTask) -> JsonObject:
    return {
        "task_id": model.task_id,
        "shot_id": model.shot_id,
        "status": model.status.value,
        "created_at": _format_datetime(
            model.created_at,
            "GenerationTask.created_at",
        ),
        "updated_at": _format_datetime(
            model.updated_at,
            "GenerationTask.updated_at",
        ),
        "completed_at": _format_optional_datetime(
            model.completed_at,
            "GenerationTask.completed_at",
        ),
        "provider_id": model.provider_id,
        "input_parameters_ref": model.input_parameters_ref,
        "external_task_ref": model.external_task_ref,
        "current_artifact_ref": model.current_artifact_ref,
        "error_summary": model.error_summary,
    }


def _video_asset_to_dict(model: VideoAsset) -> JsonObject:
    return {
        "asset_id": model.asset_id,
        "shot_id": model.shot_id,
        "source_task_id": model.source_task_id,
        "path": model.path.as_posix(),
        "container_format": model.container_format,
        "duration_seconds": model.duration_seconds,
        "width": model.width,
        "height": model.height,
        "frame_rate": model.frame_rate,
        "version": model.version,
        "validated_at": _format_datetime(
            model.validated_at,
            "VideoAsset.validated_at",
        ),
    }


def _step_manifest_to_dict(model: StepManifest) -> JsonObject:
    validate_json_compatible(model.output_metadata, path="StepManifest.output_metadata")
    return {
        "step_name": model.step_name,
        "input_digest": model.input_digest,
        "relevant_config_digest": model.relevant_config_digest,
        "output_paths": list(model.output_paths),
        "output_metadata": _copy_json_mapping(model.output_metadata),
        "status": model.status.value,
        "created_at": _format_datetime(
            model.created_at,
            "StepManifest.created_at",
        ),
        "completed_at": _format_optional_datetime(
            model.completed_at,
            "StepManifest.completed_at",
        ),
        "error_summary": model.error_summary,
        "schema_version": model.schema_version,
    }


def _project_from_dict(data: object) -> Project:
    values = _validate_fields(
        data,
        "Project",
        required={"project_id", "name", "created_at"},
        optional={"description"},
    )
    return _construct_model(
        "Project",
        lambda: Project(
            project_id=_require_str(values["project_id"], "Project.project_id"),
            name=_require_str(values["name"], "Project.name"),
            created_at=_parse_datetime(values["created_at"], "Project.created_at"),
            description=_optional_str(
                values.get("description"),
                "Project.description",
            ),
        ),
    )


def _character_from_dict(data: object) -> Character:
    values = _validate_fields(
        data,
        "Character",
        required={
            "character_id",
            "project_id",
            "name",
            "description",
            "created_at",
        },
    )
    return _construct_model(
        "Character",
        lambda: Character(
            character_id=_require_str(
                values["character_id"],
                "Character.character_id",
            ),
            project_id=_require_str(values["project_id"], "Character.project_id"),
            name=_require_str(values["name"], "Character.name"),
            description=_require_str(
                values["description"],
                "Character.description",
            ),
            created_at=_parse_datetime(
                values["created_at"],
                "Character.created_at",
            ),
        ),
    )


def _scene_from_dict(data: object) -> Scene:
    values = _validate_fields(
        data,
        "Scene",
        required={
            "scene_id",
            "project_id",
            "sequence",
            "title",
            "description",
            "created_at",
        },
    )
    return _construct_model(
        "Scene",
        lambda: Scene(
            scene_id=_require_str(values["scene_id"], "Scene.scene_id"),
            project_id=_require_str(values["project_id"], "Scene.project_id"),
            sequence=_require_int(values["sequence"], "Scene.sequence"),
            title=_require_str(values["title"], "Scene.title"),
            description=_require_str(values["description"], "Scene.description"),
            created_at=_parse_datetime(values["created_at"], "Scene.created_at"),
        ),
    )


def _shot_from_dict(data: object) -> Shot:
    values = _validate_fields(
        data,
        "Shot",
        required={
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
        },
        optional={"character_ids"},
    )
    return _construct_model(
        "Shot",
        lambda: Shot(
            shot_id=_require_str(values["shot_id"], "Shot.shot_id"),
            scene_id=_require_str(values["scene_id"], "Shot.scene_id"),
            sequence=_require_int(values["sequence"], "Shot.sequence"),
            description=_require_str(values["description"], "Shot.description"),
            prompt=_require_str(values["prompt"], "Shot.prompt"),
            duration_seconds=_require_float(
                values["duration_seconds"],
                "Shot.duration_seconds",
            ),
            width=_require_int(values["width"], "Shot.width"),
            height=_require_int(values["height"], "Shot.height"),
            frame_rate=_require_float(values["frame_rate"], "Shot.frame_rate"),
            created_at=_parse_datetime(values["created_at"], "Shot.created_at"),
            character_ids=_string_tuple(
                values.get("character_ids", []),
                "Shot.character_ids",
            ),
        ),
    )


def _generation_task_from_dict(data: object) -> GenerationTask:
    values = _validate_fields(
        data,
        "GenerationTask",
        required={"task_id", "shot_id", "status", "created_at", "updated_at"},
        optional={
            "completed_at",
            "provider_id",
            "input_parameters_ref",
            "external_task_ref",
            "current_artifact_ref",
            "error_summary",
        },
    )
    return _construct_model(
        "GenerationTask",
        lambda: GenerationTask(
            task_id=_require_str(values["task_id"], "GenerationTask.task_id"),
            shot_id=_require_str(values["shot_id"], "GenerationTask.shot_id"),
            status=_parse_enum(
                values["status"],
                GenerationTaskStatus,
                "GenerationTask.status",
            ),
            created_at=_parse_datetime(
                values["created_at"],
                "GenerationTask.created_at",
            ),
            updated_at=_parse_datetime(
                values["updated_at"],
                "GenerationTask.updated_at",
            ),
            completed_at=_parse_optional_datetime(
                values.get("completed_at"),
                "GenerationTask.completed_at",
            ),
            provider_id=_optional_str(
                values.get("provider_id"),
                "GenerationTask.provider_id",
            ),
            input_parameters_ref=_optional_str(
                values.get("input_parameters_ref"),
                "GenerationTask.input_parameters_ref",
            ),
            external_task_ref=_optional_str(
                values.get("external_task_ref"),
                "GenerationTask.external_task_ref",
            ),
            current_artifact_ref=_optional_str(
                values.get("current_artifact_ref"),
                "GenerationTask.current_artifact_ref",
            ),
            error_summary=_optional_str(
                values.get("error_summary"),
                "GenerationTask.error_summary",
            ),
        ),
    )


def _video_asset_from_dict(data: object) -> VideoAsset:
    values = _validate_fields(
        data,
        "VideoAsset",
        required={
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
    )
    return _construct_model(
        "VideoAsset",
        lambda: VideoAsset(
            asset_id=_require_str(values["asset_id"], "VideoAsset.asset_id"),
            shot_id=_require_str(values["shot_id"], "VideoAsset.shot_id"),
            source_task_id=_require_str(
                values["source_task_id"],
                "VideoAsset.source_task_id",
            ),
            path=Path(_require_str(values["path"], "VideoAsset.path")),
            container_format=_require_str(
                values["container_format"],
                "VideoAsset.container_format",
            ),
            duration_seconds=_require_float(
                values["duration_seconds"],
                "VideoAsset.duration_seconds",
            ),
            width=_require_int(values["width"], "VideoAsset.width"),
            height=_require_int(values["height"], "VideoAsset.height"),
            frame_rate=_require_float(
                values["frame_rate"],
                "VideoAsset.frame_rate",
            ),
            version=_require_int(values["version"], "VideoAsset.version"),
            validated_at=_parse_datetime(
                values["validated_at"],
                "VideoAsset.validated_at",
            ),
        ),
    )


def _step_manifest_from_dict(data: object) -> StepManifest:
    values = _validate_fields(
        data,
        "StepManifest",
        required={
            "step_name",
            "input_digest",
            "relevant_config_digest",
            "status",
            "created_at",
        },
        optional={
            "schema_version",
            "output_paths",
            "output_metadata",
            "completed_at",
            "error_summary",
        },
    )
    return _construct_model(
        "StepManifest",
        lambda: StepManifest(
            step_name=_require_str(values["step_name"], "StepManifest.step_name"),
            input_digest=_require_str(
                values["input_digest"],
                "StepManifest.input_digest",
            ),
            relevant_config_digest=_require_str(
                values["relevant_config_digest"],
                "StepManifest.relevant_config_digest",
            ),
            status=_parse_enum(
                values["status"],
                ManifestStatus,
                "StepManifest.status",
            ),
            created_at=_parse_datetime(
                values["created_at"],
                "StepManifest.created_at",
            ),
            schema_version=_require_int(
                values.get("schema_version", 1),
                "StepManifest.schema_version",
            ),
            output_paths=_string_tuple(
                values.get("output_paths", []),
                "StepManifest.output_paths",
            ),
            output_metadata=_json_mapping(
                values.get("output_metadata", {}),
                "StepManifest.output_metadata",
            ),
            completed_at=_parse_optional_datetime(
                values.get("completed_at"),
                "StepManifest.completed_at",
            ),
            error_summary=_optional_str(
                values.get("error_summary"),
                "StepManifest.error_summary",
            ),
        ),
    )


def _validate_fields(
    data: object,
    model_name: str,
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, object]:
    if type(data) is not dict:
        raise FieldTypeError(
            f"{model_name}: expected object mapping, got {type(data).__name__}"
        )
    values = cast(dict[object, object], data)
    for key in values:
        if type(key) is not str:
            raise FieldTypeError(
                f"{model_name}: field names must be strings, got {type(key).__name__}"
            )
    typed_values = cast(dict[str, object], values)
    known = required | (optional or set())
    unknown = sorted(set(typed_values) - known)
    if unknown:
        raise FieldTypeError(f"{model_name}.{unknown[0]}: unknown field")
    missing = sorted(required - set(typed_values))
    if missing:
        raise MissingFieldError(f"{model_name}.{missing[0]}: required field is missing")
    return typed_values


def _require_str(value: object, path: str) -> str:
    if type(value) is not str:
        raise FieldTypeError(f"{path}: expected string, got {type(value).__name__}")
    return value


def _optional_str(value: object, path: str) -> str | None:
    if value is None:
        return None
    return _require_str(value, path)


def _require_int(value: object, path: str) -> int:
    if type(value) is not int:
        raise FieldTypeError(f"{path}: expected int, got {type(value).__name__}")
    return value


def _require_float(value: object, path: str) -> float:
    if type(value) is not float:
        raise FieldTypeError(f"{path}: expected float, got {type(value).__name__}")
    return value


def _string_tuple(value: object, path: str) -> tuple[str, ...]:
    if type(value) is not list:
        raise FieldTypeError(f"{path}: expected JSON array, got {type(value).__name__}")
    items = cast(list[object], value)
    result = []
    for index, item in enumerate(items):
        result.append(_require_str(item, f"{path}[{index}]"))
    return tuple(result)


def _json_mapping(value: object, path: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise FieldTypeError(
            f"{path}: expected object mapping, got {type(value).__name__}"
        )
    validate_json_compatible(value, path=path)
    return cast(dict[str, object], value)


def _parse_enum(value: object, enum_type: type[EnumT], path: str) -> EnumT:
    if type(value) is not str:
        raise FieldTypeError(
            f"{path}: expected enum value string, got {type(value).__name__}"
        )
    try:
        return enum_type(value)
    except ValueError as exc:
        raise FieldTypeError(f"{path}: invalid {enum_type.__name__} value") from exc


def _format_datetime(value: datetime, path: str) -> str:
    validate_utc_datetime(value, field_name=path)
    return value.isoformat(timespec="microseconds")


def _format_optional_datetime(value: datetime | None, path: str) -> str | None:
    if value is None:
        return None
    return _format_datetime(value, path)


def _parse_datetime(value: object, path: str) -> datetime:
    if type(value) is not str:
        raise FieldTypeError(
            f"{path}: expected UTC datetime string, got {type(value).__name__}"
        )
    if _UTC_DATETIME_PATTERN.fullmatch(value) is None:
        raise InvariantViolationError(
            f"{path}: expected YYYY-MM-DDTHH:MM:SS.ffffff+00:00"
        )
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise InvariantViolationError(f"{path}: invalid UTC datetime") from exc
    validate_utc_datetime(parsed, field_name=path)
    return parsed


def _parse_optional_datetime(value: object, path: str) -> datetime | None:
    if value is None:
        return None
    return _parse_datetime(value, path)


def _construct_model(
    model_name: str,
    constructor: Callable[[], ModelT],
) -> ModelT:
    try:
        return constructor()
    except DataValidationError as exc:
        message = str(exc)
        if message.startswith(f"{model_name}."):
            raise
        raise type(exc)(f"{model_name}.{message}") from exc


def _copy_json_mapping(value: dict[str, object]) -> JsonObject:
    return {key: _copy_json_value(item) for key, item in value.items()}


def _copy_json_value(value: object) -> JsonValue:
    if value is None or type(value) in {bool, int, float, str}:
        return cast(JsonValue, value)
    if type(value) is list:
        return [_copy_json_value(item) for item in cast(list[object], value)]
    if isinstance(value, dict):
        return _copy_json_mapping(cast(dict[str, object], value))
    raise FieldTypeError(
        f"StepManifest.output_metadata: unsupported value type {type(value).__name__}"
    )


def _reject_json_constant(value: str) -> None:
    raise JsonDataError(f"JSON: non-finite number {value} is not allowed")


def _supported_model_name(model_type: object) -> str:
    supported = (
        Project,
        Character,
        Scene,
        Shot,
        GenerationTask,
        VideoAsset,
        StepManifest,
    )
    if model_type not in supported:
        name = getattr(model_type, "__name__", type(model_type).__name__)
        raise FieldTypeError(f"model_type: unsupported model type {name}")
    return cast(type[object], model_type).__name__
