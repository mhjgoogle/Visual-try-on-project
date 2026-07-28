"""Deterministic content and configuration digests (TASK-005).

Two digest primitives underpin the M1 step manifests and multi-file
partial-commit recovery:

- ``file_sha256`` — the SHA-256 of a file's raw bytes, used as a
  StepManifest ``input_digest`` for the staged media;
- ``config_digest`` — the SHA-256 of a canonical-JSON encoding of a
  JSON-compatible configuration value, used as a
  ``relevant_config_digest``.

Both return lowercase 64-character hexadecimal strings. Neither reads
the clock; the configuration digest is fully determined by its input.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from ai_video_workflow.errors import (
    DataFileError,
    DataFileNotFoundError,
    FieldTypeError,
)
from ai_video_workflow.manifest import JsonCompatibleValue
from ai_video_workflow.validation import validate_json_compatible

_READ_CHUNK = 1024 * 1024


def file_sha256(path: Path) -> str:
    """Return the lowercase hex SHA-256 of a file's raw bytes."""
    if not isinstance(path, Path):
        raise FieldTypeError(f"path: expected Path, got {type(path).__name__}")
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            while True:
                chunk = stream.read(_READ_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
    except FileNotFoundError as exc:
        raise DataFileNotFoundError(f"file does not exist: {path}") from exc
    except OSError as exc:
        raise DataFileError(f"unable to read file: {path}") from exc
    return digest.hexdigest()


def config_digest(value: JsonCompatibleValue) -> str:
    """Return the lowercase hex SHA-256 of a value's canonical JSON.

    The value must be JSON-compatible (validated, not mutated). The
    canonical encoding sorts keys, uses compact separators, forbids
    non-finite floats, and emits UTF-8 — so equal configurations always
    produce the same digest and differing ones differ.
    """
    validate_json_compatible(value, path="config")
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
