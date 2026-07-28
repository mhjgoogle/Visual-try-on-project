"""Tests for the VideoComposer abstraction and the ffmpeg adapter."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from ai_video_workflow.composition.composer import VideoComposer
from ai_video_workflow.composition.errors import CompositionToolError
from ai_video_workflow.composition.ffmpeg import FfmpegVideoComposer
from ai_video_workflow.composition.profile import CompositionProfile
from ai_video_workflow.inspection.errors import MediaToolNotAvailableError
from tests.media_fakes import FakeVideoComposer

PROFILE = CompositionProfile(width=1280, height=720, frame_rate=24.0)


class _FakeCompleted:
    def __init__(self, returncode: int, stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = ""
        self.stderr = stderr


def test_abstract_composer_cannot_instantiate() -> None:
    with pytest.raises(TypeError):
        VideoComposer()  # type: ignore[abstract]


def test_normalize_argv_is_deterministic(monkeypatch, tmp_path) -> None:
    captured = {}

    def _run(argv, **kwargs):
        assert kwargs["shell"] is False
        captured["argv"] = argv
        return _FakeCompleted(0)

    monkeypatch.setattr(subprocess, "run", _run)
    FfmpegVideoComposer().normalize(tmp_path / "in.mp4", tmp_path / "out.mp4", PROFILE)
    argv = captured["argv"]
    assert argv[0] == "ffmpeg"
    assert "-c:v" in argv and "libx264" in argv
    assert "-pix_fmt" in argv and "yuv420p" in argv
    assert "-s" in argv and "1280x720" in argv
    assert "-r" in argv and "24" in argv
    assert "-c:a" in argv and "aac" in argv
    assert argv[-1] == str(tmp_path / "out.mp4")


def test_normalize_no_audio_uses_an(monkeypatch, tmp_path) -> None:
    captured = {}

    def _run(argv, **kwargs):
        captured["argv"] = argv
        return _FakeCompleted(0)

    monkeypatch.setattr(subprocess, "run", _run)
    profile = CompositionProfile(
        width=640, height=480, frame_rate=30.0, audio_codec=None
    )
    FfmpegVideoComposer().normalize(tmp_path / "in.mp4", tmp_path / "out.mp4", profile)
    assert "-an" in captured["argv"]
    assert "-c:a" not in captured["argv"]


def test_concatenate_writes_list_and_argv(monkeypatch, tmp_path) -> None:
    captured = {}
    list_contents = {}

    def _run(argv, **kwargs):
        captured["argv"] = argv
        # the concat list file is the argument after -i
        list_path = Path(argv[argv.index("-i") + 1])
        list_contents["text"] = list_path.read_text(encoding="utf-8")
        return _FakeCompleted(0)

    monkeypatch.setattr(subprocess, "run", _run)
    (tmp_path / "a.mp4").write_bytes(b"a")
    (tmp_path / "b.mp4").write_bytes(b"b")
    FfmpegVideoComposer().concatenate(
        (tmp_path / "a.mp4", tmp_path / "b.mp4"), tmp_path / "final.mp4"
    )
    argv = captured["argv"]
    assert argv[:5] == ["ffmpeg", "-y", "-nostdin", "-f", "concat"]
    assert "-safe" in argv and "-c" in argv
    assert "a.mp4'" in list_contents["text"]
    assert "b.mp4'" in list_contents["text"]


def test_concat_cleans_up_list_file(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(subprocess, "run", lambda argv, **k: _FakeCompleted(0))
    (tmp_path / "a.mp4").write_bytes(b"a")
    FfmpegVideoComposer().concatenate((tmp_path / "a.mp4",), tmp_path / "final.mp4")
    leftovers = list(tmp_path.glob(".concat.*"))
    assert leftovers == []


def test_ffmpeg_missing_tool(monkeypatch, tmp_path) -> None:
    def _run(argv, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(subprocess, "run", _run)
    with pytest.raises(MediaToolNotAvailableError):
        FfmpegVideoComposer().normalize(
            tmp_path / "in.mp4", tmp_path / "out.mp4", PROFILE
        )


def test_ffmpeg_non_zero_exit(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        subprocess, "run", lambda argv, **k: _FakeCompleted(1, stderr="boom")
    )
    with pytest.raises(CompositionToolError):
        FfmpegVideoComposer().normalize(
            tmp_path / "in.mp4", tmp_path / "out.mp4", PROFILE
        )


def test_ffmpeg_timeout(monkeypatch, tmp_path) -> None:
    def _run(argv, **kwargs):
        raise subprocess.TimeoutExpired("ffmpeg", 600.0)

    monkeypatch.setattr(subprocess, "run", _run)
    with pytest.raises(CompositionToolError):
        FfmpegVideoComposer().normalize(
            tmp_path / "in.mp4", tmp_path / "out.mp4", PROFILE
        )


def test_fake_composer_copies_and_concats(tmp_path) -> None:
    composer = FakeVideoComposer()
    (tmp_path / "a.mp4").write_bytes(b"aaa")
    composer.normalize(tmp_path / "a.mp4", tmp_path / "na.mp4", PROFILE)
    assert (tmp_path / "na.mp4").read_bytes() == b"normalized:aaa"
    composer.concatenate((tmp_path / "na.mp4",), tmp_path / "final.mp4")
    assert (tmp_path / "final.mp4").read_bytes().startswith(b"concat|")
    assert composer.normalize_calls and composer.concatenate_calls
