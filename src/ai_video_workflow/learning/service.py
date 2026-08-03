"""Knowledge-promotion service + derived cross-project analytics (ADR-0036).

Two concerns, both account-scoped:

- **Knowledge promotion (write).** The approved path that turns a candidate
  experience into reusable, user-confirmed promoted knowledge. Promotion is the
  USER's (the record's actor is fixed to ``user``) and must carry source
  evidence refs (ref + content_digest). Append-only; a user-rejected candidate
  simply is never promoted. This never modifies profiles / prompts / budget /
  Provider / approval — recommendation-triggered CHANGES go through the Command
  Gateway (ADR-0033), not here.
- **Derived analytics (read).** Deterministic cross-project KPIs derived on
  demand from authoritative facts (no persistent cache): per-project evaluation
  pass rate and Action resolution rate, each with a stable definition and a
  three-way authoritative|derived|unavailable posture — a project with no such
  facts is ``insufficient_evidence``, never a fabricated confidence.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.learning.log import append_record, read_records
from ai_video_workflow.learning.records import (
    KnowledgeRecord,
    build_knowledge_record,
)
from ai_video_workflow.manifest import JsonCompatibleValue


@dataclass(frozen=True, slots=True)
class ProjectKpis:
    """Derived KPIs for one project.

    A rate is ``None`` when its fact type is absent (``insufficient_evidence``)
    OR corrupt; ``corrupt_sources`` names the fact logs (``evaluation`` /
    ``action``) that failed to parse, so the query can fail closed with a
    ``source_corrupt`` problem instead of silently reporting misleading zeros.
    """

    project: str
    evaluation_count: int
    evaluation_pass_rate: float | None
    action_count: int
    action_resolution_rate: float | None
    insufficient_evidence: bool
    corrupt_sources: tuple[str, ...]


class KnowledgeService:
    """Account-scoped knowledge promotion + derived cross-project analytics."""

    def __init__(self, account_root: Path, *, clock: Callable[[], datetime]) -> None:
        self._account_root = account_root
        self._clock = clock

    # --- write: user-confirmed knowledge promotion -----------------------

    def promote(
        self,
        *,
        knowledge_id: str,
        category: str,
        applicability: Mapping[str, JsonCompatibleValue],
        recommendation: str,
        evidence_refs: list,
        scope: str,
        limits: str,
        occurred_at: datetime | None = None,
    ) -> KnowledgeRecord:
        """Promote a candidate experience to user-confirmed reusable knowledge."""
        from ai_video_workflow.errors import InvariantViolationError

        record = build_knowledge_record(
            knowledge_id=knowledge_id,
            category=category,
            applicability=applicability,
            recommendation=recommendation,
            evidence_refs=evidence_refs,
            scope=scope,
            limits=limits,
            occurred_at=occurred_at if occurred_at is not None else self._clock(),
        )
        # Reject a duplicate knowledge_id: the reader de-duplicates first-wins,
        # so appending a duplicate would report success while every reader
        # ignores the new recommendation/evidence. New knowledge needs a new id.
        if any(r.record_id == record.record_id for r in self.read()):
            raise InvariantViolationError(
                f"knowledge_id {knowledge_id!r} is already promoted; use a new id"
            )
        append_record(self._account_root, record)
        return record

    def read(self) -> tuple[KnowledgeRecord, ...]:
        return read_records(self._account_root)

    # --- read: derived cross-project analytics ---------------------------

    def project_kpis(self) -> tuple[ProjectKpis, ...]:
        """Derived per-project KPIs across the account (on demand, no cache)."""
        from ai_video_workflow.action import read_records as read_actions
        from ai_video_workflow.evaluation import EvaluationRecordType
        from ai_video_workflow.evaluation import read_records as read_evals
        from ai_video_workflow.workspace.discovery import discover_projects

        out: list[ProjectKpis] = []
        for dp in discover_projects(self._account_root):
            eval_recs, eval_err = _read_or_error(read_evals, dp.root)
            action_recs, action_err = _read_or_error(read_actions, dp.root)
            corrupt = tuple(
                name
                for name, err in (("evaluation", eval_err), ("action", action_err))
                if err
            )
            evals = [
                r for r in eval_recs if r.record_type is EvaluationRecordType.EVALUATION
            ]
            # A corrupt source yields NO rate (never a misleading zero); an
            # absent source yields insufficient_evidence.
            eval_pass = (
                sum(1 for r in evals if r.payload["pass"] is True) / len(evals)
                if evals and not eval_err
                else None
            )
            resolution, total_actions = (
                _action_resolution_rate(dp.root, action_recs)
                if not action_err
                else (None, 0)
            )
            out.append(
                ProjectKpis(
                    project=dp.name,
                    evaluation_count=len(evals),
                    evaluation_pass_rate=eval_pass,
                    action_count=total_actions,
                    action_resolution_rate=resolution,
                    insufficient_evidence=(
                        not corrupt and not evals and total_actions == 0
                    ),
                    corrupt_sources=corrupt,
                )
            )
        return tuple(out)


def _read_or_error(call, *args):
    """Read a per-project fact log; return ``(records, error_name_or_None)``.

    A corrupt/unreadable log is NOT silently emptied — its error type is
    returned so the query can surface a fail-closed ``source_corrupt`` problem.
    """
    from ai_video_workflow.errors import AiVideoWorkflowError

    try:
        return list(call(*args)), None
    except AiVideoWorkflowError as exc:
        return [], type(exc).__name__


def _action_resolution_rate(project_root: Path, records) -> tuple[float | None, int]:
    """Resolved (completed) fraction of terminal-or-open actions in a project.

    Returns ``(rate_or_None, action_count)``. Cancelled actions are excluded
    from the denominator (they were withdrawn, not unresolved).
    """
    from ai_video_workflow.action.records import ActionRecordType

    action_ids = [
        r.payload["action_id"]
        for r in records
        if r.record_type is ActionRecordType.ACTION
    ]
    if not action_ids:
        return None, 0
    # Fold each action's terminal state from its transitions (append order).
    completed = 0
    counted = 0
    states = _fold_states(records)
    for aid in action_ids:
        state = states.get(aid, "pending")
        if state == "cancelled":
            continue
        counted += 1
        if state == "completed":
            completed += 1
    return (completed / counted if counted else None), len(action_ids)


def _fold_states(records) -> dict[str, str]:
    """Terminal lifecycle state per action_id, folded in append order.

    A lightweight fold sufficient for the resolution KPI: transitions and a
    resolved verification advance state; a rebind resets to pending. It mirrors
    the Action service fold's outcome for terminal states.
    """
    from ai_video_workflow.action.records import ActionRecordType

    creation_index: dict[str, int] = {}
    for i, r in enumerate(records):
        if r.record_type is ActionRecordType.ACTION:
            creation_index.setdefault(r.payload["action_id"], i)
    states: dict[str, str] = {aid: "pending" for aid in creation_index}
    for i, r in enumerate(records):
        aid = r.payload.get("action_id")
        if aid is None or aid not in creation_index or i <= creation_index[aid]:
            continue
        if r.record_type is ActionRecordType.TRANSITION:
            states[aid] = r.payload["to_state"]
        elif r.record_type is ActionRecordType.VERIFICATION:
            if r.payload["verdict"] == "resolved":
                states[aid] = "completed"
        elif r.record_type is ActionRecordType.REBIND:
            states[aid] = "pending"
    return states
