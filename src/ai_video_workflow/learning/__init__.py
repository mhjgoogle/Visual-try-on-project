"""Cross-project learning, knowledge promotion & recommendations (TASK-032).

An account-scoped domain (ADR-0036): an append-only, user-confirmed
promoted-knowledge fact log plus deterministic, on-demand derived cross-project
analytics and evidence-based recommendations. A separate state domain that only
references authoritative facts, never modifies business state, and never trains
models or shares across accounts.
"""

from __future__ import annotations

from ai_video_workflow.learning.log import (
    CorruptKnowledgeLogError,
    KnowledgeLogError,
    append_record,
    log_path,
    read_records,
)
from ai_video_workflow.learning.records import (
    KNOWLEDGE_LOG_SCHEMA_VERSION,
    KnowledgeRecord,
    build_knowledge_record,
    record_from_envelope,
)
from ai_video_workflow.learning.service import KnowledgeService, ProjectKpis

__all__ = [
    "KNOWLEDGE_LOG_SCHEMA_VERSION",
    "CorruptKnowledgeLogError",
    "KnowledgeLogError",
    "KnowledgeRecord",
    "KnowledgeService",
    "ProjectKpis",
    "append_record",
    "build_knowledge_record",
    "log_path",
    "read_records",
    "record_from_envelope",
]
