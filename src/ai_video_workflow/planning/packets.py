"""Per-shot task packets compiled from approved planning inputs (TASK-020).

A task packet is the single, digest-locked input record for one shot's
paid generation: prompt (text + version + digest), generation parameters,
resolved reuse assets (version + digest), the provider selection, the
original-currency quote, and the P50/P90 yen preview (P50 = one attempt,
P90 = two attempts — the workflow spec's per-shot retry ceiling).

Compilation is deterministic and idempotent: the packet's
``input_digest`` is computed over every input; recompiling with unchanged
inputs reuses the existing packet version, while changed inputs produce a
NEW version file (never an overwrite). Compilation requires the
``production_lock`` stage chain to be approved and fresh, so unapproved
or stale creative inputs are blocked before any packet exists.

No reservation is created and no provider is called here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.approval.workflow import require_stage_ready
from ai_video_workflow.budget.estimate import estimate_generation_cost
from ai_video_workflow.config.catalog import ProviderCatalog
from ai_video_workflow.config.project_config import ProjectConfig
from ai_video_workflow.config.selection import resolve_provider_selection
from ai_video_workflow.digests import config_digest
from ai_video_workflow.planning.documents import (
    PLANNING_DIR,
    PlannedShot,
    _load_json,
    _publish,
    load_prompt,
    load_shot_plan,
)
from ai_video_workflow.planning.errors import PacketError
from ai_video_workflow.profile.reuse import load_pack_version, load_reuse_refs
from ai_video_workflow.security.paths import resolve_within_root

PACKET_SCHEMA_VERSION = 1
PACKET_STAGE = "production_lock"

_PACKET_FILE_RE = re.compile(r"^(?P<shot>.+)_v(?P<version>[1-9][0-9]*)\.json$")


@dataclass(frozen=True, slots=True)
class TaskPacket:
    """One compiled, digest-locked generation input record for a shot."""

    schema_version: int
    shot_id: str
    packet_version: int
    input_digest: str
    prompt_id: str
    prompt_version: int
    prompt_digest: str
    prompt_text: str
    duration_seconds: int
    resolution: str
    capability: str
    model_id: str
    width: int
    height: int
    frame_rate: float
    first_frame_image: str | None
    reuse_assets: tuple[dict, ...]  # {asset_id, version, content_digest}
    provider_primary: str
    provider_fallback: str | None
    quote_minor_units: int
    quote_currency: str
    estimate_jpy: int
    p50_jpy: int
    p90_jpy: int


def packet_relpath(shot_id: str, version: int) -> str:
    return f"{PLANNING_DIR}/packets/{shot_id}_v{version}.json"


def compile_task_packets(
    project_root: Path,
    account_root: Path,
    catalog: ProviderCatalog,
    config: ProjectConfig,
) -> tuple[TaskPacket, ...]:
    """Compile one packet per planned shot from approved, fresh inputs."""
    # unapproved or stale upstream content blocks compilation entirely
    require_stage_ready(project_root, PACKET_STAGE)

    plan = load_shot_plan(project_root)
    project_refs = {ref.asset_id: ref for ref in load_reuse_refs(project_root)}
    packets: list[TaskPacket] = []
    for shot in plan.shots:
        packets.append(
            _compile_shot(
                project_root,
                account_root,
                catalog,
                config,
                plan.version,
                shot,
                project_refs,
            )
        )
    return tuple(packets)


def _compile_shot(
    project_root: Path,
    account_root: Path,
    catalog: ProviderCatalog,
    config: ProjectConfig,
    plan_version: int,
    shot: PlannedShot,
    project_refs: dict,
) -> TaskPacket:
    prompt = load_prompt(project_root, shot.prompt_id, shot.prompt_version)

    # reuse assets must be referenced by the project (version+digest locked)
    # and must still match their locked digests — drift fails closed.
    resolved_assets: list[dict] = []
    for asset_id in shot.reuse_assets:
        ref = project_refs.get(asset_id)
        if ref is None:
            raise PacketError(
                f"shot {shot.shot_id!r}: reuse asset {asset_id!r} is not "
                "referenced by this project"
            )
        pack = load_pack_version(account_root, ref.asset_id, ref.version)
        if pack.content_digest != ref.content_digest:
            raise PacketError(
                f"shot {shot.shot_id!r}: reuse asset {asset_id!r} content has "
                "drifted from the project's locked digest"
            )
        resolved_assets.append(
            {
                "asset_id": ref.asset_id,
                "version": ref.version,
                "content_digest": ref.content_digest,
            }
        )

    selection = resolve_provider_selection(
        config,
        catalog,
        shot.shot_id,
        capability=shot.capability,
        model_id=shot.model_id,
    )
    estimate = estimate_generation_cost(
        catalog,
        config.fx,
        selection.primary_provider_id,
        shot.model_id,
        resolution=shot.resolution,
        duration_seconds=shot.duration_seconds,
    )

    input_digest = config_digest(
        {
            "plan_version": plan_version,
            "shot_id": shot.shot_id,
            "prompt": {
                "id": prompt.prompt_id,
                "version": prompt.version,
                "digest": prompt.digest,
            },
            "duration_seconds": shot.duration_seconds,
            "resolution": shot.resolution,
            "capability": shot.capability,
            "model_id": shot.model_id,
            "width": shot.width,
            "height": shot.height,
            "frame_rate": shot.frame_rate,
            "first_frame_image": shot.first_frame_image,
            "reuse_assets": resolved_assets,
            "provider_primary": selection.primary_provider_id,
            "catalog_digest": config.catalog_digest,
        }
    )

    existing = _find_existing(project_root, shot.shot_id, input_digest)
    if existing is not None:
        return existing  # idempotent: unchanged inputs reuse the packet

    version = (_max_version(project_root, shot.shot_id) or 0) + 1
    packet = TaskPacket(
        schema_version=PACKET_SCHEMA_VERSION,
        shot_id=shot.shot_id,
        packet_version=version,
        input_digest=input_digest,
        prompt_id=prompt.prompt_id,
        prompt_version=prompt.version,
        prompt_digest=prompt.digest,
        prompt_text=prompt.text,
        duration_seconds=shot.duration_seconds,
        resolution=shot.resolution,
        capability=shot.capability,
        model_id=shot.model_id,
        width=shot.width,
        height=shot.height,
        frame_rate=shot.frame_rate,
        first_frame_image=shot.first_frame_image,
        reuse_assets=tuple(resolved_assets),
        provider_primary=selection.primary_provider_id,
        provider_fallback=selection.fallback_provider_id,
        quote_minor_units=estimate.original_amount_minor_units,
        quote_currency=estimate.original_currency,
        estimate_jpy=estimate.jpy,
        p50_jpy=estimate.jpy,
        p90_jpy=estimate.jpy * 2,  # per-shot retry ceiling: max 2 attempts
    )
    _publish(
        project_root, packet_relpath(shot.shot_id, version), packet_to_dict(packet)
    )
    return packet


def packet_to_dict(packet: TaskPacket) -> dict:
    return {
        "schema_version": packet.schema_version,
        "shot_id": packet.shot_id,
        "packet_version": packet.packet_version,
        "input_digest": packet.input_digest,
        "prompt": {
            "prompt_id": packet.prompt_id,
            "version": packet.prompt_version,
            "digest": packet.prompt_digest,
            "text": packet.prompt_text,
        },
        "duration_seconds": packet.duration_seconds,
        "resolution": packet.resolution,
        "capability": packet.capability,
        "model_id": packet.model_id,
        "width": packet.width,
        "height": packet.height,
        "frame_rate": packet.frame_rate,
        "first_frame_image": packet.first_frame_image,
        "reuse_assets": list(packet.reuse_assets),
        "provider": {
            "primary": packet.provider_primary,
            "fallback": packet.provider_fallback,
        },
        "quote": {
            "amount_minor_units": packet.quote_minor_units,
            "currency": packet.quote_currency,
        },
        "estimate_jpy": packet.estimate_jpy,
        "p50_jpy": packet.p50_jpy,
        "p90_jpy": packet.p90_jpy,
    }


def parse_packet(raw: object) -> TaskPacket:
    if not isinstance(raw, dict):
        raise PacketError("packet: expected a JSON object")
    try:
        prompt = raw["prompt"]
        provider = raw["provider"]
        quote = raw["quote"]
        return TaskPacket(
            schema_version=raw["schema_version"],
            shot_id=raw["shot_id"],
            packet_version=raw["packet_version"],
            input_digest=raw["input_digest"],
            prompt_id=prompt["prompt_id"],
            prompt_version=prompt["version"],
            prompt_digest=prompt["digest"],
            prompt_text=prompt["text"],
            duration_seconds=raw["duration_seconds"],
            resolution=raw["resolution"],
            capability=raw["capability"],
            model_id=raw["model_id"],
            width=raw["width"],
            height=raw["height"],
            frame_rate=raw["frame_rate"],
            first_frame_image=raw["first_frame_image"],
            reuse_assets=tuple(raw["reuse_assets"]),
            provider_primary=provider["primary"],
            provider_fallback=provider["fallback"],
            quote_minor_units=quote["amount_minor_units"],
            quote_currency=quote["currency"],
            estimate_jpy=raw["estimate_jpy"],
            p50_jpy=raw["p50_jpy"],
            p90_jpy=raw["p90_jpy"],
        )
    except (KeyError, TypeError) as exc:
        raise PacketError(f"packet: malformed document ({exc})") from exc


def load_packet(project_root: Path, shot_id: str, version: int) -> TaskPacket:
    packet = parse_packet(
        _load_json(project_root, packet_relpath(shot_id, version), "task packet")
    )
    if packet.shot_id != shot_id or packet.packet_version != version:
        raise PacketError(
            f"packet file declares ({packet.shot_id!r}, v{packet.packet_version}),"
            f" expected ({shot_id!r}, v{version})"
        )
    return packet


def _packets_dir(project_root: Path) -> Path:
    return resolve_within_root(project_root, f"{PLANNING_DIR}/packets")


def _max_version(project_root: Path, shot_id: str) -> int | None:
    base = _packets_dir(project_root)
    if not base.is_dir():
        return None
    versions = []
    for path in base.iterdir():
        match = _PACKET_FILE_RE.match(path.name)
        if match is not None and match.group("shot") == shot_id:
            versions.append(int(match.group("version")))
    return max(versions) if versions else None


def _find_existing(
    project_root: Path, shot_id: str, input_digest: str
) -> TaskPacket | None:
    top = _max_version(project_root, shot_id)
    if top is None:
        return None
    for version in range(top, 0, -1):
        try:
            packet = load_packet(project_root, shot_id, version)
        except PacketError:
            continue
        if packet.input_digest == input_digest:
            return packet
    return None


# --- bridge to the paid coordinator (TASK-016) ------------------------------


def packet_to_paid_request(
    packet: TaskPacket, *, task_id: str, operation_id: str, stage: str
):
    """Build the TASK-016 ``PaidRequest`` losslessly from a packet."""
    from ai_video_workflow.app.paid_coordinator import PaidRequest

    return PaidRequest(
        task_id=task_id,
        shot_id=packet.shot_id,
        operation_id=operation_id,
        stage=stage,
        capability=packet.capability,
        model_id=packet.model_id,
        resolution=packet.resolution,
        duration_seconds=packet.duration_seconds,
        first_frame_image=packet.first_frame_image,
    )


def packet_to_generation_spec(packet: TaskPacket):
    """Build the TASK-016 ``GenerationSpec`` losslessly from a packet."""
    from ai_video_workflow.app.paid_coordinator import GenerationSpec

    return GenerationSpec(
        model_id=packet.model_id,
        capability=packet.capability,
        resolution=packet.resolution,
        duration_seconds=packet.duration_seconds,
        width=packet.width,
        height=packet.height,
        frame_rate=packet.frame_rate,
        prompt=packet.prompt_text,
        first_frame_image=packet.first_frame_image,
    )
