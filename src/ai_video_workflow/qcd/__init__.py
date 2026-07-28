"""QCD append-only event log: model, typed constructors, writer, reader.

TASK-005 delivers the event-log foundation (all seven event types are
registered; TASK-005 emits three of them). Aggregation and reporting
are TASK-009 and are not part of this package's M1 surface.
"""

from ai_video_workflow.qcd.events import (
    QCD_LOG_SCHEMA_VERSION,
    RATING_SCALE,
    QcdEvent,
    QcdEventType,
    build_asset_imported_event,
    build_composition_completed_event,
    build_manual_attempt_recorded_event,
    build_manual_quality_rating_event,
    build_task_created_event,
    build_task_status_changed_event,
    build_validation_completed_event,
)
from ai_video_workflow.qcd.log import (
    CorruptEventLogError,
    QcdLogError,
    append_event,
    log_path,
    read_events,
)

__all__ = [
    "QCD_LOG_SCHEMA_VERSION",
    "RATING_SCALE",
    "CorruptEventLogError",
    "QcdEvent",
    "QcdEventType",
    "QcdLogError",
    "append_event",
    "build_asset_imported_event",
    "build_composition_completed_event",
    "build_manual_attempt_recorded_event",
    "build_manual_quality_rating_event",
    "build_task_created_event",
    "build_task_status_changed_event",
    "build_validation_completed_event",
    "log_path",
    "read_events",
]
