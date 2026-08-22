import pytest

from ai_video_workflow.errors import (
    AiVideoWorkflowError,
    AtomicWriteError,
    DataFileError,
    DataFileNotFoundError,
    DataValidationError,
    FieldTypeError,
    InvariantViolationError,
    JsonDataError,
    MissingFieldError,
    OverwriteRefusedError,
    ReferenceValidationError,
)


@pytest.mark.parametrize(
    "error_type",
    [
        JsonDataError,
        MissingFieldError,
        FieldTypeError,
        InvariantViolationError,
        ReferenceValidationError,
        DataFileNotFoundError,
        OverwriteRefusedError,
        AtomicWriteError,
    ],
)
def test_project_errors_share_a_common_base(error_type: type[Exception]) -> None:
    with pytest.raises(AiVideoWorkflowError):
        raise error_type("field.path: contextual failure")


def test_validation_and_file_errors_have_distinct_branches() -> None:
    assert issubclass(FieldTypeError, DataValidationError)
    assert not issubclass(FieldTypeError, DataFileError)
    assert issubclass(DataFileNotFoundError, DataFileError)
    assert not issubclass(DataFileNotFoundError, DataValidationError)


def test_error_categories_are_distinct_types() -> None:
    error_types = {
        JsonDataError,
        MissingFieldError,
        FieldTypeError,
        InvariantViolationError,
        ReferenceValidationError,
        DataFileNotFoundError,
        OverwriteRefusedError,
        AtomicWriteError,
    }
    assert len(error_types) == 8
