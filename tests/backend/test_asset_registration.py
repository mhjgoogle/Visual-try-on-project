"""Tests for media import and VideoAsset registration (TASK-005)."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

import pytest

from ai_video_workflow.assets.registration import (
    AssetConflictError,
    asset_id_for,
    import_media,
    media_relative_path,
    publish_bytes,
    register_video_asset,
)
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.persistence import read_model_json

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def _scene() -> Scene:
    return Scene(
        scene_id="scene-1",
        project_id="proj-1",
        sequence=1,
        title="Opening",
        description="opening scene",
        created_at=T0,
    )


def _shot() -> Shot:
    return Shot(
        shot_id="shot-1",
        scene_id="scene-1",
        sequence=3,
        description="a cat",
        prompt="a cat",
        duration_seconds=4.0,
        width=1280,
        height=720,
        frame_rate=24.0,
        created_at=T0,
    )


def _task() -> GenerationTask:
    return GenerationTask(
        task_id="task-shot-1-1",
        shot_id="shot-1",
        status=GenerationTaskStatus.PENDING,
        created_at=T0,
        updated_at=T0,
    )


def _probe() -> MediaProbeResult:
    return MediaProbeResult("mp4", 4.0, 1280, 720, 24.0)


def _stage(project, data=b"media"):
    path = project / "staging" / "shots" / "task-shot-1-1.mp4"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# --- publish_bytes --------------------------------------------------------


def test_publish_bytes_writes_then_reuses(tmp_path) -> None:
    target = tmp_path / "assets" / "media" / "a.mp4"
    assert publish_bytes(target, b"data") == "written"
    assert target.read_bytes() == b"data"
    assert publish_bytes(target, b"data") == "reused"  # idempotent replay


def test_publish_bytes_conflict_on_different_bytes(tmp_path) -> None:
    target = tmp_path / "assets" / "media" / "a.mp4"
    publish_bytes(target, b"one")
    with pytest.raises(AssetConflictError):
        publish_bytes(target, b"two")
    assert target.read_bytes() == b"one"  # not overwritten


# --- import_media ---------------------------------------------------------


def test_import_media_copies_and_reports(tmp_path) -> None:
    staged = _stage(tmp_path, b"clip-bytes")
    rel, sha, size = import_media(
        project_root=tmp_path,
        staged_path=staged,
        scene=_scene(),
        shot=_shot(),
        version=1,
    )
    assert rel == "assets/media/s01_sh003_v1.mp4"
    assert (tmp_path / rel).read_bytes() == b"clip-bytes"
    assert sha == hashlib.sha256(b"clip-bytes").hexdigest()
    assert size == len(b"clip-bytes")


def test_import_media_idempotent_reuse(tmp_path) -> None:
    staged = _stage(tmp_path, b"clip-bytes")
    import_media(
        project_root=tmp_path,
        staged_path=staged,
        scene=_scene(),
        shot=_shot(),
        version=1,
    )
    # a second import of the same content reuses (no conflict)
    rel, _, _ = import_media(
        project_root=tmp_path,
        staged_path=staged,
        scene=_scene(),
        shot=_shot(),
        version=1,
    )
    assert (tmp_path / rel).read_bytes() == b"clip-bytes"


# --- register_video_asset -------------------------------------------------


def test_register_video_asset_derives_id_and_persists(tmp_path) -> None:
    asset, rel = register_video_asset(
        project_root=tmp_path,
        task=_task(),
        shot=_shot(),
        version=1,
        media_relative="assets/media/s01_sh003_v1.mp4",
        probe=_probe(),
        validated_at=T0,
    )
    assert asset.asset_id == "asset-task-shot-1-1-v1"
    assert asset.source_task_id == "task-shot-1-1"
    assert asset.version == 1
    assert rel == "records/video-assets/asset-task-shot-1-1-v1.json"
    loaded = read_model_json(tmp_path / rel, VideoAsset)
    assert loaded.asset_id == asset.asset_id
    assert loaded.width == 1280 and loaded.frame_rate == 24.0


def test_register_video_asset_idempotent_reuse(tmp_path) -> None:
    for _ in range(2):
        asset, rel = register_video_asset(
            project_root=tmp_path,
            task=_task(),
            shot=_shot(),
            version=1,
            media_relative="assets/media/s01_sh003_v1.mp4",
            probe=_probe(),
            validated_at=T0,
        )
    assert asset.version == 1


def test_register_video_asset_conflict(tmp_path) -> None:
    register_video_asset(
        project_root=tmp_path,
        task=_task(),
        shot=_shot(),
        version=1,
        media_relative="assets/media/s01_sh003_v1.mp4",
        probe=_probe(),
        validated_at=T0,
    )
    with pytest.raises(AssetConflictError):
        register_video_asset(
            project_root=tmp_path,
            task=_task(),
            shot=_shot(),
            version=1,
            media_relative="assets/media/s01_sh003_v1.mp4",
            probe=MediaProbeResult(
                "mp4", 9.0, 1280, 720, 24.0
            ),  # different -> conflict
            validated_at=T0,
        )


def test_version_two_media_name(tmp_path) -> None:
    assert media_relative_path(_scene(), _shot(), 2) == "assets/media/s01_sh003_v2.mp4"
    assert asset_id_for(_task(), 2) == "asset-task-shot-1-1-v2"
