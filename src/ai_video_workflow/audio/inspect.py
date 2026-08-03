"""Audio inspection for user-provided voice-over / sound-effect files (TASK-008).

The registration path depends only on the :class:`AudioInspector` abstraction,
never on ffprobe directly, so validation is fully testable offline (ADR-0002
tool-boundary discipline, mirrored from :mod:`inspection.base`).

Two implementations ship:

* :class:`WavStructuralInspector` — a pure-Python RIFF/WAVE header parser used by
  tests and offline runs. It decodes ``fmt``/``data`` chunks deterministically
  with no external tool, no clock and no network, and fails closed on any
  malformed structure. This is the default no-spend backend.
* :class:`FfprobeAudioInspector` — the real production probe (any container),
  invoked with a fixed argv and an explicit timeout. It is only exercised by the
  skipif ffmpeg smoke test.

Unlike the video :class:`~ai_video_workflow.inspection.base.MediaProbeResult`
(which requires width/height/frame_rate), an audio probe has no picture, so this
module keeps a separate, audio-shaped result rather than widening the frozen
video probe contract.
"""

from __future__ import annotations

import json
import math
import struct
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.audio.errors import AudioToolError, AudioValidationError

_FFPROBE_TIMEOUT_SECONDS = 60.0
_STDERR_LIMIT = 2000
_MAX_WAV_BYTES = 512 * 1024 * 1024  # defensive read cap for the structural parser


@dataclass(frozen=True, slots=True)
class AudioProbeResult:
    """Basic parameters observed for one audio file."""

    codec: str
    duration_seconds: float
    channels: int
    sample_rate: int

    def __post_init__(self) -> None:
        if not isinstance(self.codec, str) or not self.codec:
            raise AudioValidationError("codec: must be a non-empty string")
        if (
            not isinstance(self.duration_seconds, float)
            or not math.isfinite(self.duration_seconds)  # rejects NaN AND ±inf
            or self.duration_seconds <= 0.0
        ):
            raise AudioValidationError("duration_seconds: must be finite and > 0")
        if isinstance(self.channels, bool) or not isinstance(self.channels, int):
            raise AudioValidationError("channels: must be an int")
        if self.channels <= 0:
            raise AudioValidationError("channels: must be > 0")
        if isinstance(self.sample_rate, bool) or not isinstance(self.sample_rate, int):
            raise AudioValidationError("sample_rate: must be an int")
        if self.sample_rate <= 0:
            raise AudioValidationError("sample_rate: must be > 0")


class AudioInspector(ABC):
    """Abstract audio inspector: probe a file for basic parameters."""

    __slots__ = ()

    @abstractmethod
    def probe(self, path: Path) -> AudioProbeResult:
        """Return the observed parameters, or raise an AudioValidationError."""


class WavStructuralInspector(AudioInspector):
    """Parse a RIFF/WAVE file structurally, fully offline and deterministic."""

    __slots__ = ()

    def probe(self, path: Path) -> AudioProbeResult:
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise AudioValidationError(f"audio file is unreadable: {path}") from exc
        if size > _MAX_WAV_BYTES:
            raise AudioValidationError(f"audio file is implausibly large: {path}")
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise AudioValidationError(f"audio file is unreadable: {path}") from exc
        return _parse_wav(data)


class FfprobeAudioInspector(AudioInspector):
    """Probe any audio container with ffprobe (fixed argv, explicit timeout)."""

    __slots__ = ("_ffprobe_path", "_timeout_seconds")

    def __init__(
        self,
        *,
        ffprobe_path: str = "ffprobe",
        timeout_seconds: float = _FFPROBE_TIMEOUT_SECONDS,
    ) -> None:
        self._ffprobe_path = ffprobe_path
        self._timeout_seconds = timeout_seconds

    def probe(self, path: Path) -> AudioProbeResult:
        argv = [
            self._ffprobe_path,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,channels,sample_rate:format=duration",
            "-of",
            "json",
            str(path),
        ]
        try:
            completed = subprocess.run(  # noqa: S603 — fixed argv, no shell
                argv,
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds,
                check=False,
                shell=False,
            )
        except FileNotFoundError as exc:
            raise AudioToolError(
                f"ffprobe is not available: {self._ffprobe_path}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise AudioToolError(
                f"ffprobe timed out after {self._timeout_seconds}s for {path}"
            ) from exc
        if completed.returncode != 0:
            stderr = (completed.stderr or "")[:_STDERR_LIMIT]
            raise AudioToolError(
                f"ffprobe exited with {completed.returncode} for {path}: {stderr}"
            )
        try:
            parsed = json.loads(completed.stdout)
            stream = parsed["streams"][0]
            duration = float(parsed["format"]["duration"])
            return AudioProbeResult(
                codec=str(stream["codec_name"]),
                duration_seconds=duration,
                channels=int(stream["channels"]),
                sample_rate=int(stream["sample_rate"]),
            )
        except (KeyError, IndexError, ValueError, TypeError) as exc:
            raise AudioValidationError(
                f"ffprobe returned no usable audio stream for {path}"
            ) from exc


