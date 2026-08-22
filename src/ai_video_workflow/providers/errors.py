"""Provider-boundary exceptions for the video provider contract."""

from ai_video_workflow.errors import AiVideoWorkflowError


class ProviderError(AiVideoWorkflowError):
    """Base exception for expected provider contract failures."""


class InvalidProviderRequestError(ProviderError):
    """Raised when a provider receives an invalid or unsupported request."""


class InvalidProviderStateError(ProviderError):
    """Raised when a provider status combination or precondition is invalid."""


class MissingArtifactReferenceError(ProviderError):
    """Raised when collect lacks an explicitly supplied artifact reference."""


class ProviderOperationError(ProviderError):
    """Raised when a provider operation cannot produce a valid result."""
