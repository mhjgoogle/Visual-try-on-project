"""Deterministic mux argv construction tests (TASK-008)."""

from __future__ import annotations

from pathlib import Path

import pytest

from ai_video_workflow.composition.audiovisual import (
    SUBTITLE_MODE_NONE,
    MuxAudioInput,
    MuxPlan,
    build_mux_argv,
)
from ai_video_workflow.composition.av_profile import (
    SUBTITLE_MODE_BURN_IN,
    SUBTITLE_MODE_SOFT,
)
from ai_video_workflow.composition.errors import CompositionToolError


def _plan(**kw) -> MuxPlan:
    base = dict(
        base_video=Path("/p/final_v1.mp4"),
        audio_inputs=(),
        include_original_audio=True,
        original_audio_gain_db=0.0,
        subtitle=None,
        subtitle_mode=SUBTITLE_MODE_NONE,
        audio_codec="aac",
        audio_bitrate_kbps=192,
        subtitle_soft_codec="mov_text",
        video_codec_burn_in="libx264",
        base_has_audio=True,
        base_duration_seconds=8.0,
    )
    base.update(kw)
    return MuxPlan(**base)


def test_original_only_copies_video_and_reencodes_audio() -> None:
    argv = build_mux_argv("ffmpeg", _plan(), Path("/out.mp4"))
    assert argv[0] == "ffmpeg"
    assert "-c:v" in argv and argv[argv.index("-c:v") + 1] == "copy"
    assert "-c:a" in argv and argv[argv.index("-c:a") + 1] == "aac"
    assert "-b:a" in argv and "192k" in argv
    assert argv[-1] == "/out.mp4"


def test_voiceover_mix_uses_amix_and_volume() -> None:
    plan = _plan(
        audio_inputs=(
            MuxAudioInput(path=Path("/p/vo.wav"), gain_db=-3.0, role="voiceover"),
        ),
        original_audio_gain_db=-6.0,
    )
    argv = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    fc = argv[argv.index("-filter_complex") + 1]
    assert "volume=-6dB" in fc
    assert "volume=-3dB" in fc
    assert "amix=inputs=2" in fc
    # each audio stream is apad-padded and the output capped to the video length
    assert "apad" in fc
    assert "-t" in argv and argv[argv.index("-t") + 1] == "8"
    assert "-shortest" not in argv
    # two -i inputs: base + one audio
    assert argv.count("-i") == 2


def test_original_only_output_is_capped_to_video() -> None:
    # keeping only the original audio still bounds output to the video (-t)
    argv = build_mux_argv("ffmpeg", _plan(), Path("/out.mp4"))
    assert "-t" in argv and argv[argv.index("-t") + 1] == "8"
    assert "apad" in argv[argv.index("-filter_complex") + 1]


def test_silent_output_has_no_duration_cap() -> None:
    plan = _plan(
        base_has_audio=False,
        subtitle=Path("/p/subs.srt"),
        subtitle_mode=SUBTITLE_MODE_SOFT,
    )
    argv = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    # no audio -> video copy sets the length; no -t/-shortest so a short subtitle
    # cannot truncate the master
    assert "-t" not in argv
    assert "-shortest" not in argv
    assert "-an" in argv


def test_single_audio_no_original_skips_amix() -> None:
    plan = _plan(
        include_original_audio=False,
        audio_inputs=(
            MuxAudioInput(path=Path("/p/vo.wav"), gain_db=0.0, role="voiceover"),
        ),
    )
    argv = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    fc = argv[argv.index("-filter_complex") + 1]
    assert "amix" not in fc
    assert "[a1]" in fc


def test_soft_subtitle_adds_input_and_codec() -> None:
    plan = _plan(subtitle=Path("/p/subs.srt"), subtitle_mode=SUBTITLE_MODE_SOFT)
    argv = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    assert argv.count("-i") == 2  # base + subtitle
    assert "-c:s" in argv and argv[argv.index("-c:s") + 1] == "mov_text"
    # the subtitle stream is mapped from the last input (index 1 here): "1:s"
    map_values = [argv[i + 1] for i, tok in enumerate(argv) if tok == "-map"]
    assert any(v.endswith(":s") for v in map_values)


def test_burn_in_subtitle_filters_video_and_reencodes() -> None:
    plan = _plan(subtitle=Path("/p/subs.srt"), subtitle_mode=SUBTITLE_MODE_BURN_IN)
    argv = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    fc = argv[argv.index("-filter_complex") + 1]
    assert "subtitles=" in fc
    assert "[vout]" in fc
    # burn-in re-encodes video (not copy)
    assert argv[argv.index("-c:v") + 1] == "libx264"
    # burn-in is NOT muxed as a soft subtitle stream
    assert "-c:s" not in argv


def test_build_mux_argv_is_deterministic() -> None:
    plan = _plan(
        audio_inputs=(
            MuxAudioInput(path=Path("/p/vo.wav"), gain_db=-3.0, role="voiceover"),
            MuxAudioInput(path=Path("/p/sfx.wav"), gain_db=1.5, role="sfx"),
        ),
        subtitle=Path("/p/subs.srt"),
        subtitle_mode=SUBTITLE_MODE_SOFT,
    )
    a = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    b = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    assert a == b


def test_silent_base_with_original_requested_writes_no_audio() -> None:
    # a silent M1 master + subtitles-only: include_original_audio=True but the
    # base has no stream -> no [0:a], output has no audio (-an), ffmpeg not asked
    # to map a non-existent stream.
    plan = _plan(
        base_has_audio=False,
        subtitle=Path("/p/subs.srt"),
        subtitle_mode=SUBTITLE_MODE_SOFT,
    )
    argv = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    assert "-an" in argv
    assert "-c:a" not in argv
    assert "[0:a]" not in " ".join(argv)
    assert "-c:s" in argv  # subtitle still muxed


def test_silent_base_with_voiceover_uses_only_track() -> None:
    plan = _plan(
        base_has_audio=False,
        audio_inputs=(
            MuxAudioInput(path=Path("/p/vo.wav"), gain_db=0.0, role="voiceover"),
        ),
    )
    argv = build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
    fc = argv[argv.index("-filter_complex") + 1]
    assert "[0:a]" not in fc  # no original
    assert "[a1]" in fc
    assert "amix" not in fc
    assert "-c:a" in argv


def test_subtitle_path_with_newline_is_refused() -> None:
    plan = _plan(subtitle=Path("/p/bad\nname.srt"), subtitle_mode=SUBTITLE_MODE_BURN_IN)
    with pytest.raises(CompositionToolError):
        build_mux_argv("ffmpeg", plan, Path("/out.mp4"))
