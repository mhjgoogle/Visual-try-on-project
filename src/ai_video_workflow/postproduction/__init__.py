"""WFM2 S5–S7 post-production / QC / release / archive contract (TASK-036 / ADR-0039).

Public surface: the S5–S7 step catalog (owner / execution class / fact domain /
inputs / completion / human gate) and the immutable, digest-bound artifact index
that enforces identity, linear versioning, cross-surface lineage, unique-writer
fact-domain separation (P5) and missing-vs-zero status semantics (P7:
not_applicable / unavailable). Contract layer only — it computes no QC, calls no
Provider, approves nothing, and generates no media (audio/subtitle mixing is
TASK-008; media generation is TASK-035).
"""

from __future__ import annotations

from ai_video_workflow.postproduction import catalog, index
from ai_video_workflow.postproduction.catalog import CatalogStep
from ai_video_workflow.postproduction.errors import (
    PostProductionError,
    PostProductionNotFoundError,
    PostProductionValidationError,
)
from ai_video_workflow.postproduction.index import (
    POSTPRODUCTION_DIR,
    POSTPRODUCTION_INDEX_SCHEMA_VERSION,
    STAGES,
    STATUS_NOT_APPLICABLE,
    STATUS_PRODUCED,
    STATUS_UNAVAILABLE,
    SURFACE_CREATIVE,
    SURFACE_EXTERNAL,
    SURFACE_MEDIA,
    SURFACE_POSTPRODUCTION,
    ChecklistItem,
    InputRef,
    PostProductionArtifact,
    artifact_from_dict,
    artifacts_of_domain,
    build_artifact,
    index_relpath,
    latest_artifacts,
    latest_version,
    load_artifact,
    load_latest,
    publish_artifact,
)

__all__ = [
    "POSTPRODUCTION_DIR",
    "POSTPRODUCTION_INDEX_SCHEMA_VERSION",
    "STAGES",
    "STATUS_NOT_APPLICABLE",
    "STATUS_PRODUCED",
    "STATUS_UNAVAILABLE",
    "SURFACE_CREATIVE",
    "SURFACE_EXTERNAL",
    "SURFACE_MEDIA",
    "SURFACE_POSTPRODUCTION",
    "CatalogStep",
    "ChecklistItem",
    "InputRef",
    "PostProductionArtifact",
    "PostProductionError",
    "PostProductionNotFoundError",
    "PostProductionValidationError",
    "artifact_from_dict",
    "artifacts_of_domain",
    "build_artifact",
    "catalog",
    "index",
    "index_relpath",
    "latest_artifacts",
    "latest_version",
    "load_artifact",
    "load_latest",
    "publish_artifact",
]
