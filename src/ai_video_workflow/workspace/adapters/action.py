"""Feedback/Action source adapter (read-only, TASK-029 / ADR-0035).

Reads the append-only feedback/action fact log for WQ-16 (the read-only Action
Center). Like every source adapter it reads exactly one authoritative domain
and, on a corrupt/unreadable log, returns a structured ``Problem`` rather than
raising or guessing (query contract §4). It never writes and never applies an
Action's implied change (that is the Command Gateway's job, ADR-0033).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.action.log import ActionLogError, read_records
from ai_video_workflow.action.records import ActionRecord
from ai_video_workflow.workspace.adapters.base import corrupt
from ai_video_workflow.workspace.envelope import Problem


@dataclass(frozen=True, slots=True)
class ActionSources:
    records: tuple[ActionRecord, ...]
    problems: tuple[Problem, ...]


def read_action(project_root: Path) -> ActionSources:
    """Read the feedback/action records; a corrupt log becomes a problem."""
    try:
        records = read_records(project_root)
    except ActionLogError as exc:
        return ActionSources(records=(), problems=(corrupt("action_log", str(exc)),))
    return ActionSources(records=records, problems=())
