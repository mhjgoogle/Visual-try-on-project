"""Project / profile / reuse / config source adapters (read-only, TASK-025)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.config.errors import ConfigError
from ai_video_workflow.config.project_config import (
    PROJECT_CONFIG_SCHEMA_VERSION,
    ProjectConfig,
    load_project_config,
)
from ai_video_workflow.profile.errors import ProfileNotFoundError
from ai_video_workflow.profile.project_profile import (
    PROFILE_SCHEMA_VERSION,
    ProjectProfile,
    load_project_profile,
)
from ai_video_workflow.profile.reuse import ReuseRef, load_reuse_refs
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.workspace.adapters.base import corrupt, schema_supported
from ai_video_workflow.workspace.envelope import Problem
from ai_video_workflow.workspace.records import load_project_snapshot

_PROFILE_SCHEMAS = frozenset({PROFILE_SCHEMA_VERSION})
_CONFIG_SCHEMAS = frozenset({PROJECT_CONFIG_SCHEMA_VERSION})


@dataclass(frozen=True, slots=True)
class ProjectSources:
    """A project's read-only snapshot with any load problems collected."""

    data: ProjectData | None
    profile: ProjectProfile | None
    config: ProjectConfig | None
    reuse_refs: tuple[ReuseRef, ...]
    problems: tuple[Problem, ...]


def read_project(project_root: Path) -> ProjectSources:
    """Read a project's core sources, fail-closed on corruption.

    A missing profile or config is a real problem for most queries but the
    snapshot still returns what it could parse so partial views work.
    """
    problems: list[Problem] = []

    data: ProjectData | None = None
    try:
        data = load_project_snapshot(project_root)
    except Exception as exc:  # invalid/broken records fail closed
        problems.append(corrupt("project", str(exc), ref=str(project_root)))

    profile: ProjectProfile | None = None
    try:
        profile = load_project_profile(project_root)
    except ProfileNotFoundError:
        profile = None  # a truly ABSENT profile is optional, not a problem
    except Exception as exc:
        # a malformed / unsupported / unreadable profile is a real problem
        problems.append(corrupt("profile", str(exc), readiness_failed=False))
    if profile is not None:
        p = schema_supported(profile.schema_version, _PROFILE_SCHEMAS, source="profile")
        if p is not None:
            problems.append(p)
            profile = None

    config: ProjectConfig | None = None
    try:
        config = load_project_config(project_root)
    except ConfigError as exc:
        problems.append(corrupt("config", str(exc), readiness_failed=False))
    except Exception as exc:
        problems.append(corrupt("config", str(exc), readiness_failed=False))
    if config is not None:
        p = schema_supported(
            config.schema_version,
            _CONFIG_SCHEMAS,
            source="config",
            readiness_failed=False,
        )
        if p is not None:
            problems.append(p)
            config = None

    reuse_refs: tuple[ReuseRef, ...] = ()
    try:
        reuse_refs = load_reuse_refs(project_root)
    except Exception as exc:
        problems.append(corrupt("reuse_refs", str(exc), readiness_failed=False))

    return ProjectSources(
        data=data,
        profile=profile,
        config=config,
        reuse_refs=reuse_refs,
        problems=tuple(problems),
    )
