"""Append-only promoted-knowledge log (account-level, ADR-0036 / TASK-032).

A single JSON Lines file, ``knowledge/events/log.jsonl``, relative to the
ACCOUNT root (authorized in ADR-0001, fifth amendment), on the shared hardened
append-only primitives. The domain's single writer; the reader de-duplicates
first-wins by ``record_id`` so every consumer sees each promoted knowledge once,
in first-seen order.
"""

from __future__ import annotations

import json
from pathlib import Path

from ai_video_workflow.appendlog import (
    append_line,
    read_text,
    resolve_log_path,
    split_complete_lines,
)
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.learning.records import KnowledgeRecord, record_from_envelope

_LOG_RELATIVE = ("knowledge", "events", "log.jsonl")


class KnowledgeLogError(AiVideoWorkflowError):
    """Base error for the promoted-knowledge log IO / integrity."""


class CorruptKnowledgeLogError(KnowledgeLogError):
    """Raised when a complete knowledge line cannot be strictly parsed."""


def log_path(account_root: Path) -> Path:
    return resolve_log_path(account_root, _LOG_RELATIVE)


def append_record(account_root: Path, record: KnowledgeRecord) -> None:
    if not isinstance(record, KnowledgeRecord):
        raise KnowledgeLogError(
            f"record: expected KnowledgeRecord, got {type(record).__name__}"
        )
    line = (
        json.dumps(
            record.to_envelope(), ensure_ascii=False, sort_keys=True, allow_nan=False
        )
        + "\n"
    ).encode("utf-8")
    append_line(account_root, _LOG_RELATIVE, line, KnowledgeLogError)


def read_records(account_root: Path) -> tuple[KnowledgeRecord, ...]:
    """Strictly read every complete record line, de-duplicated first-wins."""
    text = read_text(account_root, _LOG_RELATIVE, KnowledgeLogError)
    if not text:
        return ()
    records: list[KnowledgeRecord] = []
    seen: set[str] = set()
    for index, segment in enumerate(split_complete_lines(text), start=1):
        try:
            obj = json.loads(segment)
        except json.JSONDecodeError as exc:
            raise CorruptKnowledgeLogError(
                f"knowledge log line {index}: invalid JSON"
            ) from exc
        try:
            record = record_from_envelope(obj)
        except AiVideoWorkflowError as exc:
            raise CorruptKnowledgeLogError(
                f"knowledge log line {index}: {exc}"
            ) from exc
        if record.record_id in seen:
            continue
        seen.add(record.record_id)
        records.append(record)
    return tuple(records)
