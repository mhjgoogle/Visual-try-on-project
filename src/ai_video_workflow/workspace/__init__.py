"""Cross-project read-only Creation Workspace query layer (TASK-025 / WSM1-A).

The single query entry point over authoritative WFM1 files and events.
UI/DB-agnostic, read-only, on-demand (no persisted projection cache), and
strictly decoupled from Providers, the CLI's write paths, and any UI. See
docs/design/workspace-query-contract.md (WQ-01..WQ-14) and ADR-0031.
"""

from __future__ import annotations

from ai_video_workflow.workspace.discovery import (
    DiscoveredProject,
    discover_projects,
)
from ai_video_workflow.workspace.envelope import (
    QUERY_CONTRACT_VERSION,
    Field,
    Problem,
    ProblemCategory,
    Provenance,
    QueryResult,
    to_jsonable,
)
from ai_video_workflow.workspace.errors import AccountScopeError, WorkspaceError
from ai_video_workflow.workspace.service import WorkspaceQueryService

__all__ = [
    "QUERY_CONTRACT_VERSION",
    "AccountScopeError",
    "DiscoveredProject",
    "Field",
    "Problem",
    "ProblemCategory",
    "Provenance",
    "QueryResult",
    "WorkspaceError",
    "WorkspaceQueryService",
    "discover_projects",
    "to_jsonable",
]
