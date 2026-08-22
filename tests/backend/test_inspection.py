"""Tests for the MediaInspector abstraction and the ffprobe adapter."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from ai_video_workflow.errors import InvariantViolationError
from ai_video_workflow.inspection import (
    FfprobeMediaInspector,
    MediaInspector,
    MediaProbeParseError,
    MediaProbeResult,
    MediaToolNotAvailableError,
    UndecodableMediaError,
)
from tests.media_fakes import FakeMediaInspector

_GOOD_JSON = json.dumps(
    {
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "4.000000"},
        "streams": [
            {
                "codec_type": "video",
                "width": 1280,
                "height": 720,
                "r_frame_rate": "24/1",
            }
        ],
    }
)


class _FakeCompleted:
    def __init__(self, returncode: int, stdout: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


def _patch_run(monkeypatch, *, returncode=0, stdout=_GOOD_JSON, raises=None):
    def _run(argv, **kwargs):
        assert kwargs["shell"] is False
        assert argv[0] == "ffprobe"
        if raises is not None:
            raise raises
        return _FakeCompleted(returncode, stdout)

    monkeypatch.setattr(subprocess, "run", _run)


def test_media_probe_result_rejects_bad_values() -> None:
    with pytest.raises(InvariantViolationError):
        MediaProbeResult(
            container_format="mp4",
            duration_seconds=0.0,
            width=1280,
            height=720,
            frame_rate=24.0,
        )


def test_abstract_inspector_cannot_instantiate() -> None:
    with pytest.raises(TypeError):
        MediaInspector()  # type: ignore[abstract]


def test_fake_inspector_returns_and_records(tmp_path) -> None:
    result = MediaProbeResult("mp4", 4.0, 1280, 720, 24.0)
    fake = FakeMediaInspector(result=result)
    assert fake.probe(tmp_path / "a.mp4") is result
    assert fake.calls == [tmp_path / "a.mp4"]


def test_fake_inspector_raises(tmp_path) -> None:
    fake = FakeMediaInspector(error=UndecodableMediaError("bad"))
    with pytest.raises(UndecodableMediaError):
        fake.probe(tmp_path / "a.mp4")


def test_ffprobe_parses_good_output(monkeypatch, tmp_path) -> None:
    _patch_run(monkeypatch)
    result = FfprobeMediaInspector().probe(tmp_path / "clip.mp4")
    assert result.container_format == "mov,mp4,m4a,3gp,3g2,mj2"
    assert result.width == 1280 and result.height == 720
    assert result.duration_seconds == 4.0
    assert result.frame_rate == 24.0


def test_ffprobe_fractional_frame_rate(monkeypatch, tmp_path) -> None:
    payload = json.dumps(
        {
            "format": {"format_name": "mp4", "duration": "1.0"},
            "streams": [
                {
                    "codec_type": "video",
                    "width": 640,
                    "height": 480,
                    "r_frame_rate": "30000/1001",
                }
            ],
        }
    )
    _patch_run(monkeypatch, stdout=payload)
    result = FfprobeMediaInspector().probe(tmp_path / "clip.mp4")
    assert abs(result.frame_rate - 29.97) < 0.01


def test_ffprobe_tool_missing(monkeypatch, tmp_path) -> None:
    _patch_run(monkeypatch, raises=FileNotFoundError())
    with pytest.raises(MediaToolNotAvailableError):
        FfprobeMediaInspector().probe(tmp_path / "clip.mp4")


def test_ffprobe_timeout(monkeypatch, tmp_path) -> None:
    _patch_run(monkeypatch, raises=subprocess.TimeoutExpired("ffprobe", 30.0))
    with pytest.raises(UndecodableMediaError):
        FfprobeMediaInspector().probe(tmp_path / "clip.mp4")


def test_ffprobe_non_zero_exit(monkeypatch, tmp_path) -> None:
    _patch_run(monkeypatch, returncode=1, stdout="")
    with pytest.raises(UndecodableMediaError):
        FfprobeMediaInspector().probe(tmp_path / "clip.mp4")


def test_ffprobe_invalid_json(monkeypatch, tmp_path) -> None:
    _patch_run(monkeypatch, stdout="not json")
    with pytest.raises(MediaProbeParseError):
        FfprobeMediaInspector().probe(tmp_path / "clip.mp4")


def test_ffprobe_missing_video_stream(monkeypatch, tmp_path) -> None:
    payload = json.dumps(
        {"format": {"format_name": "mp4", "duration": "1.0"}, "streams": []}
    )
    _patch_run(monkeypatch, stdout=payload)
    with pytest.raises(MediaProbeParseError):
        FfprobeMediaInspector().probe(tmp_path / "clip.mp4")


def test_ffprobe_missing_fields(monkeypatch, tmp_path) -> None:
    payload = json.dumps(
        {
            "format": {"format_name": "mp4", "duration": "1.0"},
            "streams": [{"codec_type": "video", "width": 1280}],
        }
    )
    _patch_run(monkeypatch, stdout=payload)
    with pytest.raises(MediaProbeParseError):
        FfprobeMediaInspector().probe(tmp_path / "clip.mp4")


@pytest.mark.skipif(
    not Path("/usr/bin/ffprobe").exists()
    and not Path("/usr/local/bin/ffprobe").exists(),
    reason="ffprobe not installed",
)
def test_ffprobe_smoke_is_import_safe() -> None:
    # opt-in smoke placeholder: constructing the real inspector is side-effect
    # free; a genuine media probe belongs to the optional real-tools E2E.
    assert isinstance(FfprobeMediaInspector(), MediaInspector)
