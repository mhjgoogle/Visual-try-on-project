"""Typed errors for the minimal creative-approval gate (TASK-B2)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class ApprovalError(AiVideoWorkflowError):
    """Base error for the approval gate (e.g. a malformed approval marker)."""


class NotApprovedError(ApprovalError):
    """Raised when the concept is not in the approved state, or has no marker."""


class StaleApprovalError(NotApprovedError):
    """Raised when an approved marker's target content has changed since it
    was approved (the recorded digest no longer matches), so the approval
    is automatically invalidated."""
