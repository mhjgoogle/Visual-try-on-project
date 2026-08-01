"""QCD append-only event log plus derived aggregation and reporting.

TASK-005 delivers the event-log foundation (all seven event types are
registered; TASK-005 emits three of them). TASK-009 adds the read-only
aggregation (`aggregate_events` -> `QcdSummary`) and the versioned
report step (`run_qcd_report_step`); both are pure-derived and never
write business or QCD state.
"""

from ai_video_workflow.qcd.aggregation import (
    SUMMARY_SCHEMA_VERSION,
    ProjectMetrics,
    QcdSummary,
    ReconciliationGap,
    ShotMetrics,
    TaskMetrics,
    aggregate_events,
)
from ai_video_workflow.qcd.events import (
    QCD_LOG_SCHEMA_VERSION,
    RATING_SCALE,
    QcdEvent,
    QcdEventType,
    build_asset_imported_event,
    build_composition_completed_event,
    build_manual_attempt_recorded_event,
    build_manual_quality_rating_event,
    build_provider_cost_recorded_event,
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
from ai_video_workflow.qcd.reporting import (
    QCD_REPORT_SCHEMA_VERSION,
    QcdReportConflictError,
    QcdReportError,
    QcdReportOutcome,
    run_qcd_report_step,
)

__all__ = [
    "QCD_LOG_SCHEMA_VERSION",
    "QCD_REPORT_SCHEMA_VERSION",
    "RATING_SCALE",
    "SUMMARY_SCHEMA_VERSION",
    "CorruptEventLogError",
    "ProjectMetrics",
    "QcdEvent",
    "QcdEventType",
    "QcdLogError",
    "QcdReportConflictError",
    "QcdReportError",
    "QcdReportOutcome",
    "QcdSummary",
    "ReconciliationGap",
    "ShotMetrics",
    "TaskMetrics",
    "aggregate_events",
    "append_event",
    "build_asset_imported_event",
    "build_composition_completed_event",
    "build_manual_attempt_recorded_event",
    "build_manual_quality_rating_event",
    "build_provider_cost_recorded_event",
    "build_task_created_event",
    "build_task_status_changed_event",
    "build_validation_completed_event",
    "log_path",
    "read_events",
    "run_qcd_report_step",
]
