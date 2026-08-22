"""Real-ffmpeg smoke for the audio-visual mux step (TASK-008).

Skipped unless AI_VIDEO_WORKFLOW_REAL_TOOLS=1 and ffmpeg + ffprobe are installed.
It generates its OWN inputs with ffmpeg (a testsrc video with a silent audio
track) plus a deterministic voice-over WAV and an SRT, then mounts a soft
subtitle and mixes the voice-over — end to end, zero cost, no paid API.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.audio.registration import (
    register_subtitle_asset,
    register_voiceover_asset,
)
from ai_video_workflow.composition.audiovisual import FfmpegAudioVisualComposer
from ai_video_workflow.composition.av_profile import (
    SUBTITLE_MODE_SOFT,
    AudioTrackMix,
    AudioVisualProfile,
    SubtitleSpec,
)
from ai_video_workflow.composition.av_step import run_audiovisual_step
from ai_video_workflow.inspection.ffprobe import FfprobeMediaInspector
from tests.audio_fakes import write_srt, write_wav

_REAL_TOOLS = (
    os.environ.get("AI_VIDEO_WORKFLOW_REAL_TOOLS") == "1"
    and shutil.which("ffmpeg") is not None
    and shutil.which("ffprobe") is not None
)

T0 = datetime(2026, 8, 4, 8, 0, 0, tzinfo=timezone.utc)


@pytest.mark.skipif(
    not _REAL_TOOLS,
    reason="real-tools smoke: set AI_VIDEO_WORKFLOW_REAL_TOOLS=1 with ffmpeg+ffprobe",
)
def test_av_mux_real_ffmpeg_soft_subtitle(tmp_path) -> None:
    root = tmp_path / "project"
    (root / "outputs").mkdir(parents=True, exist_ok=True)
    base = root / "outputs" / "final_v1.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x240:rate=24",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-shortest",
            "-pix_fmt",
            "yuv420p",
            str(base),
        ],
        check=True,
        capture_output=True,
    )
    write_wav(root / "audio" / "vo.wav", samples=44100, sample_rate=44100)
    write_srt(root / "subs" / "en.srt", cues=2)
    register_voiceover_asset(root, ref="narration", media_relpath="audio/vo.wav")
    register_subtitle_asset(root, ref="en", media_relpath="subs/en.srt")
    profile = AudioVisualProfile(
        tracks=(AudioTrackMix(role="voiceover", ref="narration", version=1),),
        subtitles=SubtitleSpec(ref="en", version=1, mode=SUBTITLE_MODE_SOFT),
        original_audio_gain_db=-6.0,
    )
    outcome = run_audiovisual_step(
        project_root=root,
        project_id="proj-1",
        base_video_relpath="outputs/final_v1.mp4",
        profile=profile,
        composer=FfmpegAudioVisualComposer(),
        inspector=FfprobeMediaInspector(),
        observed_at=T0,
        base_has_audio=True,  # base was built with an anullsrc audio track
    )
    final = root / "outputs" / "final_av_v1.mp4"
    assert final.exists() and final.stat().st_size > 0
    assert outcome.version == 1
    assert Path(outcome.output_path) == Path("outputs/final_av_v1.mp4")
