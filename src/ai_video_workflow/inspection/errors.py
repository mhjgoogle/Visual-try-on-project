"""Typed errors for the external media-inspection boundary (ADR-0002)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class MediaInspectionError(AiVideoWorkflowError):
    """Base error for media probing failures."""


class MediaToolNotAvailableError(MediaInspectionError):
    """Raised when the external media tool (ffprobe) is not installed."""


class UndecodableMediaError(MediaInspectionError):
    """Raised when the tool cannot decode/probe the media (non-zero/timeout)."""


class MediaProbeParseError(MediaInspectionError):
    """Raised when the tool output cannot be parsed into a MediaProbeResult."""
