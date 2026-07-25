import json
from dataclasses import fields, replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

import ai_video_workflow.project_data as project_data_module
from ai_video_workflow.errors import (
    DataFileNotFoundError,
    FieldTypeError,
    InvariantViolationError,
    JsonDataError,
    MissingFieldError,
    ReferenceValidationError,
)
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import (
    Character,
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.project_data import (
    ProjectData,
    load_project_data,
    validate_project_data,
)

UTC_NOW = datetime(2026, 7, 26, 10, 0, tzinfo=timezone.utc)
UTC_LATER = datetime(2026, 7, 26, 10, 5, tzinfo=timezone.utc)
UTC_TEXT = "2026-07-26T10:00:00.000000+00:00"


def make_project(*, project_id: str = "project-001") -> Project:
    return Project(
        project_id=project_id,
        name="Project",
        created_at=UTC_NOW,
    )


def make_character(
    *,
    character_id: str = "character-001",
    project_id: str = "project-001",
) -> Character:
    return Character(
        character_id=character_id,
        project_id=project_id,
        name=f"Character {character_id}",
        description="A character.",
        created_at=UTC_NOW,
    )


def make_scene(
    *,
    scene_id: str = "scene-001",
    project_id: str = "project-001",
    sequence: int = 1,
) -> Scene:
    return Scene(
        scene_id=scene_id,
        project_id=project_id,
        sequence=sequence,
        title=f"Scene {scene_id}",
        description="A scene.",
        created_at=UTC_NOW,
    )


def make_shot(
    *,
    shot_id: str = "shot-001",
    scene_id: str = "scene-001",
    character_ids: tuple[str, ...] = ("character-001",),
    sequence: int = 1,
) -> Shot:
    return Shot(
        shot_id=shot_id,
        scene_id=scene_id,
        sequence=sequence,
        description="A shot.",
        prompt="A generation prompt.",
        duration_seconds=4.0,
        width=1920,
        height=1080,
        frame_rate=24.0,
        created_at=UTC_NOW,
        character_ids=character_ids,
    )


def make_task(
    *,
    task_id: str = "task-001",
    shot_id: str = "shot-001",
) -> GenerationTask:
    return GenerationTask(
        task_id=task_id,
        shot_id=shot_id,
        status=GenerationTaskStatus.PENDING,
        created_at=UTC_NOW,
        updated_at=UTC_LATER,
    )


def make_asset(
    *,
    asset_id: str = "asset-001",
    shot_id: str = "shot-001",
    source_task_id: str = "task-001",
    path: Path = Path("media/does-not-exist.mp4"),
) -> VideoAsset:
    return VideoAsset(
        asset_id=asset_id,
        shot_id=shot_id,
        source_task_id=source_task_id,
        path=path,
        container_format="mp4",
        duration_seconds=4.0,
        width=1920,
        height=1080,
        frame_rate=24.0,
        version=1,
        validated_at=UTC_LATER,
    )


def make_manifest(
    *,
    step_name: str = "prepare",
    output_path: str = "outputs/does-not-exist.json",
) -> StepManifest:
    return StepManifest(
        step_name=step_name,
        input_digest="input",
        relevant_config_digest="config",
        status=ManifestStatus.COMPLETED,
        created_at=UTC_NOW,
        output_paths=(output_path,),
        completed_at=UTC_LATER,
    )


def make_valid_project_data() -> ProjectData:
    return ProjectData(
        project=make_project(),
        characters=(
            make_character(),
            make_character(character_id="character-002"),
        ),
        scenes=(
            make_scene(),
            make_scene(scene_id="scene-002", sequence=2),
        ),
        shots=(
            make_shot(),
            make_shot(
                shot_id="shot-002",
                scene_id="scene-002",
                character_ids=("character-002",),
                sequence=2,
            ),
        ),
        generation_tasks=(
            make_task(),
            make_task(task_id="task-002", shot_id="shot-002"),
        ),
        video_assets=(
            make_asset(),
            make_asset(
                asset_id="asset-002",
                shot_id="shot-002",
                source_task_id="task-002",
            ),
        ),
        manifests=(
            make_manifest(),
            make_manifest(step_name="compose", output_path="outputs/final.mp4"),
        ),
    )


def test_valid_project_data_constructs_and_validates_automatically() -> None:
    project_data = make_valid_project_data()
    validate_project_data(project_data)
    assert project_data.project.project_id == "project-001"
    assert len(project_data.characters) == 2


def test_project_data_requires_exactly_one_project_instance() -> None:
    with pytest.raises(FieldTypeError, match="project"):
        ProjectData(project=make_character())  # type: ignore[arg-type]
    assert "projects" not in {field.name for field in fields(ProjectData)}


@pytest.mark.parametrize(
    ("field_name", "invalid_value", "expected_type"),
    [
        ("characters", [make_character()], Character),
        ("scenes", [make_scene()], Scene),
        ("shots", [make_shot()], Shot),
        ("generation_tasks", [make_task()], GenerationTask),
        ("video_assets", [make_asset()], VideoAsset),
        ("manifests", [make_manifest()], StepManifest),
    ],
)
def test_project_data_collections_require_ordered_tuples(
    field_name: str,
    invalid_value: object,
    expected_type: type[object],
) -> None:
    with pytest.raises(FieldTypeError, match=field_name):
        ProjectData(
            project=make_project(),
            **{field_name: invalid_value},
        )
    assert expected_type is not None


def test_character_project_reference_accepts_current_project() -> None:
    data = ProjectData(
        project=make_project(),
        characters=(make_character(),),
    )
    assert data.characters[0].project_id == data.project.project_id


def test_character_project_reference_rejects_other_project() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"Character 'character-001'.*project_id.*other-project",
    ):
        ProjectData(
            project=make_project(),
            characters=(make_character(project_id="other-project"),),
        )


