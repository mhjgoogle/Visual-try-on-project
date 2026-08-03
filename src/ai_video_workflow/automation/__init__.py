"""WFM3 automation & command-capability contract (TASK-038 / ADR-0040).

A versioned, single-source capability registry that declares the fixed WFM3
automation duties (project creation, stage validation, task-packet compile,
submit/collect, proxy, technical QC, release packaging), each COMPOSING an
approved ADR-0033 Gateway command and binding a real L0–S7 baseline step. It is
same-source with the Gateway registry (never a second truth), fails closed on
unregistered capabilities and version drift, and records pause/cancel/skip as
explicit UNSUPPORTED dispositions rather than inventing states. Contract layer
only — no Provider calls, no business writes, no CLI, and it approves nothing on
the user's behalf.
"""

from __future__ import annotations

from ai_video_workflow.automation import capabilities
from ai_video_workflow.automation.capabilities import (
    CAPABILITY_REGISTRY_SCHEMA,
    CONTROL_CANCEL,
    CONTROL_PAUSE,
    CONTROL_SKIP,
    Capability,
    CapabilityRegistry,
    CapabilitySnapshot,
    ControlDisposition,
    build_wfm3_registry,
    control_disposition,
    control_ops,
    wfm3_capabilities,
)
from ai_video_workflow.automation.errors import (
    AutomationError,
    CapabilityDriftError,
    CapabilityNotRegisteredError,
    SecondSourceError,
    UnsupportedControlError,
)

__all__ = [
    "CAPABILITY_REGISTRY_SCHEMA",
    "CONTROL_CANCEL",
    "CONTROL_PAUSE",
    "CONTROL_SKIP",
    "AutomationError",
    "Capability",
    "CapabilityDriftError",
    "CapabilityNotRegisteredError",
    "CapabilityRegistry",
    "CapabilitySnapshot",
    "ControlDisposition",
    "SecondSourceError",
    "UnsupportedControlError",
    "build_wfm3_registry",
    "capabilities",
    "control_disposition",
    "control_ops",
    "wfm3_capabilities",
]
