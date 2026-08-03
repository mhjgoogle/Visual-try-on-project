"""Audio-visual mux profile and its deterministic digest (TASK-008 / ADR-0039).

The M1 :class:`~ai_video_workflow.composition.profile.CompositionProfile` and its
``m1-composition-config-v1`` digest are FROZEN and untouched: mixing voice-over /
sfx and mounting/burning subtitles is a distinct downstream step (S5-T04/T05)
that consumes the M1 composition master plus registered audio/subtitle assets and
produces a NEW versioned ``final_av`` master, never overwriting the video-only
final.

``AudioVisualProfile`` is the immutable recipe for that mux: which audio assets to
mix in (by ref + version + gain), how to treat the base video's own audio, the
subtitle asset + mount mode (soft ``mov_text`` by default, or burn-in), and the
output codec parameters. Its digest is the ``relevant_config_digest`` of the mux
step — the *content* of each referenced asset feeds the step's separate input
digest, so either a recipe change or an input-content change advances the version.
"""

from __future__ import annotations

from dataclasses import dataclass

from ai_video_workflow.digests import config_digest
from ai_video_workflow.errors import FieldTypeError, InvariantViolationError

AV_PROFILE_CONFIG_SCHEMA = "wfm2-audiovisual-profile-v1"

SUBTITLE_MODE_SOFT = "soft"
SUBTITLE_MODE_BURN_IN = "burn_in"
_SUBTITLE_MODES = frozenset({SUBTITLE_MODE_SOFT, SUBTITLE_MODE_BURN_IN})

_AUDIO_ROLES = frozenset({"voiceover", "sfx"})
_ROLE_KIND = {"voiceover": "voiceover", "sfx": "sfx"}

_MIN_GAIN_DB = -60.0
_MAX_GAIN_DB = 30.0


@dataclass(frozen=True, slots=True)
class AudioTrackMix:
    """One audio asset mixed into the master, by role + ref + version + gain."""

    role: str
    ref: str
    version: int
    gain_db: float = 0.0

    def __post_init__(self) -> None:
        if self.role not in _AUDIO_ROLES:
            raise InvariantViolationError(
                f"role: must be one of {sorted(_AUDIO_ROLES)}"
            )
        _require_ref(self.ref, "ref")
        _require_positive_int(self.version, "version")
        _require_gain(self.gain_db, "gain_db")

    @property
    def media_kind(self) -> str:
        return _ROLE_KIND[self.role]

    def to_config_value(self) -> dict[str, object]:
        return {
            "role": self.role,
            "ref": self.ref,
            "version": self.version,
            "gain_db": self.gain_db,
        }


@dataclass(frozen=True, slots=True)
class SubtitleSpec:
    """The subtitle asset to mount plus the mount mode."""

    ref: str
    version: int
    mode: str = SUBTITLE_MODE_SOFT
    language: str | None = None

    def __post_init__(self) -> None:
        _require_ref(self.ref, "ref")
        _require_positive_int(self.version, "version")
        if self.mode not in _SUBTITLE_MODES:
            raise InvariantViolationError(
                f"mode: must be one of {sorted(_SUBTITLE_MODES)}"
            )
        if self.language is not None and (
            not isinstance(self.language, str) or not self.language.strip()
        ):
            raise InvariantViolationError(
                "language: must be a non-empty string or None"
            )

    def to_config_value(self) -> dict[str, object]:
        return {
            "ref": self.ref,
            "version": self.version,
            "mode": self.mode,
            "language": self.language,
        }


@dataclass(frozen=True, slots=True)
class AudioVisualProfile:
    """Immutable recipe for the audio-visual mux."""

    tracks: tuple[AudioTrackMix, ...] = ()
    subtitles: SubtitleSpec | None = None
    include_original_audio: bool = True
    original_audio_gain_db: float = 0.0
    audio_codec: str = "aac"
    audio_bitrate_kbps: int = 192
    subtitle_soft_codec: str = "mov_text"
    video_codec_burn_in: str = "libx264"

    def __post_init__(self) -> None:
        if not isinstance(self.tracks, tuple):
            raise FieldTypeError("tracks: must be a tuple")
        for track in self.tracks:
            if not isinstance(track, AudioTrackMix):
                raise FieldTypeError("tracks[]: must be AudioTrackMix instances")
        # a (role, ref) may appear only once — mixing the same asset twice is a
        # recipe error, not two tracks.
        keys = [(t.role, t.ref) for t in self.tracks]
        if len(set(keys)) != len(keys):
            raise InvariantViolationError(
                "tracks: duplicate (role, ref); each audio asset may mix in once"
            )
        if self.subtitles is not None and not isinstance(self.subtitles, SubtitleSpec):
            raise FieldTypeError("subtitles: must be a SubtitleSpec or None")
        if not isinstance(self.include_original_audio, bool):
            raise FieldTypeError("include_original_audio: must be a bool")
        _require_gain(self.original_audio_gain_db, "original_audio_gain_db")
        _require_non_empty_str(self.audio_codec, "audio_codec")
        _require_positive_int(self.audio_bitrate_kbps, "audio_bitrate_kbps")
        _require_non_empty_str(self.subtitle_soft_codec, "subtitle_soft_codec")
        _require_non_empty_str(self.video_codec_burn_in, "video_codec_burn_in")
        if not self.include_original_audio and not self.tracks:
            raise InvariantViolationError(
                "a mux must retain the original audio or add at least one track"
            )

    def to_config_value(self) -> dict[str, object]:
        return {
            "schema": AV_PROFILE_CONFIG_SCHEMA,
            "profile": {
                "tracks": [t.to_config_value() for t in self.tracks],
                "subtitles": (
                    self.subtitles.to_config_value()
                    if self.subtitles is not None
                    else None
                ),
                "include_original_audio": self.include_original_audio,
                "original_audio_gain_db": self.original_audio_gain_db,
                "audio_codec": self.audio_codec,
                "audio_bitrate_kbps": self.audio_bitrate_kbps,
                "subtitle_soft_codec": self.subtitle_soft_codec,
                "video_codec_burn_in": self.video_codec_burn_in,
            },
        }


def av_profile_digest(profile: AudioVisualProfile) -> str:
    """Return the deterministic config digest for an audio-visual profile."""
    return config_digest(profile.to_config_value())


def _require_ref(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not value:
        raise InvariantViolationError(f"{field_name}: must be a non-empty string")


def _require_non_empty_str(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not value:
        raise InvariantViolationError(f"{field_name}: must be a non-empty string")


def _require_positive_int(value: object, field_name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise FieldTypeError(f"{field_name}: expected int, got {type(value).__name__}")
    if value <= 0:
        raise InvariantViolationError(f"{field_name}: must be > 0")


def _require_gain(value: object, field_name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FieldTypeError(f"{field_name}: expected a number")
    number = float(value)
    if number != number or number < _MIN_GAIN_DB or number > _MAX_GAIN_DB:
        raise InvariantViolationError(
            f"{field_name}: must be within [{_MIN_GAIN_DB}, {_MAX_GAIN_DB}] dB"
        )