def test_scene_project_reference_accepts_current_project() -> None:
    data = ProjectData(
        project=make_project(),
        scenes=(make_scene(),),
    )
    assert data.scenes[0].project_id == data.project.project_id


def test_scene_project_reference_rejects_other_project() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"Scene 'scene-001'.*project_id.*other-project",
    ):
        ProjectData(
            project=make_project(),
            scenes=(make_scene(project_id="other-project"),),
        )


@pytest.mark.parametrize(
    "field_name",
    [
        "characters",
        "scenes",
        "shots",
        "generation_tasks",
        "video_assets",
    ],
)
def test_duplicate_ids_are_rejected_within_each_entity_type(
    field_name: str,
) -> None:
    data = make_valid_project_data()
    duplicate = getattr(data, field_name)[0]
    with pytest.raises(ReferenceValidationError, match="duplicates ID"):
        replace(data, **{field_name: (duplicate, duplicate)})


def test_same_id_is_allowed_across_different_entity_types() -> None:
    shared_id = "shared-id"
    data = ProjectData(
        project=make_project(),
        characters=(make_character(character_id=shared_id),),
        scenes=(make_scene(scene_id=shared_id),),
        shots=(
            make_shot(
                shot_id=shared_id,
                scene_id=shared_id,
                character_ids=(shared_id,),
            ),
        ),
        generation_tasks=(make_task(task_id=shared_id, shot_id=shared_id),),
        video_assets=(
            make_asset(
                asset_id=shared_id,
                shot_id=shared_id,
                source_task_id=shared_id,
            ),
        ),
    )
    assert data.characters[0].character_id == data.shots[0].shot_id


def test_shot_scene_reference_accepts_existing_scene() -> None:
    data = ProjectData(
        project=make_project(),
        scenes=(make_scene(),),
        shots=(make_shot(character_ids=()),),
    )
    assert data.shots[0].scene_id == data.scenes[0].scene_id


def test_shot_scene_reference_rejects_missing_scene() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"Shot 'shot-001'.*scene_id.*missing-scene",
    ):
        ProjectData(
            project=make_project(),
            shots=(make_shot(scene_id="missing-scene", character_ids=()),),
        )


def test_shot_character_references_accept_all_existing_characters() -> None:
    data = ProjectData(
        project=make_project(),
        characters=(
            make_character(),
            make_character(character_id="character-002"),
        ),
        scenes=(make_scene(),),
        shots=(
            make_shot(
                character_ids=("character-002", "character-001"),
            ),
        ),
    )
    assert data.shots[0].character_ids == (
        "character-002",
        "character-001",
    )


def test_shot_character_reference_rejects_missing_character() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"Shot 'shot-001'.*character_ids.*missing-character",
    ):
        ProjectData(
            project=make_project(),
            scenes=(make_scene(),),
            shots=(make_shot(character_ids=("missing-character",)),),
        )


def test_generation_task_shot_reference_accepts_existing_shot() -> None:
    data = ProjectData(
        project=make_project(),
        scenes=(make_scene(),),
        shots=(make_shot(character_ids=()),),
        generation_tasks=(make_task(),),
    )
    assert data.generation_tasks[0].shot_id == data.shots[0].shot_id


def test_generation_task_shot_reference_rejects_missing_shot() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"GenerationTask 'task-001'.*shot_id.*missing-shot",
    ):
        ProjectData(
            project=make_project(),
            generation_tasks=(make_task(shot_id="missing-shot"),),
        )


