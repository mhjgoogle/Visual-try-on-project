"""Media import and VideoAsset registration with reuse/conflict rules.

Durable outputs are published with a uniform ``publish_bytes`` helper:
if the target is absent it is written atomically (temp -> fsync ->
no-replace link); if it exists with equal bytes the write is reused
(idempotent replay); if it exists with different bytes the step raises
``AssetConflictError`` — never a silent overwrite, never a version jump
(TASK-005 / ADR-0001 §9 rules 3 and 7).
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from datetime import datetime
from pathlib import Path

from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import GenerationTask, Scene, Shot, VideoAsset
from ai_video_workflow.serialization import model_to_json


class AssetRegistrationError(AiVideoWorkflowError):
    """Base error for asset registration failures."""


class ValidationFailedError(AssetRegistrationError):
    """Raised when registration is attempted for a report that did not pass."""


class AssetConflictError(AssetRegistrationError):
    """Raised when an existing durable file has different, conflicting bytes."""


def media_relative_path(scene: Scene, shot: Shot, version: int) -> str:
    """Return the formal media path for a scene/shot/version."""
    return f"assets/media/s{scene.sequence:02d}_sh{shot.sequence:03d}_v{version}.mp4"


def asset_id_for(task: GenerationTask, version: int) -> str:
    """Return the registered asset id for a task/version."""
    return f"asset-{task.task_id}-v{version}"


def asset_record_relative_path(asset_id: str) -> str:
    return f"records/video-assets/{asset_id}.json"


def publish_bytes(path: Path, data: bytes) -> str:
    """Publish exact bytes with reuse-if-equal / conflict / no-replace.

    Returns ``"reused"`` if the file already holds these exact bytes, or
    ``"written"`` if it was newly published. Raises ``AssetConflictError``
    if it exists with different bytes.
    """
    if path.exists():
        try:
            existing = path.read_bytes()
        except OSError as exc:
            raise AssetRegistrationError(
                f"unable to read existing file: {path}"
            ) from exc
        if existing == data:
            return "reused"
        raise AssetConflictError(f"existing file has conflicting content: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_no_replace_write(path, data)
    return "written"


def import_media(
    *,
    project_root: Path,
    staged_path: Path,
    scene: Scene,
    shot: Shot,
    version: int,
) -> tuple[str, str, int]:
    """Copy staged bytes into the formal media path (reuse/conflict).

    Returns ``(media_relative_path, sha256, size_bytes)``.
    """
    try:
        data = staged_path.read_bytes()
    except OSError as exc:
        raise AssetRegistrationError(
            f"unable to read staged media: {staged_path}"
        ) from exc
    rel = media_relative_path(scene, shot, version)
    publish_bytes(project_root / rel, data)
    return rel, hashlib.sha256(data).hexdigest(), len(data)


def register_video_asset(
    *,
    project_root: Path,
    task: GenerationTask,
    shot: Shot,
    version: int,
    media_relative: str,
    probe: MediaProbeResult,
    validated_at: datetime,
) -> tuple[VideoAsset, str]:
    """Build and durably publish the VideoAsset record (reuse/conflict)."""
    asset = VideoAsset(
        asset_id=asset_id_for(task, version),
        shot_id=shot.shot_id,
        source_task_id=task.task_id,
        path=Path(media_relative),
        container_format=probe.container_format,
        duration_seconds=probe.duration_seconds,
        width=probe.width,
        height=probe.height,
        frame_rate=probe.frame_rate,
        version=version,
        validated_at=validated_at,
    )
    rel = asset_record_relative_path(asset.asset_id)
    publish_bytes(project_root / rel, model_to_json(asset).encode("utf-8"))
    return asset, rel


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
            raise AssetConflictError(
                f"existing file appeared during publish: {path}"
            ) from exc
    except AssetConflictError:
        raise
    except OSError as exc:
        raise AssetRegistrationError(f"unable to publish file: {path}") from exc
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
