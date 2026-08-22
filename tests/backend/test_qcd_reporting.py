"""Tests for QCD reporting (TASK-009): versioned deterministic summary."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
)
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.events import build_task_created_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.qcd.reporting import (
    QcdReportConflictError,
    run_qcd_report_step,
)


def _t(hour: int) -> datetime:
    return datetime(2026, 7, 30, hour, 0, 0, tzinfo=timezone.utc)


def _data(tasks=()) -> ProjectData:
    return ProjectData(
        project=Project(project_id="proj-1", name="Demo", created_at=_t(8)),
        scenes=(
            Scene(
                scene_id="scene-1",
                project_id="proj-1",
                sequence=1,
                title="S",
                description="d",
                created_at=_t(8),
            ),
        ),
        shots=(
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
                created_at=_t(8),
            ),
        ),
        generation_tasks=tuple(tasks),
    )


def _created(task_id: str, occurred_at: datetime, origin="bootstrap"):
    return build_task_created_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id=task_id,
        configured_provider_id="manual",
        origin=origin,
        redo_of_task_id=None,
        occurred_at=occurred_at,
    )


def _snapshot(root: Path) -> set[Path]:
    return {p for p in root.rglob("*") if p.is_file()}


def test_first_report_publishes_v1(tmp_path) -> None:
    data = _data(tasks=[_task()])
    append_event(tmp_path, _created("task-shot-1-1", _t(8)))
    outcome = run_qcd_report_step(project_root=tmp_path, data=data, observed_at=_t(12))
    assert outcome.version == 1 and outcome.skipped is False
    assert (tmp_path / "reports/qcd/summary_v1.json").exists()
    assert (tmp_path / "reports/qcd/summary_v1.md").exists()
    obj = json.loads((tmp_path / outcome.json_path).read_text(encoding="utf-8"))
    assert obj["derived"] is True
    assert obj["project_id"] == "proj-1"


def test_rerun_same_input_is_byte_stable_noop(tmp_path) -> None:
    data = _data(tasks=[_task()])
    append_event(tmp_path, _created("task-shot-1-1", _t(8)))
    first = run_qcd_report_step(project_root=tmp_path, data=data, observed_at=_t(12))
    before = (tmp_path / first.json_path).read_bytes()
    # a later run at a DIFFERENT observed_at with identical events -> same v1,
    # byte-identical, skipped.
    second = run_qcd_report_step(project_root=tmp_path, data=data, observed_at=_t(15))
    assert second.version == 1 and second.skipped is True
    assert (tmp_path / second.json_path).read_bytes() == before


def test_changed_input_publishes_next_version(tmp_path) -> None:
    data1 = _data(tasks=[_task()])
    append_event(tmp_path, _created("task-shot-1-1", _t(8)))
    run_qcd_report_step(project_root=tmp_path, data=data1, observed_at=_t(12))
    # a new event changes the summary -> v2
    append_event(tmp_path, _created("task-shot-1-2", _t(9), origin="redo"))
    data2 = _data(tasks=[_task(), _task("task-shot-1-2")])
    outcome = run_qcd_report_step(project_root=tmp_path, data=data2, observed_at=_t(13))
    assert outcome.version == 2 and outcome.skipped is False
    assert (tmp_path / "reports/qcd/summary_v2.json").exists()
    assert (tmp_path / "reports/qcd/summary_v1.json").exists()  # v1 retained


def test_writes_only_under_reports_qcd(tmp_path) -> None:
    # guard: the QCD report step writes nothing outside reports/qcd/.
    data = _data(tasks=[_task()])
    append_event(tmp_path, _created("task-shot-1-1", _t(8)))
    before = _snapshot(tmp_path)
    run_qcd_report_step(project_root=tmp_path, data=data, observed_at=_t(12))
    new_files = _snapshot(tmp_path) - before
    assert new_files, "expected the report to be written"
    for path in new_files:
        rel = path.relative_to(tmp_path)
        assert rel.parts[:2] == ("reports", "qcd"), f"unexpected write: {rel}"


def test_conflicting_report_content_raises(tmp_path) -> None:
    data = _data(tasks=[_task()])
    append_event(tmp_path, _created("task-shot-1-1", _t(8)))
    run_qcd_report_step(project_root=tmp_path, data=data, observed_at=_t(12))
    # tamper the published Markdown while leaving the JSON intact: the rerun
    # reuses v1 (JSON is byte-identical) and then republishes the Markdown,
    # which no-replace-conflicts with the tampered file.
    md = tmp_path / "reports/qcd/summary_v1.md"
    md.write_text(md.read_text(encoding="utf-8") + "\ntampered\n", encoding="utf-8")
    with pytest.raises(QcdReportConflictError):
        run_qcd_report_step(project_root=tmp_path, data=data, observed_at=_t(13))


def _task(task_id: str = "task-shot-1-1") -> GenerationTask:
    return GenerationTask(
        task_id=task_id,
        shot_id="shot-1",
        status=GenerationTaskStatus.DONE,
        created_at=_t(8),
        updated_at=_t(9),
        completed_at=_t(9),
    )
