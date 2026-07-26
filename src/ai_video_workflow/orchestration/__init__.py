"""Public exports for the provider orchestration boundary.

Only the names approved as public by the TASK-004 design are exported.
Canonicalization, fingerprint, and freeze utilities stay internal.
Later implementation steps extend this surface with the remaining
approved public types.
"""

from ai_video_workflow.orchestration.errors import (
    BaselineMismatchError,
    CanonicalizationError,
    ConflictingProviderResultError,
    ConflictingRequestError,
    CorruptStableRecordError,
    IdempotencyConflictError,
    IllegalProviderTransitionError,
    InvalidOrchestrationInputError,
    InvalidOrchestrationStateError,
    InvalidRecoveryRecordError,
    MissingProjectStateError,
    MissingRecoveryRecordError,
    OrchestrationError,
    PartialCommitConflictError,
    PersistenceExecutionError,
    PersistencePlanningError,
    StaleResultError,
    UnknownProviderSideEffectError,
)
from ai_video_workflow.orchestration.models import (
    OrchestrationAction,
    OutcomeKind,
    RecordPhase,
    RecoveryDisposition,
)

__all__ = [
    "BaselineMismatchError",
    "CanonicalizationError",
    "ConflictingProviderResultError",
    "ConflictingRequestError",
    "CorruptStableRecordError",
    "IdempotencyConflictError",
    "IllegalProviderTransitionError",
    "InvalidOrchestrationInputError",
    "InvalidOrchestrationStateError",
    "InvalidRecoveryRecordError",
    "MissingProjectStateError",
    "MissingRecoveryRecordError",
    "OrchestrationAction",
    "OrchestrationError",
    "OutcomeKind",
    "PartialCommitConflictError",
    "PersistenceExecutionError",
    "PersistencePlanningError",
    "RecordPhase",
    "RecoveryDisposition",
    "StaleResultError",
    "UnknownProviderSideEffectError",
]
