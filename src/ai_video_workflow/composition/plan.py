"""Composition planning: derive the ordered shot sequence (TASK-006).

``build_composition_plan`` reads only the in-memory ``ProjectData`` (it
never scans ``assets/media/``): it orders shots by (scene.sequence,
shot.sequence), selects the highest-version registered VideoAsset per
shot, rejects any shot without an asset (listing every gap), and
requires a single width/height/frame-rate spec across all shots (v1),
deriving the default profile from it.
"""

from __future__ import annotations

from dataclasses import dataclass

from ai_video_workflow.composition.errors import (
    InconsistentShotSpecError,
    MissingShotAssetError,
)
from ai_video_workflow.composition.profile import CompositionProfile
from ai_video_workflow.digests import config_digest
from ai_video_workflow.models import Shot, VideoAsset
from ai_video_workflow.project_data import ProjectData

_ENTRY_SCHEMA = "m1-composition-entry-v1"


@dataclass(frozen=True, slots=True)
class CompositionPlanEntry:
    scene_id: str
    shot_id: str
    asset_id: str
    asset_path: str
    asset_version: int
    input_digest: str


@dataclass(frozen=True, slots=True)
class CompositionPlan:
    project_id: str
    entries: tuple[CompositionPlanEntry, ...]
    profile: CompositionProfile


def build_composition_plan(
    *,
    data: ProjectData,
    profile: CompositionProfile | None = None,
) -> CompositionPlan:
    """Build the ordered composition plan from a validated ProjectData."""
    scene_sequence = {scene.scene_id: scene.sequence for scene in data.scenes}
    ordered_shots = sorted(
        data.shots,
        key=lambda shot: (scene_sequence.get(shot.scene_id, 0), shot.sequence),
    )
    if not ordered_shots:
        raise MissingShotAssetError("composition: the project has no shots")

    _require_uniform_spec(ordered_shots)
    effective_profile = profile or _derive_profile(ordered_shots[0])

    entries: list[CompositionPlanEntry] = []
    missing: list[str] = []
    for shot in ordered_shots:
        asset = _latest_asset_for(data.video_assets, shot.shot_id)
        if asset is None:
            missing.append(shot.shot_id)
            continue
        entries.append(
            CompositionPlanEntry(
                scene_id=shot.scene_id,
                shot_id=shot.shot_id,
                asset_id=asset.asset_id,
                asset_path=asset.path.as_posix(),
                asset_version=asset.version,
                input_digest=config_digest(
                    {
                        "schema": _ENTRY_SCHEMA,
                        "asset_id": asset.asset_id,
                        "asset_version": asset.version,
                        "asset_path": asset.path.as_posix(),
                    }
                ),
            )
        )
    if missing:
        raise MissingShotAssetError(
            f"composition: shots without a registered asset: {sorted(missing)}"
        )

    return CompositionPlan(
        project_id=data.project.project_id,
        entries=tuple(entries),
        profile=effective_profile,
    )


def _latest_asset_for(
    assets: tuple[VideoAsset, ...], shot_id: str
) -> VideoAsset | None:
    candidates = [asset for asset in assets if asset.shot_id == shot_id]
    if not candidates:
        return None
    return max(candidates, key=lambda asset: asset.version)


def _require_uniform_spec(shots: list[Shot]) -> None:
    specs = {(shot.width, shot.height, shot.frame_rate) for shot in shots}
    if len(specs) > 1:
        raise InconsistentShotSpecError(
            f"composition: shots have inconsistent specs: {sorted(specs)}"
        )


def _derive_profile(shot: Shot) -> CompositionProfile:
    return CompositionProfile(
        width=shot.width, height=shot.height, frame_rate=shot.frame_rate
    )
