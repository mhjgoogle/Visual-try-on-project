"""AudioVisualComposer: mux voice-over / sfx / subtitles onto a video master.

This runs PARALLEL to the frozen :class:`~ai_video_workflow.composition.composer.
VideoComposer` (normalize/concatenate) and never touches it — mounting audio and
subtitles is a different operation from concatenating shots. The mux is a single
deterministic ffmpeg invocation built by :func:`build_mux_argv` (a pure function,
so the exact argv is unit-tested without the tool), executed only by
:class:`FfmpegAudioVisualComposer` with a fixed argument list, no shell and an
explicit timeout.

The step layer resolves a :class:`MuxPlan` (concrete file paths + gains + subtitle
mode) and hands it here; the composer holds no business state and writes no facts.
"""

from __future__ import annotations

import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.composition.av_profile import (
    SUBTITLE_MODE_BURN_IN,
    SUBTITLE_MODE_SOFT,
)
from ai_video_workflow.composition.errors import CompositionToolError
from ai_video_workflow.inspection.errors import MediaToolNotAvailableError

_DEFAULT_TIMEOUT_SECONDS = 600.0
_STDERR_LIMIT = 2000

SUBTITLE_MODE_NONE = "none"


@dataclass(frozen=True, slots=True)
class MuxAudioInput:
    """One resolved audio track to mix in (concrete path + gain + role)."""

    path: Path
    gain_db: float
    role: str


@dataclass(frozen=True, slots=True)
class MuxPlan:
    """A fully-resolved mux request (concrete files; no refs/versions left)."""

    base_video: Path
    audio_inputs: tuple[MuxAudioInput, ...]
    include_original_audio: bool
    original_audio_gain_db: float
    subtitle: Path | None
    subtitle_mode: str  # "soft" | "burn_in" | "none"
    audio_codec: str
    audio_bitrate_kbps: int
    subtitle_soft_codec: str
    video_codec_burn_in: str
    # Whether the base video actually carries an audio stream. An M1 master can
    # be silent (composed with no audio), in which case "keep the original audio"
    # must not reference a non-existent [0:a] and make ffmpeg fail — the caller
    # declares this because the mux step probes video, not audio streams.
    base_has_audio: bool = True
    # The base video's duration (seconds). When audio is present the output is
    # capped to EXACTLY this length (see build_mux_argv) so neither a longer audio
    # track nor a shorter subtitle stream can change the master's duration.
    base_duration_seconds: float = 0.0

    def __post_init__(self) -> None:
        if self.subtitle_mode not in (
            SUBTITLE_MODE_SOFT,
            SUBTITLE_MODE_BURN_IN,
            SUBTITLE_MODE_NONE,
        ):
            raise CompositionToolError(
                f"mux: unknown subtitle mode {self.subtitle_mode!r}"
            )
        if self.subtitle_mode == SUBTITLE_MODE_NONE and self.subtitle is not None:
            raise CompositionToolError("mux: subtitle path given with mode 'none'")
        if self.subtitle_mode != SUBTITLE_MODE_NONE and self.subtitle is None:
            raise CompositionToolError(
                f"mux: subtitle mode {self.subtitle_mode!r} requires a subtitle path"
            )
        has_audio = self.uses_original_audio or bool(self.audio_inputs)
        if has_audio and not (
            isinstance(self.base_duration_seconds, (int, float))
            and not isinstance(self.base_duration_seconds, bool)
            and math.isfinite(self.base_duration_seconds)
            and self.base_duration_seconds > 0
        ):
            raise CompositionToolError(
                "mux: base_duration_seconds must be > 0 when audio is present "
                "(the output is capped to the video duration)"
            )

    @property
    def uses_original_audio(self) -> bool:
        """Original audio is written only if requested AND the base has any."""
        return self.include_original_audio and self.base_has_audio


class AudioVisualComposer:
    """Abstract single-shot muxer: base video + audio tracks + subtitles."""

    __slots__ = ()

    def mux(self, plan: MuxPlan, output: Path) -> None:  # pragma: no cover - abstract
        raise NotImplementedError


def _fmt_gain(gain_db: float) -> str:
    """Deterministic dB rendering (``0`` not ``0.0``; no locale/float noise)."""
    return f"{gain_db:g}"


def _escape_subtitles_filter_path(path: Path) -> str:
    """Escape a path for use inside the ffmpeg ``subtitles=`` filter argument.

    The filtergraph parser treats ``\\``, ``:``, ``'`` and ``[`` specially; a
    newline would break the graph outright and is refused. Only used for burn-in.
    """
    text = path.as_posix()
    if "\n" in text or "\r" in text:
        raise CompositionToolError(f"mux: subtitle path contains a newline: {path!r}")
    text = text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return text


