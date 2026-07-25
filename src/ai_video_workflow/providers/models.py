"""Provider contract data structures, enums, and JSON freezing helpers."""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from types import MappingProxyType
from typing import TypeAlias

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.providers.errors import (
    InvalidProviderRequestError,
    InvalidProviderStateError,
)
from ai_video_workflow.validation import (
    validate_json_compatible,
    validate_stable_id,
    validate_utc_datetime,
)

JsonInputValue: TypeAlias = (
    None
    | bool
    | int
    | float
    | str
    | list["JsonInputValue"]
    | dict[str, "JsonInputValue"]
)
FrozenJsonValue: TypeAlias = (
    None
    | bool
    | int
    | float
    | str
    | tuple["FrozenJsonValue", ...]
    | Mapping[str, "FrozenJsonValue"]
)


class ArtifactOrigin(str, Enum):
    """Which actor produced a generation artifact."""

    USER = "user"
    PROVIDER = "provider"


class ArtifactLocation(str, Enum):
    """Which reference mechanism locates a generation artifact."""

    EXTERNAL = "external"
    STAGING = "staging"


class ProviderStatus(str, Enum):
    """Normalized provider-side status of one generation lifecycle."""

    NOT_SUBMITTED = "not_submitted"
    WAITING_FOR_USER = "waiting_for_user"
    PROCESSING = "processing"
    ARTIFACT_AVAILABLE = "artifact_available"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        """Return True for succeeded, failed, and cancelled."""
        return self in _TERMINAL_PROVIDER_STATUSES

    @property
    def requires_user_action(self) -> bool:
        """Return True only while waiting for user action."""
        return self is ProviderStatus.WAITING_FOR_USER


_TERMINAL_PROVIDER_STATUSES = frozenset(
    {
        ProviderStatus.SUCCEEDED,
        ProviderStatus.FAILED,
        ProviderStatus.CANCELLED,
    }
)


@dataclass(frozen=True, slots=True)
class ArtifactReference:
    """One normalized reference to a generation artifact."""

    reference: str
    origin: ArtifactOrigin
    location: ArtifactLocation

    def __post_init__(self) -> None:
        _validate_opaque_reference(self.reference, field_name="reference")
        if not isinstance(self.origin, ArtifactOrigin):
            raise FieldTypeError(
                f"origin: expected ArtifactOrigin, got {type(self.origin).__name__}"
            )
        if not isinstance(self.location, ArtifactLocation):
            raise FieldTypeError(
                "location: expected ArtifactLocation, "
                f"got {type(self.location).__name__}"
            )

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this reference."""
        return {
            "reference": self.reference,
            "origin": self.origin.value,
            "location": self.location.value,
        }


@dataclass(frozen=True, slots=True)
class ProviderCostObservation:
    """One optional single-operation provider cost observation."""

    amount: float
    unit: str

    def __post_init__(self) -> None:
        if type(self.amount) is not float:
            raise FieldTypeError(
                f"amount: expected float, got {type(self.amount).__name__}"
            )
        if not math.isfinite(self.amount) or self.amount < 0:
            raise InvariantViolationError("amount: must be finite and non-negative")
        _validate_opaque_reference(self.unit, field_name="unit")

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this observation."""
        return {"amount": self.amount, "unit": self.unit}


@dataclass(frozen=True, slots=True, init=False)
class ProviderInstruction:
    """Structured provider instructions a caller can show to a user."""

    provider_id: str
    task_id: str
    shot_id: str
    prompt: str
    expected_duration_seconds: float
    expected_width: int
    expected_height: int
    expected_frame_rate: float
    staging_ref: str
    steps: tuple[str, ...]
    _suggested_parameters: Mapping[str, FrozenJsonValue]

    __hash__ = None

    def __init__(
        self,
        provider_id: str,
        task_id: str,
        shot_id: str,
        prompt: str,
        expected_duration_seconds: float,
        expected_width: int,
        expected_height: int,
        expected_frame_rate: float,
        staging_ref: str,
        steps: tuple[str, ...],
        suggested_parameters: dict[str, JsonInputValue] | None = None,
    ) -> None:
        set_field = object.__setattr__
        set_field(
            self,
            "provider_id",
            validate_stable_id(provider_id, field_name="provider_id"),
        )
        set_field(self, "task_id", validate_stable_id(task_id, field_name="task_id"))
        set_field(self, "shot_id", validate_stable_id(shot_id, field_name="shot_id"))
        set_field(self, "prompt", _validate_text(prompt, field_name="prompt"))
        set_field(
            self,
            "expected_duration_seconds",
            _validate_strict_positive_float(
                expected_duration_seconds,
                field_name="expected_duration_seconds",
            ),
        )
        set_field(
            self,
            "expected_width",
            _validate_strict_positive_int(
                expected_width,
                field_name="expected_width",
            ),
        )
        set_field(
            self,
            "expected_height",
            _validate_strict_positive_int(
                expected_height,
                field_name="expected_height",
            ),
        )
        set_field(
            self,
            "expected_frame_rate",
            _validate_strict_positive_float(
                expected_frame_rate,
                field_name="expected_frame_rate",
            ),
        )
        set_field(
            self,
            "staging_ref",
            _validate_opaque_reference(staging_ref, field_name="staging_ref"),
        )
        set_field(self, "steps", _validate_steps(steps))
        set_field(
            self,
            "_suggested_parameters",
            _freeze_parameters(
                suggested_parameters,
                field_name="suggested_parameters",
            ),
        )

    @property
    def suggested_parameters(self) -> Mapping[str, FrozenJsonValue]:
        """Return the read-only frozen suggested parameters mapping."""
        return self._suggested_parameters

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this instruction."""
        return {
            "provider_id": self.provider_id,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "prompt": self.prompt,
            "expected_duration_seconds": self.expected_duration_seconds,
            "expected_width": self.expected_width,
            "expected_height": self.expected_height,
            "expected_frame_rate": self.expected_frame_rate,
            "staging_ref": self.staging_ref,
            "steps": list(self.steps),
            "suggested_parameters": _thaw_json_mapping(self._suggested_parameters),
        }


@dataclass(frozen=True, slots=True, init=False)
class ProviderRequest:
    """One immutable generation request handed to a provider."""

    provider_id: str
    task_id: str
    shot_id: str
    prompt: str
    duration_seconds: float
    width: int
    height: int
    frame_rate: float
    staging_ref: str | None
    _provider_parameters: Mapping[str, FrozenJsonValue]

    __hash__ = None

    def __init__(
        self,
        provider_id: str,
        task_id: str,
        shot_id: str,
        prompt: str,
        duration_seconds: float,
        width: int,
        height: int,
        frame_rate: float,
        staging_ref: str | None = None,
        provider_parameters: dict[str, JsonInputValue] | None = None,
    ) -> None:
        set_field = object.__setattr__
        set_field(
            self,
            "provider_id",
            validate_stable_id(provider_id, field_name="provider_id"),
        )
        set_field(self, "task_id", validate_stable_id(task_id, field_name="task_id"))
        set_field(self, "shot_id", validate_stable_id(shot_id, field_name="shot_id"))
        set_field(self, "prompt", _validate_text(prompt, field_name="prompt"))
        set_field(
            self,
            "duration_seconds",
            _validate_strict_positive_float(
                duration_seconds,
                field_name="duration_seconds",
            ),
        )
        set_field(
            self,
            "width",
            _validate_strict_positive_int(width, field_name="width"),
        )
        set_field(
            self,
            "height",
            _validate_strict_positive_int(height, field_name="height"),
        )
        set_field(
            self,
            "frame_rate",
            _validate_strict_positive_float(frame_rate, field_name="frame_rate"),
        )
        if staging_ref is not None:
            _validate_opaque_reference(staging_ref, field_name="staging_ref")
        set_field(self, "staging_ref", staging_ref)
        set_field(
            self,
            "_provider_parameters",
            _freeze_parameters(
                provider_parameters,
                field_name="provider_parameters",
            ),
        )

    @property
    def provider_parameters(self) -> Mapping[str, FrozenJsonValue]:
        """Return the read-only frozen provider parameters mapping."""
        return self._provider_parameters

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this request."""
        return {
            "provider_id": self.provider_id,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "prompt": self.prompt,
            "duration_seconds": self.duration_seconds,
            "width": self.width,
            "height": self.height,
            "frame_rate": self.frame_rate,
            "staging_ref": self.staging_ref,
            "provider_parameters": _thaw_json_mapping(self._provider_parameters),
        }


