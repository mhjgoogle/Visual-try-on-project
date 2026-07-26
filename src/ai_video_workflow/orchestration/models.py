"""Public orchestration enums and summary models."""

from __future__ import annotations

from enum import Enum


class OrchestrationAction(str, Enum):
    """One orchestration-level action on a generation task."""

    PREPARE = "prepare"
    SUBMIT = "submit"
    POLL = "poll"
    REPORT_ARTIFACT = "report_artifact"
    COLLECT = "collect"
    REPLAY_RESULT = "replay_result"
    RESUME = "resume"


class OutcomeKind(str, Enum):
    """Whether an orchestration action applied changes or was a no-op."""

    APPLIED = "applied"
    NO_OP = "no_op"


class RecordPhase(str, Enum):
    """Durable phase of one orchestration record envelope."""

    STABLE = "stable"
    PROVIDER_CALL_INTENT = "provider_call_intent"
    PROVIDER_CALL_MAY_HAVE_STARTED = "provider_call_may_have_started"
    PROVIDER_RESULT_UNKNOWN = "provider_result_unknown"
    APPLYING = "applying"
    RECOVERY_REQUIRED = "recovery_required"


class RecoveryDisposition(str, Enum):
    """How a recovery situation may proceed."""

    NONE = "none"
    SAFE_AUTO_RETRY = "safe_auto_retry"
    MANUAL_RECONCILIATION = "manual_reconciliation"
    CONFLICT = "conflict"
