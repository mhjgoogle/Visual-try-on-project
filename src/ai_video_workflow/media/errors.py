"""Typed errors for the WFM2 multimedia layer (TASK-035 / ADR-0038)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class MediaError(AiVideoWorkflowError):
    """Base error for the multimedia provider/asset/cost contract."""


class MediaNotFoundError(MediaError):
    """A requested media asset / batch / selection does not exist."""


class MediaValidationError(MediaError):
    """A media asset, batch, selection or capability failed a fail-closed check."""


class MediaProviderError(MediaError):
    """A media provider or the media registry rejected a request (fail-closed)."""
