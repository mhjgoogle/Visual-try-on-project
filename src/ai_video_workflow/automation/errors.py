"""Typed errors for the WFM3 automation / command-capability layer
(TASK-038 / ADR-0040)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class AutomationError(AiVideoWorkflowError):
    """Base error for the WFM3 automation capability contract."""


class CapabilityNotRegisteredError(AutomationError):
    """A capability id is not in the approved registry — refused fail-closed."""


class CapabilityDriftError(AutomationError):
    """A capability snapshot is bound to a drifted registry version/digest and
    must not continue executing on the stale binding (ADR-0010 decision 6)."""


class SecondSourceError(AutomationError):
    """A capability names a Gateway command absent from the Gateway registry —
    the capability registry must stay same-source, not a second truth."""


class UnsupportedControlError(AutomationError):
    """A control operation (pause / cancel / skip) is unsupported and must not be
    faked as a state (AGENTS.md red line)."""
