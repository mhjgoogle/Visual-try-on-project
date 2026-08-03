"""WFM2 creative & audiovisual artifact contract (L0/S1/S2/S3, TASK-034 / ADR-0037).

Public surface: the locked-artifact structured index (identity/version/lineage),
the L0–S3 step catalog, payload-continuity and three-representative-shot pilot
gates, and per-lock stage-target validation. Contract layer only — no Provider,
no approval, no image/audio generation (deferred to ADR-0038/0039).
"""

from __future__ import annotations

from ai_video_workflow.creative import catalog, index, payload, pilot, stage_targets
from ai_video_workflow.creative.catalog import CatalogStep
from ai_video_workflow.creative.errors import (
    CreativeError,
    CreativeNotFoundError,
    CreativeValidationError,
)
from ai_video_workflow.creative.index import (
    CREATIVE_DIR,
    CREATIVE_INDEX_SCHEMA_VERSION,
    STAGES,
    ChecklistItem,
    CreativeArtifact,
    InputRef,
    artifact_from_dict,
    artifacts_of_kind,
    build_artifact,
    index_relpath,
    latest_version,
    load_artifact,
    load_latest,
    publish_artifact,
)

__all__ = [
    "CREATIVE_DIR",
    "CREATIVE_INDEX_SCHEMA_VERSION",
    "STAGES",
    "CatalogStep",
    "ChecklistItem",
    "CreativeArtifact",
    "CreativeError",
    "CreativeNotFoundError",
    "CreativeValidationError",
    "InputRef",
    "artifact_from_dict",
    "artifacts_of_kind",
    "build_artifact",
    "catalog",
    "index",
    "index_relpath",
    "latest_version",
    "load_artifact",
    "load_latest",
    "payload",
    "pilot",
    "publish_artifact",
    "stage_targets",
]