def test_video_asset_references_accept_existing_shot_and_task() -> None:
    data = ProjectData(
        project=make_project(),
        scenes=(make_scene(),),
        shots=(make_shot(character_ids=()),),
        generation_tasks=(make_task(),),
        video_assets=(make_asset(),),
    )
    assert data.video_assets[0].source_task_id == data.generation_tasks[0].task_id


def test_video_asset_shot_reference_rejects_missing_shot() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"VideoAsset 'asset-001'.*shot_id.*missing-shot",
    ):
        ProjectData(
            project=make_project(),
            scenes=(make_scene(),),
            shots=(make_shot(character_ids=()),),
            generation_tasks=(make_task(),),
            video_assets=(make_asset(shot_id="missing-shot"),),
        )


def test_video_asset_source_task_reference_rejects_missing_task() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"VideoAsset 'asset-001'.*source_task_id.*missing-task",
    ):
        ProjectData(
            project=make_project(),
            scenes=(make_scene(),),
            shots=(make_shot(character_ids=()),),
            video_assets=(make_asset(source_task_id="missing-task"),),
        )


def test_video_asset_and_source_task_shot_ids_must_match() -> None:
    with pytest.raises(
        ReferenceValidationError,
        match=r"VideoAsset 'asset-001'.*shot_id 'shot-002'.*shot_id 'shot-001'",
    ):
        ProjectData(
            project=make_project(),
            scenes=(make_scene(),),
            shots=(
                make_shot(character_ids=()),
                make_shot(
                    shot_id="shot-002",
                    character_ids=(),
                    sequence=2,
                ),
            ),
            generation_tasks=(make_task(),),
            video_assets=(make_asset(shot_id="shot-002"),),
        )


def test_generation_task_has_no_reverse_asset_reference() -> None:
    task_fields = {field.name for field in fields(GenerationTask)}
    assert "asset_id" not in task_fields
    assert "asset_ids" not in task_fields
    assert "video_asset_id" not in task_fields


def test_project_data_preserves_collection_order_and_input_models() -> None:
    second = make_character(character_id="character-002")
    first = make_character()
    characters = (second, first)
    data = ProjectData(
        project=make_project(),
        characters=characters,
    )
    assert data.characters is characters
    assert data.characters == (second, first)
    assert data.characters[0] is second
    assert data.characters[1] is first


def test_default_collections_have_no_shared_mutable_state() -> None:
    first = ProjectData(project=make_project())
    second = ProjectData(project=make_project())
    assert first.characters == ()
    assert second.characters == ()
    assert isinstance(first.characters, tuple)


def test_validation_does_not_access_media_or_manifest_output_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    media_path = tmp_path / "missing-media.mp4"
    output_path = str(tmp_path / "missing-output.json")

    def fail_file_access(self: Path, *args: object, **kwargs: object) -> object:
        raise AssertionError(f"unexpected file access: {self}, {args}, {kwargs}")

    with monkeypatch.context() as context:
        context.setattr(Path, "exists", fail_file_access)
        context.setattr(Path, "read_text", fail_file_access)
        data = ProjectData(
            project=make_project(),
            scenes=(make_scene(),),
            shots=(make_shot(character_ids=()),),
            generation_tasks=(make_task(),),
            video_assets=(make_asset(path=media_path),),
            manifests=(make_manifest(output_path=output_path),),
        )

    assert data.video_assets[0].path == media_path
    assert data.manifests[0].output_paths == (output_path,)


def test_manifest_step_names_need_not_be_unique_or_reference_entities() -> None:
    first = make_manifest(step_name="same-step")
    second = make_manifest(step_name="same-step")
    data = ProjectData(
        project=make_project(),
        manifests=(first, second),
    )
    assert data.manifests == (first, second)


def test_project_data_public_contract_has_no_indices_or_write_state() -> None:
    assert {field.name for field in fields(ProjectData)} == {
        "project",
        "characters",
        "scenes",
        "shots",
        "generation_tasks",
        "video_assets",
        "manifests",
    }
    data = ProjectData(project=make_project())
    for attribute in (
        "scene_by_id",
        "character_by_id",
        "shot_by_id",
        "task_by_id",
        "asset_by_id",
        "save",
        "write",
    ):
        assert not hasattr(data, attribute)
    assert not hasattr(project_data_module, "save_project_data")


