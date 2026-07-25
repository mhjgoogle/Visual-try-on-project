"""Reusable validation helpers for foundational value types."""

from __future__ import annotations

import math
import unicodedata
from datetime import datetime, timedelta
from enum import Enum
from typing import Any

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError


def validate_stable_id(value: object, *, field_name: str = "id") -> str:
    """Return an unchanged, non-empty string ID without control characters."""
    if not isinstance(value, str):
        raise FieldTypeError(
            f"{field_name}: expected a string ID, got {type(value).__name__}"
        )
    if not value or value.isspace():
        raise InvariantViolationError(f"{field_name}: ID must not be empty or blank")
    if value != value.strip():
        raise InvariantViolationError(
            f"{field_name}: ID must not contain leading or trailing whitespace"
        )
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise InvariantViolationError(
            f"{field_name}: ID must not contain control characters"
        )
    return value


def validate_utc_datetime(value: object, *, field_name: str = "datetime") -> datetime:
    """Return an unchanged timezone-aware datetime whose UTC offset is zero."""
    if not isinstance(value, datetime):
        raise FieldTypeError(
            f"{field_name}: expected datetime, got {type(value).__name__}"
        )
    if value.tzinfo is None or value.utcoffset() is None:
        raise InvariantViolationError(
            f"{field_name}: datetime must include timezone information"
        )
    if value.utcoffset() != timedelta(0):
        raise InvariantViolationError(
            f"{field_name}: datetime must have a zero UTC offset"
        )
    return value


def validate_json_compatible(value: object, *, path: str = "value") -> None:
    """Validate a value recursively without converting or mutating it."""
    _validate_json_compatible(value, path=path, active_container_ids=set())


def _validate_json_compatible(
    value: object, *, path: str, active_container_ids: set[int]
) -> None:
    if isinstance(value, Enum):
        raise FieldTypeError(
            f"{path}: expected a JSON-compatible value, got {type(value).__name__}"
        )
    if value is None or isinstance(value, (bool, int, str)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise InvariantViolationError(f"{path}: float must be finite")
        return
    if isinstance(value, list):
        _validate_json_container(
            value,
            path=path,
            active_container_ids=active_container_ids,
            validate_contents=lambda: _validate_json_list(
                value, path=path, active_container_ids=active_container_ids
            ),
        )
        return
    if isinstance(value, dict):
        _validate_json_container(
            value,
            path=path,
            active_container_ids=active_container_ids,
            validate_contents=lambda: _validate_json_dict(
                value, path=path, active_container_ids=active_container_ids
            ),
        )
        return
    raise FieldTypeError(
        f"{path}: expected a JSON-compatible value, got {type(value).__name__}"
    )


def _validate_json_container(
    value: list[Any] | dict[Any, Any],
    *,
    path: str,
    active_container_ids: set[int],
    validate_contents: Any,
) -> None:
    container_id = id(value)
    if container_id in active_container_ids:
        raise InvariantViolationError(f"{path}: cyclic containers are not valid JSON")
    active_container_ids.add(container_id)
    try:
        validate_contents()
    finally:
        active_container_ids.remove(container_id)


def _validate_json_list(
    value: list[Any], *, path: str, active_container_ids: set[int]
) -> None:
    for index, item in enumerate(value):
        _validate_json_compatible(
            item,
            path=f"{path}[{index}]",
            active_container_ids=active_container_ids,
        )


def _validate_json_dict(
    value: dict[Any, Any], *, path: str, active_container_ids: set[int]
) -> None:
    for key, item in value.items():
        if not isinstance(key, str):
            raise FieldTypeError(
                f"{path}: JSON mapping keys must be strings, got {type(key).__name__}"
            )
        _validate_json_compatible(
            item,
            path=_child_path(path, key),
            active_container_ids=active_container_ids,
        )


def _child_path(parent: str, key: str) -> str:
    if key.isidentifier():
        return f"{parent}.{key}"
    return f"{parent}[{key!r}]"
