"""Composition encoding profile and its deterministic digest (TASK-006).

``CompositionProfile`` is the explicit, immutable normalization target
for the two-stage compose (normalize each input to the profile, then
concat). ``M1_COMPOSITION_CONFIG_SCHEMA`` is the sole owner of the
composition config-digest schema string.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ai_video_workflow.digests import config_digest
from ai_video_workflow.errors import FieldTypeError, InvariantViolationError

M1_COMPOSITION_CONFIG_SCHEMA = "m1-composition-config-v1"


@dataclass(frozen=True, slots=True)
class CompositionProfile:
    """Explicit normalization/encoding target for composition."""

    # non-default fields first (dataclass field-order constraint)
    width: int
    height: int
    frame_rate: float
    video_codec: str = "libx264"
    pixel_format: str = "yuv420p"
    audio_codec: str | None = "aac"

    def __post_init__(self) -> None:
        _require_positive_int(self.width, "width")
        _require_positive_int(self.height, "height")
        _require_positive_float(self.frame_rate, "frame_rate")
        _require_non_empty_str(self.video_codec, "video_codec")
        _require_non_empty_str(self.pixel_format, "pixel_format")
        if self.audio_codec is not None:
            _require_non_empty_str(self.audio_codec, "audio_codec")

    def to_config_value(self) -> dict[str, object]:
        return {
            "schema": M1_COMPOSITION_CONFIG_SCHEMA,
            "profile": {
                "width": self.width,
                "height": self.height,
                "frame_rate": self.frame_rate,
                "video_codec": self.video_codec,
                "pixel_format": self.pixel_format,
                "audio_codec": self.audio_codec,
            },
        }


def profile_digest(profile: CompositionProfile) -> str:
    """Return the deterministic config digest for a composition profile."""
    return config_digest(profile.to_config_value())


def _require_positive_int(value: object, field_name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise FieldTypeError(f"{field_name}: expected int, got {type(value).__name__}")
    if value <= 0:
        raise InvariantViolationError(f"{field_name}: must be > 0")


def _require_positive_float(value: object, field_name: str) -> None:
    if not isinstance(value, float):
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value <= 0:
        raise InvariantViolationError(f"{field_name}: must be finite and > 0")


def _require_non_empty_str(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not value:
        raise InvariantViolationError(f"{field_name}: must be a non-empty string")
