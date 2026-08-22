"""Media inspection boundary: the MediaInspector abstraction + ffprobe.

Core validation depends only on ``MediaInspector`` (ADR-0002); ffprobe
is confined to ``FfprobeMediaInspector``.
"""

from ai_video_workflow.inspection.base import MediaInspector, MediaProbeResult
from ai_video_workflow.inspection.errors import (
    MediaInspectionError,
    MediaProbeParseError,
    MediaToolNotAvailableError,
    UndecodableMediaError,
)
from ai_video_workflow.inspection.ffprobe import FfprobeMediaInspector

__all__ = [
    "FfprobeMediaInspector",
    "MediaInspectionError",
    "MediaInspector",
    "MediaProbeParseError",
    "MediaProbeResult",
    "MediaToolNotAvailableError",
    "UndecodableMediaError",
]