def test_load_project_data_reads_all_types_and_preserves_path_order(
    tmp_path: Path,
) -> None:
    project = make_project()
    characters = [
        make_character(),
        make_character(character_id="character-002"),
    ]
    scenes = [
        make_scene(),
        make_scene(scene_id="scene-002", sequence=2),
    ]
    shots = [
        make_shot(),
        make_shot(
            shot_id="shot-002",
            scene_id="scene-002",
            character_ids=("character-002",),
            sequence=2,
        ),
    ]
    tasks = [
        make_task(),
        make_task(task_id="task-002", shot_id="shot-002"),
    ]
    assets = [
        make_asset(),
        make_asset(
            asset_id="asset-002",
            shot_id="shot-002",
            source_task_id="task-002",
        ),
    ]
    manifests = [
        make_manifest(),
        make_manifest(step_name="compose", output_path="outputs/final.mp4"),
    ]

    project_path = _write_model(tmp_path / "project.json", project)
    character_paths = [
        _write_model(tmp_path / "character-002.json", characters[1]),
        _write_model(tmp_path / "character-001.json", characters[0]),
    ]
    scene_paths = [
        _write_model(tmp_path / "scene-002.json", scenes[1]),
        _write_model(tmp_path / "scene-001.json", scenes[0]),
    ]
    shot_paths = [
        _write_model(tmp_path / "shot-002.json", shots[1]),
        _write_model(tmp_path / "shot-001.json", shots[0]),
    ]
    task_paths = [
        _write_model(tmp_path / "task-002.json", tasks[1]),
        _write_model(tmp_path / "task-001.json", tasks[0]),
    ]
    asset_paths = [
        _write_model(tmp_path / "asset-002.json", assets[1]),
        _write_model(tmp_path / "asset-001.json", assets[0]),
    ]
    manifest_paths = [
        _write_model(tmp_path / "manifest-002.json", manifests[1]),
        _write_model(tmp_path / "manifest-001.json", manifests[0]),
    ]

    data = load_project_data(
        project_path,
        character_paths=character_paths,
        scene_paths=scene_paths,
        shot_paths=shot_paths,
        generation_task_paths=task_paths,
        video_asset_paths=asset_paths,
        manifest_paths=manifest_paths,
    )

    assert isinstance(data.project, Project)
    assert [item.character_id for item in data.characters] == [
        "character-002",
        "character-001",
    ]
    assert [item.scene_id for item in data.scenes] == ["scene-002", "scene-001"]
    assert [item.shot_id for item in data.shots] == ["shot-002", "shot-001"]
    assert [item.task_id for item in data.generation_tasks] == [
        "task-002",
        "task-001",
    ]
    assert [item.asset_id for item in data.video_assets] == [
        "asset-002",
        "asset-001",
    ]
    assert [item.step_name for item in data.manifests] == ["compose", "prepare"]
    assert character_paths[0].name == "character-002.json"


def test_load_project_data_validates_references_after_reading(
    tmp_path: Path,
) -> None:
    project_path = _write_model(tmp_path / "project.json", make_project())
    character_path = _write_model(
        tmp_path / "character.json",
        make_character(project_id="other-project"),
    )
    with pytest.raises(ReferenceValidationError, match="other-project"):
        load_project_data(
            project_path,
            character_paths=(character_path,),
        )


def test_load_project_data_does_not_scan_unlisted_directories(
    tmp_path: Path,
) -> None:
    project_path = _write_model(tmp_path / "project.json", make_project())
    unlisted = tmp_path / "inputs"
    unlisted.mkdir()
    (unlisted / "invalid.json").write_text("not JSON", encoding="utf-8")

    data = load_project_data(project_path)

    assert data.project == make_project()
    assert data.characters == ()


def test_load_missing_file_preserves_file_error_type(tmp_path: Path) -> None:
    with pytest.raises(DataFileNotFoundError) as captured:
        load_project_data(tmp_path / "missing.json")
    assert isinstance(captured.value.__cause__, FileNotFoundError)


@pytest.mark.parametrize(
    ("content", "expected_error"),
    [
        ('{"project_id":', JsonDataError),
        (
            json.dumps({"name": "Project", "created_at": UTC_TEXT}),
            MissingFieldError,
        ),
        (
            json.dumps(
                {
                    "project_id": 1,
                    "name": "Project",
                    "created_at": UTC_TEXT,
                }
            ),
            FieldTypeError,
        ),
        (
            json.dumps(
                {
                    "project_id": "project-001",
                    "name": "   ",
                    "created_at": UTC_TEXT,
                }
            ),
            InvariantViolationError,
        ),
    ],
)
def test_load_preserves_structured_data_error_categories(
    tmp_path: Path,
    content: str,
    expected_error: type[Exception],
) -> None:
    path = tmp_path / "project.json"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(expected_error):
        load_project_data(path)


def _write_model(path: Path, model: object) -> Path:
    write_model_json(path, model)  # type: ignore[arg-type]
    return path
