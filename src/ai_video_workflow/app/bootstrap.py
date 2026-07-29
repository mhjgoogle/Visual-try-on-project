"""Generation task bootstrap and explicit redo (TASK-007).

``bootstrap_generation_tasks`` creates, for each shot, the initial
GenerationTask (PENDING, provider_id=None) and the generation
StepManifest that TASK-004 requires to pre-exist — nothing else (no
instruction, no ProviderRequest, no staging_ref, no provider binding).
Task identity is deterministic (``task-<shot-id>-1``); an existing
equivalent task in any status is never auto-recreated, its companion
manifest is filled if missing (partial-crash recovery), and a
non-equivalent existing file is a conflict. A new attempt is created
only explicitly through ``create_redo_task``; ordinary bootstrap never
creates a redo.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.app.contracts import (
    generation_config_digest,
    generation_input_digest,
)
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus, Shot
from ai_video_workflow.persistence import read_model_json, write_model_json
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.events import build_task_created_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.validation import validate_utc_datetime


class BootstrapError(AiVideoWorkflowError):
    """Base error for bootstrap failures."""


class TaskAlreadyExistsError(BootstrapError):
    """Raised when an existing file at the task's path is not equivalent."""


@dataclass(frozen=True, slots=True)
class BootstrapOutcome:
    created: tuple[str, ...]
    skipped: tuple[str, ...]
    emitted_event_ids: tuple[str, ...]


def initial_task_id(shot_id: str) -> str:
    return f"task-{shot_id}-1"


def task_record_path(project_root: Path, task_id: str) -> Path:
    return project_root / "records" / "generation-tasks" / f"{task_id}.json"


def generation_manifest_path(project_root: Path, task_id: str) -> Path:
    return project_root / "manifests" / f"generation-{task_id}.json"


def bootstrap_generation_tasks(
    *,
    project_root: Path,
    data: ProjectData,
    provider_id: str,
    now: datetime,
) -> BootstrapOutcome:
    """Create the initial task + generation manifest for each shot."""
    validate_utc_datetime(now, field_name="now")
    created: list[str] = []
    skipped: list[str] = []
    emitted: list[str] = []
    for shot in data.shots:
        task_id = initial_task_id(shot.shot_id)
        outcome = _ensure_task(
            project_root=project_root,
            shot=shot,
            task_id=task_id,
            provider_id=provider_id,
            origin="bootstrap",
            redo_of_task_id=None,
            project_id=data.project.project_id,
            now=now,
        )
        if outcome is None:
            skipped.append(task_id)
        else:
            created.append(task_id)
            emitted.append(outcome)
    return BootstrapOutcome(
        created=tuple(created),
        skipped=tuple(skipped),
        emitted_event_ids=tuple(emitted),
    )


def create_redo_task(
    *,
    project_root: Path,
    data: ProjectData,
    shot_id: str,
    provider_id: str,
    now: datetime,
) -> BootstrapOutcome:
    """Explicitly create a new attempt (task) for a shot.

    Persists a new deterministic task_id (``task-<shot-id>-<n+1>``),
    records ``redo_of_task_id``, and creates the new generation
    manifest. It neither creates nor returns an orchestration
    operation_id: each later prepare/submit takes a caller-supplied one.
    """
    validate_utc_datetime(now, field_name="now")
    shot = _find_shot(data, shot_id)
    highest, previous_task_id = _highest_attempt(data, shot_id)
    if previous_task_id is None:
        raise BootstrapError(
            f"redo: no existing task for shot {shot_id}; bootstrap first"
        )
    # retry identity: if the shot's current top attempt is itself an unused
    # (PENDING) *redo* attempt, a repeated redo reuses it rather than
    # stacking another empty attempt (v2 -> v3 -> ...). The first redo of
    # the original bootstrap attempt (number 1) is always allowed.
    top_task = _find_task(data, previous_task_id)
    if (
        highest > 1
        and top_task is not None
        and top_task.status is GenerationTaskStatus.PENDING
    ):
        return BootstrapOutcome(
            created=(), skipped=(previous_task_id,), emitted_event_ids=()
        )
    new_task_id = f"task-{shot_id}-{highest + 1}"
    event_id = _ensure_task(
        project_root=project_root,
        shot=shot,
        task_id=new_task_id,
        provider_id=provider_id,
        origin="redo",
        redo_of_task_id=previous_task_id,
        project_id=data.project.project_id,
        now=now,
    )
    if event_id is None:
        return BootstrapOutcome(
            created=(), skipped=(new_task_id,), emitted_event_ids=()
        )
    return BootstrapOutcome(
        created=(new_task_id,), skipped=(), emitted_event_ids=(event_id,)
    )


