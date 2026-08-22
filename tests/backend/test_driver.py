"""Tests for the WorkflowDriver and ProviderRequestFactory (TASK-007)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ai_video_workflow.app.bootstrap import bootstrap_generation_tasks
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.app.driver import (
    DriverOutcome,
    StagedFileMissingError,
    WorkflowDriver,
)
from ai_video_workflow.app.requests import DefaultProviderRequestFactory
from ai_video_workflow.models import (
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
)
from ai_video_workflow.orchestration import OrchestrationAction, OutcomeKind
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.providers import ManualVideoProvider
from ai_video_workflow.providers.models import ProviderRequest
from ai_video_workflow.qcd.log import read_events
from tests.media_fakes import FakeMediaInspector, FakeVideoComposer

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def _shot() -> Shot:
    return Shot(
        shot_id="shot-1",
        scene_id="scene-1",
        sequence=1,
        description="a cat",
        prompt="a cat playing",
        duration_seconds=4.0,
        width=1280,
        height=720,
        frame_rate=24.0,
        created_at=T0,
    )


def _setup_project(root: Path) -> None:
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    (root / "records" / "shots").mkdir(parents=True, exist_ok=True)
    write_model_json(root / "records" / "shots" / "shot-1.json", _shot())
    (root / "records" / "scenes").mkdir(parents=True, exist_ok=True)
    write_model_json(
        root / "records" / "scenes" / "scene-1.json",
        Scene("scene-1", "proj-1", 1, "S1", "d", T0),
    )
    data = ProjectData(
        project=Project("proj-1", "Demo", T0),
        scenes=(Scene("scene-1", "proj-1", 1, "S1", "d", T0),),
        shots=(_shot(),),
    )
    bootstrap_generation_tasks(
        project_root=root, data=data, provider_id="manual", now=T0
    )


class _IncrementingClock:
    def __init__(self, start: datetime) -> None:
        self._n = 0
        self._start = start

    def __call__(self) -> datetime:
        self._n += 1
        return self._start + timedelta(minutes=self._n)


def _driver(root: Path) -> WorkflowDriver:
    return WorkflowDriver(
        provider_id="manual",
        provider=ManualVideoProvider(),
        request_factory=DefaultProviderRequestFactory(),
        project_root=root,
        inspector=FakeMediaInspector(),
        composer=FakeVideoComposer(),
        clock=_IncrementingClock(T0),
    )


# --- ProviderRequestFactory ------------------------------------------------


def test_request_factory_builds_from_public_models() -> None:
    from ai_video_workflow.models import GenerationTask

    task = GenerationTask(
        task_id="task-shot-1-1",
        shot_id="shot-1",
        status=GenerationTaskStatus.PENDING,
        created_at=T0,
        updated_at=T0,
    )
    request = DefaultProviderRequestFactory().build(
        project=Project("proj-1", "Demo", T0),
        shot=_shot(),
        task=task,
        provider_id="manual",
    )
    assert isinstance(request, ProviderRequest)
    assert request.task_id == "task-shot-1-1"
    assert request.staging_ref == staging_ref_for("task-shot-1-1")
    assert request.prompt == "a cat playing"


# --- WorkflowDriver lifecycle ---------------------------------------------


def test_prepare_writes_instruction(tmp_path) -> None:
    _setup_project(tmp_path)
    outcome = _driver(tmp_path).prepare("task-shot-1-1")
    assert isinstance(outcome, DriverOutcome)
    assert outcome.action is OrchestrationAction.PREPARE
    assert outcome.outcome.kind is OutcomeKind.APPLIED
    assert outcome.instruction_path == "tasks/instructions/task-shot-1-1.md"
    assert (tmp_path / outcome.instruction_path).exists()
    assert outcome.staged_path is None


def test_full_lifecycle_and_status_events(tmp_path) -> None:
    _setup_project(tmp_path)
    driver = _driver(tmp_path)
    driver.prepare("task-shot-1-1")
    submit = driver.submit("task-shot-1-1")
    assert submit.outcome.kind is OutcomeKind.APPLIED
    # stage the user's media, then report + collect
    staged = tmp_path / staging_ref_for("task-shot-1-1")
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_bytes(b"user-media")
    report = driver.report_artifact("task-shot-1-1", staging_ref_for("task-shot-1-1"))
    assert report.staged_path == staging_ref_for("task-shot-1-1")
    collect = driver.collect("task-shot-1-1")
    assert collect.outcome.kind is OutcomeKind.APPLIED
    assert collect.outcome.artifact_handoff is not None
    assert collect.outcome.updated_task.status is GenerationTaskStatus.DONE
    # task_status_changed emitted for submit (pending->in_progress) and
    # collect (in_progress->done); task_created from bootstrap
    events = read_events(tmp_path)
    status_changes = [e for e in events if e.event_type.value == "task_status_changed"]
    assert len(status_changes) == 2
    assert {e.payload["new_status"] for e in status_changes} == {
        "in_progress",
        "done",
    }


def test_report_artifact_missing_staged_file(tmp_path) -> None:
    _setup_project(tmp_path)
    driver = _driver(tmp_path)
    driver.prepare("task-shot-1-1")
    driver.submit("task-shot-1-1")
    with pytest.raises(StagedFileMissingError):
        driver.report_artifact("task-shot-1-1", staging_ref_for("task-shot-1-1"))


def test_status_is_resume_assessment(tmp_path) -> None:
    _setup_project(tmp_path)
    driver = _driver(tmp_path)
    driver.prepare("task-shot-1-1")
    assessment = driver.status("task-shot-1-1")
    # a ResumeAssessment view only: it exposes the navigation fields, not
    # asset/composition state.
    assert hasattr(assessment, "phase")
    assert hasattr(assessment, "legal_actions")
    assert not hasattr(assessment, "registered_asset")


def test_record_attempt_and_rating(tmp_path) -> None:
    _setup_project(tmp_path)
    driver = _driver(tmp_path)
    attempt_id = driver.record_attempt("task-shot-1-1", note="tried once")
    assert attempt_id.startswith("manual_attempt_recorded:task-shot-1-1:")
    rating_id = driver.record_rating(
        shot_id="shot-1", task_id="task-shot-1-1", score=4, note="ok"
    )
    assert rating_id.startswith("manual_quality_rating_recorded:shot-1:")
    kinds = {e.event_type.value for e in read_events(tmp_path)}
    assert "manual_attempt_recorded" in kinds
    assert "manual_quality_rating_recorded" in kinds
