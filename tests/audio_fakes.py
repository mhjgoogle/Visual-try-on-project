"""Shared test doubles + deterministic placeholder generators for TASK-008.

The production contract is user-provided audio/subtitle files; tests never need a
real recording. These helpers synthesize DETERMINISTIC, structurally valid WAV and
SRT bytes (no clock, no randomness, no external tool, zero cost) so the mix/subtitle
argv and the end-to-end mux path can be exercised with a fake composer, and a
separate skipif smoke exercises real ffmpeg.
"""

from __future__ import annotations

import struct
from pathlib import Path

from ai_video_workflow.composition.audiovisual import AudioVisualComposer, MuxPlan


def make_wav_bytes(*, samples: int = 8000, sample_rate: int = 8000) -> bytes:
    """A valid 8-bit PCM mono WAV of ``samples`` bytes (duration samples/rate)."""
    if samples <= 0:
        raise ValueError("samples must be > 0")
    body = bytes((i * 7 + 3) & 0xFF for i in range(samples))
    return (
        b"RIFF"
        + struct.pack("<I", 36 + len(body))
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate, 1, 8)
        + b"data"
        + struct.pack("<I", len(body))
        + body
    )


def write_wav(path: Path, *, samples: int = 8000, sample_rate: int = 8000) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(make_wav_bytes(samples=samples, sample_rate=sample_rate))
    return path


def make_srt_bytes(cues: int = 2, *, bom: bool = False) -> bytes:
    """A valid SRT with ``cues`` sequential, non-overlapping cues."""
    blocks = []
    for i in range(1, cues + 1):
        start = (i - 1) * 2
        end = start + 1
        blocks.append(f"{i}\n00:00:{start:02d},000 --> 00:00:{end:02d},000\nLine {i}\n")
    text = "\n".join(blocks)
    raw = text.encode("utf-8")
    return (b"\xef\xbb\xbf" + raw) if bom else raw


def write_srt(path: Path, *, cues: int = 2) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(make_srt_bytes(cues))
    return path


class FakeAudioVisualComposer(AudioVisualComposer):
    """Mux by writing deterministic bytes; records the plan (no ffmpeg)."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error
        self.calls: list[tuple[MuxPlan, Path]] = []

    def mux(self, plan: MuxPlan, output: Path) -> None:
        self.calls.append((plan, output))
        if self._error is not None:
            raise self._error
        output.parent.mkdir(parents=True, exist_ok=True)
        payload = b"muxed:" + plan.base_video.read_bytes()
        for audio in plan.audio_inputs:
            payload += b"|a:" + audio.path.read_bytes()
        if plan.subtitle is not None:
            payload += b"|s:" + plan.subtitle.read_bytes()
        output.write_bytes(payload)