def _ensure_task(
    *,
    project_root: Path,
    shot: Shot,
    task_id: str,
    provider_id: str,
    origin: str,
    redo_of_task_id: str | None,
    project_id: str,
    now: datetime,
) -> str | None:
    """Create (or complete) the task + manifest; return the emitted event id.

    Returns None when a fully-bootstrapped equivalent task already exists
    (a no-op skip). A companion manifest is never overwritten: an existing
    one must be identity-equivalent (step_name + approved input/config
    digests + PENDING status) or it is a conflict.
    """
    task_path = task_record_path(project_root, task_id)
    manifest_path = generation_manifest_path(project_root, task_id)
    expected_manifest = _build_generation_manifest(task_id, shot, provider_id, now)

    if task_path.exists():
        existing = read_model_json(task_path, GenerationTask)
        if existing.task_id != task_id or existing.shot_id != shot.shot_id:
            raise TaskAlreadyExistsError(
                f"bootstrap: existing task file is not equivalent: {task_path}"
            )
        if manifest_path.exists():
            existing_manifest = read_model_json(manifest_path, StepManifest)
            if not _manifest_equivalent(existing_manifest, expected_manifest):
                raise TaskAlreadyExistsError(
                    f"bootstrap: existing manifest is not equivalent: {manifest_path}"
                )
            return None  # fully bootstrapped -> skip
        # partial crash: task exists, manifest missing -> complete it
        _ensure_manifest(manifest_path, expected_manifest)
        return _emit_created(
            project_root,
            project_id,
            shot,
            task_id,
            provider_id,
            origin,
            redo_of_task_id,
            now,
        )

    task = GenerationTask(
        task_id=task_id,
        shot_id=shot.shot_id,
        status=GenerationTaskStatus.PENDING,
        created_at=now,
        updated_at=now,
    )
    task_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(task_path, task, overwrite=False)
    _ensure_manifest(manifest_path, expected_manifest)
    return _emit_created(
        project_root,
        project_id,
        shot,
        task_id,
        provider_id,
        origin,
        redo_of_task_id,
        now,
    )


def _build_generation_manifest(
    task_id: str,
    shot: Shot,
    provider_id: str,
    now: datetime,
) -> StepManifest:
    return StepManifest(
        step_name=f"generation:{task_id}",
        input_digest=generation_input_digest(shot),
        relevant_config_digest=generation_config_digest(provider_id),
        status=ManifestStatus.PENDING,
        created_at=now,
    )


def _manifest_equivalent(existing: StepManifest, expected: StepManifest) -> bool:
    return (
        existing.step_name == expected.step_name
        and existing.input_digest == expected.input_digest
        and existing.relevant_config_digest == expected.relevant_config_digest
        and existing.status is ManifestStatus.PENDING
    )


def _ensure_manifest(manifest_path: Path, expected: StepManifest) -> None:
    """Write the companion manifest with CAS/no-replace semantics.

    An existing manifest must be identity-equivalent; a non-equivalent one
    is a conflict, never a silent overwrite (AGENTS.md §13).
    """
    if manifest_path.exists():
        existing = read_model_json(manifest_path, StepManifest)
        if not _manifest_equivalent(existing, expected):
            raise TaskAlreadyExistsError(
                f"bootstrap: existing manifest is not equivalent: {manifest_path}"
            )
        return
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(manifest_path, expected, overwrite=False)


def _emit_created(
    project_root: Path,
    project_id: str,
    shot: Shot,
    task_id: str,
    provider_id: str,
    origin: str,
    redo_of_task_id: str | None,
    now: datetime,
) -> str:
    event = build_task_created_event(
        project_id=project_id,
        shot_id=shot.shot_id,
        task_id=task_id,
        configured_provider_id=provider_id,
        origin=origin,
        redo_of_task_id=redo_of_task_id,
        occurred_at=now,
    )
    append_event(project_root, event)
    return event.event_id


def _find_shot(data: ProjectData, shot_id: str) -> Shot:
    for shot in data.shots:
        if shot.shot_id == shot_id:
            return shot
    raise BootstrapError(f"redo: unknown shot {shot_id}")


def _find_task(data: ProjectData, task_id: str) -> GenerationTask | None:
    for task in data.generation_tasks:
        if task.task_id == task_id:
            return task
    return None


def _highest_attempt(data: ProjectData, shot_id: str) -> tuple[int, str | None]:
    prefix = f"task-{shot_id}-"
    highest = 0
    best: str | None = None
    for task in data.generation_tasks:
        if task.shot_id != shot_id or not task.task_id.startswith(prefix):
            continue
        suffix = task.task_id[len(prefix) :]
        if not suffix.isdigit():
            continue
        number = int(suffix)
        if number > highest:
            highest = number
            best = task.task_id
    return highest, best
