"""Feedback / Action fact domain and Action Center (TASK-029 / ADR-0035).

An append-only, immutable observation-evidence domain with its own single
writer. A SEPARATE state domain (ADR-0010 decision 7): the Action lifecycle
(pending / in_progress / waiting_for_user / completed / blocked / cancelled /
stale) never reuses workflow-approval, GenerationTask, StepManifest, Provider,
or reservation state. Feedback stands alone from Action; any real change an
Action implies is applied only through the Command Gateway (ADR-0033), never
written here as a second writer.
"""

from __future__ import annotations

from ai_video_workflow.action.log import (
    ActionLogError,
    CorruptActionLogError,
    append_record,
    log_path,
    read_records,
)
from ai_video_workflow.action.records import (
    ACTION_LOG_SCHEMA_VERSION,
    ActionActor,
    ActionRecord,
    ActionRecordType,
    build_action_record,
    build_feedback_record,
    build_handling_record,
    build_rebind_record,
    build_transition_record,
    build_verification_record,
    record_from_envelope,
)
from ai_video_workflow.action.resolvers import WorkflowTargetResolver
from ai_video_workflow.action.service import (
    ActionActorError,
    ActionService,
    ActionServiceError,
    ActionStateError,
    ActionView,
    DuplicateRecordError,
    FeedbackView,
    ResolvedTarget,
    StaleActionError,
    StaleTargetError,
    TargetResolver,
)
from ai_video_workflow.action.state import (
    LEGAL_TRANSITIONS,
    TERMINAL_STATES,
    FoldedAction,
    fold,
    is_terminal,
    transition_allowed,
)

__all__ = [
    "ACTION_LOG_SCHEMA_VERSION",
    "LEGAL_TRANSITIONS",
    "TERMINAL_STATES",
    "ActionActor",
    "ActionActorError",
    "ActionLogError",
    "ActionRecord",
    "ActionRecordType",
    "ActionService",
    "ActionServiceError",
    "ActionStateError",
    "ActionView",
    "CorruptActionLogError",
    "DuplicateRecordError",
    "FeedbackView",
    "FoldedAction",
    "ResolvedTarget",
    "StaleActionError",
    "StaleTargetError",
    "TargetResolver",
    "WorkflowTargetResolver",
    "append_record",
    "build_action_record",
    "build_feedback_record",
    "build_handling_record",
    "build_rebind_record",
    "build_transition_record",
    "build_verification_record",
    "fold",
    "is_terminal",
    "log_path",
    "read_records",
    "record_from_envelope",
    "transition_allowed",
]
