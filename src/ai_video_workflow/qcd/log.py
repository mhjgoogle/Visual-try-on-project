"""Append-only QCD event log writer and strict reader (ADR-0003).

The log is a single JSON Lines file, ``qcd/events/log.jsonl``, relative
to the project data root. Writes are strictly append-only (``O_APPEND``
+ flush + fsync); a torn final line blocks further appends. The reader
strictly parses every complete line, tolerates exactly one torn final
fragment, and never rewrites, patches, or truncates the log. Duplicate
``event_id`` lines may exist on disk (replay); the reader de-duplicates
first-wins so every consumer sees each event once, in first-seen order
(ADR-0003 §5: "读取方必须去重（保留首行）").
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.qcd.events import (
    QCD_LOG_SCHEMA_VERSION,
    QcdEvent,
    QcdEventType,
)
from ai_video_workflow.security import resolve_within_root
from ai_video_workflow.validation import validate_utc_datetime

_LOG_RELATIVE = ("qcd", "events", "log.jsonl")

_ENVELOPE_KEYS = frozenset(
    {
        "schema_version",
        "event_id",
        "event_type",
        "occurred_at",
        "project_id",
        "shot_id",
        "task_id",
        "payload",
    }
)


class QcdLogError(AiVideoWorkflowError):
    """Base error for QCD event-log IO and integrity failures."""


class CorruptEventLogError(QcdLogError):
    """Raised when a complete log line cannot be strictly parsed."""


def log_path(project_root: Path) -> Path:
    """Return the append-only event log path for a project root.

    The path is admitted through the ADR-0004 containment resolver: a
    symlinked ``qcd/`` or ``qcd/events/`` component (which would write the
    log outside the project root) is refused.
    """
    return resolve_within_root(project_root, Path(*_LOG_RELATIVE))


def append_event(project_root: Path, event: QcdEvent) -> None:
    """Atomically append one event line (O_APPEND + flush + fsync).

    Refuses to append when the existing file is non-empty and does not
    end with a newline (a torn final line, ADR-0003 §7): appending there
    would turn the torn fragment into a corrupt middle line.
    """
    if not isinstance(event, QcdEvent):
        raise QcdLogError(f"event: expected QcdEvent, got {type(event).__name__}")
    path = log_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    _require_no_torn_tail(path)
    line = (
        json.dumps(
            event.to_envelope(),
            ensure_ascii=False,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line)
        os.fsync(fd)
    finally:
        os.close(fd)


def read_events(project_root: Path) -> tuple[QcdEvent, ...]:
    """Strictly read every complete event line, de-duplicated first-wins.

    A missing log is an empty tuple. A corrupt middle line raises
    ``CorruptEventLogError`` with its 1-based line number. A single torn
    final fragment (no trailing newline) is ignored, and nothing else.
    Every complete line is parsed (so a corrupt duplicate still raises),
    but only the first event per ``event_id`` is returned, in first-seen
    order (ADR-0003 §5).
    """
    path = log_path(project_root)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return ()
    except OSError as exc:
        raise QcdLogError(f"unable to read QCD event log: {path}") from exc
    if not raw:
        return ()
    try:
        text = raw.decode("utf-8")
    except UnicodeError as exc:
        raise CorruptEventLogError("QCD event log is not valid UTF-8") from exc
    segments = text.split("\n")
    # A trailing newline yields a final empty segment (a fully written log);
    # any non-empty final segment is the tolerated torn tail and is dropped.
    trailing = segments.pop()
    events: list[QcdEvent] = []
    seen: set[str] = set()
    for index, segment in enumerate(segments, start=1):
        event = _parse_line(segment, index)
        if event.event_id in seen:
            continue
        seen.add(event.event_id)
        events.append(event)
    del trailing
    return tuple(events)


def _require_no_torn_tail(path: Path) -> None:
    try:
        with path.open("rb") as stream:
            try:
                stream.seek(-1, os.SEEK_END)
            except OSError:
                return  # empty file
            if stream.read(1) != b"\n":
                raise CorruptEventLogError(
                    f"QCD event log has a torn final line; refusing to append: {path}"
                )
    except FileNotFoundError:
        return


def _parse_line(segment: str, line_number: int) -> QcdEvent:
    try:
        obj = json.loads(segment)
    except json.JSONDecodeError as exc:
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: invalid JSON"
        ) from exc
    if not isinstance(obj, dict):
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: top-level value must be an object"
        )
    if frozenset(obj) != _ENVELOPE_KEYS:
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: unexpected envelope key set"
        )
    if obj["schema_version"] != QCD_LOG_SCHEMA_VERSION:
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: unsupported schema_version"
        )
    try:
        event_type = QcdEventType(obj["event_type"])
    except ValueError as exc:
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: unknown event_type"
        ) from exc
    payload = obj["payload"]
    if not isinstance(payload, dict):
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: payload must be an object"
        )
    try:
        return QcdEvent(
            event_id=obj["event_id"],
            event_type=event_type,
            occurred_at=_parse_occurred_at(obj["occurred_at"], line_number),
            project_id=obj["project_id"],
            shot_id=obj["shot_id"],
            task_id=obj["task_id"],
            payload=payload,
        )
    except AiVideoWorkflowError as exc:
        raise CorruptEventLogError(f"QCD event log line {line_number}: {exc}") from exc


def _parse_occurred_at(value: object, line_number: int) -> datetime:
    if not isinstance(value, str):
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: occurred_at must be a string"
        )
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise CorruptEventLogError(
            f"QCD event log line {line_number}: invalid occurred_at"
        ) from exc
    try:
        return validate_utc_datetime(parsed, field_name="occurred_at")
    except AiVideoWorkflowError as exc:
        raise CorruptEventLogError(f"QCD event log line {line_number}: {exc}") from exc
