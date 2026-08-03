"""Evaluation / experiment / creative-decision fact domain (TASK-028).

An append-only, immutable observation-evidence domain (ADR-0034) with its own
single writer. It is a SEPARATE state domain (ADR-0010 decision 7): it never
reuses workflow-approval, GenerationTask, StepManifest, Provider or reservation
state, and it never copies or rewrites QC / release / final-review facts — it
only references them by ref + version + content_digest.
"""

from __future__ import annotations

from ai_video_workflow.evaluation.log import (
    CorruptEvaluationLogError,
    EvaluationLogError,
    append_record,
    log_path,
    read_records,
)
from ai_video_workflow.evaluation.records import (
    EVALUATION_LOG_SCHEMA_VERSION,
    EvaluationActor,
    EvaluationRecord,
    EvaluationRecordType,
    build_creative_decision_record,
    build_evaluation_record,
    build_experiment_record,
    record_from_envelope,
)

__all__ = [
    "EVALUATION_LOG_SCHEMA_VERSION",
    "CorruptEvaluationLogError",
    "EvaluationActor",
    "EvaluationLogError",
    "EvaluationRecord",
    "EvaluationRecordType",
    "append_record",
    "build_creative_decision_record",
    "build_evaluation_record",
    "build_experiment_record",
    "log_path",
    "read_records",
    "record_from_envelope",
]