def build_mux_argv(ffmpeg_path: str, plan: MuxPlan, output: Path) -> list[str]:
    """Build the deterministic ffmpeg argv for one mux (pure, no IO)."""
    argv: list[str] = [ffmpeg_path, "-y", "-nostdin", "-i", str(plan.base_video)]
    for audio in plan.audio_inputs:
        argv += ["-i", str(audio.path)]
    soft = plan.subtitle_mode == SUBTITLE_MODE_SOFT and plan.subtitle is not None
    subtitle_input_index: int | None = None
    if soft:
        subtitle_input_index = 1 + len(plan.audio_inputs)
        argv += ["-i", str(plan.subtitle)]

    filters: list[str] = []

    # --- video branch ---
    if plan.subtitle_mode == SUBTITLE_MODE_BURN_IN and plan.subtitle is not None:
        escaped = _escape_subtitles_filter_path(plan.subtitle)
        filters.append(f"[0:v]subtitles='{escaped}'[vout]")
        video_map = "[vout]"
        video_copy = False
    else:
        video_map = "0:v"
        video_copy = True

    # --- audio branch ---
    # The base's own audio is only referenced when the base actually has a stream
    # (a silent M1 master with include_original_audio=True yields no [0:a], so
    # ffmpeg is not asked to map a non-existent stream). Each audio stream is
    # padded with silence (``apad``) so it is effectively infinite; combined with
    # ``-shortest`` below, the output is bounded by the (finite) VIDEO duration —
    # a voice-over/SFX longer than the video is trimmed to it, a shorter one
    # leaves trailing silence, so the master always matches the video length.
    audio_labels: list[str] = []
    if plan.uses_original_audio:
        filters.append(
            f"[0:a]volume={_fmt_gain(plan.original_audio_gain_db)}dB,apad[a0]"
        )
        audio_labels.append("[a0]")
    for position, audio in enumerate(plan.audio_inputs, start=1):
        filters.append(
            f"[{position}:a]volume={_fmt_gain(audio.gain_db)}dB,apad[a{position}]"
        )
        audio_labels.append(f"[a{position}]")
    audio_map: str | None
    if len(audio_labels) >= 2:
        joined = "".join(audio_labels)
        filters.append(f"{joined}amix=inputs={len(audio_labels)}:normalize=0[aout]")
        audio_map = "[aout]"
    elif audio_labels:
        audio_map = audio_labels[0]
    else:
        # no original audio and no added tracks -> a legitimately silent output
        # (e.g. subtitles-only over a silent video). Write no audio stream.
        audio_map = None

    if filters:
        argv += ["-filter_complex", ";".join(filters)]

    argv += ["-map", video_map]
    if audio_map is not None:
        argv += ["-map", audio_map]
    if soft and subtitle_input_index is not None:
        argv += ["-map", f"{subtitle_input_index}:s"]

    if video_copy:
        argv += ["-c:v", "copy"]
    else:
        argv += ["-c:v", plan.video_codec_burn_in]
    if audio_map is not None:
        argv += ["-c:a", plan.audio_codec, "-b:a", f"{plan.audio_bitrate_kbps}k"]
        # Cap the output to EXACTLY the video duration. The audio is apad-padded to
        # infinite, so this trims a longer track and pads a shorter one; using an
        # explicit -t (not -shortest) means a short subtitle stream can never
        # truncate the master early.
        argv += ["-t", f"{plan.base_duration_seconds:g}"]
    else:
        argv += ["-an"]
    if soft:
        argv += ["-c:s", plan.subtitle_soft_codec]

    argv.append(str(output))
    return argv


class FfmpegAudioVisualComposer(AudioVisualComposer):
    """Mux with ffmpeg (deterministic argv, no shell, explicit timeout)."""

    __slots__ = ("_ffmpeg_path", "_timeout_seconds")

    def __init__(
        self,
        *,
        ffmpeg_path: str = "ffmpeg",
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._ffmpeg_path = ffmpeg_path
        self._timeout_seconds = timeout_seconds

    def mux(self, plan: MuxPlan, output: Path) -> None:
        argv = build_mux_argv(self._ffmpeg_path, plan, output)
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
                f"ffmpeg is not available: {self._ffmpeg_path}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise CompositionToolError(
                f"ffmpeg mux timed out after {self._timeout_seconds}s for {output}"
            ) from exc
        if completed.returncode != 0:
            stderr = (completed.stderr or "")[:_STDERR_LIMIT]
            raise CompositionToolError(
                f"ffmpeg mux exited with {completed.returncode} for {output}: {stderr}"
            )
