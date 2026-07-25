"""Data model for persisted workflow step manifests."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import TypeAlias

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.validation import (
    validate_json_compatible,
    validate_utc_datetime,
)

JsonCompatibleValue: TypeAlias = (
    None
    | bool
    | int
    | float
    | str
    | list["JsonCompatibleValue"]
    | dict[str, "JsonCompatibleValue"]
)


class ManifestStatus(str, Enum):
    """Persistence state of one recoverable workflow step."""

    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class StepManifest:
    """Validated state recorded for one recoverable workflow step."""

    step_name: str
    input_digest: str
    relevant_config_digest: str
    status: ManifestStatus
    created_at: datetime
    schema_version: int = 1
    output_paths: tuple[str, ...] = ()
    output_metadata: dict[str, JsonCompatibleValue] = field(default_factory=dict)
    completed_at: datetime | None = None
    error_summary: str | None = None

    def __post_init__(self) -> None:
        _validate_non_empty_text(self.step_name, field_name="step_name")
        _validate_non_empty_text(self.input_digest, field_name="input_digest")
        _validate_non_empty_text(
            self.relevant_config_digest,
            field_name="relevant_config_digest",
        )
        if not isinstance(self.status, ManifestStatus):
            raise FieldTypeError(
                f"status: expected ManifestStatus, got {type(self.status).__name__}"
            )
        validate_utc_datetime(self.created_at, field_name="created_at")
        _validate_schema_version(self.schema_version)
        _validate_output_paths(self.output_paths)
        if not isinstance(self.output_metadata, dict):
            raise FieldTypeError(
                "output_metadata: expected dict, "
                f"got {type(self.output_metadata).__name__}"
            )
        validate_json_compatible(self.output_metadata, path="output_metadata")
        if self.completed_at is not None:
            validate_utc_datetime(self.completed_at, field_name="completed_at")
            if self.completed_at < self.created_at:
                raise InvariantViolationError(
                    "completed_at: must not be earlier than created_at"
                )
        _validate_optional_text(self.error_summary, field_name="error_summary")
        self._validate_status_fields()

    def _validate_status_fields(self) -> None:
        terminal = {ManifestStatus.COMPLETED, ManifestStatus.FAILED}
        if self.status in terminal and self.completed_at is None:
            raise InvariantViolationError(
                "completed_at: required for terminal manifest status"
            )
        if self.status not in terminal and self.completed_at is not None:
            raise InvariantViolationError(
                "completed_at: must be empty for non-terminal manifest status"
            )
        if self.status is ManifestStatus.FAILED:
            if self.error_summary is None:
                raise InvariantViolationError(
                    "error_summary: required for failed manifest status"
                )
        elif self.error_summary is not None:
            raise InvariantViolationError(
                "error_summary: only allowed for failed manifest status"
            )
        if self.status is ManifestStatus.COMPLETED and not self.output_paths:
            raise InvariantViolationError(
                "output_paths: completed manifest must contain at least one path"
            )


def _validate_non_empty_text(value: object, *, field_name: str) -> str:
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
    return _validate_non_empty_text(value, field_name=field_name)


def _validate_schema_version(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise FieldTypeError(
            f"schema_version: expected int, got {type(value).__name__}"
        )
    if value <= 0:
        raise InvariantViolationError("schema_version: must be greater than zero")
    return value


def _validate_output_paths(value: object) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise FieldTypeError(
            f"output_paths: expected tuple, got {type(value).__name__}"
        )
    for index, path in enumerate(value):
        _validate_non_empty_text(path, field_name=f"output_paths[{index}]")
    if len(set(value)) != len(value):
        raise InvariantViolationError("output_paths: duplicate paths are not allowed")
    return value
