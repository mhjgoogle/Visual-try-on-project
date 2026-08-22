"""Project-specific exceptions for validation and persistence boundaries."""


class AiVideoWorkflowError(Exception):
    """Base exception for all expected project errors."""


class DataValidationError(AiVideoWorkflowError):
    """Base exception for invalid structured data."""


class JsonDataError(DataValidationError):
    """Raised when JSON syntax or top-level structure is invalid."""


class MissingFieldError(DataValidationError):
    """Raised when a required field is absent."""


class FieldTypeError(DataValidationError):
    """Raised when a field has an unsupported type."""


class InvariantViolationError(DataValidationError):
    """Raised when individually valid fields violate a local invariant."""


class ReferenceValidationError(DataValidationError):
    """Raised when a cross-model reference is missing or inconsistent."""


class DataFileError(AiVideoWorkflowError):
    """Base exception for expected data-file failures."""


class DataFileNotFoundError(DataFileError):
    """Raised when a required data file does not exist."""


class OverwriteRefusedError(DataFileError):
    """Raised when a write would overwrite a file without explicit permission."""


class AtomicWriteError(DataFileError):
    """Raised when an atomic file publication cannot be completed."""
