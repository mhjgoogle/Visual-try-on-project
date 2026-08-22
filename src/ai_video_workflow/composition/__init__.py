"""FFmpeg shot composition into the final deliverable (TASK-006).

``run_composition_step`` is the resumable, project-level entry point;
``build_composition_plan`` derives the ordered shot sequence;
``VideoComposer`` / ``FfmpegVideoComposer`` are the media boundary. The
CompositionPublishIntent journal is an internal recovery detail and is
deliberately not re-exported here; import it from
``ai_video_workflow.composition.intent`` if a test needs it.
"""

from ai_video_workflow.composition.audiovisual import (
    AudioVisualComposer,
    FfmpegAudioVisualComposer,
    MuxAudioInput,
    MuxPlan,
    build_mux_argv,
)
from ai_video_workflow.composition.av_profile import (
    AV_PROFILE_CONFIG_SCHEMA,
    SUBTITLE_MODE_BURN_IN,
    SUBTITLE_MODE_SOFT,
    AudioTrackMix,
    AudioVisualProfile,
    SubtitleSpec,
    av_profile_digest,
)
from ai_video_workflow.composition.av_step import (
    AudioVisualStepOutcome,
    audiovisual_manifest_path,
    run_audiovisual_step,
)
from ai_video_workflow.composition.composer import VideoComposer
from ai_video_workflow.composition.errors import (
    CompositionConflictError,
    CompositionError,
    CompositionToolError,
    InconsistentShotSpecError,
    MissingShotAssetError,
)
from ai_video_workflow.composition.ffmpeg import FfmpegVideoComposer
from ai_video_workflow.composition.plan import (
    CompositionPlan,
    CompositionPlanEntry,
    build_composition_plan,
)
from ai_video_workflow.composition.profile import (
    M1_COMPOSITION_CONFIG_SCHEMA,
    CompositionProfile,
    profile_digest,
)
from ai_video_workflow.composition.step import (
    CompositionStepOutcome,
    composition_manifest_path,
    run_composition_step,
)

__all__ = [
    "AV_PROFILE_CONFIG_SCHEMA",
    "M1_COMPOSITION_CONFIG_SCHEMA",
    "SUBTITLE_MODE_BURN_IN",
    "SUBTITLE_MODE_SOFT",
    "AudioTrackMix",
    "AudioVisualComposer",
    "AudioVisualProfile",
    "AudioVisualStepOutcome",
    "CompositionConflictError",
    "CompositionError",
    "CompositionPlan",
    "CompositionPlanEntry",
    "CompositionProfile",
    "CompositionStepOutcome",
    "CompositionToolError",
    "FfmpegAudioVisualComposer",
    "FfmpegVideoComposer",
    "InconsistentShotSpecError",
    "MissingShotAssetError",
    "MuxAudioInput",
    "MuxPlan",
    "SubtitleSpec",
    "VideoComposer",
    "audiovisual_manifest_path",
    "av_profile_digest",
    "build_composition_plan",
    "build_mux_argv",
    "composition_manifest_path",
    "profile_digest",
    "run_audiovisual_step",
    "run_composition_step",
]
