"""FFmpeg shot composition into the final deliverable (TASK-006).

``run_composition_step`` is the resumable, project-level entry point;
``build_composition_plan`` derives the ordered shot sequence;
``VideoComposer`` / ``FfmpegVideoComposer`` are the media boundary. The
CompositionPublishIntent journal is an internal recovery detail and is
deliberately not re-exported here; import it from
``ai_video_workflow.composition.intent`` if a test needs it.
"""

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
    "M1_COMPOSITION_CONFIG_SCHEMA",
    "CompositionConflictError",
    "CompositionError",
    "CompositionPlan",
    "CompositionPlanEntry",
    "CompositionProfile",
    "CompositionStepOutcome",
    "CompositionToolError",
    "FfmpegVideoComposer",
    "InconsistentShotSpecError",
    "MissingShotAssetError",
    "VideoComposer",
    "build_composition_plan",
    "composition_manifest_path",
    "profile_digest",
    "run_composition_step",
]
