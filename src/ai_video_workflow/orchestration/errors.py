"""Orchestration-boundary exceptions for the provider orchestrator."""

from ai_video_workflow.errors import AiVideoWorkflowError


class OrchestrationError(AiVideoWorkflowError):
    """Base exception for expected orchestration failures."""


class InvalidOrchestrationInputError(OrchestrationError):
    """Raised when context, identity, or association validation fails."""


class InvalidOrchestrationStateError(OrchestrationError):
    """Raised for an illegal action or precondition state."""


class IllegalProviderTransitionError(OrchestrationError):
    """Raised when a provider return status is illegal for the action."""


class StaleResultError(OrchestrationError):
    """Raised for an older observation within the same baseline."""


class ConflictingProviderResultError(OrchestrationError):
    """Raised for conflicting payloads, artifacts, or terminal changes."""


class ConflictingRequestError(OrchestrationError):
    """Raised when the request snapshot fingerprint does not match."""


class IdempotencyConflictError(OrchestrationError):
    """Raised when an operation id is reused with different inputs."""


class BaselineMismatchError(OrchestrationError):
    """Raised when the stable version or baseline does not match."""


class PartialCommitConflictError(OrchestrationError):
    """Raised when a target matches neither its before nor after state."""


class UnknownProviderSideEffectError(OrchestrationError):
    """Raised for automatic actions while a provider call is unresolved."""


class MissingRecoveryRecordError(OrchestrationError):
    """Raised when the record is missing but orchestration traces exist."""


class MissingProjectStateError(OrchestrationError):
    """Raised when a required task or manifest file does not exist."""


class InvalidRecoveryRecordError(OrchestrationError):
    """Raised when recovery data is invalid or cannot be parsed."""


class CorruptStableRecordError(InvalidRecoveryRecordError):
    """Raised when the stable record self-fingerprint does not verify."""


class CanonicalizationError(OrchestrationError):
    """Raised when a value cannot be canonicalized deterministically."""


class PersistencePlanningError(OrchestrationError):
    """Raised when an update plan cannot be constructed."""


class PersistenceExecutionError(OrchestrationError):
    """Raised when state persistence I/O fails."""
