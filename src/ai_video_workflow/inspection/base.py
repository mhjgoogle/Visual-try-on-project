"""MediaInspector abstraction and its immutable probe result (ADR-0002).

The core validation logic depends only on ``MediaInspector`` — never on
ffprobe directly — so it is fully testable without the external tool.
``FfprobeMediaInspector`` is the sole production implementation.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError


@dataclass(frozen=True, slots=True)
class MediaProbeResult:
    """Basic container/stream parameters observed for one media file."""

    container_format: str
    duration_seconds: float
    width: int
    height: int
    frame_rate: float

    def __post_init__(self) -> None:
        if not isinstance(self.container_format, str) or not self.container_format:
            raise InvariantViolationError(
                "container_format: must be a non-empty string"
            )
        _require_positive_float(self.duration_seconds, "duration_seconds")
        _require_positive_int(self.width, "width")
        _require_positive_int(self.height, "height")
        _require_positive_float(self.frame_rate, "frame_rate")


class MediaInspector(ABC):
    """Abstract media inspector: probe a file for basic parameters."""

    __slots__ = ()

    @abstractmethod
    def probe(self, path: Path) -> MediaProbeResult:
        """Return the observed parameters, or raise a MediaInspectionError."""


def _require_positive_float(value: object, field_name: str) -> None:
    if not isinstance(value, float):
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value <= 0:
        raise InvariantViolationError(f"{field_name}: must be finite and > 0")


def _require_positive_int(value: object, field_name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise FieldTypeError(f"{field_name}: expected int, got {type(value).__name__}")
    if value <= 0:
        raise InvariantViolationError(f"{field_name}: must be > 0")
