"""Integration tests for the resumable composition step (TASK-006)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.composition.errors import CompositionConflictError
from ai_video_workflow.composition.intent import intent_path
from ai_video_workflow.composition.step import (
    composition_manifest_path,
    run_composition_step,
)
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.persistence import read_model_json
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.log import read_events
from tests.media_fakes import FakeVideoComposer

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def _build(project_root: Path, *, shots=2) -> ProjectData:
    scenes = (
        Scene(
            scene_id="scene-1",
            project_id="proj-1",
            sequence=1,
            title="S1",
            description="d",
            created_at=T0,
        ),
    )
    shot_models = []
    asset_models = []
    task_models = []
    for i in range(shots):
        shot_id = f"shot-{i + 1}"
        shot_models.append(
            Shot(
                shot_id=shot_id,
                scene_id="scene-1",
                sequence=i + 1,
                description="d",
                prompt="p",
                duration_seconds=4.0,
                width=1280,
                height=720,
                frame_rate=24.0,
                created_at=T0,
            )
        )
        task_id = f"task-{shot_id}-1"
        media_rel = f"assets/media/s01_sh00{i + 1}_v1.mp4"
        (project_root / media_rel).parent.mkdir(parents=True, exist_ok=True)
        (project_root / media_rel).write_bytes(f"media-{shot_id}".encode())
        asset_models.append(
            VideoAsset(
                asset_id=f"asset-{task_id}-v1",
                shot_id=shot_id,
                source_task_id=task_id,
                path=Path(media_rel),
                container_format="mp4",
                duration_seconds=4.0,
                width=1280,
                height=720,
                frame_rate=24.0,
                version=1,
                validated_at=T0,
            )
        )
        task_models.append(
            GenerationTask(
                task_id=task_id,
                shot_id=shot_id,
                status=GenerationTaskStatus.DONE,
                created_at=T0,
                updated_at=T0,
                completed_at=T0,
            )
        )
    return ProjectData(
        project=Project(project_id="proj-1", name="Demo", created_at=T0),
        scenes=scenes,
        shots=tuple(shot_models),
        generation_tasks=tuple(task_models),
        video_assets=tuple(asset_models),
    )


def _run(project_root, data, composer=None):
    return run_composition_step(
        project_root=project_root,
        data=data,
        composer=composer or FakeVideoComposer(),
        profile=None,
        observed_at=T0,
    )


def test_success_end_to_end(tmp_path) -> None:
    data = _build(tmp_path)
    outcome = _run(tmp_path, data)
    assert outcome.skipped is False
    assert outcome.version == 1
    assert outcome.output_path == "outputs/final_v1.mp4"
    assert (tmp_path / "outputs/final_v1.mp4").exists()
    assert (tmp_path / "reports/composition/final_v1.json").exists()
    assert (tmp_path / "reports/composition/final_v1.md").exists()
    manifest = read_model_json(
        composition_manifest_path(tmp_path, "proj-1"), StepManifest
    )
    assert manifest.status is ManifestStatus.COMPLETED
    assert set(manifest.output_paths) == {
        "outputs/final_v1.mp4",
        "reports/composition/final_v1.json",
        "reports/composition/final_v1.md",
    }
    events = read_events(tmp_path)
    assert [e.event_type.value for e in events] == ["composition_completed"]
    assert events[0].payload["entry_count"] == 2
    # the intent was cleaned up on success (step 10)
    assert not intent_path(tmp_path, "proj-1", 1).exists()


def test_rerun_is_noop(tmp_path) -> None:
    data = _build(tmp_path)
    _run(tmp_path, data)
    second = _run(tmp_path, data)
    assert second.skipped is True
    assert len(read_events(tmp_path)) == 1  # no new event


def test_recovery_a_missing_report_completes_without_recompose(tmp_path) -> None:
    data = _build(tmp_path)
    _run(tmp_path, data)
    # simulate a crash after the MP4 was published but before the reports:
    # remove the reports and manifest, and re-create the intent.
    (tmp_path / "reports/composition/final_v1.json").unlink()
    (tmp_path / "reports/composition/final_v1.md").unlink()
    composition_manifest_path(tmp_path, "proj-1").unlink()
    # re-write the intent that step 2 would have durably left
    from ai_video_workflow.composition.intent import (
        CompositionPublishIntent,
        write_intent,
    )

    # rebuild the intent identity from a fresh planning pass
    from ai_video_workflow.composition.plan import build_composition_plan
    from ai_video_workflow.composition.profile import profile_digest
    from ai_video_workflow.composition.step import _input_digest

    plan = build_composition_plan(data=data)
    write_intent(
        tmp_path,
        CompositionPublishIntent(
            project_id="proj-1",
            logical_version=1,
            input_digest=_input_digest(tmp_path, plan),
            profile_digest=profile_digest(plan.profile),
            media_path="outputs/final_v1.mp4",
            json_report_path="reports/composition/final_v1.json",
            markdown_report_path="reports/composition/final_v1.md",
        ),
    )
    composer = FakeVideoComposer()
    recovered = run_composition_step(
        project_root=tmp_path,
        data=data,
        composer=composer,
        profile=None,
        observed_at=T0,
    )
    assert recovered.skipped is False
    assert composer.concatenate_calls == []  # no re-compose (A)
    assert (tmp_path / "reports/composition/final_v1.json").exists()


def test_recovery_c_stray_media_without_intent_conflicts(tmp_path) -> None:
    data = _build(tmp_path)
    # a stray final MP4 with no intent and no completed manifest
    (tmp_path / "outputs").mkdir(parents=True, exist_ok=True)
    (tmp_path / "outputs/final_v1.mp4").write_bytes(b"stray")
    with pytest.raises(CompositionConflictError):
        _run(tmp_path, data)


def test_recovery_f_report_without_media_conflicts(tmp_path) -> None:
    data = _build(tmp_path)
    (tmp_path / "reports/composition").mkdir(parents=True, exist_ok=True)
    (tmp_path / "reports/composition/final_v1.json").write_text("{}", encoding="utf-8")
    with pytest.raises(CompositionConflictError):
        _run(tmp_path, data)


def test_new_version_on_asset_change(tmp_path) -> None:
    data = _build(tmp_path)
    _run(tmp_path, data)
    # a shot's media content changes (re-registered) -> new input digest
    (tmp_path / "assets/media/s01_sh001_v1.mp4").write_bytes(b"different-content")
    second = _run(tmp_path, data)
    assert second.version == 2
    assert (tmp_path / "outputs/final_v1.mp4").exists()
    assert (tmp_path / "outputs/final_v2.mp4").exists()


def test_recovery_partial_report_completes_at_later_time(tmp_path) -> None:
    # crash between the JSON and Markdown report writes; re-run one hour
    # later. The JSON report's observed_at must be reused so the bytes
    # match (ADR-0005) rather than raising a spurious conflict.
    from datetime import timedelta

    data = _build(tmp_path)
    _run(tmp_path, data)
    (tmp_path / "reports/composition/final_v1.md").unlink()
    composition_manifest_path(tmp_path, "proj-1").unlink()
    from ai_video_workflow.composition.intent import (
        CompositionPublishIntent,
        write_intent,
    )
    from ai_video_workflow.composition.plan import build_composition_plan
    from ai_video_workflow.composition.profile import profile_digest
    from ai_video_workflow.composition.step import _input_digest

    plan = build_composition_plan(data=data)
    write_intent(
        tmp_path,
        CompositionPublishIntent(
            project_id="proj-1",
            logical_version=1,
            input_digest=_input_digest(tmp_path, plan),
            profile_digest=profile_digest(plan.profile),
            media_path="outputs/final_v1.mp4",
            json_report_path="reports/composition/final_v1.json",
            markdown_report_path="reports/composition/final_v1.md",
        ),
    )
    later = run_composition_step(
        project_root=tmp_path,
        data=data,
        composer=FakeVideoComposer(),
        profile=None,
        observed_at=T0 + timedelta(hours=1),
    )
    assert later.skipped is False
    assert (tmp_path / "reports/composition/final_v1.md").exists()


def test_recovery_e_noop_removes_stale_intent(tmp_path) -> None:
    data = _build(tmp_path)
    _run(tmp_path, data)
    # a stale intent reappears after the completed manifest
    from ai_video_workflow.composition.intent import (
        CompositionPublishIntent,
        write_intent,
    )
    from ai_video_workflow.composition.plan import build_composition_plan
    from ai_video_workflow.composition.profile import profile_digest
    from ai_video_workflow.composition.step import _input_digest

    plan = build_composition_plan(data=data)
    write_intent(
        tmp_path,
        CompositionPublishIntent(
            project_id="proj-1",
            logical_version=1,
            input_digest=_input_digest(tmp_path, plan),
            profile_digest=profile_digest(plan.profile),
            media_path="outputs/final_v1.mp4",
            json_report_path="reports/composition/final_v1.json",
            markdown_report_path="reports/composition/final_v1.md",
        ),
    )
    assert intent_path(tmp_path, "proj-1", 1).exists()
    second = _run(tmp_path, data)
    assert second.skipped is True
    assert not intent_path(tmp_path, "proj-1", 1).exists()  # E cleanup on no-op


def test_failed_compose_records_failed_manifest(tmp_path) -> None:
    from ai_video_workflow.composition.errors import CompositionToolError

    data = _build(tmp_path)

    class _FailingComposer(FakeVideoComposer):
        def normalize(self, source, target, profile):
            raise CompositionToolError("ffmpeg boom")

    with pytest.raises(CompositionToolError):
        _run(tmp_path, data, composer=_FailingComposer())
    manifest = read_model_json(
        composition_manifest_path(tmp_path, "proj-1"), StepManifest
    )
    assert manifest.status is ManifestStatus.FAILED
    assert not (tmp_path / "outputs/final_v1.mp4").exists()


def test_intent_written_before_media(tmp_path) -> None:
    data = _build(tmp_path)

    class _RecordingComposer(FakeVideoComposer):
        def __init__(self, root):
            super().__init__()
            self._root = root
            self.intent_present_at_concat = None

        def concatenate(self, sources, target):
            self.intent_present_at_concat = intent_path(
                self._root, "proj-1", 1
            ).exists()
            super().concatenate(sources, target)

    composer = _RecordingComposer(tmp_path)
    _run(tmp_path, data, composer=composer)
    assert composer.intent_present_at_concat is True
