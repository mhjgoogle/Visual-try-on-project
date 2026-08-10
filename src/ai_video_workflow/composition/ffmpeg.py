"""The sole production VideoComposer: ffmpeg via subprocess (ADR-0002).

ffmpeg is invoked with a deterministic, fixed argument list, no shell,
and an explicit timeout. A missing tool maps to
``MediaToolNotAvailableError``; a non-zero exit or timeout maps to
``CompositionToolError`` (with a truncated stderr summary). This is the
only module permitted to call ffmpeg.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from ai_video_workflow.composition.composer import VideoComposer
from ai_video_workflow.composition.errors import CompositionToolError
from ai_video_workflow.composition.profile import CompositionProfile
from ai_video_workflow.inspection.errors import MediaToolNotAvailableError

_DEFAULT_TIMEOUT_SECONDS = 600.0
_STDERR_LIMIT = 2000


def _concat_quote(source: Path) -> str:
    """Render one concat-demuxer entry path safely (ADR-0004 §5).

    The concat list is parsed line by line with single-quoted paths, so a
    ``'`` in the path must be escaped as ``'\\''`` and a newline (which
    would break the line-based format) is refused outright.
    """
    text = source.resolve().as_posix()
    if "\n" in text or "\r" in text:
        raise CompositionToolError(
            f"composition: media path contains a newline: {source!r}"
        )
    return text.replace("'", "'\\''")


class FfmpegVideoComposer(VideoComposer):
    """Normalize/concatenate with ffmpeg (deterministic argv, no shell)."""

    __slots__ = ("_ffmpeg_path", "_timeout_seconds")

    def __init__(
        self,
        *,
        ffmpeg_path: str = "ffmpeg",
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._ffmpeg_path = ffmpeg_path
        self._timeout_seconds = timeout_seconds

    def normalize(
        self, source: Path, target: Path, profile: CompositionProfile
    ) -> None:
        self._run(self._normalize_argv(source, target, profile), target)

    def concatenate(self, sources: tuple[Path, ...], target: Path) -> None:
        if not sources:
            raise CompositionToolError("concatenate: no sources provided")
        list_fd, list_name = tempfile.mkstemp(
            dir=target.parent, prefix=".concat.", suffix=".txt"
        )
        list_path = Path(list_name)
        try:
            with os.fdopen(list_fd, "w", encoding="utf-8") as stream:
                for source in sources:
                    stream.write(f"file '{_concat_quote(source)}'\n")
            self._run(self._concat_argv(list_path, target), target)
        finally:
            try:
                list_path.unlink()
            except OSError:
                pass

    def _normalize_argv(
        self, source: Path, target: Path, profile: CompositionProfile
    ) -> list[str]:
        argv = [
            self._ffmpeg_path,
            "-y",
            "-nostdin",
            "-i",
            str(source),
            "-c:v",
            profile.video_codec,
            "-pix_fmt",
            profile.pixel_format,
            "-r",
            f"{profile.frame_rate:g}",
            "-s",
            f"{profile.width}x{profile.height}",
        ]
        if profile.audio_codec is not None:
            argv += ["-c:a", profile.audio_codec]
        else:
            argv += ["-an"]
        argv.append(str(target))
        return argv

    def _concat_argv(self, list_path: Path, target: Path) -> list[str]:
        return [
            self._ffmpeg_path,
            "-y",
            "-nostdin",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c",
            "copy",
            str(target),
        ]

    def _run(self, argv: list[str], target: Path) -> None:
        try:
            completed = subprocess.run(  # noqa: S603 — fixed argv, no shell
                argv,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",  # CJK stderr under a Windows locale codepage
                timeout=self._timeout_seconds,
                check=False,
                shell=False,
            )
        except FileNotFoundError as exc:
            raise MediaToolNotAvailableError(
                f"ffmpeg is not available: {self._ffmpeg_path}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise CompositionToolError(
                f"ffmpeg timed out after {self._timeout_seconds}s for {target}"
            ) from exc
        if completed.returncode != 0:
            stderr = (completed.stderr or "")[:_STDERR_LIMIT]
            raise CompositionToolError(
                f"ffmpeg exited with {completed.returncode} for {target}: {stderr}"
            )
