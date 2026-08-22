import json
import re
from collections import Counter
from pathlib import Path

import pytest

from ai_video_workflow.errors import ReferenceValidationError
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
from ai_video_workflow.project_data import ProjectData, load_project_data
from ai_video_workflow.serialization import model_to_json

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ADR_PATH = (
    REPOSITORY_ROOT / "docs" / "adr" / "ADR-0001-project-data-directory-contract.md"
)
EXAMPLE_ROOT = REPOSITORY_ROOT / "examples" / "projects" / "minimal"
PROJECT_PATH = EXAMPLE_ROOT / "project.json"
CHARACTER_PATHS = (EXAMPLE_ROOT / "records" / "characters" / "character-001.json",)
SCENE_PATHS = (EXAMPLE_ROOT / "records" / "scenes" / "scene-001.json",)
SHOT_PATHS = (
    EXAMPLE_ROOT / "records" / "shots" / "shot-001.json",
    EXAMPLE_ROOT / "records" / "shots" / "shot-002.json",
)
TASK_PATHS = (
    EXAMPLE_ROOT / "records" / "generation-tasks" / "task-001.json",
    EXAMPLE_ROOT / "records" / "generation-tasks" / "task-002.json",
)
ASSET_PATHS = (EXAMPLE_ROOT / "records" / "video-assets" / "asset-001.json",)
MANIFEST_PATHS = (EXAMPLE_ROOT / "manifests" / "compose-final.json",)
INVALID_SHOT_PATH = (
    Path(__file__).resolve().parent / "fixtures" / "invalid" / "shot-missing-scene.json"
)
MODEL_FILES = (
    (PROJECT_PATH, Project),
    (CHARACTER_PATHS[0], Character),
    (SCENE_PATHS[0], Scene),
    (SHOT_PATHS[0], Shot),
    (SHOT_PATHS[1], Shot),
    (TASK_PATHS[0], GenerationTask),
    (TASK_PATHS[1], GenerationTask),
    (ASSET_PATHS[0], VideoAsset),
    (MANIFEST_PATHS[0], StepManifest),
)
DATETIME_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$")
WINDOWS_DRIVE_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")


def test_adr_0001_exists() -> None:
    assert ADR_PATH.is_file()


@pytest.mark.parametrize(
    ("path", "model_type"),
    MODEL_FILES,
    ids=lambda value: value.name if isinstance(value, Path) else value.__name__,
)
def test_every_example_json_file_loads_with_its_approved_model(
    path: Path,
    model_type: type[object],
) -> None:
    model = read_model_json(path, model_type)  # type: ignore[type-var]
    assert isinstance(model, model_type)


def test_example_loads_from_explicit_paths_and_validates() -> None:
    data = _load_example()
    assert isinstance(data, ProjectData)
    assert data.project.project_id == "minimal-project"


def test_example_has_required_entity_counts() -> None:
    data = _load_example()
    assert len(data.characters) >= 1
    assert len(data.scenes) >= 1
    assert len(data.shots) >= 2
    assert len(data.generation_tasks) >= 2
    assert len(data.video_assets) >= 1
    assert len(data.manifests) >= 1
    assert len((data.project,)) == 1


def test_every_shot_has_a_generation_task() -> None:
    data = _load_example()
    task_count_by_shot = Counter(task.shot_id for task in data.generation_tasks)
    assert all(task_count_by_shot[shot.shot_id] >= 1 for shot in data.shots)


def test_video_assets_match_their_source_tasks() -> None:
    data = _load_example()
    task_by_id = {task.task_id: task for task in data.generation_tasks}
    for asset in data.video_assets:
        assert asset.source_task_id in task_by_id
        assert asset.shot_id == task_by_id[asset.source_task_id].shot_id


@pytest.mark.parametrize(
    ("path", "model_type"),
    MODEL_FILES,
    ids=lambda value: value.name if isinstance(value, Path) else value.__name__,
)
def test_example_json_matches_deterministic_serializer(
    path: Path,
    model_type: type[object],
) -> None:
    model = read_model_json(path, model_type)  # type: ignore[type-var]
    content = path.read_text(encoding="utf-8")
    assert content == model_to_json(model)  # type: ignore[arg-type]
    assert content.endswith("\n")
    assert not content.endswith("\n\n")


