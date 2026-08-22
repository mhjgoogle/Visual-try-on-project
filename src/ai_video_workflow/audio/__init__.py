"""Subtitle, voice-over and audio-track layer (TASK-008 / ADR-0038/0039).

User-provided voice-over / sound-effect audio and subtitle (SRT) files are
validated fail-closed and registered as immutable, versioned, digest-bound media
assets through the frozen TASK-035 media asset index (no second asset system),
then mounted onto an existing M1 composition master by the resumable audio-visual
mux step (:mod:`ai_video_workflow.composition.av_step`). No TTS / paid API is
used: the production contract is user-provided files, and tests self-generate
deterministic placeholder WAV/SRT inputs. The frozen ``VideoProvider``,
``VideoComposer``, ``CompositionProfile`` and M1 composition step are untouched.
"""

from __future__ import annotations

from ai_video_workflow.audio.errors import (
    AudioError,
    AudioToolError,
    AudioValidationError,
    SubtitleValidationError,
)
from ai_video_workflow.audio.inspect import (
    AudioInspector,
    AudioProbeResult,
    FfprobeAudioInspector,
    WavStructuralInspector,
)
from ai_video_workflow.audio.registration import (
    AudioRegistration,
    SubtitleRegistration,
    register_sfx_asset,
    register_subtitle_asset,
    register_voiceover_asset,
)
from ai_video_workflow.audio.subtitle import (
    SubtitleValidationResult,
    validate_srt_bytes,
)

__all__ = [
    "AudioError",
    "AudioInspector",
    "AudioProbeResult",
    "AudioRegistration",
    "AudioToolError",
    "AudioValidationError",
    "FfprobeAudioInspector",
    "SubtitleRegistration",
    "SubtitleValidationError",
    "SubtitleValidationResult",
    "WavStructuralInspector",
    "register_sfx_asset",
    "register_subtitle_asset",
    "register_voiceover_asset",
    "validate_srt_bytes",
]
