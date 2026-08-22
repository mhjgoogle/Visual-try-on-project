"""Tests for generation-task bootstrap and explicit redo (TASK-007)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ai_video_workflow.app.bootstrap import (
    BootstrapError,
    TaskAlreadyExistsError,
    bootstrap_generation_tasks,
    create_redo_task,
    generation_manifest_path,
    task_record_path,
)
from ai_video_workflow.app.contracts import (
    generation_config_digest,
    generation_input_digest,
    staging_ref_for,
)
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
)
from ai_video_workflow.persistence import read_model_json, write_model_json
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.log import read_events

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 7, 29, 9, 0, 0, tzinfo=timezone.utc)


def _data(*, tasks=()) -> ProjectData:
    return ProjectData(
        project=Project(project_id="proj-1", name="Demo", created_at=T0),
        scenes=(
            Scene(
                scene_id="scene-1",
                project_id="proj-1",
                sequence=1,
                title="S1",
                description="d",
                created_at=T0,
            ),
        ),
        shots=(
            Shot(
                shot_id="shot-1",
                scene_id="scene-1",
                sequence=1,
                description="d",
                prompt="p",
                duration_seconds=4.0,
                width=1280,
                height=720,
                frame_rate=24.0,
                created_at=T0,
            ),
            Shot(
                shot_id="shot-2",
                scene_id="scene-1",
                sequence=2,
                description="d",
                prompt="p",
                duration_seconds=4.0,
                width=1280,
                height=720,
                frame_rate=24.0,
                created_at=T0,
            ),
        ),
        generation_tasks=tasks,
    )


def test_bootstrap_creates_task_and_manifest(tmp_path) -> None:
    outcome = bootstrap_generation_tasks(
        project_root=tmp_path, data=_data(), provider_id="manual", now=T0
    )
    assert set(outcome.created) == {"task-shot-1-1", "task-shot-2-1"}
    task = read_model_json(task_record_path(tmp_path, "task-shot-1-1"), GenerationTask)
    assert task.status is GenerationTaskStatus.PENDING
    assert task.provider_id is None  # not bound at bootstrap
    manifest = read_model_json(
        generation_manifest_path(tmp_path, "task-shot-1-1"), StepManifest
    )
    assert manifest.step_name == "generation:task-shot-1-1"
    assert manifest.status is ManifestStatus.PENDING
    events = read_events(tmp_path)
    assert {e.event_type.value for e in events} == {"task_created"}
    assert len(events) == 2


def test_bootstrap_creates_nothing_else(tmp_path) -> None:
    bootstrap_generation_tasks(
        project_root=tmp_path, data=_data(), provider_id="manual", now=T0
    )
    # no instruction, no ProviderRequest, no staged media
    assert not (tmp_path / "tasks/instructions").exists()
    assert not (tmp_path / staging_ref_for("task-shot-1-1")).exists()


def test_bootstrap_is_idempotent(tmp_path) -> None:
    bootstrap_generation_tasks(
        project_root=tmp_path, data=_data(), provider_id="manual", now=T0
    )
    task_bytes = task_record_path(tmp_path, "task-shot-1-1").read_bytes()
    second = bootstrap_generation_tasks(
        project_root=tmp_path, data=_data(), provider_id="manual", now=T1
    )
    assert set(second.skipped) == {"task-shot-1-1", "task-shot-2-1"}
    assert second.created == ()
    # original timestamps preserved (not rewritten with T1)
    assert task_record_path(tmp_path, "task-shot-1-1").read_bytes() == task_bytes
    assert len(read_events(tmp_path)) == 2  # no new events


def test_bootstrap_partial_crash_fills_manifest(tmp_path) -> None:
    bootstrap_generation_tasks(
        project_root=tmp_path, data=_data(), provider_id="manual", now=T0
    )
    # simulate a crash after the task write, before the manifest write
    generation_manifest_path(tmp_path, "task-shot-1-1").unlink()
    recovered = bootstrap_generation_tasks(
        project_root=tmp_path, data=_data(), provider_id="manual", now=T1
    )
    assert "task-shot-1-1" in recovered.created
    assert generation_manifest_path(tmp_path, "task-shot-1-1").exists()


def test_bootstrap_conflict_on_non_equivalent(tmp_path) -> None:
    # a file at the task path whose shot_id disagrees
    path = task_record_path(tmp_path, "task-shot-1-1")
    path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(
        path,
        GenerationTask(
            task_id="task-shot-1-1",
            shot_id="OTHER",
            status=GenerationTaskStatus.PENDING,
            created_at=T0,
            updated_at=T0,
        ),
    )
    with pytest.raises(TaskAlreadyExistsError):
        bootstrap_generation_tasks(
            project_root=tmp_path, data=_data(), provider_id="manual", now=T0
        )


def test_bootstrap_skips_completed_task(tmp_path) -> None:
    # an already-DONE task is not auto-recreated
    path = task_record_path(tmp_path, "task-shot-1-1")
    path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(
        path,
        GenerationTask(
            task_id="task-shot-1-1",
            shot_id="shot-1",
            status=GenerationTaskStatus.DONE,
            created_at=T0,
            updated_at=T0,
            completed_at=T0,
            provider_id="manual",
        ),
    )
    generation_manifest_path(tmp_path, "task-shot-1-1").parent.mkdir(
        parents=True, exist_ok=True
    )
    data = _data()
    shot = next(s for s in data.shots if s.shot_id == "shot-1")
    write_model_json(
        generation_manifest_path(tmp_path, "task-shot-1-1"),
        StepManifest(
            step_name="generation:task-shot-1-1",
            input_digest=generation_input_digest(shot),
            relevant_config_digest=generation_config_digest("manual"),
            status=ManifestStatus.PENDING,
            created_at=T0,
        ),
    )
    outcome = bootstrap_generation_tasks(
        project_root=tmp_path, data=data, provider_id="manual", now=T0
    )
    assert "task-shot-1-1" in outcome.skipped  # not recreated


def test_bootstrap_conflict_on_non_equivalent_manifest(tmp_path) -> None:
    # a companion manifest whose approved digests disagree is a conflict,
    # never a silent overwrite (TASK-013 blocker 7).
    data = _data()
    task_path = task_record_path(tmp_path, "task-shot-1-1")
    task_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(
        task_path,
        GenerationTask(
            task_id="task-shot-1-1",
            shot_id="shot-1",
            status=GenerationTaskStatus.PENDING,
            created_at=T0,
            updated_at=T0,
        ),
    )
    manifest_path = generation_manifest_path(tmp_path, "task-shot-1-1")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(
        manifest_path,
        StepManifest(
            step_name="generation:task-shot-1-1",
            input_digest="STALE-DIGEST",  # drifted from the shot's real input
            relevant_config_digest=generation_config_digest("manual"),
            status=ManifestStatus.PENDING,
            created_at=T0,
        ),
    )
    with pytest.raises(TaskAlreadyExistsError):
        bootstrap_generation_tasks(
            project_root=tmp_path, data=data, provider_id="manual", now=T0
        )


def _done_task(task_id: str, shot_id: str) -> GenerationTask:
    return GenerationTask(
        task_id=task_id,
        shot_id=shot_id,
        status=GenerationTaskStatus.DONE,
        created_at=T0,
        updated_at=T0,
        completed_at=T0,
        provider_id="manual",
    )


def test_create_redo_task(tmp_path) -> None:
    data = _data(tasks=(_done_task("task-shot-1-1", "shot-1"),))
    outcome = create_redo_task(
        project_root=tmp_path,
        data=data,
        shot_id="shot-1",
        provider_id="manual",
        now=T1,
    )
    assert outcome.created == ("task-shot-1-2",)
    task = read_model_json(task_record_path(tmp_path, "task-shot-1-2"), GenerationTask)
    assert task.status is GenerationTaskStatus.PENDING
    assert task.provider_id is None
    events = read_events(tmp_path)
    assert events[0].event_type.value == "task_created"
    assert events[0].payload["origin"] == "redo"
    assert events[0].payload["redo_of_task_id"] == "task-shot-1-1"


def test_repeated_redo_is_idempotent_while_top_unused(tmp_path) -> None:
    # the first redo creates task-shot-1-2 (PENDING); a second redo before
    # that attempt is used must NOT stack a task-shot-1-3.
    data = _data(tasks=(_done_task("task-shot-1-1", "shot-1"),))
    first = create_redo_task(
        project_root=tmp_path,
        data=data,
        shot_id="shot-1",
        provider_id="manual",
        now=T1,
    )
    assert first.created == ("task-shot-1-2",)
    # reload with the new PENDING attempt visible
    data2 = _data(
        tasks=(
            _done_task("task-shot-1-1", "shot-1"),
            GenerationTask(
                task_id="task-shot-1-2",
                shot_id="shot-1",
                status=GenerationTaskStatus.PENDING,
                created_at=T1,
                updated_at=T1,
            ),
        )
    )
    second = create_redo_task(
        project_root=tmp_path,
        data=data2,
        shot_id="shot-1",
        provider_id="manual",
        now=T1,
    )
    assert second.created == ()
    assert second.skipped == ("task-shot-1-2",)
    assert not task_record_path(tmp_path, "task-shot-1-3").exists()


def test_redo_repairs_crashed_pending_attempt(tmp_path) -> None:
    # v1 done; first redo creates v2 (task + manifest + QCD)
    data = _data(tasks=(_done_task("task-shot-1-1", "shot-1"),))
    create_redo_task(
        project_root=tmp_path,
        data=data,
        shot_id="shot-1",
        provider_id="manual",
        now=T1,
    )
    # simulate a crash after the v2 task write but before its manifest
    generation_manifest_path(tmp_path, "task-shot-1-2").unlink()
    data2 = _data(
        tasks=(
            _done_task("task-shot-1-1", "shot-1"),
            GenerationTask(
                task_id="task-shot-1-2",
                shot_id="shot-1",
                status=GenerationTaskStatus.PENDING,
                created_at=T1,
                updated_at=T1,
            ),
        )
    )
    repaired = create_redo_task(
        project_root=tmp_path,
        data=data2,
        shot_id="shot-1",
        provider_id="manual",
        now=T1,
    )
    # the missing manifest is restored and no v3 is stacked
    assert repaired.created == ("task-shot-1-2",)
    assert generation_manifest_path(tmp_path, "task-shot-1-2").exists()
    assert not task_record_path(tmp_path, "task-shot-1-3").exists()


def test_redo_without_prior_raises(tmp_path) -> None:
    with pytest.raises(BootstrapError):
        create_redo_task(
            project_root=tmp_path,
            data=_data(),
            shot_id="shot-1",
            provider_id="manual",
            now=T1,
        )
