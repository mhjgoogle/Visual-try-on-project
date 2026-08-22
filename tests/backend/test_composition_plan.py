"""Tests for composition planning and the profile digest (TASK-006)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.composition.errors import (
    InconsistentShotSpecError,
    MissingShotAssetError,
)
from ai_video_workflow.composition.plan import build_composition_plan
from ai_video_workflow.composition.profile import (
    M1_COMPOSITION_CONFIG_SCHEMA,
    CompositionProfile,
    profile_digest,
)
from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.project_data import ProjectData

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def _project_data(*, scenes, shots, video_assets) -> ProjectData:
    # derive a matching GenerationTask per asset so the ProjectData
    # cross-reference validation (source_task_id + shot_id) passes.
    tasks = tuple(
        GenerationTask(
            task_id=asset.source_task_id,
            shot_id=asset.shot_id,
            status=GenerationTaskStatus.DONE,
            created_at=T0,
            updated_at=T0,
            completed_at=T0,
        )
        for asset in video_assets
    )
    return ProjectData(
        project=_project(),
        scenes=scenes,
        shots=shots,
        generation_tasks=tasks,
        video_assets=video_assets,
    )


def _project() -> Project:
    return Project(project_id="proj-1", name="Demo", created_at=T0)


def _scene(scene_id: str, sequence: int) -> Scene:
    return Scene(
        scene_id=scene_id,
        project_id="proj-1",
        sequence=sequence,
        title=f"Scene {sequence}",
        description="scene",
        created_at=T0,
    )


def _shot(shot_id: str, scene_id: str, sequence: int, **spec) -> Shot:
    base = dict(width=1280, height=720, frame_rate=24.0)
    base.update(spec)
    return Shot(
        shot_id=shot_id,
        scene_id=scene_id,
        sequence=sequence,
        description="d",
        prompt="p",
        duration_seconds=4.0,
        created_at=T0,
        **base,
    )


def _asset(asset_id: str, shot_id: str, version: int) -> VideoAsset:
    return VideoAsset(
        asset_id=asset_id,
        shot_id=shot_id,
        source_task_id=f"task-{shot_id}-{version}",
        path=Path(f"assets/media/{shot_id}_v{version}.mp4"),
        container_format="mp4",
        duration_seconds=4.0,
        width=1280,
        height=720,
        frame_rate=24.0,
        version=version,
        validated_at=T0,
    )


def test_profile_digest_stable_and_schema() -> None:
    p = CompositionProfile(width=1280, height=720, frame_rate=24.0)
    assert profile_digest(p) == profile_digest(
        CompositionProfile(width=1280, height=720, frame_rate=24.0)
    )
    assert p.to_config_value()["schema"] == M1_COMPOSITION_CONFIG_SCHEMA


def test_profile_digest_changes_with_field() -> None:
    a = CompositionProfile(width=1280, height=720, frame_rate=24.0)
    b = CompositionProfile(width=1920, height=1080, frame_rate=24.0)
    assert profile_digest(a) != profile_digest(b)


def test_plan_orders_by_scene_then_shot() -> None:
    data = _project_data(
        scenes=(_scene("scene-2", 2), _scene("scene-1", 1)),
        shots=(
            _shot("shot-b", "scene-1", 2),
            _shot("shot-a", "scene-1", 1),
            _shot("shot-c", "scene-2", 1),
        ),
        video_assets=(
            _asset("asset-a", "shot-a", 1),
            _asset("asset-b", "shot-b", 1),
            _asset("asset-c", "shot-c", 1),
        ),
    )
    plan = build_composition_plan(data=data)
    assert [e.shot_id for e in plan.entries] == ["shot-a", "shot-b", "shot-c"]
    assert plan.project_id == "proj-1"


def test_plan_selects_highest_version() -> None:
    data = _project_data(
        scenes=(_scene("scene-1", 1),),
        shots=(_shot("shot-a", "scene-1", 1),),
        video_assets=(
            _asset("asset-a-v1", "shot-a", 1),
            _asset("asset-a-v2", "shot-a", 2),
        ),
    )
    plan = build_composition_plan(data=data)
    assert plan.entries[0].asset_id == "asset-a-v2"
    assert plan.entries[0].asset_version == 2


def test_plan_missing_asset_lists_gaps() -> None:
    data = _project_data(
        scenes=(_scene("scene-1", 1),),
        shots=(_shot("shot-a", "scene-1", 1), _shot("shot-b", "scene-1", 2)),
        video_assets=(_asset("asset-a", "shot-a", 1),),
    )
    with pytest.raises(MissingShotAssetError) as exc:
        build_composition_plan(data=data)
    assert "shot-b" in str(exc.value)


def test_plan_inconsistent_spec_rejected() -> None:
    data = _project_data(
        scenes=(_scene("scene-1", 1),),
        shots=(
            _shot("shot-a", "scene-1", 1, width=1280, height=720),
            _shot("shot-b", "scene-1", 2, width=1920, height=1080),
        ),
        video_assets=(
            _asset("asset-a", "shot-a", 1),
            _asset("asset-b", "shot-b", 1),
        ),
    )
    with pytest.raises(InconsistentShotSpecError):
        build_composition_plan(data=data)


def test_plan_derives_profile_from_shots() -> None:
    data = _project_data(
        scenes=(_scene("scene-1", 1),),
        shots=(_shot("shot-a", "scene-1", 1, width=640, height=480, frame_rate=30.0),),
        video_assets=(_asset("asset-a", "shot-a", 1),),
    )
    plan = build_composition_plan(data=data)
    assert plan.profile.width == 640 and plan.profile.height == 480
    assert plan.profile.frame_rate == 30.0


def test_plan_uses_explicit_profile() -> None:
    data = _project_data(
        scenes=(_scene("scene-1", 1),),
        shots=(_shot("shot-a", "scene-1", 1),),
        video_assets=(_asset("asset-a", "shot-a", 1),),
    )
    profile = CompositionProfile(
        width=1280, height=720, frame_rate=24.0, audio_codec=None
    )
    plan = build_composition_plan(data=data, profile=profile)
    assert plan.profile.audio_codec is None
