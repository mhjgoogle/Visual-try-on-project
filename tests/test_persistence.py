import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

import ai_video_workflow.persistence as persistence
from ai_video_workflow.errors import (
    AtomicWriteError,
    DataFileError,
    DataFileNotFoundError,
    FieldTypeError,
    JsonDataError,
    OverwriteRefusedError,
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
from ai_video_workflow.persistence import read_model_json, write_model_json
from ai_video_workflow.serialization import model_to_json

UTC_NOW = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
UTC_LATER = datetime(2026, 7, 25, 12, 5, tzinfo=timezone.utc)


def sample_models() -> list[object]:
    return [
        Project("project-001", "项目", UTC_NOW),
        Character(
            "character-001",
            "project-001",
            "角色",
            "主角",
            UTC_NOW,
        ),
        Scene(
            "scene-001",
            "project-001",
            1,
            "场景",
            "车站。",
            UTC_NOW,
        ),
        Shot(
            "shot-001",
            "scene-001",
            1,
            "镜头。",
            "A station.",
            4.0,
            1920,
            1080,
            24.0,
            UTC_NOW,
            ("character-001",),
        ),
        GenerationTask(
            "task-001",
            "shot-001",
            GenerationTaskStatus.PENDING,
            UTC_NOW,
            UTC_LATER,
        ),
        VideoAsset(
            "asset-001",
            "shot-001",
            "task-001",
            Path("assets/media/shot-001.mp4"),
            "mp4",
            4.0,
            1920,
            1080,
            24.0,
            1,
            UTC_LATER,
        ),
        StepManifest(
            step_name="prepare",
            input_digest="input",
            relevant_config_digest="config",
            status=ManifestStatus.COMPLETED,
            created_at=UTC_NOW,
            output_paths=("outputs/shot-001.json",),
            output_metadata={"count": 1},
            completed_at=UTC_LATER,
        ),
    ]


@pytest.mark.parametrize(
    "model", sample_models(), ids=lambda model: type(model).__name__
)
def test_all_models_round_trip_through_files(tmp_path: Path, model: object) -> None:
    path = tmp_path / f"{type(model).__name__}.json"
    write_model_json(path, model)  # type: ignore[arg-type]
    restored = read_model_json(path, type(model))  # type: ignore[arg-type]
    assert restored == model


def test_new_file_write_uses_exact_deterministic_utf8_content(
    tmp_path: Path,
) -> None:
    model = sample_models()[0]
    path = tmp_path / "project.json"
    write_model_json(path, model)  # type: ignore[arg-type]
    assert path.read_bytes() == model_to_json(model).encode("utf-8")  # type: ignore[arg-type]


def test_default_write_refuses_existing_target_and_preserves_content(
    tmp_path: Path,
) -> None:
    path = tmp_path / "project.json"
    original = b'{"original": true}\n'
    path.write_bytes(original)

    with pytest.raises(OverwriteRefusedError) as captured:
        write_model_json(path, sample_models()[0])  # type: ignore[arg-type]

    assert isinstance(captured.value.__cause__, FileExistsError)
    assert path.read_bytes() == original
    assert _temporary_files(tmp_path) == []


def test_overwrite_true_atomically_replaces_complete_content(
    tmp_path: Path,
) -> None:
    path = tmp_path / "project.json"
    path.write_text("old content", encoding="utf-8")
    model = sample_models()[0]

    write_model_json(path, model, overwrite=True)  # type: ignore[arg-type]

    assert path.read_bytes() == model_to_json(model).encode("utf-8")  # type: ignore[arg-type]
    assert _temporary_files(tmp_path) == []


def test_successful_publication_is_not_reported_as_failed_when_cleanup_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"
    model = sample_models()[0]
    cleanup_attempts: list[Path] = []

    def fail_unlink(temporary_path: Path) -> None:
        cleanup_attempts.append(temporary_path)
        raise OSError(f"simulated cleanup failure for {temporary_path}")

    with monkeypatch.context() as context:
        context.setattr(Path, "unlink", fail_unlink)
        write_model_json(path, model)  # type: ignore[arg-type]

    temporary_files = _temporary_files(tmp_path)
    assert cleanup_attempts == temporary_files
    assert path.read_bytes() == model_to_json(model).encode("utf-8")  # type: ignore[arg-type]
    for temporary_path in temporary_files:
        temporary_path.unlink()


def test_cleanup_failure_does_not_mask_overwrite_refusal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"
    original = b'{"original": true}\n'
    path.write_bytes(original)
    cleanup_attempts: list[Path] = []

    def fail_unlink(temporary_path: Path) -> None:
        cleanup_attempts.append(temporary_path)
        raise OSError(f"simulated cleanup failure for {temporary_path}")

    with monkeypatch.context() as context:
        context.setattr(Path, "unlink", fail_unlink)
        with pytest.raises(OverwriteRefusedError) as captured:
            write_model_json(path, sample_models()[0])  # type: ignore[arg-type]

    temporary_files = _temporary_files(tmp_path)
    assert isinstance(captured.value.__cause__, FileExistsError)
    assert cleanup_attempts == temporary_files
    assert path.read_bytes() == original
    for temporary_path in temporary_files:
        temporary_path.unlink()


def test_default_publication_uses_link_without_exists_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"
    original_link = os.link
    calls: list[tuple[object, object]] = []

    def recording_link(source: object, target: object) -> None:
        calls.append((source, target))
        original_link(source, target)

    def forbidden_exists(self: Path) -> bool:
        raise AssertionError(f"unexpected exists check for {self}")

    with monkeypatch.context() as context:
        context.setattr(persistence.os, "link", recording_link)
        context.setattr(Path, "exists", forbidden_exists)
        write_model_json(path, sample_models()[0])  # type: ignore[arg-type]

    assert len(calls) == 1
    assert Path(calls[0][1]) == path
    assert path.is_file()


def test_simulated_link_file_exists_is_classified_and_cleans_temp(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"

    def fail_link(source: object, target: object) -> None:
        raise FileExistsError(f"simulated conflict: {source} -> {target}")

    monkeypatch.setattr(persistence.os, "link", fail_link)
    with pytest.raises(OverwriteRefusedError) as captured:
        write_model_json(path, sample_models()[0])  # type: ignore[arg-type]

    assert isinstance(captured.value.__cause__, FileExistsError)
    assert not path.exists()
    assert _temporary_files(tmp_path) == []


def test_link_failure_leaves_no_formal_or_temporary_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"

    def fail_link(source: object, target: object) -> None:
        raise OSError(f"simulated link failure: {source} -> {target}")

    monkeypatch.setattr(persistence.os, "link", fail_link)
    with pytest.raises(AtomicWriteError) as captured:
        write_model_json(path, sample_models()[0])  # type: ignore[arg-type]

    assert isinstance(captured.value.__cause__, OSError)
    assert not path.exists()
    assert _temporary_files(tmp_path) == []


def test_fsync_failure_leaves_no_formal_or_temporary_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"

    def fail_fsync(file_descriptor: int) -> None:
        raise OSError(f"simulated fsync failure for {file_descriptor}")

    monkeypatch.setattr(persistence.os, "fsync", fail_fsync)
    with pytest.raises(AtomicWriteError) as captured:
        write_model_json(path, sample_models()[0])  # type: ignore[arg-type]

    assert isinstance(captured.value.__cause__, OSError)
    assert not path.exists()
    assert _temporary_files(tmp_path) == []


def test_replace_failure_preserves_existing_file_and_cleans_temp(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"
    original = b"original content"
    path.write_bytes(original)

    def fail_replace(source: object, target: object) -> None:
        raise OSError(f"simulated replace failure: {source} -> {target}")

    monkeypatch.setattr(persistence.os, "replace", fail_replace)
    with pytest.raises(AtomicWriteError) as captured:
        write_model_json(
            path,
            sample_models()[0],  # type: ignore[arg-type]
            overwrite=True,
        )

    assert isinstance(captured.value.__cause__, OSError)
    assert path.read_bytes() == original
    assert _temporary_files(tmp_path) == []


def test_missing_parent_is_not_created(
    tmp_path: Path,
) -> None:
    parent = tmp_path / "missing"
    path = parent / "project.json"
    with pytest.raises(AtomicWriteError) as captured:
        write_model_json(path, sample_models()[0])  # type: ignore[arg-type]
    assert isinstance(captured.value.__cause__, FileNotFoundError)
    assert not parent.exists()


def test_read_missing_file_is_classified_and_preserves_cause(
    tmp_path: Path,
) -> None:
    path = tmp_path / "missing.json"
    with pytest.raises(DataFileNotFoundError) as captured:
        read_model_json(path, Project)
    assert isinstance(captured.value.__cause__, FileNotFoundError)


def test_read_invalid_utf8_is_classified_and_preserves_cause(
    tmp_path: Path,
) -> None:
    path = tmp_path / "invalid.json"
    path.write_bytes(b"\xff\xfe")
    with pytest.raises(DataFileError) as captured:
        read_model_json(path, Project)
    assert isinstance(captured.value.__cause__, UnicodeDecodeError)


def test_read_illegal_json_uses_json_error_category(tmp_path: Path) -> None:
    path = tmp_path / "invalid.json"
    path.write_text('{"project_id":', encoding="utf-8")
    with pytest.raises(JsonDataError) as captured:
        read_model_json(path, Project)
    assert captured.value.__cause__ is not None


def test_read_os_error_is_mapped_and_preserves_cause(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "project.json"

    def fail_read_text(self: Path, *, encoding: str) -> str:
        raise OSError(f"simulated read failure for {self} using {encoding}")

    monkeypatch.setattr(Path, "read_text", fail_read_text)
    with pytest.raises(DataFileError) as captured:
        read_model_json(path, Project)
    assert isinstance(captured.value.__cause__, OSError)


def test_invalid_os_path_does_not_leak_raw_path_errors() -> None:
    invalid_path = Path("invalid\x00path.json")
    with pytest.raises(DataFileError) as read_error:
        read_model_json(invalid_path, Project)
    assert isinstance(read_error.value.__cause__, (ValueError, OSError))

    with pytest.raises(AtomicWriteError) as write_error:
        write_model_json(invalid_path, sample_models()[0])  # type: ignore[arg-type]
    assert isinstance(write_error.value.__cause__, (ValueError, OSError))


def test_path_and_overwrite_argument_types_are_strict(tmp_path: Path) -> None:
    with pytest.raises(FieldTypeError, match="path"):
        read_model_json("project.json", Project)  # type: ignore[arg-type]
    with pytest.raises(FieldTypeError, match="path"):
        write_model_json("project.json", sample_models()[0])  # type: ignore[arg-type]
    with pytest.raises(FieldTypeError, match="overwrite"):
        write_model_json(
            tmp_path / "project.json",
            sample_models()[0],  # type: ignore[arg-type]
            overwrite=1,  # type: ignore[arg-type]
        )


def _temporary_files(directory: Path) -> list[Path]:
    return list(directory.glob(".*.tmp"))
