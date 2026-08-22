"""Validation policy and its deterministic configuration digest (TASK-005).

``ValidationPolicy`` is the explicit, immutable tolerance configuration
for file-level validation. ``M1_VALIDATION_CONFIG_SCHEMA`` is the sole
owner of the validation config-digest schema string; no other component
spells it. ``policy_digest`` produces the StepManifest
``relevant_config_digest`` for the validation step.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ai_video_workflow.digests import config_digest
from ai_video_workflow.errors import FieldTypeError, InvariantViolationError

M1_VALIDATION_CONFIG_SCHEMA = "m1-validation-config-v1"


@dataclass(frozen=True, slots=True)
class ValidationPolicy:
    """Explicit tolerance configuration for file-level validation."""

    allowed_containers: tuple[str, ...] = ("mp4",)
    duration_tolerance_ratio: float = 0.1
    frame_rate_tolerance: float = 0.5
    require_exact_resolution: bool = True

    def __post_init__(self) -> None:
        if (
            not isinstance(self.allowed_containers, tuple)
            or not self.allowed_containers
        ):
            raise InvariantViolationError(
                "allowed_containers: must be a non-empty tuple"
            )
        for item in self.allowed_containers:
            if not isinstance(item, str) or not item:
                raise InvariantViolationError(
                    "allowed_containers: entries must be non-empty strings"
                )
        _require_non_negative_float(
            self.duration_tolerance_ratio, "duration_tolerance_ratio"
        )
        _require_non_negative_float(self.frame_rate_tolerance, "frame_rate_tolerance")
        if not isinstance(self.require_exact_resolution, bool):
            raise FieldTypeError("require_exact_resolution: expected bool")

    def to_config_value(self) -> dict[str, object]:
        """Return the JSON-compatible config value for the digest."""
        return {
            "schema": M1_VALIDATION_CONFIG_SCHEMA,
            "policy": {
                "allowed_containers": list(self.allowed_containers),
                "duration_tolerance_ratio": self.duration_tolerance_ratio,
                "frame_rate_tolerance": self.frame_rate_tolerance,
                "require_exact_resolution": self.require_exact_resolution,
            },
        }


def policy_digest(policy: ValidationPolicy) -> str:
    """Return the deterministic config digest for a validation policy."""
    return config_digest(policy.to_config_value())


def _require_non_negative_float(value: object, field_name: str) -> None:
    if not isinstance(value, float):
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value < 0:
        raise InvariantViolationError(f"{field_name}: must be finite and >= 0")
