"""WFM2 multimedia (image/audio) Provider, asset, batch and cost contract layer
(TASK-035 / ADR-0038).

A capability-declaring media Provider registry PARALLEL to the frozen
``VideoProvider`` (never generalized), a media asset identity/lineage index,
generation batch + selection records (all candidates retained), and unified cost
that reuses the existing budget/reservation/QCD chain. Contract layer only —
the only provider shipped is the offline zero-cost stub; real paid providers stay
explicit opt-in under ADR-0006/0009. Providers never write business facts.
"""

from __future__ import annotations

from ai_video_workflow.media import assets, batch, cost, generation, provider
from ai_video_workflow.media.assets import (
    MediaAsset,
    MediaInputRef,
    assets_of_kind,
    build_asset,
    latest_version,
    load_asset,
    load_latest,
    publish_asset,
)
from ai_video_workflow.media.batch import (
    Candidate,
    GenerationBatch,
    Selection,
    build_batch,
    load_batch,
    load_selection,
    publish_batch,
    record_selection,
)
from ai_video_workflow.media.cost import book_media_cost
from ai_video_workflow.media.errors import (
    MediaError,
    MediaNotFoundError,
    MediaProviderError,
    MediaValidationError,
)
from ai_video_workflow.media.generation import generate_batch, promote_selection
from ai_video_workflow.media.provider import (
    MEDIA_CAPABILITIES,
    MEDIA_KINDS,
    LocalStubMediaProvider,
    MediaProvider,
    MediaProviderRegistry,
    MediaRequest,
    MediaResult,
    MediaStatus,
    default_media_registry,
)

__all__ = [
    "MEDIA_CAPABILITIES",
    "MEDIA_KINDS",
    "Candidate",
    "GenerationBatch",
    "LocalStubMediaProvider",
    "MediaAsset",
    "MediaError",
    "MediaInputRef",
    "MediaNotFoundError",
    "MediaProvider",
    "MediaProviderError",
    "MediaProviderRegistry",
    "MediaRequest",
    "MediaResult",
    "MediaStatus",
    "MediaValidationError",
    "Selection",
    "assets",
    "assets_of_kind",
    "batch",
    "book_media_cost",
    "build_asset",
    "build_batch",
    "cost",
    "default_media_registry",
    "generate_batch",
    "generation",
    "latest_version",
    "load_asset",
    "load_batch",
    "load_latest",
    "load_selection",
    "promote_selection",
    "provider",
    "publish_asset",
    "publish_batch",
    "record_selection",
]
