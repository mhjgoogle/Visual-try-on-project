"""Security primitives shared across the workflow (ADR-0004)."""

from __future__ import annotations

from ai_video_workflow.security.paths import (
    PathEscapeError,
    resolve_within_root,
)

__all__ = ["PathEscapeError", "resolve_within_root"]
