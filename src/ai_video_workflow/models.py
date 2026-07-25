"""Core persisted data models for the file-based workflow."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.validation import validate_stable_id, validate_utc_datetime


class GenerationTaskStatus(str, Enum):
    """Current local persistence state of a generation task."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class Project:
    """Top-level project metadata."""

    project_id: str
    name: str
    created_at: datetime
    description: str | None = None

    def __post_init__(self) -> None:
        validate_stable_id(self.project_id, field_name="project_id")
        _validate_text(self.name, field_name="name")
        validate_utc_datetime(self.created_at, field_name="created_at")
        _validate_optional_text(self.description, field_name="description")


@dataclass(frozen=True, slots=True)
class Character:
    """Minimal character metadata owned by a project."""

    character_id: str
    project_id: str
    name: str
    description: str
    created_at: datetime

    def __post_init__(self) -> None:
        validate_stable_id(self.character_id, field_name="character_id")
        validate_stable_id(self.project_id, field_name="project_id")
        _validate_text(self.name, field_name="name")
        _validate_text(self.description, field_name="description")
        validate_utc_datetime(self.created_at, field_name="created_at")


@dataclass(frozen=True, slots=True)
class Scene:
    """Minimal ordered scene metadata owned by a project."""

    scene_id: str
    project_id: str
    sequence: int
    title: str
    description: str
    created_at: datetime

    def __post_init__(self) -> None:
        validate_stable_id(self.scene_id, field_name="scene_id")
        validate_stable_id(self.project_id, field_name="project_id")
        _validate_positive_int(self.sequence, field_name="sequence")
        _validate_text(self.title, field_name="title")
        _validate_text(self.description, field_name="description")
        validate_utc_datetime(self.created_at, field_name="created_at")


@dataclass(frozen=True, slots=True)
class Shot:
    """Minimal generation input for one ordered shot."""

    shot_id: str
    scene_id: str
    sequence: int
    description: str
    prompt: str
    duration_seconds: float
    width: int
    height: int
    frame_rate: float
    created_at: datetime
    character_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        validate_stable_id(self.shot_id, field_name="shot_id")
        validate_stable_id(self.scene_id, field_name="scene_id")
        _validate_positive_int(self.sequence, field_name="sequence")
        _validate_text(self.description, field_name="description")
        _validate_text(self.prompt, field_name="prompt")
        _validate_positive_float(self.duration_seconds, field_name="duration_seconds")
        _validate_positive_int(self.width, field_name="width")
        _validate_positive_int(self.height, field_name="height")
        _validate_positive_float(self.frame_rate, field_name="frame_rate")
        validate_utc_datetime(self.created_at, field_name="created_at")
        _validate_id_tuple(self.character_ids, field_name="character_ids")
        if len(set(self.character_ids)) != len(self.character_ids):
            raise InvariantViolationError(
                "character_ids: duplicate character IDs are not allowed"
            )


