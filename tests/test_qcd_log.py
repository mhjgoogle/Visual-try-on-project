"""Tests for the append-only QCD event log writer and reader (ADR-0003)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ai_video_workflow.qcd.events import (
    build_task_created_event,
    build_validation_completed_event,
)
from ai_video_workflow.qcd.log import (
    CorruptEventLogError,
    append_event,
    log_path,
    read_events,
)

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def _task_created(root_task: str, occurred_at=T0):
    return build_task_created_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id=root_task,
        configured_provider_id="manual",
        origin="bootstrap",
        redo_of_task_id=None,
        occurred_at=occurred_at,
    )


def test_read_missing_log_is_empty(tmp_path) -> None:
    assert read_events(tmp_path) == ()


def test_append_then_read_round_trip(tmp_path) -> None:
    a = _task_created("task-a")
    b = _task_created("task-b")
    append_event(tmp_path, a)
    append_event(tmp_path, b)
    events = read_events(tmp_path)
    assert [e.event_id for e in events] == [a.event_id, b.event_id]
    assert events[0].payload == a.payload


def test_append_is_append_only_never_truncates(tmp_path) -> None:
    append_event(tmp_path, _task_created("task-a"))
    before = log_path(tmp_path).read_bytes()
    append_event(tmp_path, _task_created("task-b"))
    after = log_path(tmp_path).read_bytes()
    assert after.startswith(before)
    assert len(after) > len(before)


def test_each_line_ends_with_newline(tmp_path) -> None:
    append_event(tmp_path, _task_created("task-a"))
    raw = log_path(tmp_path).read_bytes()
    assert raw.endswith(b"\n")
    assert b"\n" in raw and raw.count(b"\n") == 1


def test_duplicate_event_ids_preserved(tmp_path) -> None:
    event = build_validation_completed_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        passed=True,
        report_path="reports/validation/task-1_v1.json",
        report_version=1,
        checks_total=3,
        checks_failed=0,
        input_sha256="a" * 64,
        asset_id="asset-task-1-v1",
        occurred_at=T0,
    )
    append_event(tmp_path, event)
    append_event(tmp_path, event)  # replay: deterministic id, duplicate line
    events = read_events(tmp_path)
    assert len(events) == 2
    assert events[0].event_id == events[1].event_id
    # consumer-side de-duplication (first wins), per ADR-0003 §5
    seen: dict[str, object] = {}
    for e in events:
        seen.setdefault(e.event_id, e)
    assert len(seen) == 1


def test_torn_final_line_is_ignored(tmp_path) -> None:
    append_event(tmp_path, _task_created("task-a"))
    # simulate a crash mid-append: a fragment with no trailing newline
    with log_path(tmp_path).open("ab") as stream:
        stream.write(b'{"partial": ')
    events = read_events(tmp_path)
    assert len(events) == 1
    assert events[0].event_id == "task_created:task-a"


def test_append_refuses_after_torn_tail(tmp_path) -> None:
    append_event(tmp_path, _task_created("task-a"))
    with log_path(tmp_path).open("ab") as stream:
        stream.write(b'{"partial": ')
    with pytest.raises(CorruptEventLogError):
        append_event(tmp_path, _task_created("task-b"))


def test_corrupt_middle_line_raises_with_line_number(tmp_path) -> None:
    append_event(tmp_path, _task_created("task-a"))
    with log_path(tmp_path).open("ab") as stream:
        stream.write(b"not json\n")
    append_event(tmp_path, _task_created("task-b"))
    with pytest.raises(CorruptEventLogError) as exc:
        read_events(tmp_path)
    assert "line 2" in str(exc.value)


def test_unknown_event_type_is_corrupt(tmp_path) -> None:
    log_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    log_path(tmp_path).write_text(
        '{"schema_version": 1, "event_id": "x", "event_type": "mystery", '
        '"occurred_at": "2026-07-29T08:00:00.000000+00:00", "project_id": "p", '
        '"shot_id": null, "task_id": null, "payload": {}}\n',
        encoding="utf-8",
    )
    with pytest.raises(CorruptEventLogError):
        read_events(tmp_path)


def test_unsupported_schema_version_is_corrupt(tmp_path) -> None:
    log_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    log_path(tmp_path).write_text(
        '{"schema_version": 2, "event_id": "task_created:task-a", '
        '"event_type": "task_created", '
        '"occurred_at": "2026-07-29T08:00:00.000000+00:00", "project_id": "p", '
        '"shot_id": "shot-1", "task_id": "task-a", '
        '"payload": {"initial_status": "pending", "task_kind": "generation", '
        '"configured_provider_id": "manual", "origin": "bootstrap", '
        '"redo_of_task_id": null}}\n',
        encoding="utf-8",
    )
    with pytest.raises(CorruptEventLogError):
        read_events(tmp_path)
