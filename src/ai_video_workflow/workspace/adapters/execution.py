"""Run / cost source adapters: reservation, QCD, lineage (read-only, TASK-025)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.app.paid_lifecycle import build_lineage
from ai_video_workflow.budget.account import (
    account_outstanding_holds,
    read_account_month_spent,
)
from ai_video_workflow.budget.ledger import BudgetLedger, build_ledger, month_key_jst
from ai_video_workflow.budget.reservation import (
    RESERVATION_SCHEMA_VERSION,
    Reservation,
    list_reservations,
)
from ai_video_workflow.config.project_config import FxConfig
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.aggregation import QcdSummary, aggregate_events
from ai_video_workflow.qcd.events import QcdEvent
from ai_video_workflow.qcd.log import read_events
from ai_video_workflow.workspace.adapters.base import corrupt, schema_supported
from ai_video_workflow.workspace.envelope import Problem

# reservations are read across all historical schema versions (v1-v3)
_RESERVATION_SCHEMAS = frozenset({1, 2, RESERVATION_SCHEMA_VERSION})
# The QCD event log's schema_version is validated inside read_events (it
# raises CorruptEventLogError on an unsupported version), surfaced below as
# a source_corrupt problem — no separate per-event schema gate is needed.


@dataclass(frozen=True, slots=True)
class ExecutionSources:
    reservations: tuple[Reservation, ...]
    events: tuple[QcdEvent, ...]
    problems: tuple[Problem, ...]


def read_execution(project_root: Path) -> ExecutionSources:
    problems: list[Problem] = []
    reservations: tuple[Reservation, ...] = ()
    try:
        reservations = list_reservations(project_root)
    except Exception as exc:
        problems.append(corrupt("reservation", str(exc)))
    for r in reservations:
        p = schema_supported(
            r.schema_version,
            _RESERVATION_SCHEMAS,
            source="reservation",
            task=r.task_id,
            operation=r.operation_id,
        )
        if p is not None:
            problems.append(p)

    events: tuple[QcdEvent, ...] = ()
    try:
        events = read_events(project_root)
    except Exception as exc:
        problems.append(corrupt("qcd_log", str(exc)))
    return ExecutionSources(
        reservations=reservations, events=events, problems=tuple(problems)
    )


def summarize(events: tuple[QcdEvent, ...], data: ProjectData) -> QcdSummary:
    """Pure aggregation of the QCD event log against the project snapshot."""
    return aggregate_events(events, data=data)


def ledger(events: tuple[QcdEvent, ...], fx: FxConfig) -> BudgetLedger:
    """Pure JPY ledger derived from the event log at the locked FX table."""
    return build_ledger(events, fx)


def lineage(project_root: Path, task_id: str) -> tuple[dict, tuple[Problem, ...]]:
    """Read-only packet->operation->media->asset projection for a task.

    Never raises: a broken lineage source (unreadable task record, path
    escape, corrupt packet) becomes a structured problem so the query can
    fail closed instead of crashing.
    """
    try:
        return build_lineage(project_root, task_id), ()
    except Exception as exc:
        return {}, (corrupt("lineage", str(exc), task=task_id),)


def account_standing(account_root: Path, month: str) -> tuple[int, int]:
    """(committed JPY this month across projects, outstanding holds JPY)."""
    return (
        read_account_month_spent(account_root, month).total_jpy,
        account_outstanding_holds(account_root),
    )


def month_of(occurred_at) -> str:
    return month_key_jst(occurred_at)
