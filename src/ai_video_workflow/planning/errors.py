"""Typed errors for WFM1 production planning (TASK-020)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class PlanningError(AiVideoWorkflowError):
    """Base error for planning documents and prompt versions."""


class PacketError(AiVideoWorkflowError):
    """Raised when a shot task packet cannot be compiled or validated."""
