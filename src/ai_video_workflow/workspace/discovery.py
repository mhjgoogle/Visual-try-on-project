"""Cross-project discovery for the workspace layer (TASK-025 / WQ-11).

A project is any immediate subdirectory of the account root that carries a
``config/wfm1.json`` — the same account-root semantics the budget layer
already uses (a project = a subdir with the project config), so no new
discovery mechanism is introduced (query contract §3 WQ-11, ADR-0031
decision 4). Read-only: only presence is inspected, nothing is written.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.config.project_config import PROJECT_CONFIG_RELPATH


@dataclass(frozen=True, slots=True)
class DiscoveredProject:
    """One discovered project: its stable directory name and root path."""

    name: str  # the account-relative directory name (stable id for discovery)
    root: Path


def discover_projects(account_root: Path) -> tuple[DiscoveredProject, ...]:
    """Return every project under ``account_root``, ordered by name.

    Ordering is deterministic (directory name). A directory without a
    readable ``config/wfm1.json`` is simply not a project and is skipped;
    corruption of a discovered project's other files is a per-query concern,
    not a discovery concern.
    """
    if not account_root.is_dir():
        return ()
    found: list[DiscoveredProject] = []
    for child in sorted(account_root.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or child.is_symlink():
            continue
        if (child / PROJECT_CONFIG_RELPATH).is_file():
            found.append(DiscoveredProject(name=child.name, root=child))
    return tuple(found)