@dataclass(frozen=True, slots=True)
class ProviderResult:
    """One immutable provider-side result snapshot for one request."""

    provider_id: str
    task_id: str
    shot_id: str
    status: ProviderStatus
    observed_at: datetime
    external_task_ref: str | None = None
    artifact: ArtifactReference | None = None
    instruction: ProviderInstruction | None = None
    message: str | None = None
    error_summary: str | None = None
    completed_at: datetime | None = None
    elapsed_seconds: float | None = None
    cost_observation: ProviderCostObservation | None = None

    def __post_init__(self) -> None:
        validate_stable_id(self.provider_id, field_name="provider_id")
        validate_stable_id(self.task_id, field_name="task_id")
        validate_stable_id(self.shot_id, field_name="shot_id")
        if not isinstance(self.status, ProviderStatus):
            raise FieldTypeError(
                f"status: expected ProviderStatus, got {type(self.status).__name__}"
            )
        validate_utc_datetime(self.observed_at, field_name="observed_at")
        if self.external_task_ref is not None:
            _validate_opaque_reference(
                self.external_task_ref,
                field_name="external_task_ref",
            )
        if self.artifact is not None and not isinstance(
            self.artifact, ArtifactReference
        ):
            raise FieldTypeError(
                "artifact: expected ArtifactReference, "
                f"got {type(self.artifact).__name__}"
            )
        if self.instruction is not None and not isinstance(
            self.instruction, ProviderInstruction
        ):
            raise FieldTypeError(
                "instruction: expected ProviderInstruction, "
                f"got {type(self.instruction).__name__}"
            )
        if self.message is not None:
            _validate_text(self.message, field_name="message")
        if self.error_summary is not None:
            _validate_text(self.error_summary, field_name="error_summary")
        if self.completed_at is not None:
            validate_utc_datetime(self.completed_at, field_name="completed_at")
            if self.completed_at > self.observed_at:
                raise InvariantViolationError(
                    "completed_at: must not be later than observed_at"
                )
        if self.elapsed_seconds is not None:
            _validate_non_negative_float(
                self.elapsed_seconds,
                field_name="elapsed_seconds",
            )
        if self.cost_observation is not None and not isinstance(
            self.cost_observation, ProviderCostObservation
        ):
            raise FieldTypeError(
                "cost_observation: expected ProviderCostObservation, "
                f"got {type(self.cost_observation).__name__}"
            )
        self._validate_status_matrix()
        self._validate_instruction_alignment()

    def _validate_instruction_alignment(self) -> None:
        if self.instruction is None:
            return
        for field_name in ("provider_id", "task_id", "shot_id"):
            if getattr(self.instruction, field_name) != getattr(self, field_name):
                raise InvalidProviderRequestError(
                    f"instruction.{field_name}: must match the result {field_name}"
                )

    def _validate_status_matrix(self) -> None:
        status = self.status
        if status is ProviderStatus.NOT_SUBMITTED:
            _forbid(self.artifact, field_name="artifact", status=status)
            _forbid(
                self.external_task_ref,
                field_name="external_task_ref",
                status=status,
            )
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _forbid(self.completed_at, field_name="completed_at", status=status)
            return
        _forbid(self.instruction, field_name="instruction", status=status)
        if status in (ProviderStatus.WAITING_FOR_USER, ProviderStatus.PROCESSING):
            _forbid(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _forbid(self.completed_at, field_name="completed_at", status=status)
        elif status is ProviderStatus.ARTIFACT_AVAILABLE:
            _require(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _forbid(self.completed_at, field_name="completed_at", status=status)
        elif status is ProviderStatus.SUCCEEDED:
            _require(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _require(self.completed_at, field_name="completed_at", status=status)
        elif status is ProviderStatus.FAILED:
            _forbid(self.artifact, field_name="artifact", status=status)
            _require(self.error_summary, field_name="error_summary", status=status)
            _require(self.completed_at, field_name="completed_at", status=status)
        else:
            _forbid(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _require(self.completed_at, field_name="completed_at", status=status)

    @property
    def is_terminal(self) -> bool:
        """Return the terminal flag derived from the provider status."""
        return self.status.is_terminal

    @property
    def requires_user_action(self) -> bool:
        """Return the user-action flag derived from the provider status."""
        return self.status.requires_user_action

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this result."""
        return {
            "provider_id": self.provider_id,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "status": self.status.value,
            "observed_at": _format_utc_datetime(self.observed_at),
            "external_task_ref": self.external_task_ref,
            "artifact": (
                None if self.artifact is None else self.artifact.to_json_dict()
            ),
            "instruction": (
                None if self.instruction is None else self.instruction.to_json_dict()
            ),
            "message": self.message,
            "error_summary": self.error_summary,
            "completed_at": (
                None
                if self.completed_at is None
                else _format_utc_datetime(self.completed_at)
            ),
            "elapsed_seconds": self.elapsed_seconds,
            "cost_observation": (
                None
                if self.cost_observation is None
                else self.cost_observation.to_json_dict()
            ),
        }


def _forbid(value: object, *, field_name: str, status: ProviderStatus) -> None:
    if value is not None:
        raise InvalidProviderStateError(
            f"{field_name}: not allowed for provider status {status.value}"
        )


def _require(value: object, *, field_name: str, status: ProviderStatus) -> None:
    if value is None:
        raise InvalidProviderStateError(
            f"{field_name}: required for provider status {status.value}"
        )


def _validate_opaque_reference(value: object, *, field_name: str) -> str:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if not value or value.isspace():
        raise InvariantViolationError(f"{field_name}: must not be empty or blank")
    if value != value.strip():
        raise InvariantViolationError(
            f"{field_name}: must not contain leading or trailing whitespace"
        )
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise InvariantViolationError(
            f"{field_name}: must not contain control characters"
        )
    return value


def _validate_text(value: object, *, field_name: str) -> str:
    if type(value) is not str:
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


def _validate_strict_positive_float(value: object, *, field_name: str) -> float:
    if type(value) is not float:
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value <= 0:
        raise InvariantViolationError(
            f"{field_name}: must be finite and greater than zero"
        )
    return value


def _validate_strict_positive_int(value: object, *, field_name: str) -> int:
    if type(value) is not int:
        raise FieldTypeError(f"{field_name}: expected int, got {type(value).__name__}")
    if value <= 0:
        raise InvariantViolationError(f"{field_name}: must be greater than zero")
    return value


def _validate_non_negative_float(value: object, *, field_name: str) -> float:
    if type(value) is not float:
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value < 0:
        raise InvariantViolationError(f"{field_name}: must be finite and non-negative")
    return value


def _validate_steps(value: object) -> tuple[str, ...]:
    if type(value) is not tuple:
        raise FieldTypeError(f"steps: expected tuple, got {type(value).__name__}")
    if not value:
        raise InvariantViolationError("steps: must contain at least one step")
    for index, step in enumerate(value):
        _validate_text(step, field_name=f"steps[{index}]")
    return value


def _freeze_parameters(
    value: object,
    *,
    field_name: str,
) -> Mapping[str, FrozenJsonValue]:
    if value is None:
        value = {}
    if type(value) is not dict:
        raise FieldTypeError(f"{field_name}: expected dict, got {type(value).__name__}")
    validate_json_compatible(value, path=field_name)
    return _freeze_json_mapping(value, field_name=field_name)


def _freeze_json_mapping(
    value: dict[str, object],
    *,
    field_name: str,
) -> Mapping[str, FrozenJsonValue]:
    return MappingProxyType(
        {
            key: _freeze_json_value(item, field_name=field_name)
            for key, item in value.items()
        }
    )


def _freeze_json_value(value: object, *, field_name: str) -> FrozenJsonValue:
    if value is None or type(value) in {bool, int, float, str}:
        return value
    if type(value) is list:
        return tuple(_freeze_json_value(item, field_name=field_name) for item in value)
    if type(value) is dict:
        return _freeze_json_mapping(value, field_name=field_name)
    raise FieldTypeError(
        f"{field_name}: expected plain dict/list JSON input, got {type(value).__name__}"
    )


def _thaw_json_mapping(
    value: Mapping[str, FrozenJsonValue],
) -> dict[str, JsonInputValue]:
    return {key: _thaw_json_value(item) for key, item in value.items()}


def _thaw_json_value(value: object) -> JsonInputValue:
    if isinstance(value, Mapping):
        return {key: _thaw_json_value(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw_json_value(item) for item in value]
    return value


def _format_utc_datetime(value: datetime) -> str:
    return value.isoformat(timespec="microseconds")
