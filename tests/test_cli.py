"""Tests for the CLI: parsing, exit codes, and subcommand wiring (TASK-007)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.app.bootstrap import task_record_path
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.cli import _require_done
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
)
from ai_video_workflow.persistence import write_model_json
from tests.media_fakes import FakeMediaInspector, FakeVideoComposer

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


class _Clock:
    def __init__(self) -> None:
        self._n = 0

    def __call__(self) -> datetime:
        self._n += 1
        return T0 + timedelta(minutes=self._n)


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    (root / "records" / "shots").mkdir(parents=True)
    (root / "records" / "scenes").mkdir(parents=True)
    write_model_json(
        root / "records" / "scenes" / "scene-1.json",
        Scene("scene-1", "proj-1", 1, "S1", "d", T0),
    )
    write_model_json(
        root / "records" / "shots" / "shot-1.json",
        Shot(
            shot_id="shot-1",
            scene_id="scene-1",
            sequence=1,
            description="d",
            prompt="p",
            duration_seconds=4.0,
            width=1280,
            height=720,
            frame_rate=24.0,
            created_at=T0,
        ),
    )
    # patch the clock and the real media tools to deterministic fakes
    monkeypatch.setattr(cli, "utc_now", _Clock())
    monkeypatch.setattr(
        cli,
        "FfprobeMediaInspector",
        lambda: FakeMediaInspector(
            result=MediaProbeResult("mp4", 4.0, 1280, 720, 24.0)
        ),
    )
    monkeypatch.setattr(cli, "FfmpegVideoComposer", FakeVideoComposer)
    return root


def _run(project_root, *args) -> int:
    return cli.main(["--project-root", str(project_root), *args])


def test_no_command_returns_2(project) -> None:
    assert _run(project) == 2


def test_unknown_command_argparse_error(project) -> None:
    with pytest.raises(SystemExit) as exc:
        _run(project, "bogus")
    assert exc.value.code == 2


def test_init_tasks(project, capsys) -> None:
    assert _run(project, "init-tasks") == 0
    assert "created" in capsys.readouterr().out
    assert (project / "records/generation-tasks/task-shot-1-1.json").exists()


def test_prepare_and_status(project, capsys) -> None:
    _run(project, "init-tasks")
    assert _run(project, "prepare", "task-shot-1-1") == 0
    assert _run(project, "status", "task-shot-1-1") == 0
    out = capsys.readouterr().out
    assert "phase" in out and "disposition" in out


def test_report_artifact_missing_is_exit_1(project, capsys) -> None:
    _run(project, "init-tasks")
    _run(project, "prepare", "task-shot-1-1")
    _run(project, "submit", "task-shot-1-1")
    code = _run(project, "report-artifact", "task-shot-1-1")
    assert code == 1
    assert "StagedFileMissingError" in capsys.readouterr().err


def test_create_redo_task(project, capsys) -> None:
    _run(project, "init-tasks")
    assert _run(project, "create-redo-task", "shot-1") == 0
    assert (project / "records/generation-tasks/task-shot-1-2.json").exists()


def test_record_attempt_and_rate(project, capsys) -> None:
    _run(project, "init-tasks")
    assert _run(project, "record-attempt", "task-shot-1-1", "--note", "x") == 0
    assert _run(project, "rate", "shot-1", "--score", "5") == 0


def test_lifecycle_subcommands_to_validate(project, capsys) -> None:
    _run(project, "init-tasks")
    _run(project, "prepare", "task-shot-1-1")
    _run(project, "submit", "task-shot-1-1")
    staged = project / staging_ref_for("task-shot-1-1")
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_bytes(b"user-media")
    assert _run(project, "report-artifact", "task-shot-1-1") == 0
    assert _run(project, "collect", "task-shot-1-1") == 0
    assert _run(project, "validate", "task-shot-1-1") == 0
    out = capsys.readouterr().out
    assert "validation passed: True" in out
    assert (project / "records/video-assets/asset-task-shot-1-1-v1.json").exists()


def test_run_resumes_after_submit_interrupt(project) -> None:
    # drive only up to submit, then interrupt; `run` must resume from
    # report-artifact/collect rather than illegally re-preparing.
    _run(project, "init-tasks")
    _run(project, "prepare", "task-shot-1-1")
    _run(project, "submit", "task-shot-1-1")
    staged = project / staging_ref_for("task-shot-1-1")
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_bytes(b"user-media")
    assert _run(project, "run") == 0
    assert (project / "outputs/final_v1.mp4").exists()


def test_validate_failure_exits_1(project, capsys) -> None:
    # nothing staged -> validation fails -> exit 1 (ValidationFailedError)
    _run(project, "init-tasks")
    _run(project, "prepare", "task-shot-1-1")
    _run(project, "submit", "task-shot-1-1")
    code = _run(project, "validate", "task-shot-1-1")
    assert code == 1
    assert "validation passed: False" in capsys.readouterr().out


def test_require_done_rejects_failed_task(project) -> None:
    # a FAILED/CANCELLED terminal task must not be treated as done
    task_record_path(project, "task-shot-9-1").parent.mkdir(
        parents=True, exist_ok=True
    )
    write_model_json(
        task_record_path(project, "task-shot-9-1"),
        GenerationTask(
            task_id="task-shot-9-1",
            shot_id="shot-9",
            status=GenerationTaskStatus.CANCELLED,
            created_at=T0,
            updated_at=T0,
            completed_at=T0,
        ),
    )
    with pytest.raises(AiVideoWorkflowError):
        _require_done(project, "task-shot-9-1")


def test_show_instruction(project, capsys) -> None:
    _run(project, "init-tasks")
    _run(project, "prepare", "task-shot-1-1")
    assert _run(project, "show-instruction", "task-shot-1-1") == 0
    assert "Manual Video Generation Task" in capsys.readouterr().out
