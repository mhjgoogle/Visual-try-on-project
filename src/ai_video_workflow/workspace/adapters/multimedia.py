"""WFM2 multimedia + post-production source adapter (read-only, TASK-039).

Reads the WFM2 authoritative fact indices so the Workspace can observe images,
audio, subtitles, formal post-production, QC, release and post-mortem — the media
types WFM1 could only report as ``unavailable``:

* the media asset index (ADR-0038 / TASK-035): reference / master / keyframe /
  generated_image / audio_generation / voiceover / sfx / subtitle assets;
* the post-production index (ADR-0039 / TASK-036): the S5–S7 artifacts with their
  fact domain and status (produced / not_applicable / unavailable).

Like every source adapter it reads authoritative domains only, never writes, never
calls a Provider, never copies referenced cost/QC/lineage facts, and — because the
indices verify their own and their bound files' digests on load — surfaces a
corrupt/tampered/missing fact as a fail-closed ``Problem`` instead of raising or
guessing (query contract §4). The projection is a derived read view, never a second
source of truth (ADR-0010 decision 4).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.media import assets as media_assets
from ai_video_workflow.media.errors import MediaError
from ai_video_workflow.media.provider import MEDIA_KINDS
from ai_video_workflow.postproduction import catalog as pp_catalog
from ai_video_workflow.postproduction import index as pp
from ai_video_workflow.postproduction.errors import PostProductionError
from ai_video_workflow.workspace.adapters.base import corrupt
from ai_video_workflow.workspace.envelope import Problem

# A stable, sorted read order so the projection is deterministic.
MEDIA_KIND_ORDER: tuple[str, ...] = tuple(sorted(MEDIA_KINDS))


@dataclass(frozen=True, slots=True)
class MediaAssetView:
    media_kind: str
    ref: str
    version: int
    content_digest: str
    media_sha256: str
    size_bytes: int
    producer_source: str


@dataclass(frozen=True, slots=True)
class PostProductionView:
    stage: str
    step_id: str
    fact_domain: str
    kind: str
    ref: str
    version: int
    status: str
    content_digest: str


@dataclass(frozen=True, slots=True)
class MultimediaSources:
    media: tuple[MediaAssetView, ...]
    postproduction: tuple[PostProductionView, ...]
    problems: tuple[Problem, ...]


def read_multimedia(project_root: Path) -> MultimediaSources:
    """Read the WFM2 media + post-production facts; corrupt sources become
    fail-closed problems (per kind / per stage), never a raise."""
    media: list[MediaAssetView] = []
    postproduction: list[PostProductionView] = []
    problems: list[Problem] = []

    for media_kind in MEDIA_KIND_ORDER:
        try:
            assets = media_assets.assets_of_kind(project_root, media_kind)
        except MediaError as exc:
            # a corrupt/tampered/missing asset or bound media file for this kind
            problems.append(corrupt("media_assets", str(exc), media_kind=media_kind))
            continue
        for asset in assets:
            media.append(
                MediaAssetView(
                    media_kind=asset.media_kind,
                    ref=asset.ref,
                    version=asset.version,
                    content_digest=asset.content_digest,
                    media_sha256=asset.media_sha256,
                    size_bytes=asset.size_bytes,
                    producer_source=str(asset.producer.get("source", "")),
                )
            )

    for stage in pp_catalog.STAGES:
        try:
            artifacts = pp.latest_artifacts(project_root, stage)
        except PostProductionError as exc:
            problems.append(corrupt("postproduction", str(exc), stage=stage))
            continue
        for art in artifacts:
            postproduction.append(
                PostProductionView(
                    stage=art.stage,
                    step_id=art.step_id,
                    fact_domain=art.fact_domain,
                    kind=art.kind,
                    ref=art.ref,
                    version=art.version,
                    status=art.status,
                    content_digest=art.content_digest,
                )
            )

    return MultimediaSources(
        media=tuple(media),
        postproduction=tuple(postproduction),
        problems=tuple(problems),
    )
