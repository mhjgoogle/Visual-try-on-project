"""Content-bound creative-approval gate (TASK-014 contract 1).

Public API: read a stage's approval marker and fail closed unless the
stage is approved *and* its approved content is unchanged. Nothing here
constructs a provider, spends budget, or mutates business state.
"""

from __future__ import annotations

from ai_video_workflow.approval.errors import (
    ApprovalError,
    NotApprovedError,
    StaleApprovalError,
)
from ai_video_workflow.approval.gate import (
    APPROVAL_DIR,
    APPROVAL_SCHEMA_VERSION,
    APPROVED,
    ApprovalMarker,
    ApprovalTarget,
    load_approval,
    marker_relpath,
    parse_approval,
    require_stage_approved,
)
from ai_video_workflow.approval.workflow import (
    AUDIT_RELPATH,
    STAGE_IDS,
    StageInfo,
    StageState,
    read_audit,
    require_stage_ready,
    stage_plan,
    stage_status,
    transition_stage,
)

__all__ = [
    "APPROVAL_DIR",
    "APPROVAL_SCHEMA_VERSION",
    "APPROVED",
    "AUDIT_RELPATH",
    "STAGE_IDS",
    "ApprovalError",
    "ApprovalMarker",
    "ApprovalTarget",
    "NotApprovedError",
    "StageInfo",
    "StageState",
    "StaleApprovalError",
    "load_approval",
    "marker_relpath",
    "parse_approval",
    "read_audit",
    "require_stage_approved",
    "require_stage_ready",
    "stage_plan",
    "stage_status",
    "transition_stage",
]
