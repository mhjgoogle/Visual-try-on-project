"""Typed errors for FFmpeg shot composition (TASK-006)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class CompositionError(AiVideoWorkflowError):
    """Base error for composition planning and execution failures."""


class MissingShotAssetError(CompositionError):
    """Raised when one or more shots have no registered VideoAsset."""


class InconsistentShotSpecError(CompositionError):
    """Raised when shots do not share a single width/height/frame-rate spec."""


class CompositionToolError(CompositionError):
    """Raised when the external composer (ffmpeg) fails or times out."""


class CompositionConflictError(CompositionError):
    """Raised when an existing durable output conflicts with the plan."""
