"""Typed errors for the WFM2 post-production / QC / release / archive layer
(TASK-036 / ADR-0039)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class PostProductionError(AiVideoWorkflowError):
    """Base error for the S5–S7 post-production/QC/release/archive contract."""


class PostProductionNotFoundError(PostProductionError):
    """A requested post-production artifact index version does not exist."""


class PostProductionValidationError(PostProductionError):
    """A post-production artifact failed a fail-closed identity/lineage check."""
