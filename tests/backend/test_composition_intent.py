"""Tests for the project-level CompositionPublishIntent (TASK-006 / ADR-0001)."""

from __future__ import annotations

import pytest

from ai_video_workflow.composition.errors import CompositionConflictError
from ai_video_workflow.composition.intent import (
    CompositionPublishIntent,
    intent_path,
    read_intent,
    write_intent,
)
from ai_video_workflow.errors import InvariantViolationError


def _intent(**overrides) -> CompositionPublishIntent:
    base = dict(
        project_id="proj-1",
        logical_version=1,
        input_digest="a" * 64,
        profile_digest="b" * 64,
        media_path="outputs/final_v1.mp4",
        json_report_path="reports/composition/final_v1.json",
        markdown_report_path="reports/composition/final_v1.md",
    )
    base.update(overrides)
    return CompositionPublishIntent(**base)


def test_intent_path_is_project_keyed(tmp_path) -> None:
    path = intent_path(tmp_path, "proj-1", 2)
    assert path == (tmp_path / "records/step-intents/composition/proj-1/2.json")


def test_intent_rejects_task_shot_operation_absence() -> None:
    # the intent has no task/shot/operation fields by construction
    fields = _intent().to_json_dict()
    assert "task_id" not in fields
    assert "shot_id" not in fields
    assert "operation_id" not in fields
    assert set(fields) == {
        "schema_version",
        "project_id",
        "logical_version",
        "input_digest",
        "profile_digest",
        "media_path",
        "json_report_path",
        "markdown_report_path",
    }


def test_intent_rejects_bad_version() -> None:
    with pytest.raises(InvariantViolationError):
        _intent(logical_version=0)


def test_write_then_read_round_trip(tmp_path) -> None:
    intent = _intent()
    assert write_intent(tmp_path, intent) == "written"
    loaded = read_intent(tmp_path, "proj-1", 1)
    assert loaded == intent


def test_write_same_identity_is_reused(tmp_path) -> None:
    intent = _intent()
    write_intent(tmp_path, intent)
    assert write_intent(tmp_path, intent) == "reused"


def test_write_conflicting_identity_raises(tmp_path) -> None:
    write_intent(tmp_path, _intent())
    with pytest.raises(CompositionConflictError):
        write_intent(tmp_path, _intent(input_digest="c" * 64))
    # original preserved, not overwritten
    assert read_intent(tmp_path, "proj-1", 1).input_digest == "a" * 64


def test_read_missing_intent_is_none(tmp_path) -> None:
    assert read_intent(tmp_path, "proj-1", 9) is None


def test_intent_json_has_no_wall_clock(tmp_path) -> None:
    write_intent(tmp_path, _intent())
    text = intent_path(tmp_path, "proj-1", 1).read_text(encoding="utf-8")
    assert "occurred_at" not in text and "timestamp" not in text
