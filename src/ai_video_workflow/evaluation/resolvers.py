"""Concrete authoritative-fact resolvers for the evaluation service (WFM1).

:class:`EvaluationService` depends only on the :class:`AuthoritativeFacts`
protocol; this module supplies the concrete WFM1 wiring so the domain service
stays free of any cross-domain import. It resolves references **read-only** and
never copies, rewrites, or writes authoritative facts (ADR-0034 P2):

- **Goals** — the project-goals baseline version is the highest project profile
  version on disk (TASK-018 / ADR-0011); a project with no profile resolves to
  ``None`` (fail-closed at write, "goals missing" at read).
- **Targets** — the WFM1 evaluatable artifact is the imported shot video, whose
  authoritative ``(asset_id, version, sha256)`` triple lives in the append-only
  QCD ``asset_imported`` event (ADR-0003). A target whose ``(ref, version)``
  matches such an event resolves to that event's ``sha256``; anything else does
  not resolve (fail-closed). Because ``asset_id`` already encodes its version
  (``asset-<task>-v<n>``), a ref has exactly one authoritative version, so
  ``latest_version`` is that version — cross-ref supersession is a query-layer
  concern (TASK-028 step 4), not inferred here.

Other target ref-kinds (final output, reuse packs) are resolved as their
read-only query wiring lands; until then they fail closed, which is the correct
posture for an unverifiable target (ADR-0034 P3).
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.evaluation.service import TargetFact
from ai_video_workflow.profile.errors import ProfileNotFoundError
from ai_video_workflow.profile.project_profile import load_project_profile
from ai_video_workflow.qcd.events import QcdEventType
from ai_video_workflow.qcd.log import read_events


class WorkflowAuthoritativeFacts:
    """Resolve evaluation goals/targets against authoritative WFM1 facts."""

    def current_goals_version(self, project_root: Path) -> int | None:
        """Highest project-profile version on disk, or ``None`` if none exists."""
        try:
            return load_project_profile(project_root).version
        except ProfileNotFoundError:
            return None

    def resolve_target(
        self, project_root: Path, *, ref: str, version: int
    ) -> TargetFact:
        """Resolve a shot-video target to its authoritative ``asset_imported`` fact."""
        for event in read_events(project_root):
            if event.event_type is not QcdEventType.ASSET_IMPORTED:
                continue
            if event.payload.get("asset_id") == ref and (
                event.payload.get("version") == version
            ):
                digest = event.payload.get("sha256")
                return TargetFact(
                    exists=True,
                    content_digest=str(digest) if digest is not None else None,
                    latest_version=version,
                )
        return TargetFact(exists=False, content_digest=None, latest_version=None)
