"""Single-project aggregation, explicit loading, and reference validation."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar

from ai_video_workflow.errors import FieldTypeError, ReferenceValidationError
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

EntityT = TypeVar(
    "EntityT",
    Character,
    Scene,
    Shot,
    GenerationTask,
    VideoAsset,
)


@dataclass(frozen=True, slots=True)
class ProjectData:
    """Validated in-memory snapshot for exactly one project."""

    project: Project
    characters: tuple[Character, ...] = ()
    scenes: tuple[Scene, ...] = ()
    shots: tuple[Shot, ...] = ()
    generation_tasks: tuple[GenerationTask, ...] = ()
    video_assets: tuple[VideoAsset, ...] = ()
    manifests: tuple[StepManifest, ...] = ()

    def __post_init__(self) -> None:
        validate_project_data(self)


def validate_project_data(project_data: ProjectData) -> None:
    """Validate collection types, ID uniqueness, and cross-model references."""
    if not isinstance(project_data, ProjectData):
        raise FieldTypeError(
            f"project_data: expected ProjectData, got {type(project_data).__name__}"
        )
    if not isinstance(project_data.project, Project):
        raise FieldTypeError(
            f"project: expected Project, got {type(project_data.project).__name__}"
        )

    _validate_model_tuple(
        project_data.characters,
        Character,
        "characters",
    )
    _validate_model_tuple(project_data.scenes, Scene, "scenes")
    _validate_model_tuple(project_data.shots, Shot, "shots")
    _validate_model_tuple(
        project_data.generation_tasks,
        GenerationTask,
        "generation_tasks",
    )
    _validate_model_tuple(
        project_data.video_assets,
        VideoAsset,
        "video_assets",
    )
    _validate_model_tuple(
        project_data.manifests,
        StepManifest,
        "manifests",
    )

    character_by_id = _build_unique_index(
        project_data.characters,
        model_name="Character",
        id_field="character_id",
        get_id=lambda character: character.character_id,
    )
    scene_by_id = _build_unique_index(
        project_data.scenes,
        model_name="Scene",
        id_field="scene_id",
        get_id=lambda scene: scene.scene_id,
    )
    shot_by_id = _build_unique_index(
        project_data.shots,
        model_name="Shot",
        id_field="shot_id",
        get_id=lambda shot: shot.shot_id,
    )
    task_by_id = _build_unique_index(
        project_data.generation_tasks,
        model_name="GenerationTask",
        id_field="task_id",
        get_id=lambda task: task.task_id,
    )
    _build_unique_index(
        project_data.video_assets,
        model_name="VideoAsset",
        id_field="asset_id",
        get_id=lambda asset: asset.asset_id,
    )

    project_id = project_data.project.project_id
    for character in project_data.characters:
        if character.project_id != project_id:
            raise ReferenceValidationError(
                f"Character '{character.character_id}' project_id references "
                f"Project '{character.project_id}', not current Project '{project_id}'"
            )
    for scene in project_data.scenes:
        if scene.project_id != project_id:
            raise ReferenceValidationError(
                f"Scene '{scene.scene_id}' project_id references Project "
                f"'{scene.project_id}', not current Project '{project_id}'"
            )
    for shot in project_data.shots:
        if shot.scene_id not in scene_by_id:
            raise ReferenceValidationError(
                f"Shot '{shot.shot_id}' scene_id references missing Scene "
                f"'{shot.scene_id}'"
            )
        for character_id in shot.character_ids:
            if character_id not in character_by_id:
                raise ReferenceValidationError(
                    f"Shot '{shot.shot_id}' character_ids references missing "
                    f"Character '{character_id}'"
                )
    for task in project_data.generation_tasks:
        if task.shot_id not in shot_by_id:
            raise ReferenceValidationError(
                f"GenerationTask '{task.task_id}' shot_id references missing "
                f"Shot '{task.shot_id}'"
            )
    for asset in project_data.video_assets:
        if asset.shot_id not in shot_by_id:
            raise ReferenceValidationError(
                f"VideoAsset '{asset.asset_id}' shot_id references missing Shot "
                f"'{asset.shot_id}'"
            )
        source_task = task_by_id.get(asset.source_task_id)
        if source_task is None:
            raise ReferenceValidationError(
                f"VideoAsset '{asset.asset_id}' source_task_id references missing "
                f"GenerationTask '{asset.source_task_id}'"
            )
        if asset.shot_id != source_task.shot_id:
            raise ReferenceValidationError(
                f"VideoAsset '{asset.asset_id}' shot_id '{asset.shot_id}' does not "
                f"match GenerationTask '{source_task.task_id}' shot_id "
                f"'{source_task.shot_id}' referenced by source_task_id "
                f"'{asset.source_task_id}'"
            )


def load_project_data(
    project_path: Path,
    *,
    character_paths: Sequence[Path] = (),
    scene_paths: Sequence[Path] = (),
    shot_paths: Sequence[Path] = (),
    generation_task_paths: Sequence[Path] = (),
    video_asset_paths: Sequence[Path] = (),
    manifest_paths: Sequence[Path] = (),
) -> ProjectData:
    """Load explicitly listed model files in caller-provided order."""
    project = read_model_json(project_path, Project)
    characters = tuple(read_model_json(path, Character) for path in character_paths)
    scenes = tuple(read_model_json(path, Scene) for path in scene_paths)
    shots = tuple(read_model_json(path, Shot) for path in shot_paths)
    generation_tasks = tuple(
        read_model_json(path, GenerationTask) for path in generation_task_paths
    )
    video_assets = tuple(
        read_model_json(path, VideoAsset) for path in video_asset_paths
    )
    manifests = tuple(read_model_json(path, StepManifest) for path in manifest_paths)
    return ProjectData(
        project=project,
        characters=characters,
        scenes=scenes,
        shots=shots,
        generation_tasks=generation_tasks,
        video_assets=video_assets,
        manifests=manifests,
    )


def _validate_model_tuple(
    value: object,
    model_type: type[object],
    field_name: str,
) -> None:
    if not isinstance(value, tuple):
        raise FieldTypeError(
            f"{field_name}: expected tuple, got {type(value).__name__}"
        )
    for index, item in enumerate(value):
        if not isinstance(item, model_type):
            raise FieldTypeError(
                f"{field_name}[{index}]: expected {model_type.__name__}, "
                f"got {type(item).__name__}"
            )


def _build_unique_index(
    entities: tuple[EntityT, ...],
    *,
    model_name: str,
    id_field: str,
    get_id: Callable[[EntityT], str],
) -> dict[str, EntityT]:
    index: dict[str, EntityT] = {}
    for entity in entities:
        entity_id = get_id(entity)
        if entity_id in index:
            raise ReferenceValidationError(
                f"{model_name} '{entity_id}' {id_field} duplicates ID '{entity_id}'"
            )
        index[entity_id] = entity
    return index
