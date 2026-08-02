"""Approval + planning + packet source adapters (read-only, TASK-025).

These serve the plan-definition and creative-version queries. The
stage-plan registry and the L0-S7 I/O contract give the full plan even for
an unrun project (query contract §5); real approval/planning facts are
layered on when present.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.approval.errors import ApprovalError
from ai_video_workflow.approval.workflow import (
    StageInfo,
    StageState,
    read_audit,
    stage_plan,
    stage_status,
)
from ai_video_workflow.planning.documents import (
    ShotPlan,
    latest_shot_plan_version,
    load_prompt,
    load_shot_plan,
)
from ai_video_workflow.planning.errors import PacketError, PlanningError
from ai_video_workflow.planning.packets import TaskPacket, load_packet
from ai_video_workflow.workspace.adapters.base import corrupt, schema_supported
from ai_video_workflow.workspace.envelope import Problem

_PLAN_SCHEMAS = frozenset({1})
_PACKET_SCHEMAS = frozenset({1})


@dataclass(frozen=True, slots=True)
class ApprovalSources:
    plan: tuple[StageInfo, ...]  # fixed registry: always available
    states: tuple[StageState, ...]
    audit: tuple[dict, ...]
    problems: tuple[Problem, ...]


def read_approvals(project_root: Path) -> ApprovalSources:
    problems: list[Problem] = []
    plan = stage_plan()  # pure registry, no IO
    states: tuple[StageState, ...] = ()
    try:
        states = stage_status(project_root)
    except ApprovalError as exc:
        problems.append(corrupt("approval", str(exc)))
    except Exception as exc:
        problems.append(corrupt("approval", str(exc)))
    audit: tuple[dict, ...] = ()
    try:
        audit = read_audit(project_root)
    except Exception as exc:
        problems.append(corrupt("approval_audit", str(exc), readiness_failed=False))
    return ApprovalSources(
        plan=plan, states=states, audit=audit, problems=tuple(problems)
    )


@dataclass(frozen=True, slots=True)
class PlanningSources:
    shot_plan: ShotPlan | None
    packets: tuple[TaskPacket, ...]
    problems: tuple[Problem, ...]


def read_planning(project_root: Path, shots: tuple[str, ...] = ()) -> PlanningSources:
    """Read the latest shot plan and each shot's latest task packet.

    ``shots`` narrows packet loading; empty means "the plan's shots".
    """
    problems: list[Problem] = []
    shot_plan: ShotPlan | None = None
    # distinguish "no plan yet" (unrun, not a problem) from "a plan file
    # exists but won't parse" (corrupt, fail-closed): an absent latest
    # version means unrun; a present version that fails to load is corrupt.
    present = latest_shot_plan_version(project_root)
    if present is not None:
        try:
            shot_plan = load_shot_plan(project_root)
        except Exception as exc:
            problems.append(corrupt("shot_plan", str(exc)))
    if shot_plan is not None:
        p = schema_supported(
            shot_plan.schema_version, _PLAN_SCHEMAS, source="shot_plan"
        )
        if p is not None:
            problems.append(p)
            shot_plan = None

    shot_ids = shots or (tuple(s.shot_id for s in shot_plan.shots) if shot_plan else ())
    packets: list[TaskPacket] = []
    for shot_id in shot_ids:
        packet = _latest_packet(project_root, shot_id, problems)
        if packet is not None:
            packets.append(packet)
    return PlanningSources(
        shot_plan=shot_plan, packets=tuple(packets), problems=tuple(problems)
    )


def _latest_packet(
    project_root: Path, shot_id: str, problems: list[Problem]
) -> TaskPacket | None:
    base = project_root / "planning" / "packets"
    if not base.is_dir():
        return None
    versions = []
    for path in base.glob(f"{shot_id}_v*.json"):
        try:
            versions.append(int(path.stem.rsplit("_v", 1)[1]))
        except (ValueError, IndexError):
            continue
    if not versions:
        return None
    try:
        packet = load_packet(project_root, shot_id, max(versions))
    except (PacketError, PlanningError) as exc:
        problems.append(corrupt("packet", str(exc), shot=shot_id))
        return None
    p = schema_supported(
        packet.schema_version, _PACKET_SCHEMAS, source="packet", shot=shot_id
    )
    if p is not None:
        problems.append(p)
        return None
    return packet


def prompt_versions(
    project_root: Path, prompt_id: str
) -> tuple[list, tuple[Problem, ...]]:
    """Return the full version chain of one prompt (ascending)."""
    base = project_root / "planning" / "prompts" / prompt_id
    problems: list[Problem] = []
    if not base.is_dir():
        return [], ()
    versions = sorted(
        int(p.stem[1:]) for p in base.glob("v*.json") if p.stem[1:].isdigit()
    )
    chain = []
    for v in versions:
        try:
            chain.append(load_prompt(project_root, prompt_id, v))
        except PlanningError as exc:
            problems.append(corrupt("prompt", str(exc), prompt=prompt_id))
    return chain, tuple(problems)


def latest_plan_version(project_root: Path) -> int | None:
    return latest_shot_plan_version(project_root)