@pytest.mark.parametrize("path", [item[0] for item in MODEL_FILES])
def test_example_datetime_strings_use_canonical_utc_format(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    for key, value in data.items():
        if key.endswith("_at") and value is not None:
            assert DATETIME_PATTERN.fullmatch(value)


def test_persisted_paths_are_relative_posix_strings() -> None:
    data = _load_example()
    for asset in data.video_assets:
        path_text = asset.path.as_posix()
        assert not asset.path.is_absolute()
        assert "\\" not in path_text
        assert WINDOWS_DRIVE_PATTERN.match(path_text) is None
    for manifest in data.manifests:
        for output_path in manifest.output_paths:
            assert not Path(output_path).is_absolute()
            assert "\\" not in output_path
            assert WINDOWS_DRIVE_PATTERN.match(output_path) is None


@pytest.mark.parametrize("path", [item[0] for item in MODEL_FILES])
def test_example_contains_no_machine_absolute_paths(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    for value in _all_strings(data):
        assert not value.startswith("/home/")
        assert WINDOWS_DRIVE_PATTERN.match(value) is None


def test_example_does_not_require_real_media_or_outputs() -> None:
    data = _load_example()
    assert all(not (EXAMPLE_ROOT / asset.path).exists() for asset in data.video_assets)
    assert all(
        not (EXAMPLE_ROOT / output_path).exists()
        for manifest in data.manifests
        for output_path in manifest.output_paths
    )


def test_invalid_fixture_is_locally_valid_but_fails_reference_validation() -> None:
    invalid_shot = read_model_json(INVALID_SHOT_PATH, Shot)
    assert invalid_shot.scene_id == "missing-scene"

    with pytest.raises(
        ReferenceValidationError,
        match=r"invalid-shot-missing-scene.*scene_id.*missing-scene",
    ):
        load_project_data(
            PROJECT_PATH,
            character_paths=CHARACTER_PATHS,
            scene_paths=SCENE_PATHS,
            shot_paths=(INVALID_SHOT_PATH,),
        )


def test_invalid_fixture_is_separate_from_legal_example() -> None:
    assert INVALID_SHOT_PATH.is_file()
    assert not INVALID_SHOT_PATH.is_relative_to(EXAMPLE_ROOT)


def test_example_loading_does_not_scan_directories(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_scan(self: Path, *args: object) -> object:
        raise AssertionError(f"unexpected directory scan: {self}, {args}")

    with monkeypatch.context() as context:
        context.setattr(Path, "glob", fail_scan)
        context.setattr(Path, "rglob", fail_scan)
        context.setattr(Path, "iterdir", fail_scan)
        data = _load_example()

    assert data.project.project_id == "minimal-project"


def test_example_loading_does_not_depend_on_current_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    assert _load_example().project.project_id == "minimal-project"


def test_example_tests_do_not_modify_repository_data() -> None:
    paths = tuple(path for path, _ in MODEL_FILES) + (INVALID_SHOT_PATH,)
    before = {path: path.read_bytes() for path in paths}
    _load_example()
    read_model_json(INVALID_SHOT_PATH, Shot)
    after = {path: path.read_bytes() for path in paths}
    assert after == before


def _load_example() -> ProjectData:
    return load_project_data(
        PROJECT_PATH,
        character_paths=CHARACTER_PATHS,
        scene_paths=SCENE_PATHS,
        shot_paths=SHOT_PATHS,
        generation_task_paths=TASK_PATHS,
        video_asset_paths=ASSET_PATHS,
        manifest_paths=MANIFEST_PATHS,
    )


def _all_strings(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list):
        return tuple(item for child in value for item in _all_strings(child))
    if isinstance(value, dict):
        return tuple(item for child in value.values() for item in _all_strings(child))
    return ()
