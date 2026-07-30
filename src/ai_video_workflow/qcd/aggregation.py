"""QCD aggregation: event stream + ProjectData -> three-granularity summary.

``aggregate_events`` is a pure function (no IO, no clock). It consumes
the append-only QCD events (deduplicated first-wins, ADR-0003 §5) plus
the current ``ProjectData`` and returns a deeply-frozen ``QcdSummary``
with per-task / per-shot / per-project metrics and a read-only
reconciliation list. It never writes business or QCD state; all metrics
are derived and recomputable from the log (architecture.md §10). The
consumption contract for each event type is ADR-0003 §4 + its
"TASK-009 aggregation 使用方式" section; see also
docs/design/TASK-009-qcd-aggregation-design.md.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from types import MappingProxyType

from ai_video_workflow.models import GenerationTaskStatus
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.events import QcdEvent, QcdEventType

SUMMARY_SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class TaskMetrics:
    task_id: str
    shot_id: str | None
    created_at: datetime | None
    origin: str | None
    first_asset_imported_at: datetime | None
    delivery_ms: int | None
    attempt_count: int
    attempts_elapsed_ms: int | None
    cost_by_currency: Mapping[str, int]
    validation_runs: int
    validation_failures: int
    latest_status: str | None


@dataclass(frozen=True, slots=True)
class ShotMetrics:
    shot_id: str
    scene_id: str | None
    task_count: int
    redo_count: int
    delivered: bool
    rating_count: int
    latest_rating: int | None
    mean_rating: float | None
    attempt_count: int
    validation_failures: int


@dataclass(frozen=True, slots=True)
class ProjectMetrics:
    project_id: str
    task_count: int
    shot_count: int
    redo_count: int
    delivered_shot_count: int
    composition_count: int
    latest_composition_at: datetime | None
    latest_output_version: int | None
    total_attempts: int
    total_attempts_elapsed_ms: int | None
    cost_by_currency: Mapping[str, int]
    rating_count: int
    mean_rating: float | None


@dataclass(frozen=True, slots=True)
class ReconciliationGap:
    kind: str
    entity_id: str
    detail: str


@dataclass(frozen=True, slots=True)
class QcdSummary:
    summary_schema_version: int
    project_id: str
    event_count: int
    per_task: tuple[TaskMetrics, ...]
    per_shot: tuple[ShotMetrics, ...]
    per_project: ProjectMetrics
    reconciliation: tuple[ReconciliationGap, ...]


# --- internal mutable accumulators -----------------------------------------


@dataclass
class _TaskAcc:
    task_id: str
    shot_id: str | None = None
    created_at: datetime | None = None
    origin: str | None = None
    first_asset_imported_at: datetime | None = None
    attempt_count: int = 0
    attempts_elapsed_ms: int | None = None
    cost: dict[str, int] = field(default_factory=dict)
    validation_runs: int = 0
    validation_failures: int = 0
    _latest_status_key: tuple[datetime, str] | None = None
    latest_status: str | None = None


@dataclass
class _RatingAcc:
    count: int = 0
    total: int = 0
    _latest_key: tuple[datetime, str] | None = None
    latest: int | None = None


def _dedup_first_wins(events: tuple[QcdEvent, ...]) -> list[QcdEvent]:
    seen: set[str] = set()
    result: list[QcdEvent] = []
    for event in events:
        if event.event_id in seen:
            continue
        seen.add(event.event_id)
        result.append(event)
    return result


def _add_elapsed(acc_value: int | None, add: object) -> int | None:
    if not isinstance(add, int) or isinstance(add, bool):
        return acc_value
    return add if acc_value is None else acc_value + add


def aggregate_events(events: tuple[QcdEvent, ...], data: ProjectData) -> QcdSummary:
    """Aggregate deduplicated QCD events into a deeply-frozen QcdSummary."""
    deduped = _dedup_first_wins(events)

    shot_scene = {shot.shot_id: shot.scene_id for shot in data.shots}
    known_shots = set(shot_scene)
    known_tasks = {task.task_id for task in data.generation_tasks}
    done_tasks = {
        task.task_id
        for task in data.generation_tasks
        if task.status is GenerationTaskStatus.DONE
    }
    asset_ids = {asset.asset_id for asset in data.video_assets}

    tasks: dict[str, _TaskAcc] = {}
    shot_ratings: dict[str, _RatingAcc] = {}
    project_ratings = _RatingAcc()
    composition_count = 0
    latest_composition_at: datetime | None = None
    latest_output_version: int | None = None
    imported_asset_ids: set[str] = set()
    gaps: list[ReconciliationGap] = []

    def task_acc(task_id: str, shot_id: str | None) -> _TaskAcc:
        acc = tasks.get(task_id)
        if acc is None:
            acc = _TaskAcc(task_id=task_id)
            tasks[task_id] = acc
        if acc.shot_id is None and shot_id is not None:
            acc.shot_id = shot_id
        return acc

    for event in deduped:
        etype = event.event_type
        payload = event.payload
        task_id = event.task_id
        shot_id = event.shot_id
        if task_id is not None and task_id not in known_tasks:
            gaps.append(
                ReconciliationGap(
                    "event_for_unknown_task", task_id, f"{etype.value} references it"
                )
            )
        if shot_id is not None and shot_id not in known_shots:
            gaps.append(
                ReconciliationGap(
                    "event_for_unknown_shot", shot_id, f"{etype.value} references it"
                )
            )

        if etype is QcdEventType.TASK_CREATED and task_id is not None:
            acc = task_acc(task_id, shot_id)
            acc.created_at = event.occurred_at
            acc.origin = str(payload["origin"])
        elif etype is QcdEventType.TASK_STATUS_CHANGED and task_id is not None:
            acc = task_acc(task_id, shot_id)
            key = (event.occurred_at, event.event_id)
            if acc._latest_status_key is None or key > acc._latest_status_key:
                acc._latest_status_key = key
                acc.latest_status = str(payload["new_status"])
        elif etype is QcdEventType.MANUAL_ATTEMPT_RECORDED and task_id is not None:
            acc = task_acc(task_id, shot_id)
            acc.attempt_count += 1
            acc.attempts_elapsed_ms = _add_elapsed(
                acc.attempts_elapsed_ms, payload["elapsed_ms"]
            )
            cost = payload["cost_minor_units"]
            currency = payload["currency"]
            if (
                isinstance(cost, int)
                and not isinstance(cost, bool)
                and (isinstance(currency, str))
            ):
                acc.cost[currency] = acc.cost.get(currency, 0) + cost
        elif etype is QcdEventType.ASSET_IMPORTED and task_id is not None:
            acc = task_acc(task_id, shot_id)
            if (
                acc.first_asset_imported_at is None
                or event.occurred_at < acc.first_asset_imported_at
            ):
                acc.first_asset_imported_at = event.occurred_at
            reported_asset = payload["asset_id"]
            if isinstance(reported_asset, str):
                imported_asset_ids.add(reported_asset)
        elif etype is QcdEventType.VALIDATION_COMPLETED and task_id is not None:
            acc = task_acc(task_id, shot_id)
            acc.validation_runs += 1
            if payload["passed"] is False:
                acc.validation_failures += 1
        elif etype is QcdEventType.MANUAL_QUALITY_RATING_RECORDED:
            score = payload["score"]
            if isinstance(score, int) and not isinstance(score, bool):
                key = (event.occurred_at, event.event_id)
                for racc in (
                    project_ratings,
                    shot_ratings.setdefault(shot_id, _RatingAcc())
                    if shot_id is not None
                    else _RatingAcc(),
                ):
                    racc.count += 1
                    racc.total += score
                    if racc._latest_key is None or key > racc._latest_key:
                        racc._latest_key = key
                        racc.latest = score
        elif etype is QcdEventType.COMPOSITION_COMPLETED:
            composition_count += 1
            if (
                latest_composition_at is None
                or event.occurred_at > latest_composition_at
            ):
                latest_composition_at = event.occurred_at
            version = payload["output_version"]
            if isinstance(version, int) and not isinstance(version, bool):
                if latest_output_version is None or version > latest_output_version:
                    latest_output_version = version

    per_task = _build_task_metrics(tasks, gaps)
    per_shot = _build_shot_metrics(tasks, shot_ratings, shot_scene, known_shots, gaps)
    # reconciliation over business records vs the event stream
    _reconcile_records(data, tasks, done_tasks, asset_ids, imported_asset_ids, gaps)

    per_project = _build_project_metrics(
        data.project.project_id,
        per_task,
        per_shot,
        project_ratings,
        composition_count,
        latest_composition_at,
        latest_output_version,
    )

    seen_gap: set[tuple[str, str]] = set()
    unique_gaps: list[ReconciliationGap] = []
    for gap in gaps:
        key = (gap.kind, gap.entity_id)
        if key in seen_gap:
            continue
        seen_gap.add(key)
        unique_gaps.append(gap)
    unique_gaps.sort(key=lambda g: (g.kind, g.entity_id))
    return QcdSummary(
        summary_schema_version=SUMMARY_SCHEMA_VERSION,
        project_id=data.project.project_id,
        event_count=len(deduped),
        per_task=per_task,
        per_shot=per_shot,
        per_project=per_project,
        reconciliation=tuple(unique_gaps),
    )


def _delivery_ms(acc: _TaskAcc, gaps: list[ReconciliationGap]) -> int | None:
    if acc.created_at is None or acc.first_asset_imported_at is None:
        return None
    delta = (acc.first_asset_imported_at - acc.created_at).total_seconds()
    if delta < 0:
        gaps.append(
            ReconciliationGap(
                "negative_delivery",
                acc.task_id,
                "asset imported before task_created",
            )
        )
        return None
    return int(round(delta * 1000))


def _build_task_metrics(
    tasks: dict[str, _TaskAcc], gaps: list[ReconciliationGap]
) -> tuple[TaskMetrics, ...]:
    out: list[TaskMetrics] = []
    for task_id in sorted(tasks):
        acc = tasks[task_id]
        out.append(
            TaskMetrics(
                task_id=acc.task_id,
                shot_id=acc.shot_id,
                created_at=acc.created_at,
                origin=acc.origin,
                first_asset_imported_at=acc.first_asset_imported_at,
                delivery_ms=_delivery_ms(acc, gaps),
                attempt_count=acc.attempt_count,
                attempts_elapsed_ms=acc.attempts_elapsed_ms,
                cost_by_currency=MappingProxyType(dict(sorted(acc.cost.items()))),
                validation_runs=acc.validation_runs,
                validation_failures=acc.validation_failures,
                latest_status=acc.latest_status,
            )
        )
    return tuple(out)


def _mean(total: int, count: int) -> float | None:
    return None if count == 0 else round(total / count, 6)


def _build_shot_metrics(
    tasks: dict[str, _TaskAcc],
    shot_ratings: dict[str, _RatingAcc],
    shot_scene: dict[str, str],
    known_shots: set[str],
    gaps: list[ReconciliationGap],
) -> tuple[ShotMetrics, ...]:
    by_shot: dict[str, list[_TaskAcc]] = {}
    for acc in tasks.values():
        if acc.shot_id is not None:
            by_shot.setdefault(acc.shot_id, []).append(acc)
    shot_ids = set(by_shot) | set(shot_ratings) | known_shots
    out: list[ShotMetrics] = []
    for shot_id in shot_ids:
        accs = by_shot.get(shot_id, [])
        racc = shot_ratings.get(shot_id, _RatingAcc())
        scene_id = shot_scene.get(shot_id)
        out.append(
            ShotMetrics(
                shot_id=shot_id,
                scene_id=scene_id,
                task_count=len(accs),
                redo_count=sum(1 for a in accs if a.origin == "redo"),
                delivered=any(a.first_asset_imported_at is not None for a in accs),
                rating_count=racc.count,
                latest_rating=racc.latest,
                mean_rating=_mean(racc.total, racc.count),
                attempt_count=sum(a.attempt_count for a in accs),
                validation_failures=sum(a.validation_failures for a in accs),
            )
        )
    out.sort(key=lambda s: (s.scene_id or "", s.shot_id))
    return tuple(out)


def _reconcile_records(
    data: ProjectData,
    tasks: dict[str, _TaskAcc],
    done_tasks: set[str],
    asset_ids: set[str],
    imported_asset_ids: set[str],
    gaps: list[ReconciliationGap],
) -> None:
    created_task_ids = {
        task_id for task_id, acc in tasks.items() if acc.created_at is not None
    }
    for task in data.generation_tasks:
        if task.task_id not in created_task_ids:
            gaps.append(
                ReconciliationGap(
                    "task_without_created_event",
                    task.task_id,
                    "GenerationTask has no task_created event",
                )
            )
        if task.task_id in done_tasks:
            acc = tasks.get(task.task_id)
            if acc is None or acc.first_asset_imported_at is None:
                gaps.append(
                    ReconciliationGap(
                        "done_task_without_asset",
                        task.task_id,
                        "DONE task has no asset_imported event",
                    )
                )
    for asset_id in sorted(asset_ids - imported_asset_ids):
        gaps.append(
            ReconciliationGap(
                "asset_without_import_event",
                asset_id,
                "VideoAsset has no asset_imported event",
            )
        )


def _build_project_metrics(
    project_id: str,
    per_task: tuple[TaskMetrics, ...],
    per_shot: tuple[ShotMetrics, ...],
    project_ratings: _RatingAcc,
    composition_count: int,
    latest_composition_at: datetime | None,
    latest_output_version: int | None,
) -> ProjectMetrics:
    cost: dict[str, int] = {}
    elapsed: int | None = None
    for tm in per_task:
        for currency, amount in tm.cost_by_currency.items():
            cost[currency] = cost.get(currency, 0) + amount
        elapsed = _add_elapsed(elapsed, tm.attempts_elapsed_ms)
    return ProjectMetrics(
        project_id=project_id,
        task_count=len(per_task),
        shot_count=sum(1 for s in per_shot if s.task_count > 0),
        redo_count=sum(s.redo_count for s in per_shot),
        delivered_shot_count=sum(1 for s in per_shot if s.delivered),
        composition_count=composition_count,
        latest_composition_at=latest_composition_at,
        latest_output_version=latest_output_version,
        total_attempts=sum(tm.attempt_count for tm in per_task),
        total_attempts_elapsed_ms=elapsed,
        cost_by_currency=MappingProxyType(dict(sorted(cost.items()))),
        rating_count=project_ratings.count,
        mean_rating=_mean(project_ratings.total, project_ratings.count),
    )
