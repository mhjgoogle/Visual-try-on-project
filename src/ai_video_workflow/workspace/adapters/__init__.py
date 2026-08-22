"""Read-only source adapters, one per authoritative domain (TASK-025).

Each adapter reads exactly one domain, declares supported schema versions,
and fails closed with structured problems. Cross-domain composition is the
query layer's job, never an adapter's (ADR-0031 decision 3).
"""

from __future__ import annotations

from ai_video_workflow.workspace.adapters import (
    delivery,
    execution,
    plan,
    project,
)

__all__ = ["delivery", "execution", "plan", "project"]
