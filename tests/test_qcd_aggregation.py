"""Tests for QCD aggregation (TASK-009): event stream -> QcdSummary."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.aggregation import aggregate_events
from ai_video_workflow.qcd.events import (
    build_asset_imported_event,
    build_composition_completed_event,
    build_manual_attempt_recorded_event,
    build_manual_quality_rating_event,
    build_task_created_event,
    build_task_status_changed_event,
    build_validation_completed_event,
)


def _t(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 30, hour, minute, 0, tzinfo=timezone.utc)


def _shot(shot_id: str, scene_id: str = "scene-1", seq: int = 1) -> Shot:
    return Shot(
        shot_id=shot_id,
        scene_id=scene_id,
        sequence=seq,
        description="d",
        prompt="p",
        duration_seconds=4.0,
        width=1280,
        height=720,
        frame_rate=24.0,
        created_at=_t(8),
    )


def _task(
    task_id: str, shot_id: str, status=GenerationTaskStatus.DONE
) -> GenerationTask:
    return GenerationTask(
        task_id=task_id,
        shot_id=shot_id,
        status=status,
        created_at=_t(8),
        updated_at=_t(9),
        completed_at=_t(9) if status is GenerationTaskStatus.DONE else None,
    )


def _asset(asset_id: str, shot_id: str, task_id: str, version: int = 1) -> VideoAsset:
    return VideoAsset(
        asset_id=asset_id,
        shot_id=shot_id,
        source_task_id=task_id,
        path=Path(f"assets/media/{asset_id}.mp4"),
        container_format="mp4",
        duration_seconds=4.0,
        width=1280,
        height=720,
        frame_rate=24.0,
        version=version,
        validated_at=_t(9),
    )


def _data(*, shots=(), tasks=(), assets=()) -> ProjectData:
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
        shots=tuple(shots),
        generation_tasks=tuple(tasks),
        video_assets=tuple(assets),
    )


def test_delivery_quality_cost_end_to_end() -> None:
    data = _data(
        shots=[_shot("shot-1")],
        tasks=[_task("task-shot-1-1", "shot-1")],
        assets=[_asset("asset-task-shot-1-1-v1", "shot-1", "task-shot-1-1")],
    )
    events = (
        build_task_created_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            configured_provider_id="manual",
            origin="bootstrap",
            redo_of_task_id=None,
            occurred_at=_t(8),
        ),
        build_manual_attempt_recorded_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            attempt_id="att-1",
            provider_id="manual",
            outcome="produced_candidate",
            occurred_at=_t(8, 30),
            elapsed_ms=120000,
            cost_minor_units=250,
            currency="USD",
        ),
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            asset_id="asset-task-shot-1-1-v1",
            sha256="a" * 64,
            size_bytes=10,
            path="assets/media/asset-task-shot-1-1-v1.mp4",
            version=1,
            duration_ms=4000,
            source_attempt_id="att-1",
            occurred_at=_t(9),
        ),
        build_validation_completed_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            passed=True,
            report_path="reports/validation/task-shot-1-1_v1.json",
            report_version=1,
            checks_total=10,
            checks_failed=0,
            input_sha256="a" * 64,
            asset_id="asset-task-shot-1-1-v1",
            occurred_at=_t(9),
        ),
        build_manual_quality_rating_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            rating_id="rate-1",
            score=4,
            asset_id="asset-task-shot-1-1-v1",
            occurred_at=_t(10),
        ),
    )
    summary = aggregate_events(events, data)

    tm = summary.per_task[0]
    assert tm.delivery_ms == 3600000  # 08:00 -> 09:00
    assert tm.attempt_count == 1
    assert tm.attempts_elapsed_ms == 120000
    assert dict(tm.cost_by_currency) == {"USD": 250}
    assert tm.validation_runs == 1 and tm.validation_failures == 0

    sm = summary.per_shot[0]
    assert sm.delivered is True
    assert sm.rating_count == 1 and sm.latest_rating == 4 and sm.mean_rating == 4.0

    pm = summary.per_project
    assert pm.task_count == 1 and pm.delivered_shot_count == 1
    assert pm.total_attempts == 1 and dict(pm.cost_by_currency) == {"USD": 250}
    assert summary.reconciliation == ()


def test_redo_count_and_latest_rating_and_mean() -> None:
    data = _data(
        shots=[_shot("shot-1")],
        tasks=[_task("task-shot-1-1", "shot-1"), _task("task-shot-1-2", "shot-1")],
    )
    events = (
        build_task_created_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            configured_provider_id="manual",
            origin="bootstrap",
            redo_of_task_id=None,
            occurred_at=_t(8),
        ),
        build_task_created_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-2",
            configured_provider_id="manual",
            origin="redo",
            redo_of_task_id="task-shot-1-1",
            occurred_at=_t(9),
        ),
        build_manual_quality_rating_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id=None,
            rating_id="rate-1",
            score=2,
            asset_id=None,
            occurred_at=_t(10),
        ),
        build_manual_quality_rating_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id=None,
            rating_id="rate-2",
            score=5,
            asset_id=None,
            occurred_at=_t(11),
        ),
    )
    summary = aggregate_events(events, data)
    sm = summary.per_shot[0]
    assert sm.task_count == 2 and sm.redo_count == 1
    assert sm.rating_count == 2 and sm.latest_rating == 5  # by occurred_at
    assert sm.mean_rating == 3.5
    assert summary.per_project.redo_count == 1


def test_cost_not_summed_across_currencies() -> None:
    data = _data(shots=[_shot("shot-1")], tasks=[_task("task-shot-1-1", "shot-1")])
    events = tuple(
        build_manual_attempt_recorded_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            attempt_id=f"att-{i}",
            provider_id="manual",
            outcome="produced_candidate",
            occurred_at=_t(8, i),
            cost_minor_units=amount,
            currency=currency,
        )
        for i, (amount, currency) in enumerate(
            [(100, "USD"), (200, "USD"), (300, "JPY")], start=1
        )
    )
    summary = aggregate_events(events, data)
    assert dict(summary.per_task[0].cost_by_currency) == {"USD": 300, "JPY": 300}
    assert dict(summary.per_project.cost_by_currency) == {"USD": 300, "JPY": 300}


def test_reconciliation_gaps() -> None:
    # a DONE task with no events; a VideoAsset never imported; an event for an
    # unknown shot/task.
    data = _data(
        shots=[_shot("shot-1")],
        tasks=[_task("task-shot-1-1", "shot-1")],
        assets=[_asset("asset-task-shot-1-1-v1", "shot-1", "task-shot-1-1")],
    )
    events = (
        build_validation_completed_event(
            project_id="proj-1",
            shot_id="shot-9",  # unknown shot
            task_id="task-shot-9-1",  # unknown task
            passed=True,
            report_path="reports/validation/task-shot-9-1_v1.json",
            report_version=1,
            checks_total=1,
            checks_failed=0,
            input_sha256="b" * 64,
            asset_id=None,
            occurred_at=_t(9),
        ),
    )
    kinds = {g.kind for g in aggregate_events(events, data).reconciliation}
    assert "task_without_created_event" in kinds  # task-shot-1-1 has no event
    assert "done_task_without_asset" in kinds
    assert "asset_without_import_event" in kinds
    assert "event_for_unknown_shot" in kinds
    assert "event_for_unknown_task" in kinds


def test_negative_delivery_is_gap_and_none() -> None:
    data = _data(shots=[_shot("shot-1")], tasks=[_task("task-shot-1-1", "shot-1")])
    events = (
        build_task_created_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            configured_provider_id="manual",
            origin="bootstrap",
            redo_of_task_id=None,
            occurred_at=_t(10),  # created AFTER the import (clock anomaly)
        ),
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            asset_id="asset-task-shot-1-1-v1",
            sha256="a" * 64,
            size_bytes=10,
            path="assets/media/x.mp4",
            version=1,
            duration_ms=4000,
            source_attempt_id=None,
            occurred_at=_t(9),
        ),
    )
    summary = aggregate_events(events, data)
    assert summary.per_task[0].delivery_ms is None
    assert any(g.kind == "negative_delivery" for g in summary.reconciliation)


def test_dedup_first_wins_idempotent() -> None:
    data = _data(shots=[_shot("shot-1")], tasks=[_task("task-shot-1-1", "shot-1")])
    event = build_task_created_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        configured_provider_id="manual",
        origin="bootstrap",
        redo_of_task_id=None,
        occurred_at=_t(8),
    )
    one = aggregate_events((event,), data)
    twice = aggregate_events((event, event), data)  # replayed duplicate
    assert one == twice
    assert twice.event_count == 1


def test_composition_metrics() -> None:
    data = _data(shots=[_shot("shot-1")], tasks=[_task("task-shot-1-1", "shot-1")])
    events = (
        build_composition_completed_event(
            project_id="proj-1",
            output_path="outputs/final_v1.mp4",
            output_version=1,
            output_sha256="c" * 64,
            input_asset_ids=("asset-a",),
            profile_digest="d",
            occurred_at=_t(11),
            output_duration_ms=8000,
        ),
        build_composition_completed_event(
            project_id="proj-1",
            output_path="outputs/final_v2.mp4",
            output_version=2,
            output_sha256="d" * 64,
            input_asset_ids=("asset-a", "asset-b"),
            profile_digest="d",
            occurred_at=_t(12),
            output_duration_ms=9000,
        ),
    )
    pm = aggregate_events(events, data).per_project
    assert pm.composition_count == 2
    assert pm.latest_output_version == 2
    assert pm.latest_composition_at == _t(12)


def test_latest_status_uses_occurred_at_then_event_id() -> None:
    data = _data(shots=[_shot("shot-1")], tasks=[_task("task-shot-1-1", "shot-1")])
    events = (
        build_task_status_changed_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            previous_status="pending",
            new_status="in_progress",
            orchestration_action="submit",
            operation_id="op-1",
            occurred_at=_t(9),
        ),
        build_task_status_changed_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-shot-1-1",
            previous_status="in_progress",
            new_status="done",
            orchestration_action="collect",
            operation_id="op-2",
            occurred_at=_t(10),
        ),
    )
    assert aggregate_events(events, data).per_task[0].latest_status == "done"
