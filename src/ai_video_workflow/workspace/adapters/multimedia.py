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

from collections.abc import Mapping
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
    # 绑定媒体文件的项目内相对路径。加载时已被 `_verify_media_file` 按 digest +
    # size 重新校验过，所以它到这里已经是**核过的事实**，不是一个待信任的字符串。
    media_path: str
    # 只有 `source == "generation"` 的资产才有；它是 attempt ↔ 资产的连接键
    # （`_validate_producer` 对 generation 强制要求）。手工/导入来源没有，
    # 那时是 None —— **不编一个**。
    producer_operation_id: str | None


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


def _generation_operation(producer) -> str | None:
    """The operation that generated this asset, or None.

    ONLY for `source == "generation"`. `_validate_producer` already whitelists
    the non-generation branch down to `source` + `note`, so a manual/import
    asset cannot carry an `operation_id` through validation today — this is
    not fixing a live defect. It is here because the field decides an IDENTITY
    binding (WQ-06 attaches this asset's footage to that attempt), and binding
    the wrong take is not a cosmetic error: the creator judges a shot by a clip
    that another operation produced. The rule belongs where it is used, not
    three modules away in a whitelist that a future edit could widen.
    """
    if not isinstance(producer, Mapping):
        return None
    if producer.get("source") != "generation":
        return None
    op = producer.get("operation_id")
    return op if isinstance(op, str) and op else None


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
                    media_path=asset.media_path,
                    producer_operation_id=_generation_operation(asset.producer),
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
