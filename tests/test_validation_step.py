"""Integration tests for the resumable validation step (TASK-005)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.assets.policy import ValidationPolicy
from ai_video_workflow.assets.step import (
    record_manual_quality_rating,
    run_validation_step,
    validation_manifest_path,
)
from ai_video_workflow.assets.validation import staged_relative_path
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus, Scene, Shot
from ai_video_workflow.persistence import read_model_json
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
)
from ai_video_workflow.qcd.log import read_events
from tests.media_fakes import FakeMediaInspector

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def _scene() -> Scene:
    return Scene(
        scene_id="scene-1",
        project_id="proj-1",
        sequence=1,
        title="Opening",
        description="opening",
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
        status=GenerationTaskStatus.DONE,
        created_at=T0,
        updated_at=T0,
        completed_at=T0,
        provider_id="manual",
    )


def _artifact(task) -> ArtifactReference:
    return ArtifactReference(
        reference=staged_relative_path(task),
        origin=ArtifactOrigin.USER,
        location=ArtifactLocation.STAGING,
    )


def _stage(project: Path, task, data=b"good-media-bytes") -> None:
    path = project / staged_relative_path(task)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _good_probe() -> MediaProbeResult:
    return MediaProbeResult("mov,mp4,m4a", 4.0, 1280, 720, 24.0)


def _run(project, *, probe, task=None, policy=None):
    task = task or _task()
    return run_validation_step(
        project_root=project,
        shot=_shot(),
        scene=_scene(),
        task=task,
        artifact=_artifact(task),
        inspector=FakeMediaInspector(result=probe),
        policy=policy or ValidationPolicy(),
        observed_at=T0,
    )


def test_success_end_to_end(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    outcome = _run(tmp_path, probe=_good_probe(), task=task)

    assert outcome.report.passed is True
    assert outcome.skipped is False
    assert outcome.registered_asset is not None
    assert outcome.registered_asset.asset_id == "asset-task-shot-1-1-v1"
    # report (json + md), media, asset record all present
    assert (tmp_path / "reports/validation/task-shot-1-1_v1.json").exists()
    assert (tmp_path / "reports/validation/task-shot-1-1_v1.md").exists()
    assert (tmp_path / "assets/media/s01_sh003_v1.mp4").exists()
    assert (tmp_path / "records/video-assets/asset-task-shot-1-1-v1.json").exists()
    # manifest COMPLETED with all four output_paths
    manifest = read_model_json(validation_manifest_path(tmp_path, task), StepManifest)
    assert manifest.status is ManifestStatus.COMPLETED
    assert len(manifest.output_paths) == 4
    # two QCD events emitted
    events = read_events(tmp_path)
    assert {e.event_type.value for e in events} == {
        "asset_imported",
        "validation_completed",
    }
    assert len(outcome.emitted_event_ids) == 2


def test_failure_path(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    bad_probe = MediaProbeResult("mp4", 9.0, 1280, 720, 24.0)  # duration out of range
    outcome = _run(tmp_path, probe=bad_probe, task=task)

    assert outcome.report.passed is False
    assert outcome.registered_asset is None
    assert not (tmp_path / "assets/media/s01_sh003_v1.mp4").exists()
    manifest = read_model_json(validation_manifest_path(tmp_path, task), StepManifest)
    assert manifest.status is ManifestStatus.FAILED
    assert manifest.error_summary
    events = read_events(tmp_path)
    assert [e.event_type.value for e in events] == ["validation_completed"]
    assert events[0].payload["passed"] is False


def test_rerun_after_completed_is_noop(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    _run(tmp_path, probe=_good_probe(), task=task)
    second = _run(tmp_path, probe=_good_probe(), task=task)
    assert second.skipped is True
    assert second.registered_asset is not None
    # no new events (still exactly two)
    assert len(read_events(tmp_path)) == 2
    assert second.emitted_event_ids == ()


def test_partial_commit_recovery_completes(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    _run(tmp_path, probe=_good_probe(), task=task)
    # simulate a crash before the manifest commit: remove the manifest
    validation_manifest_path(tmp_path, task).unlink()
    recovered = _run(tmp_path, probe=_good_probe(), task=task)
    assert recovered.skipped is False
    assert recovered.registered_asset.asset_id == "asset-task-shot-1-1-v1"
    manifest = read_model_json(validation_manifest_path(tmp_path, task), StepManifest)
    assert manifest.status is ManifestStatus.COMPLETED
    # events may be duplicated on the log, but only two distinct ids
    events = read_events(tmp_path)
    assert len({e.event_id for e in events}) == 2


def test_missing_output_triggers_reregistration(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    _run(tmp_path, probe=_good_probe(), task=task)
    # a durable output disappeared -> not a no-op; re-run republishes it
    (tmp_path / "assets/media/s01_sh003_v1.mp4").unlink()
    recovered = _run(tmp_path, probe=_good_probe(), task=task)
    assert recovered.skipped is False
    assert (tmp_path / "assets/media/s01_sh003_v1.mp4").exists()


def test_content_change_registers_new_version(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task, data=b"first-content")
    first = _run(tmp_path, probe=_good_probe(), task=task)
    assert first.registered_asset.version == 1
    # the user re-stages different content for the same task
    _stage(tmp_path, task, data=b"second-different-content")
    second = _run(tmp_path, probe=_good_probe(), task=task)
    assert second.skipped is False
    assert second.registered_asset.version == 2
    # both versions retained on disk
    assert (tmp_path / "assets/media/s01_sh003_v1.mp4").exists()
    assert (tmp_path / "assets/media/s01_sh003_v2.mp4").exists()
    assert (tmp_path / "reports/validation/task-shot-1-1_v1.json").exists()
    assert (tmp_path / "reports/validation/task-shot-1-1_v2.json").exists()


def test_missing_staged_file_fails_cleanly(tmp_path) -> None:
    task = _task()  # nothing staged
    outcome = _run(tmp_path, probe=_good_probe(), task=task)
    assert outcome.report.passed is False
    assert outcome.registered_asset is None
    manifest = read_model_json(validation_manifest_path(tmp_path, task), StepManifest)
    assert manifest.status is ManifestStatus.FAILED


def test_partial_report_recovery_at_later_time(tmp_path) -> None:
    # crash after the JSON report but before the Markdown/manifest; re-run
    # one hour later. The report's observed_at must be reused so bytes match
    # (ADR-0005) instead of raising a conflict.
    from datetime import timedelta

    task = _task()
    _stage(tmp_path, task)
    _run(tmp_path, probe=_good_probe(), task=task)
    (tmp_path / "reports/validation/task-shot-1-1_v1.md").unlink()
    validation_manifest_path(tmp_path, task).unlink()
    later = run_validation_step(
        project_root=tmp_path,
        shot=_shot(),
        scene=_scene(),
        task=task,
        artifact=_artifact(task),
        inspector=FakeMediaInspector(result=_good_probe()),
        policy=ValidationPolicy(),
        observed_at=T0 + timedelta(hours=1),
    )
    assert later.skipped is False
    assert (tmp_path / "reports/validation/task-shot-1-1_v1.md").exists()
    manifest = read_model_json(validation_manifest_path(tmp_path, task), StepManifest)
    assert manifest.status is ManifestStatus.COMPLETED


def test_redo_task_new_content_gets_next_shot_version(tmp_path) -> None:
    # the original task registers shot version 1; a redo task with new
    # content for the same shot must become version 2, not collide on v1.
    task1 = _task()
    _stage(tmp_path, task1, data=b"original-content")
    _run(tmp_path, probe=_good_probe(), task=task1)

    task2 = GenerationTask(
        task_id="task-shot-1-2",
        shot_id="shot-1",
        status=GenerationTaskStatus.DONE,
        created_at=T0,
        updated_at=T0,
        completed_at=T0,
        provider_id="manual",
    )
    _stage(tmp_path, task2, data=b"redo-different-content")
    redo = _run(tmp_path, probe=_good_probe(), task=task2)
    assert redo.skipped is False
    assert redo.registered_asset.version == 2
    assert redo.registered_asset.asset_id == "asset-task-shot-1-2-v2"
    assert (tmp_path / "assets/media/s01_sh003_v1.mp4").exists()
    assert (tmp_path / "assets/media/s01_sh003_v2.mp4").exists()


def test_redo_task_identical_content_reuses_shot_version(tmp_path) -> None:
    # a redo task whose content is byte-identical to the shot's existing
    # asset reuses that version (idempotent cross-task import).
    task1 = _task()
    _stage(tmp_path, task1, data=b"same-bytes")
    _run(tmp_path, probe=_good_probe(), task=task1)

    task2 = GenerationTask(
        task_id="task-shot-1-2",
        shot_id="shot-1",
        status=GenerationTaskStatus.DONE,
        created_at=T0,
        updated_at=T0,
        completed_at=T0,
        provider_id="manual",
    )
    _stage(tmp_path, task2, data=b"same-bytes")
    redo = _run(tmp_path, probe=_good_probe(), task=task2)
    assert redo.registered_asset.version == 1  # reused shot version


def test_media_drift_is_not_silent_noop(tmp_path) -> None:
    from ai_video_workflow.assets.registration import AssetConflictError

    task = _task()
    _stage(tmp_path, task)
    _run(tmp_path, probe=_good_probe(), task=task)
    # the published media drifts on disk while the manifest still claims done
    (tmp_path / "assets/media/s01_sh003_v1.mp4").write_bytes(b"corrupted-drift")
    with pytest.raises(AssetConflictError):
        _run(tmp_path, probe=_good_probe(), task=task)


def test_record_manual_quality_rating(tmp_path) -> None:
    event_id = record_manual_quality_rating(
        tmp_path,
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        rating_id="rate-1",
        score=4,
        asset_id="asset-task-shot-1-1-v1",
        occurred_at=T0,
        note="looks good",
    )
    assert event_id == "manual_quality_rating_recorded:shot-1:rate-1"
    events = read_events(tmp_path)
    assert len(events) == 1
    assert events[0].payload["score"] == 4
