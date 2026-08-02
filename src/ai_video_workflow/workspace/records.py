"""Read-only project-record snapshot for the workspace layer (TASK-025).

Mirrors the CLI's explicit record enumeration (``records/<kind>``) without
importing the CLI module, so the workspace query layer stays decoupled and
never pulls in provider/composition machinery. Every read routes through
``resolve_within_root`` (ADR-0004), so a symlinked record directory cannot
redirect reads outside the project root. Purely read-only.
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.manifest import StepManifest
from ai_video_workflow.models import (
    Character,
    GenerationTask,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.persistence import read_model_json
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.security.paths import resolve_within_root


def _load_dir(project_root: Path, relative: str, model_type) -> tuple:
    directory = resolve_within_root(project_root, relative)
    if not directory.is_dir():
        return ()
    return tuple(
        read_model_json(
            resolve_within_root(project_root, f"{relative}/{path.name}"), model_type
        )
        for path in sorted(directory.glob("*.json"))
    )


def load_project_snapshot(project_root: Path) -> ProjectData:
    """Load the validated ProjectData snapshot from the record directories."""
    project = read_model_json(
        resolve_within_root(project_root, "project.json"), Project
    )
    return ProjectData(
        project=project,
        characters=_load_dir(project_root, "records/characters", Character),
        scenes=_load_dir(project_root, "records/scenes", Scene),
        shots=_load_dir(project_root, "records/shots", Shot),
        generation_tasks=_load_dir(
            project_root, "records/generation-tasks", GenerationTask
        ),
        video_assets=_load_dir(project_root, "records/video-assets", VideoAsset),
        manifests=_load_dir(project_root, "manifests", StepManifest),
    )
