"""Append-only feedback/action fact log writer and strict reader (ADR-0035).

The log is a single JSON Lines file, ``action/events/log.jsonl``, relative to
the project data root (authorized in ADR-0001, third amendment). It is the
domain's single writer, built on the shared hardened append-only primitives
(:mod:`ai_video_workflow.appendlog`): strictly append-only (O_APPEND + flock +
fsync), a torn final line blocks further appends, and the reader strictly parses
every complete line, tolerates exactly one torn final fragment, and never
rewrites/patches/truncates the log. Duplicate ``record_id`` lines de-duplicate
first-wins so every consumer sees each record once, in first-seen order.

The current state of an Action is DERIVED by folding these append-only events
(see :mod:`ai_video_workflow.action.state`); nothing here stores a mutable
"current state" and no Provider change is written here (that is the Command
Gateway's job, ADR-0033).
"""

from __future__ import annotations

import json
from pathlib import Path

from ai_video_workflow.action.records import ActionRecord, record_from_envelope
from ai_video_workflow.appendlog import (
    append_line,
    read_text,
    resolve_log_path,
    split_complete_lines,
)
from ai_video_workflow.errors import AiVideoWorkflowError

_LOG_RELATIVE = ("action", "events", "log.jsonl")


class ActionLogError(AiVideoWorkflowError):
    """Base error for feedback/action-log IO and integrity failures."""


class CorruptActionLogError(ActionLogError):
    """Raised when a complete log line cannot be strictly parsed."""


def log_path(project_root: Path) -> Path:
    """Return the append-only feedback/action log path for a project root."""
    return resolve_log_path(project_root, _LOG_RELATIVE)


def append_record(project_root: Path, record: ActionRecord) -> None:
    """Atomically append one record line (O_APPEND + flock + torn-tail + fsync)."""
    if not isinstance(record, ActionRecord):
        raise ActionLogError(
            f"record: expected ActionRecord, got {type(record).__name__}"
        )
    line = (
        json.dumps(
            record.to_envelope(),
            ensure_ascii=False,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    append_line(project_root, _LOG_RELATIVE, line, ActionLogError)


def read_records(project_root: Path) -> tuple[ActionRecord, ...]:
    """Strictly read every complete record line, de-duplicated first-wins.

    A missing log is an empty tuple. A corrupt middle line raises
    ``CorruptActionLogError`` with its 1-based line number. A single torn final
    fragment is ignored, and nothing else.
    """
    text = read_text(project_root, _LOG_RELATIVE, ActionLogError)
    if text is None or text == "":
        return ()
    records: list[ActionRecord] = []
    seen: set[str] = set()
    for index, segment in enumerate(split_complete_lines(text), start=1):
        record = _parse_line(segment, index)
        if record.record_id in seen:
            continue
        seen.add(record.record_id)
        records.append(record)
    return tuple(records)


def _parse_line(segment: str, line_number: int) -> ActionRecord:
    try:
        obj = json.loads(segment)
    except json.JSONDecodeError as exc:
        raise CorruptActionLogError(
            f"action log line {line_number}: invalid JSON"
        ) from exc
    try:
        return record_from_envelope(obj)
    except AiVideoWorkflowError as exc:
        raise CorruptActionLogError(f"action log line {line_number}: {exc}") from exc
