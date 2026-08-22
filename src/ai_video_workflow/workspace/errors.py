"""Typed errors for the read-only workspace query layer (TASK-025)."""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class WorkspaceError(AiVideoWorkflowError):
    """Base error for the workspace query layer."""


class AccountScopeError(WorkspaceError):
    """A project root does not belong to the service's account root.

    Raised at the service boundary — not a data problem but an API misuse /
    account-scope violation — so a caller cannot mix a project from one
    account into another account's read model.
    """
