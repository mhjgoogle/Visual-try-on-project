"""Typed errors for WFM1 QC, release packaging, and archive (TASK-022)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class QcError(AiVideoWorkflowError):
    """Raised when a QC document cannot be produced or is invalid."""


class ReleaseError(AiVideoWorkflowError):
    """Raised when a release package cannot be produced (gate failures)."""


class ArchiveError(AiVideoWorkflowError):
    """Raised when the archive/postmortem cannot be produced."""
