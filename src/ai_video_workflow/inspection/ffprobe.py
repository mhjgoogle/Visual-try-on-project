"""The sole production MediaInspector: ffprobe via subprocess (ADR-0002).

ffprobe is invoked with a fixed argument list, no shell, and an explicit
timeout. A missing tool, a non-zero exit / timeout, and unparseable
output each map to a distinct typed error. This is the only module in
the repository permitted to call ffprobe.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ai_video_workflow.inspection.base import MediaInspector, MediaProbeResult
from ai_video_workflow.inspection.errors import (
    MediaProbeParseError,
    MediaToolNotAvailableError,
    UndecodableMediaError,
)

_DEFAULT_TIMEOUT_SECONDS = 30.0


class FfprobeMediaInspector(MediaInspector):
    """Probe media parameters by running ffprobe (fixed argv, no shell)."""

    __slots__ = ("_ffprobe_path", "_timeout_seconds")

    def __init__(
        self,
        *,
        ffprobe_path: str = "ffprobe",
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._ffprobe_path = ffprobe_path
        self._timeout_seconds = timeout_seconds

    def probe(self, path: Path) -> MediaProbeResult:
        argv = [
            self._ffprobe_path,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
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
            raise MediaToolNotAvailableError(
                f"ffprobe is not available: {self._ffprobe_path}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise UndecodableMediaError(
                f"ffprobe timed out after {self._timeout_seconds}s: {path}"
            ) from exc
        if completed.returncode != 0:
            raise UndecodableMediaError(
                f"ffprobe exited with {completed.returncode} for {path}"
            )
        return _parse_ffprobe_json(completed.stdout, path)


def _parse_ffprobe_json(stdout: str, path: Path) -> MediaProbeResult:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise MediaProbeParseError(f"ffprobe output is not valid JSON: {path}") from exc
    if not isinstance(data, dict):
        raise MediaProbeParseError(f"ffprobe output is not an object: {path}")
    fmt = data.get("format")
    streams = data.get("streams")
    if not isinstance(fmt, dict) or not isinstance(streams, list):
        raise MediaProbeParseError(f"ffprobe output missing format/streams: {path}")
    container_format = fmt.get("format_name")
    if not isinstance(container_format, str) or not container_format:
        raise MediaProbeParseError(f"ffprobe output missing format_name: {path}")

    video = _first_video_stream(streams, path)
    width = _require_int(video.get("width"), "width", path)
    height = _require_int(video.get("height"), "height", path)
    frame_rate = _parse_rational(video.get("r_frame_rate"), "r_frame_rate", path)
    duration = _parse_duration(fmt, video, path)
    try:
        return MediaProbeResult(
            container_format=container_format,
            duration_seconds=duration,
            width=width,
            height=height,
            frame_rate=frame_rate,
        )
    except Exception as exc:  # invariant violations from the model
        raise MediaProbeParseError(f"ffprobe values are invalid: {path}") from exc


def _first_video_stream(streams: list, path: Path) -> dict:
    for stream in streams:
        if isinstance(stream, dict) and stream.get("codec_type") == "video":
            return stream
    raise MediaProbeParseError(f"ffprobe found no video stream: {path}")


def _require_int(value: object, name: str, path: Path) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise MediaProbeParseError(f"ffprobe {name} is not an int: {path}")
    return value


def _parse_rational(value: object, name: str, path: Path) -> float:
    if not isinstance(value, str) or "/" not in value:
        raise MediaProbeParseError(f"ffprobe {name} is not a rational: {path}")
    numerator, _, denominator = value.partition("/")
    try:
        num = float(numerator)
        den = float(denominator)
    except ValueError as exc:
        raise MediaProbeParseError(f"ffprobe {name} is not numeric: {path}") from exc
    if den == 0:
        raise MediaProbeParseError(f"ffprobe {name} has zero denominator: {path}")
    return num / den


def _parse_duration(fmt: dict, video: dict, path: Path) -> float:
    raw = fmt.get("duration")
    if raw is None:
        raw = video.get("duration")
    try:
        return float(raw)
    except (TypeError, ValueError) as exc:
        raise MediaProbeParseError(f"ffprobe duration is not numeric: {path}") from exc