# The fixed 8-byte tail (Data4) of every KSDATAFORMAT_SUBTYPE GUID, plus the
# fixed Data2/Data3 words: <code:LE u32><0x0000:LE u16><0x0010:LE u16><tail>.
_KSDATAFORMAT_TAIL = bytes((0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71))


def _extensible_format_code(data: bytes, body: int, chunk_size: int) -> int:
    """Validate a WAVE_FORMAT_EXTENSIBLE fmt chunk and return the real format code.

    A chunk claiming 0xFFFE must carry the mandatory extension: ``cbSize`` >= 22
    and a 16-byte SubFormat GUID equal to the canonical KSDATAFORMAT_SUBTYPE GUID
    for a supported code (1 = PCM, 3 = IEEE float). Anything else is malformed and
    refused, rather than accepted and left to fail later in ffmpeg.
    """
    if chunk_size < 40:
        raise AudioValidationError(
            "WAVE_FORMAT_EXTENSIBLE requires an extended fmt chunk"
        )
    cb_size = struct.unpack_from("<H", data, body + 16)[0]
    if cb_size < 22:
        raise AudioValidationError("WAVE_FORMAT_EXTENSIBLE cbSize must be >= 22")
    guid = data[body + 24 : body + 40]
    if len(guid) != 16:
        raise AudioValidationError("WAVE_FORMAT_EXTENSIBLE SubFormat GUID is truncated")
    sub_code = struct.unpack_from("<I", guid, 0)[0]
    if sub_code not in (1, 3):
        raise AudioValidationError(
            f"unsupported WAVE extensible SubFormat code: {sub_code}"
        )
    canonical = struct.pack("<IHH", sub_code, 0x0000, 0x0010) + _KSDATAFORMAT_TAIL
    if guid != canonical:
        raise AudioValidationError("WAVE_FORMAT_EXTENSIBLE SubFormat GUID is not valid")
    return sub_code


def _parse_wav(data: bytes) -> AudioProbeResult:
    """Decode a canonical PCM/float WAV header, failing closed on any defect."""
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise AudioValidationError("not a RIFF/WAVE file")
    riff_size = struct.unpack_from("<I", data, 4)[0]
    # RIFF size counts everything after the first 8 bytes; a truncated file
    # (claimed larger than present) is refused rather than parsed partially.
    if riff_size + 8 > len(data):
        raise AudioValidationError("WAVE RIFF size exceeds the file length")

    offset = 12
    fmt: tuple[int, int, int, int] | None = None  # (fmt_code, channels, rate, bits)
    data_bytes: int | None = None
    end = min(len(data), riff_size + 8)
    while offset + 8 <= end:
        chunk_id = data[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
        body = offset + 8
        # a chunk must fit within the DECLARED RIFF container (end), not merely
        # within the physical file — a data/fmt chunk extending past riff_size
        # (into bytes appended after the container) is malformed and refused.
        if body + chunk_size > end:
            raise AudioValidationError(
                f"WAVE chunk {chunk_id!r} overruns the RIFF container"
            )
        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise AudioValidationError("WAVE fmt chunk is too small")
            fmt_code, channels, rate, _byte_rate, _align, bits = struct.unpack_from(
                "<HHIIHH", data, body
            )
            if fmt_code == 0xFFFE:
                fmt_code = _extensible_format_code(data, body, chunk_size)
            fmt = (fmt_code, channels, rate, bits)
        elif chunk_id == b"data":
            data_bytes = chunk_size
        # chunks are word-aligned: an odd size carries one pad byte.
        offset = body + chunk_size + (chunk_size & 1)

    if fmt is None:
        raise AudioValidationError("WAVE file has no fmt chunk")
    if data_bytes is None:
        raise AudioValidationError("WAVE file has no data chunk")
    fmt_code, channels, rate, bits = fmt
    # 1 = PCM, 3 = IEEE float. WAVE_FORMAT_EXTENSIBLE (0xFFFE) was resolved to its
    # real SubFormat code above, so only concrete codecs may reach here.
    if fmt_code not in (1, 3):
        raise AudioValidationError(f"unsupported WAVE format code: {fmt_code}")
    if channels <= 0:
        raise AudioValidationError("WAVE file declares no channels")
    if rate <= 0:
        raise AudioValidationError("WAVE file declares a non-positive sample rate")
    if bits <= 0 or bits % 8 != 0:
        raise AudioValidationError(f"unsupported WAVE bit depth: {bits}")
    if data_bytes <= 0:
        raise AudioValidationError("WAVE data chunk is empty")
    byte_rate = rate * channels * (bits // 8)
    if byte_rate <= 0:
        raise AudioValidationError("WAVE header yields a zero byte rate")
    duration = data_bytes / byte_rate
    if duration <= 0.0:
        raise AudioValidationError("WAVE file has a zero duration")
    codec = "pcm_f" if fmt_code == 3 else "pcm"
    return AudioProbeResult(
        codec=codec,
        duration_seconds=float(duration),
        channels=int(channels),
        sample_rate=int(rate),
    )
