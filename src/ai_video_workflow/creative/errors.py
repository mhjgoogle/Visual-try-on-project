"""Typed errors for the WFM2 creative/audiovisual artifact layer (TASK-034)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class CreativeError(AiVideoWorkflowError):
    """Base error for the creative/audiovisual artifact contract."""


class CreativeNotFoundError(CreativeError):
    """A requested creative artifact index version does not exist."""


class CreativeValidationError(CreativeError):
    """A creative artifact or stage target failed a fail-closed check."""
