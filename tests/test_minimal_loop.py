"""M1 minimal-loop end-to-end tests (TASK-007).

The mandatory suite runs the whole loop through the CLI with fake media
tools (no ffmpeg/ffprobe): init-tasks -> prepare -> submit ->
report-artifact -> collect -> validate -> compose, via both the
per-step subcommands and the single-command ``run``. The optional real
smoke runs the identical CLI sequence with the real tools; it is
skipped unless ffmpeg + ffprobe are installed AND
AI_VIDEO_WORKFLOW_REAL_TOOLS=1, and is never part of the default gate.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import Project, Scene, Shot
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.qcd.log import read_events
from tests.media_fakes import FakeMediaInspector, FakeVideoComposer

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


class _Clock:
    def __init__(self) -> None:
        self._n = 0

    def __call__(self) -> datetime:
        self._n += 1
        return T0 + timedelta(minutes=self._n)


def _seed_project(root: Path, *, shots: int = 2) -> None:
    root.mkdir(parents=True, exist_ok=True)
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    (root / "records" / "scenes").mkdir(parents=True, exist_ok=True)
    (root / "records" / "shots").mkdir(parents=True, exist_ok=True)
    write_model_json(
        root / "records" / "scenes" / "scene-1.json",
        Scene("scene-1", "proj-1", 1, "S1", "d", T0),
    )
    for i in range(shots):
        write_model_json(
            root / "records" / "shots" / f"shot-{i + 1}.json",
            Shot(
                shot_id=f"shot-{i + 1}",
                scene_id="scene-1",
                sequence=i + 1,
                description="d",
                prompt="p",
                duration_seconds=4.0,
                width=1280,
                height=720,
                frame_rate=24.0,
                created_at=T0,
            ),
        )


def _use_fakes(monkeypatch) -> None:
    monkeypatch.setattr(cli, "utc_now", _Clock())
    monkeypatch.setattr(
        cli,
        "FfprobeMediaInspector",
        lambda: FakeMediaInspector(
            result=MediaProbeResult("mp4", 4.0, 1280, 720, 24.0)
        ),
    )
    monkeypatch.setattr(cli, "FfmpegVideoComposer", FakeVideoComposer)


def _run(root, *args) -> int:
    return cli.main(["--project-root", str(root), *args])


def _stage_all(root: Path, shots: int = 2) -> None:
    for i in range(shots):
        staged = root / staging_ref_for(f"task-shot-{i + 1}-1")
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(f"user-media-{i}".encode())


def test_minimal_loop_run_one_command(tmp_path, monkeypatch) -> None:
    root = tmp_path / "project"
    _seed_project(root)
    _use_fakes(monkeypatch)
    _stage_all(root)
    assert _run(root, "run") == 0
    # criterion 3: a single command produced the final MP4
    assert (root / "outputs" / "final_v1.mp4").exists()
    # criterion 1: instructions were generated (prepare)
    assert (root / "tasks" / "instructions" / "task-shot-1-1.md").exists()
    # criterion 2: validation reports exist and assets registered
    assert (root / "records" / "video-assets" / "asset-task-shot-1-1-v1.json").exists()
    assert (root / "reports" / "validation" / "task-shot-1-1_v1.json").exists()
    # the event stream covers the five automated types
    kinds = {e.event_type.value for e in read_events(root)}
    assert {
        "task_created",
        "task_status_changed",
        "asset_imported",
        "validation_completed",
        "composition_completed",
    } <= kinds


def test_minimal_loop_run_is_idempotent(tmp_path, monkeypatch) -> None:
    root = tmp_path / "project"
    _seed_project(root)
    _use_fakes(monkeypatch)
    _stage_all(root)
    assert _run(root, "run") == 0
    # criterion 4: re-running the whole loop is safe (no silent overwrite)
    assert _run(root, "run") == 0
    assert (root / "outputs" / "final_v1.mp4").exists()
    assert not (root / "outputs" / "final_v2.mp4").exists()


def test_minimal_loop_step_by_step(tmp_path, monkeypatch) -> None:
    root = tmp_path / "project"
    _seed_project(root, shots=1)
    _use_fakes(monkeypatch)
    assert _run(root, "init-tasks") == 0
    assert _run(root, "prepare", "task-shot-1-1") == 0
    assert _run(root, "submit", "task-shot-1-1") == 0
    _stage_all(root, shots=1)
    assert _run(root, "report-artifact", "task-shot-1-1") == 0
    assert _run(root, "collect", "task-shot-1-1") == 0
    assert _run(root, "validate", "task-shot-1-1") == 0
    assert _run(root, "compose") == 0
    assert (root / "outputs" / "final_v1.mp4").exists()


_REAL_TOOLS = (
    os.environ.get("AI_VIDEO_WORKFLOW_REAL_TOOLS") == "1"
    and shutil.which("ffmpeg") is not None
    and shutil.which("ffprobe") is not None
)


@pytest.mark.skipif(
    not _REAL_TOOLS,
    reason="real-tools smoke: set AI_VIDEO_WORKFLOW_REAL_TOOLS=1 with ffmpeg+ffprobe",
)
def test_minimal_loop_real_tools_smoke(tmp_path, monkeypatch) -> None:
    root = tmp_path / "project"
    _seed_project(root, shots=1)
    # deterministic clock only; the real ffprobe/ffmpeg are used unpatched
    monkeypatch.setattr(cli, "utc_now", _Clock())
    staged = root / staging_ref_for("task-shot-1-1")
    staged.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=4:size=1280x720:rate=24",
            "-pix_fmt",
            "yuv420p",
            str(staged),
        ],
        check=True,
        capture_output=True,
    )
    assert _run(root, "run") == 0
    final = root / "outputs" / "final_v1.mp4"
    assert final.exists() and final.stat().st_size > 0
