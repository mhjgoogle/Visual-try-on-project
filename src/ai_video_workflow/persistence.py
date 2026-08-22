"""UTF-8 model JSON persistence with atomic publication semantics."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import TypeVar

from ai_video_workflow.errors import (
    AtomicWriteError,
    DataFileError,
    DataFileNotFoundError,
    FieldTypeError,
    OverwriteRefusedError,
)
from ai_video_workflow.manifest import StepManifest
from ai_video_workflow.models import (
    Character,
    GenerationTask,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.serialization import (
    SupportedModel,
    model_from_json,
    model_to_json,
)

ModelT = TypeVar(
    "ModelT",
    Project,
    Character,
    Scene,
    Shot,
    GenerationTask,
    VideoAsset,
    StepManifest,
)


def read_model_json(path: Path, model_type: type[ModelT]) -> ModelT:
    """Read one UTF-8 JSON file and construct the requested approved model."""
    _validate_path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise DataFileNotFoundError(f"data file does not exist: {path}") from exc
    except (OSError, UnicodeError, ValueError) as exc:
        raise DataFileError(f"unable to read data file: {path}") from exc
    return model_from_json(text, model_type)


def write_model_json(
    path: Path,
    model: SupportedModel,
    *,
    overwrite: bool = False,
) -> None:
    """Atomically publish one deterministic UTF-8 model JSON file."""
    _validate_path(path)
    if type(overwrite) is not bool:
        raise FieldTypeError(
            f"overwrite: expected bool, got {type(overwrite).__name__}"
        )

    try:
        payload = model_to_json(model).encode("utf-8")
    except UnicodeError as exc:
        raise AtomicWriteError("unable to encode model as UTF-8") from exc

    temporary_path: Path | None = None
    raw_fd: int | None = None
    try:
        raw_fd, temporary_name = tempfile.mkstemp(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        )
        temporary_path = Path(temporary_name)
        stream = os.fdopen(raw_fd, "wb")
        raw_fd = None
        with stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())

        if overwrite:
            os.replace(temporary_path, path)
        else:
            try:
                os.link(temporary_path, path)
            except FileExistsError as exc:
                raise OverwriteRefusedError(
                    f"refusing to overwrite existing data file: {path}"
                ) from exc
    except OverwriteRefusedError:
        raise
    except (OSError, UnicodeError, ValueError) as exc:
        raise AtomicWriteError(f"unable to publish data file: {path}") from exc
    finally:
        if raw_fd is not None:
            try:
                os.close(raw_fd)
            except OSError:
                pass
        if temporary_path is not None:
            _remove_temporary_file(temporary_path)


def _validate_path(path: object) -> None:
    if not isinstance(path, Path):
        raise FieldTypeError(f"path: expected Path, got {type(path).__name__}")


def _remove_temporary_file(path: Path) -> None:
    """Remove a temporary file without changing the primary operation outcome."""
    try:
        path.unlink()
    except OSError:
        pass
