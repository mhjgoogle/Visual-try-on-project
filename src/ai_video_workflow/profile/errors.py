"""Typed errors for the WFM1 project profile and reuse layer (TASK-018)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class ProfileError(AiVideoWorkflowError):
    """Base error for project instance profiles."""


class ProfileNotFoundError(ProfileError):
    """Raised when a project has no profile version on disk."""


class ReuseError(AiVideoWorkflowError):
    """Base error for reusable asset packs and references."""


class ReuseRefError(ReuseError):
    """Raised when a reuse reference is missing, drifted, or malformed."""
