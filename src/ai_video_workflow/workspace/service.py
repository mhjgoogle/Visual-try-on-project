"""The single read-only workspace query entry point (TASK-025 / WSM1-A).

``WorkspaceQueryService`` is the one place CLI, tests, and any future UI go
to run the WQ-01..WQ-18 queries. It is strictly read-only: it never writes
business state, never calls a Provider, never imports UI, never reads
credential values, and holds no persistent projection cache — every query
is evaluated on demand from authoritative files (ADR-0031 decision 2), so
"delete the projection and rebuild" is trivially satisfied.

The clock is injected so results are deterministic under test.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from ai_video_workflow.workspace import queries
from ai_video_workflow.workspace.envelope import QueryResult
from ai_video_workflow.workspace.errors import AccountScopeError


class WorkspaceQueryService:
    """Read-only cross-project query service."""

    def __init__(
        self,
        account_root: Path,
        *,
        clock: Callable[[], datetime],
    ) -> None:
        self._account_root = account_root
        self._clock = clock

    def _now(self) -> str:
        return self._clock().isoformat()

    def _project(self, project_root: Path) -> Path:
        """Validate the project belongs to this service's account root.

        A project is an immediate child of the account root (the same
        containment discovery uses); a project from any other location is
        an account-scope violation and is refused, so a caller cannot mix
        accounts through a single-project query.
        """
        try:
            resolved = project_root.resolve()
            account = self._account_root.resolve()
        except OSError as exc:
            raise AccountScopeError(f"unresolvable project root: {exc}") from exc
        if resolved.parent != account:
            raise AccountScopeError(
                f"project {project_root} is not under account root {self._account_root}"
            )
        return project_root

    # --- single-project queries ------------------------------------------

    def project_plan(self, project_root: Path) -> QueryResult:
        return queries.project_plan(self._project(project_root), self._now())

    def project_status(self, project_root: Path) -> QueryResult:
        return queries.project_status(self._project(project_root), self._now())

    def lineage_upstream(self, project_root: Path, artifact_ref: str) -> QueryResult:
        return queries.lineage_upstream(
            self._project(project_root), artifact_ref, self._now()
        )

    def lineage_downstream(self, project_root: Path, object_ref: str) -> QueryResult:
        return queries.lineage_downstream(
            self._project(project_root), object_ref, self._now()
        )

    def prompt_history(self, project_root: Path, prompt_id: str) -> QueryResult:
        return queries.prompt_history(
            self._project(project_root), prompt_id, self._now()
        )

    def shot_attempts(self, project_root: Path, shot_id: str) -> QueryResult:
        return queries.shot_attempts(self._project(project_root), shot_id, self._now())

    def cost_breakdown(self, project_root: Path) -> QueryResult:
        return queries.cost_breakdown(self._project(project_root), self._now())

    def evaluation_decision(self, project_root: Path) -> QueryResult:
        return queries.evaluation_decision(self._project(project_root), self._now())

    def evaluation_domain(self, project_root: Path) -> QueryResult:
        return queries.evaluation_domain(self._project(project_root), self._now())

    def action_center(self, project_root: Path) -> QueryResult:
        return queries.action_center(self._project(project_root), self._now())

    def project_multimedia(self, project_root: Path) -> QueryResult:
        return queries.project_multimedia(self._project(project_root), self._now())

    def recent_problems(self, project_root: Path) -> QueryResult:
        return queries.recent_problems(self._project(project_root), self._now())

    def rebuild_check(self, project_root: Path, query_id: str, **params) -> QueryResult:
        return queries.rebuild_check(
            self, self._project(project_root), query_id, self._now(), **params
        )

    def reuse_usage(self, asset_id: str, version: int) -> QueryResult:
        return queries.reuse_usage(self._account_root, asset_id, version, self._now())

    def approval_audit(self, project_root: Path) -> QueryResult:
        return queries.approval_audit(self._project(project_root), self._now())

    def budget_standing(self, project_root: Path) -> QueryResult:
        return queries.budget_standing(
            self._project(project_root), self._account_root, self._now()
        )

    # --- account-level query ---------------------------------------------

    def cross_project_index(self) -> QueryResult:
        return queries.cross_project_index(self._account_root, self._now())

    def cross_project_analytics(self) -> QueryResult:
        return queries.cross_project_analytics(self._account_root, self._now())

    def recommendations(self) -> QueryResult:
        return queries.recommendations(self._account_root, self._now())
