"""Concrete authoritative-target resolver for the action service (WFM1).

The feedback/action domain only *references* targets (ADR-0035 P2); staleness is
derived by re-resolving a target's authoritative content digest. This reads the
QCD ``asset_imported`` fact read-only (the WFM1 evaluatable artifact) and never
writes or copies it. Other target ref-kinds fail closed (``exists=False``) until
their read-only wiring lands, which is the correct posture for an unverifiable
target (ADR-0035 §2 fail-closed).
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.action.service import ResolvedTarget
from ai_video_workflow.project_data import owning_project_id
from ai_video_workflow.qcd.events import QcdEventType
from ai_video_workflow.qcd.log import QcdLogError, read_events


class WorkflowTargetResolver:
    """Resolve action targets against authoritative WFM1 QCD asset facts."""

    def resolve_target(
        self, project_root: Path, *, ref: str, version: int
    ) -> ResolvedTarget:
        # A corrupt/unreadable authoritative QCD log must NOT raise into a
        # read-only query (fail-closed contract): an unresolvable target reads
        # as absent, which drives the safe outcome (write refuses, read marks
        # the Action stale). QCD-log integrity is surfaced by WQ-07/WQ-09.
        try:
            events = read_events(project_root)
        except QcdLogError:
            return ResolvedTarget(exists=False, content_digest=None)
        # Only this project's own facts may bind/refresh its targets
        # (cross-project integrity). If the project identity is unknown
        # (missing/unreadable project.json) we cannot verify ownership, so we
        # fail CLOSED — nothing resolves — rather than accept foreign facts.
        owner = owning_project_id(project_root)
        if owner is None:
            return ResolvedTarget(exists=False, content_digest=None)
        for event in events:
            if event.event_type is not QcdEventType.ASSET_IMPORTED:
                continue
            if event.project_id != owner:
                continue
            if event.payload.get("asset_id") == ref and (
                event.payload.get("version") == version
            ):
                digest = event.payload.get("sha256")
                return ResolvedTarget(
                    exists=True,
                    content_digest=str(digest) if digest is not None else None,
                )
        return ResolvedTarget(exists=False, content_digest=None)