@dataclass(frozen=True, slots=True)
class GenerationTask:
    """Current business and runtime state for one shot generation attempt."""

    task_id: str
    shot_id: str
    status: GenerationTaskStatus
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    provider_id: str | None = None
    input_parameters_ref: str | None = None
    external_task_ref: str | None = None
    current_artifact_ref: str | None = None
    error_summary: str | None = None

    def __post_init__(self) -> None:
        validate_stable_id(self.task_id, field_name="task_id")
        validate_stable_id(self.shot_id, field_name="shot_id")
        if not isinstance(self.status, GenerationTaskStatus):
            raise FieldTypeError(
                "status: expected GenerationTaskStatus, "
                f"got {type(self.status).__name__}"
            )
        validate_utc_datetime(self.created_at, field_name="created_at")
        validate_utc_datetime(self.updated_at, field_name="updated_at")
        if self.updated_at < self.created_at:
            raise InvariantViolationError(
                "updated_at: must not be earlier than created_at"
            )
        if self.completed_at is not None:
            validate_utc_datetime(self.completed_at, field_name="completed_at")
            if self.completed_at < self.created_at:
                raise InvariantViolationError(
                    "completed_at: must not be earlier than created_at"
                )
            if self.completed_at > self.updated_at:
                raise InvariantViolationError(
                    "completed_at: must not be later than updated_at"
                )
        _validate_optional_id(self.provider_id, field_name="provider_id")
        _validate_optional_text(
            self.input_parameters_ref, field_name="input_parameters_ref"
        )
        _validate_optional_text(self.external_task_ref, field_name="external_task_ref")
        _validate_optional_text(
            self.current_artifact_ref, field_name="current_artifact_ref"
        )
        _validate_optional_text(self.error_summary, field_name="error_summary")
        self._validate_status_fields()

    def _validate_status_fields(self) -> None:
        terminal = {
            GenerationTaskStatus.DONE,
            GenerationTaskStatus.FAILED,
        }
        if self.status in terminal and self.completed_at is None:
            raise InvariantViolationError(
                "completed_at: required for terminal task status"
            )
        if self.status not in terminal and self.completed_at is not None:
            raise InvariantViolationError(
                "completed_at: must be empty for non-terminal task status"
            )
        if self.status is GenerationTaskStatus.FAILED:
            if self.error_summary is None:
                raise InvariantViolationError(
                    "error_summary: required for failed task status"
                )
        elif self.error_summary is not None:
            raise InvariantViolationError(
                "error_summary: only allowed for failed task status"
            )


@dataclass(frozen=True, slots=True)
class VideoAsset:
    """Metadata for a validated and formally registered video asset."""

    asset_id: str
    shot_id: str
    source_task_id: str
    path: Path
    container_format: str
    duration_seconds: float
    width: int
    height: int
    frame_rate: float
    version: int
    validated_at: datetime

    def __post_init__(self) -> None:
        validate_stable_id(self.asset_id, field_name="asset_id")
        validate_stable_id(self.shot_id, field_name="shot_id")
        validate_stable_id(self.source_task_id, field_name="source_task_id")
        if not isinstance(self.path, Path):
            raise FieldTypeError(f"path: expected Path, got {type(self.path).__name__}")
        if str(self.path) == ".":
            raise InvariantViolationError("path: asset path must not be empty")
        _validate_text(self.container_format, field_name="container_format")
        _validate_positive_float(self.duration_seconds, field_name="duration_seconds")
        _validate_positive_int(self.width, field_name="width")
        _validate_positive_int(self.height, field_name="height")
        _validate_positive_float(self.frame_rate, field_name="frame_rate")
        _validate_positive_int(self.version, field_name="version")
        validate_utc_datetime(self.validated_at, field_name="validated_at")


def _validate_text(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if not value or value.isspace():
        raise InvariantViolationError(f"{field_name}: must not be empty or blank")
    if value != value.strip():
        raise InvariantViolationError(
            f"{field_name}: must not contain leading or trailing whitespace"
        )
    return value


def _validate_optional_text(value: object, *, field_name: str) -> str | None:
    if value is None:
        return None
    return _validate_text(value, field_name=field_name)


def _validate_optional_id(value: object, *, field_name: str) -> str | None:
    if value is None:
        return None
    return validate_stable_id(value, field_name=field_name)


def _validate_positive_int(value: object, *, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise FieldTypeError(f"{field_name}: expected int, got {type(value).__name__}")
    if value <= 0:
        raise InvariantViolationError(f"{field_name}: must be greater than zero")
    return value


def _validate_positive_float(value: object, *, field_name: str) -> float:
    if not isinstance(value, float):
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value <= 0:
        raise InvariantViolationError(
            f"{field_name}: must be finite and greater than zero"
        )
    return value


def _validate_id_tuple(value: object, *, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise FieldTypeError(
            f"{field_name}: expected tuple, got {type(value).__name__}"
        )
    for index, item in enumerate(value):
        validate_stable_id(item, field_name=f"{field_name}[{index}]")
    return value
