from copy import deepcopy
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path

import pytest

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.validation import (
    validate_json_compatible,
    validate_stable_id,
    validate_utc_datetime,
)


class StringEnum(str, Enum):
    VALUE = "value"


class CustomObject:
    pass


@pytest.mark.parametrize("value", ["project-01", "镜头_01", "id.with:punc"])
def test_stable_id_accepts_general_non_blank_strings(value: str) -> None:
    assert validate_stable_id(value) is value


@pytest.mark.parametrize("value", [None, 1, b"id"])
def test_stable_id_rejects_non_strings(value: object) -> None:
    with pytest.raises(FieldTypeError):
        validate_stable_id(value)


@pytest.mark.parametrize("value", ["", "   ", " leading", "trailing ", "line\nbreak"])
def test_stable_id_rejects_invalid_strings(value: str) -> None:
    with pytest.raises(InvariantViolationError):
        validate_stable_id(value)


def test_stable_id_error_includes_field_context_without_value() -> None:
    with pytest.raises(InvariantViolationError, match=r"^shot_id:") as caught:
        validate_stable_id(" secret ", field_name="shot_id")
    assert "secret" not in str(caught.value)


def test_utc_datetime_rejects_naive_datetime() -> None:
    with pytest.raises(InvariantViolationError):
        validate_utc_datetime(datetime(2026, 1, 1))


def test_utc_datetime_rejects_non_utc_offset() -> None:
    non_utc = datetime(2026, 1, 1, tzinfo=timezone(timedelta(hours=9)))
    with pytest.raises(InvariantViolationError):
        validate_utc_datetime(non_utc)


def test_utc_datetime_accepts_utc_without_conversion() -> None:
    utc_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert validate_utc_datetime(utc_value) is utc_value


def test_utc_datetime_rejects_non_datetime() -> None:
    with pytest.raises(FieldTypeError):
        validate_utc_datetime("2026-01-01T00:00:00Z")


@pytest.mark.parametrize(
    "value",
    [None, True, False, 0, -2, 3.5, "", "text", [], {}],
)
def test_json_compatible_accepts_scalar_and_empty_container_values(
    value: object,
) -> None:
    validate_json_compatible(value)


def test_json_compatible_accepts_deep_structure_without_mutation() -> None:
    value = {"frames": [{"path": "frame-001.png", "scores": [1, 0.5, None]}]}
    original = deepcopy(value)
    validate_json_compatible(value, path="output_metadata")
    assert value == original


@pytest.mark.parametrize(
    "value",
    [float("nan"), float("inf"), float("-inf")],
)
def test_json_compatible_rejects_non_finite_float(value: float) -> None:
    with pytest.raises(InvariantViolationError):
        validate_json_compatible(value)


def test_json_compatible_rejects_non_string_mapping_key() -> None:
    with pytest.raises(FieldTypeError, match="mapping keys must be strings"):
        validate_json_compatible({1: "value"}, path="output_metadata")


@pytest.mark.parametrize(
    "value",
    [
        Path("frame.png"),
        datetime(2026, 1, 1, tzinfo=timezone.utc),
        StringEnum.VALUE,
        CustomObject(),
        ("tuple",),
        {"set"},
        b"bytes",
    ],
)
def test_json_compatible_rejects_unsupported_values(value: object) -> None:
    with pytest.raises(FieldTypeError):
        validate_json_compatible(value)


def test_json_compatible_error_identifies_nested_path() -> None:
    value = {"frames": [{"path": Path("frame.png")}]}
    with pytest.raises(FieldTypeError, match=r"^output_metadata\.frames\[0\]\.path:"):
        validate_json_compatible(value, path="output_metadata")


def test_json_compatible_rejects_cyclic_container() -> None:
    value: list[object] = []
    value.append(value)
    with pytest.raises(InvariantViolationError, match=r"^value\[0\]:"):
        validate_json_compatible(value)
