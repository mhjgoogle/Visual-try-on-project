"""CompositionPublishIntent: the project-level durable publish journal.

Composition is project-level (one ``outputs/final_v<N>.mp4`` covers all
shots), so the intent is keyed by project + logical version, never by a
task/shot/operation (ADR-0001). It is written durably BEFORE composing
or publishing the final MP4 and is not part of the step's output_paths.
Its identity is ``(project_id, logical_version, input_digest,
profile_digest)`` plus the three target paths: a same-identity replay is
idempotent; a same-path write with a different identity/digest/path is a
conflict; it is never overwritten with different content.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.composition.errors import (
    CompositionConflictError,
    CompositionError,
)
from ai_video_workflow.errors import (
    FieldTypeError,
    InvariantViolationError,
    JsonDataError,
)
from ai_video_workflow.security import resolve_within_root
from ai_video_workflow.validation import validate_stable_id

INTENT_SCHEMA_VERSION = 1

_KEYS = frozenset(
    {
        "schema_version",
        "project_id",
        "logical_version",
        "input_digest",
        "profile_digest",
        "media_path",
        "json_report_path",
        "markdown_report_path",
    }
)


@dataclass(frozen=True, slots=True)
class CompositionPublishIntent:
    project_id: str
    logical_version: int
    input_digest: str
    profile_digest: str
    media_path: str
    json_report_path: str
    markdown_report_path: str

    def __post_init__(self) -> None:
        validate_stable_id(self.project_id, field_name="project_id")
        if isinstance(self.logical_version, bool) or not isinstance(
            self.logical_version, int
        ):
            raise FieldTypeError("logical_version: expected int")
        if self.logical_version <= 0:
            raise InvariantViolationError("logical_version: must be > 0")
        for name in (
            "input_digest",
            "profile_digest",
            "media_path",
            "json_report_path",
            "markdown_report_path",
        ):
            value = getattr(self, name)
            if not isinstance(value, str) or not value:
                raise InvariantViolationError(f"{name}: must be a non-empty string")

    def to_json_dict(self) -> dict[str, object]:
        return {
            "schema_version": INTENT_SCHEMA_VERSION,
            "project_id": self.project_id,
            "logical_version": self.logical_version,
            "input_digest": self.input_digest,
            "profile_digest": self.profile_digest,
            "media_path": self.media_path,
            "json_report_path": self.json_report_path,
            "markdown_report_path": self.markdown_report_path,
        }


def intent_path(project_root: Path, project_id: str, logical_version: int) -> Path:
    return resolve_within_root(
        project_root,
        Path("records")
        / "step-intents"
        / "composition"
        / project_id
        / f"{logical_version}.json",
    )


def _intent_bytes(intent: CompositionPublishIntent) -> bytes:
    text = (
        json.dumps(
            intent.to_json_dict(),
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    )
    return text.encode("utf-8")


def write_intent(project_root: Path, intent: CompositionPublishIntent) -> str:
    """Durably publish the intent: reuse-if-equal / conflict / no-replace.

    Returns ``"reused"`` if an identical intent already exists, or
    ``"written"`` if newly published. Raises ``CompositionConflictError``
    if an intent with the same path but different content exists.
    """
    path = intent_path(project_root, intent.project_id, intent.logical_version)
    data = _intent_bytes(intent)
    if path.exists():
        existing = path.read_bytes()
        if existing == data:
            return "reused"
        raise CompositionConflictError(
            f"composition intent conflicts with existing content: {path}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_no_replace_write(path, data)
    return "written"


def read_intent(
    project_root: Path, project_id: str, logical_version: int
) -> CompositionPublishIntent | None:
    """Read the durable intent for a project/version, or None if absent."""
    path = intent_path(project_root, project_id, logical_version)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise JsonDataError(f"composition intent is not valid JSON: {path}") from exc
    if not isinstance(obj, dict) or frozenset(obj) != _KEYS:
        raise JsonDataError(f"composition intent has an unexpected key set: {path}")
    if obj["schema_version"] != INTENT_SCHEMA_VERSION:
        raise JsonDataError(f"composition intent schema_version unsupported: {path}")
    return CompositionPublishIntent(
        project_id=obj["project_id"],
        logical_version=obj["logical_version"],
        input_digest=obj["input_digest"],
        profile_digest=obj["profile_digest"],
        media_path=obj["media_path"],
        json_report_path=obj["json_report_path"],
        markdown_report_path=obj["markdown_report_path"],
    )


def _atomic_no_replace_write(path: Path, data: bytes) -> None:
    temporary_path: Path | None = None
    raw_fd: int | None = None
    try:
        raw_fd, temporary_name = tempfile.mkstemp(
            dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
        )
        temporary_path = Path(temporary_name)
        stream = os.fdopen(raw_fd, "wb")
        raw_fd = None
        with stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary_path, path)
        except FileExistsError as exc:
            raise CompositionConflictError(
                f"composition intent appeared during publish: {path}"
            ) from exc
    except CompositionConflictError:
        raise
    except OSError as exc:
        raise CompositionError(f"unable to publish composition intent: {path}") from exc
    finally:
        if raw_fd is not None:
            try:
                os.close(raw_fd)
            except OSError:
                pass
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass
