"""Per-lock stage-target validation for WFM2 creative locks (TASK-034).

Each human stage lock (concept / screenplay / av_design / production) is only
admissible when its refined artifact contract holds: the lock's structured index
exists with checklist evidence, every required upstream creative artifact is
published AND digest-bound into the lock's ``input_refs`` (so an upstream
version change invalidates the lock, ADR-0037 P2/P3), the payload threads
through, and — where the baseline requires it — the three-representative-shot
pilot gate has passed. This module reports problems; it never approves anything
(the human ``approval`` gate is unchanged) and never calls a Provider.

``production_lock`` keeps its WFM1 surface: the packet compile + approval stay in
``planning``/``approval``; here we only assert the S3 creative *design* indexes
(shot list/card/route/provider plan/budget/preflight) are all published.
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.creative import catalog, pilot
from ai_video_workflow.creative.catalog import (
    AV_DESIGN_LOCK,
    CONCEPT_LOCK,
    PRODUCTION_LOCK,
    SURFACE_CREATIVE,
)
from ai_video_workflow.creative.errors import CreativeValidationError
from ai_video_workflow.creative.index import (
    CreativeArtifact,
    artifacts_of_kind,
    latest_artifacts,
)

_LOCK_BY_APPROVAL = {row.approval_stage: row for row in catalog.lock_steps()}


def _binds(lock: CreativeArtifact, upstream: CreativeArtifact) -> bool:
    return any(
        r.stage == upstream.stage
        and r.ref == upstream.ref
        and r.version == upstream.version
        and r.content_digest == upstream.content_digest
        for r in lock.input_refs
    )


def validate_lock(project_root: Path, approval_stage: str) -> tuple[str, ...]:
    """Problems (empty == ready) blocking ``approval_stage`` at the creative layer."""
    lock_row = _LOCK_BY_APPROVAL.get(approval_stage)
    if lock_row is None:
        raise CreativeValidationError(f"not a creative lock stage: {approval_stage!r}")

    if approval_stage == PRODUCTION_LOCK:
        return _production_problems(project_root)

    # Resolve the lock by KIND (its stable ref may differ from its kind). Exactly
    # one lock artifact of this kind is expected; zero or many are fail-closed.
    lock_arts = artifacts_of_kind(
        project_root, lock_row.stage, lock_row.kind, lock_row.step_id
    )
    if not lock_arts:
        return (f"{lock_row.step_id} {lock_row.kind} has not been published",)
    if len(lock_arts) > 1:
        return (
            f"{lock_row.kind} is ambiguous: "
            f"{len(lock_arts)} artifacts of this kind published",
        )
    lock_art = lock_arts[0]

    problems = []
    if not lock_art.checklist:
        problems.append(f"{lock_row.kind} has no checklist evidence")

    # Resolve each required input by KIND, then require the lock to bind at least
    # one of them by digest.
    for input_id in lock_row.inputs:
        row = catalog.step(input_id)
        if row.surface != SURFACE_CREATIVE:
            continue
        candidates = artifacts_of_kind(project_root, row.stage, row.kind, row.step_id)
        if not candidates:
            problems.append(f"required input {row.kind} ({input_id}) not published")
            continue
        if not any(_binds(lock_art, u) for u in candidates):
            problems.append(
                f"{lock_row.kind} does not bind a current {row.kind} ({input_id}) "
                "(stale or unlinked lineage)"
            )

    problems.extend(_gate_problems(project_root, approval_stage, lock_art))
    return tuple(problems)


def _input_binds(carrier: CreativeArtifact, upstream: CreativeArtifact) -> bool:
    return any(
        r.stage == upstream.stage
        and r.ref == upstream.ref
        and r.version == upstream.version
        and r.content_digest == upstream.content_digest
        for r in carrier.input_refs
    )


def _production_problems(project_root: Path) -> tuple[str, ...]:
    """S3 formal compile/approval stay on the WFM1 surface; the creative layer
    asserts each S3 design index is published (type-correct), carries checklist
    evidence, and binds EVERY declared creative input by digest — including the
    cross-stage prerequisites (screenplay / AV / format locks, feasibility) — so
    an incomplete or stale S3 production design cannot read as ready. A kind may
    have many refs (e.g. per-shot shot_card). Each prerequisite lock's own
    readiness is enforced at its gate; here we require the binding to exist.
    """
    arts = latest_artifacts(project_root, "s3")
    by_kind: dict[str, list[CreativeArtifact]] = {}
    for a in arts:
        by_kind.setdefault(a.kind, []).append(a)

    problems: list[str] = []
    for row in catalog.steps("s3"):
        if row.surface != SURFACE_CREATIVE:
            continue
        matches = [a for a in by_kind.get(row.kind, []) if a.step_id == row.step_id]
        if not matches:
            problems.append(f"S3 design index {row.kind} ({row.step_id}) not published")
            continue
        inputs = [
            catalog.step(i)
            for i in row.inputs
            if catalog.step(i).surface == SURFACE_CREATIVE
        ]
        for artifact in matches:
            if not artifact.checklist:
                problems.append(
                    f"{artifact.ref} ({row.kind}) has no checklist evidence"
                )
            for irow in inputs:
                candidates = (
                    by_kind.get(irow.kind, [])
                    if irow.stage == "s3"
                    else artifacts_of_kind(
                        project_root, irow.stage, irow.kind, irow.step_id
                    )
                )
                if not any(_input_binds(artifact, u) for u in candidates):
                    problems.append(
                        f"{artifact.ref} ({row.kind}) does not bind a current "
                        f"{irow.kind} ({irow.step_id})"
                    )
    return tuple(problems)


def _gate_problems(
    project_root: Path, approval_stage: str, lock_art: CreativeArtifact
) -> list[str]:
    # Payload continuity is enforced structurally: publish-time input binding
    # requires load_review / visual & audio bibles to bind the load declaration
    # (they are its catalog consumers), so it always reaches the review and AV
    # design layers. The lock gates add only the bound-probe pilot check.
    if approval_stage == CONCEPT_LOCK:
        return pilot.bound_probe_problems(
            project_root, lock_art, stage="l0", kind="concept_probe", step_id="L0-06"
        )
    if approval_stage == AV_DESIGN_LOCK:
        return pilot.bound_probe_problems(
            project_root, lock_art, stage="s2", kind="visual_probe", step_id="S2-T06"
        )
    return []


def require_lock_ready(project_root: Path, approval_stage: str) -> None:
    problems = validate_lock(project_root, approval_stage)
    if problems:
        raise CreativeValidationError(
            f"{approval_stage} creative target not ready: " + "; ".join(problems)
        )
