"""Typed errors for the subtitle / voice-over / audio layer (TASK-008)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class AudioError(AiVideoWorkflowError):
    """Base error for the TASK-008 audio/subtitle layer."""


class AudioValidationError(AudioError):
    """Raised when a voice-over / sound-effect audio file is malformed."""


class SubtitleValidationError(AudioError):
    """Raised when a subtitle (SRT) file is structurally invalid."""


class AudioToolError(AudioError):
    """Raised when the external audio probe tool (ffprobe) fails or is absent."""
