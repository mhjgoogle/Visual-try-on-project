"""Integration tests for the resumable audio-visual mux step (TASK-008)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.audio.errors import AudioValidationError
from ai_video_workflow.audio.inspect import AudioProbeResult
from ai_video_workflow.audio.registration import (
    register_subtitle_asset,
    register_voiceover_asset,
)
from ai_video_workflow.composition.av_profile import (
    SUBTITLE_MODE_SOFT,
    AudioTrackMix,
    AudioVisualProfile,
    SubtitleSpec,
)
from ai_video_workflow.composition.av_step import (
    audiovisual_manifest_path,
    detect_base_audio,
    run_audiovisual_step,
)
from ai_video_workflow.composition.errors import (
    CompositionConflictError,
    CompositionError,
    CompositionToolError,
)
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.inspection.errors import MediaInspectionError
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
from ai_video_workflow.qcd.aggregation import aggregate_events
from ai_video_workflow.qcd.events import (
    build_audiovisual_completed_event,
    build_composition_completed_event,
)
from ai_video_workflow.qcd.log import read_events
from tests.audio_fakes import FakeAudioVisualComposer, write_srt, write_wav
from tests.media_fakes import FakeMediaInspector

T0 = datetime(2026, 8, 4, 8, 0, 0, tzinfo=timezone.utc)
PROJECT = "proj-1"


def _inspector() -> FakeMediaInspector:
    return FakeMediaInspector(result=MediaProbeResult("mp4", 8.0, 1280, 720, 24.0))


def _seed(project_root: Path) -> tuple[str, AudioVisualProfile]:
    (project_root / "outputs").mkdir(parents=True, exist_ok=True)
    (project_root / "outputs" / "final_v1.mp4").write_bytes(b"m1-video-master")
    write_wav(project_root / "audio" / "vo.wav", samples=8000)
    write_srt(project_root / "subs" / "en.srt", cues=2)
    register_voiceover_asset(
        project_root, ref="narration", media_relpath="audio/vo.wav"
    )
    register_subtitle_asset(project_root, ref="en", media_relpath="subs/en.srt")
    profile = AudioVisualProfile(
        tracks=(
            AudioTrackMix(role="voiceover", ref="narration", version=1, gain_db=0.0),
        ),
        subtitles=SubtitleSpec(ref="en", version=1, mode=SUBTITLE_MODE_SOFT),
        original_audio_gain_db=-6.0,
    )
    return "outputs/final_v1.mp4", profile


def _run(
    project_root, base_rel, profile, composer=None, inspector=None, base_has_audio=True
):
    return run_audiovisual_step(
        project_root=project_root,
        project_id=PROJECT,
        base_video_relpath=base_rel,
        profile=profile,
        composer=composer or FakeAudioVisualComposer(),
        inspector=inspector or _inspector(),
        observed_at=T0,
        base_has_audio=base_has_audio,
    )


def test_first_run_publishes_av_master_report_manifest_event(tmp_path) -> None:
    base_rel, profile = _seed(tmp_path)
    outcome = _run(tmp_path, base_rel, profile)
    assert outcome.skipped is False
    assert outcome.version == 1
    final = tmp_path / "outputs" / "final_av_v1.mp4"
    assert final.exists()
    # the final is an INDEPENDENT file (streamed copy), not a hard-link alias of
    # the mutable staging file: they must not share an inode.
    staged = tmp_path / "staging" / "audiovisual" / "v1" / "_final_av.mp4"
    if staged.exists():
        assert final.stat().st_ino != staged.stat().st_ino
    assert (tmp_path / "reports" / "audiovisual" / "final_av_v1.json").exists()
    assert (tmp_path / "reports" / "audiovisual" / "final_av_v1.md").exists()
    manifest = read_model_json(
        audiovisual_manifest_path(tmp_path, PROJECT), StepManifest
    )
    assert manifest.status is ManifestStatus.COMPLETED
    # intent cleaned up after commit
    assert not (
        tmp_path / "records" / "step-intents" / "audiovisual" / PROJECT / "1.json"
    ).exists()
    events = read_events(tmp_path)
    av = [e for e in events if e.event_id == "audiovisual_completed:proj-1:v1"]
    assert len(av) == 1
    assert av[0].event_type.value == "audiovisual_completed"
    assert av[0].payload["audio_track_count"] == 1
    assert av[0].payload["subtitle"]["ref"] == "en"


def test_rerun_same_inputs_is_noop(tmp_path) -> None:
    base_rel, profile = _seed(tmp_path)
    _run(tmp_path, base_rel, profile)
    second = _run(tmp_path, base_rel, profile)
    assert second.skipped is True
    assert second.version == 1


def test_changed_profile_bumps_version(tmp_path) -> None:
    base_rel, profile = _seed(tmp_path)
    _run(tmp_path, base_rel, profile)
    changed = AudioVisualProfile(
        tracks=profile.tracks,
        subtitles=profile.subtitles,
        original_audio_gain_db=-3.0,  # different gain -> different recipe
    )
    second = _run(tmp_path, base_rel, changed)
    assert second.skipped is False
    assert second.version == 2
    assert (tmp_path / "outputs" / "final_av_v2.mp4").exists()
    assert (tmp_path / "outputs" / "final_av_v1.mp4").exists()  # v1 retained


def test_tool_error_records_failed_manifest_and_no_output(tmp_path) -> None:
    base_rel, profile = _seed(tmp_path)
    composer = FakeAudioVisualComposer(error=CompositionToolError("boom"))
    with pytest.raises(CompositionToolError):
        _run(tmp_path, base_rel, profile, composer=composer)
    assert not (tmp_path / "outputs" / "final_av_v1.mp4").exists()
    manifest = read_model_json(
        audiovisual_manifest_path(tmp_path, PROJECT), StepManifest
    )
    assert manifest.status is ManifestStatus.FAILED


def test_missing_tool_records_failed_manifest(tmp_path) -> None:
    from ai_video_workflow.inspection.errors import MediaToolNotAvailableError

    base_rel, profile = _seed(tmp_path)
    composer = FakeAudioVisualComposer(
        error=MediaToolNotAvailableError("ffmpeg is not available")
    )
    with pytest.raises(MediaToolNotAvailableError):
        _run(tmp_path, base_rel, profile, composer=composer)
    manifest = read_model_json(
        audiovisual_manifest_path(tmp_path, PROJECT), StepManifest
    )
    assert manifest.status is ManifestStatus.FAILED


def test_undecodable_output_is_not_published(tmp_path) -> None:
    base_rel, profile = _seed(tmp_path)
    bad_inspector = FakeMediaInspector(error=MediaInspectionError("undecodable"))
    with pytest.raises(CompositionToolError):
        _run(tmp_path, base_rel, profile, inspector=bad_inspector)
    assert not (tmp_path / "outputs" / "final_av_v1.mp4").exists()
    manifest = read_model_json(
        audiovisual_manifest_path(tmp_path, PROJECT), StepManifest
    )
    assert manifest.status is ManifestStatus.FAILED


def test_published_media_without_intent_is_conflict(tmp_path) -> None:
    base_rel, profile = _seed(tmp_path)
    # a stray media file with no matching intent/manifest -> conflict
    (tmp_path / "outputs" / "final_av_v1.mp4").write_bytes(b"stray")
    with pytest.raises(CompositionConflictError):
        _run(tmp_path, base_rel, profile)


def test_missing_base_video_is_rejected(tmp_path) -> None:
    _base_rel, profile = _seed(tmp_path)
    with pytest.raises(CompositionError):
        _run(tmp_path, "outputs/does_not_exist.mp4", profile)


class _StubAudioInspector:
    def __init__(self, *, result=None, error=None):
        self._result = result
        self._error = error

    def probe(self, path):
        if self._error is not None:
            raise self._error
        return self._result


def test_detect_base_audio_true_and_false(tmp_path) -> None:
    ok = _StubAudioInspector(
        result=AudioProbeResult(
            codec="aac", duration_seconds=2.0, channels=2, sample_rate=44100
        )
    )
    assert detect_base_audio(ok, tmp_path / "x.mp4") is True
    silent = _StubAudioInspector(error=AudioValidationError("no audio stream"))
    assert detect_base_audio(silent, tmp_path / "x.mp4") is False


def test_silent_base_step_produces_av_master(tmp_path) -> None:
    base_rel, profile = _seed(tmp_path)
    outcome = _run(tmp_path, base_rel, profile, base_has_audio=False)
    assert outcome.skipped is False
    assert outcome.report["base_has_audio"] is False


def test_av_event_does_not_inflate_composition_count() -> None:
    project = Project(project_id=PROJECT, name="Demo", created_at=T0)
    scene = Scene(
        scene_id="scene-1",
        project_id=PROJECT,
        sequence=1,
        title="S1",
        description="d",
        created_at=T0,
    )
    shot = Shot(
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
    )
    task = GenerationTask(
        task_id="task-1",
        shot_id="shot-1",
        status=GenerationTaskStatus.DONE,
        created_at=T0,
        updated_at=T0,
        completed_at=T0,
    )
    asset = VideoAsset(
        asset_id="asset-1",
        shot_id="shot-1",
        source_task_id="task-1",
        path=Path("assets/media/s01_sh001_v1.mp4"),
        container_format="mp4",
        duration_seconds=4.0,
        width=1280,
        height=720,
        frame_rate=24.0,
        version=1,
        validated_at=T0,
    )
    data = ProjectData(
        project=project,
        scenes=(scene,),
        shots=(shot,),
        generation_tasks=(task,),
        video_assets=(asset,),
    )
    video_event = build_composition_completed_event(
        project_id=PROJECT,
        output_path="outputs/final_v1.mp4",
        output_version=1,
        output_sha256="a" * 64,
        input_asset_ids=("asset-1",),
        profile_digest="pd",
        occurred_at=T0,
        output_duration_ms=8000,
    )
    av_event = build_audiovisual_completed_event(
        project_id=PROJECT,
        output_path="outputs/final_av_v1.mp4",
        output_version=1,
        output_sha256="b" * 64,
        base_video_path="outputs/final_v1.mp4",
        base_video_sha256="a" * 64,
        audio_refs=(("voiceover", "narration", 1),),
        subtitle_ref=("en", 1, "soft"),
        profile_digest="pd2",
        occurred_at=T0,
        output_duration_ms=8000,
    )
    summary = aggregate_events((video_event, av_event), data)
    # the av event must NOT be counted as an M1 video composition
    assert summary.per_project.composition_count == 1
    assert summary.per_project.latest_output_version == 1
