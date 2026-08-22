"""Cross-project read-only Creation Workspace shell (TASK-026 / WSM1-B).

A local web application: a loopback read-only backend plus a browser client.
The backend is a **thin read-only query adapter** — its only core dependency
is the TASK-025 public query package (``ai_video_workflow.workspace``:
``WorkspaceQueryService`` / ``discover_projects`` / ``to_jsonable``). It never
writes business state, never calls a Provider, never runs / approves / retries
anything, holds no credential, and imports no core-internal types (ADR-0032
Security & Boundary Invariants; ADR-0010). Closing the backend or the browser
never touches committed work — the file-based core/CLI run and recover on
their own.

Framework selection (recorded in TASK-026): stdlib ``http.server`` on loopback
plus vanilla JS static assets, i.e. **zero new dependencies** (the project's
runtime dependency list is empty) and **no npm build chain**.
"""

from __future__ import annotations

from workspace_shell.app import Response, WorkspaceApp

__all__ = ["Response", "WorkspaceApp"]
