"""Evaluation-domain source adapter (read-only, TASK-028 / ADR-0034).

Reads the append-only evaluation-domain fact log (evaluation / experiment /
creative-decision records) for WQ-15. Like every source adapter it reads
exactly one authoritative domain and, on a corrupt/unreadable log, returns a
structured ``Problem`` rather than raising or guessing (query contract §4). It
never writes, never resolves staleness (that is derived in the query layer from
authoritative facts), and never copies the referenced QC/cost/lineage facts.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.evaluation import (
    EvaluationLogError,
    EvaluationRecord,
    read_records,
)
from ai_video_workflow.workspace.adapters.base import corrupt
from ai_video_workflow.workspace.envelope import Problem


@dataclass(frozen=True, slots=True)
class EvaluationSources:
    records: tuple[EvaluationRecord, ...]
    problems: tuple[Problem, ...]


def read_evaluation(project_root: Path) -> EvaluationSources:
    """Read the evaluation-domain records; a corrupt log becomes a problem.

    ``read_records`` already enforces the record schema and de-duplicates
    first-wins, so a bad line surfaces as ``CorruptEvaluationLogError`` (a
    subclass of ``EvaluationLogError``), which is mapped to a fail-closed
    ``source_corrupt`` problem with an empty record set.
    """
    try:
        records = read_records(project_root)
    except EvaluationLogError as exc:
        return EvaluationSources(
            records=(),
            problems=(corrupt("evaluation_log", str(exc)),),
        )
    return EvaluationSources(records=records, problems=())
