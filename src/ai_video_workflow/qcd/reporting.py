"""QCD reporting: render a QcdSummary to versioned JSON + Markdown.

``run_qcd_report_step`` reads the append-only event log and the current
ProjectData, aggregates them (``aggregation.aggregate_events``), and
publishes ``reports/qcd/summary_v<N>.{json,md}`` versioned and
no-replace. The JSON is the deterministic fact source (recomputable from
the log); the Markdown is a deterministic human-readable view. This step
owns no StepManifest — the summary is pure derived data, so recomputing
is the whole recovery story. It never writes business or QCD state; the
only writes are under ``reports/qcd/`` (architecture.md §10).
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.aggregation import (
    ProjectMetrics,
    QcdSummary,
    ShotMetrics,
    TaskMetrics,
    aggregate_events,
)
from ai_video_workflow.qcd.log import read_events
from ai_video_workflow.security import resolve_within_root
from ai_video_workflow.validation import validate_utc_datetime

QCD_REPORT_SCHEMA_VERSION = 1


class QcdReportError(AiVideoWorkflowError):
    """Base error for QCD report generation."""


class QcdReportConflictError(QcdReportError):
    """A summary report path exists with conflicting content."""


@dataclass(frozen=True, slots=True)
class QcdReportOutcome:
    summary: QcdSummary
    version: int
    json_path: str
    md_path: str
    skipped: bool


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat(timespec="microseconds")


def _task_json(task: TaskMetrics) -> dict[str, object]:
    return {
        "task_id": task.task_id,
        "shot_id": task.shot_id,
        "created_at": _iso(task.created_at),
        "origin": task.origin,
        "first_asset_imported_at": _iso(task.first_asset_imported_at),
        "delivery_ms": task.delivery_ms,
        "attempt_count": task.attempt_count,
        "attempts_elapsed_ms": task.attempts_elapsed_ms,
        "cost_by_currency": dict(task.cost_by_currency),
        "validation_runs": task.validation_runs,
        "validation_failures": task.validation_failures,
        "latest_status": task.latest_status,
    }


def _shot_json(shot: ShotMetrics) -> dict[str, object]:
    return {
        "shot_id": shot.shot_id,
        "scene_id": shot.scene_id,
        "task_count": shot.task_count,
        "redo_count": shot.redo_count,
        "delivered": shot.delivered,
        "rating_count": shot.rating_count,
        "latest_rating": shot.latest_rating,
        "mean_rating": shot.mean_rating,
        "attempt_count": shot.attempt_count,
        "validation_failures": shot.validation_failures,
    }


def _project_json(project: ProjectMetrics) -> dict[str, object]:
    return {
        "project_id": project.project_id,
        "task_count": project.task_count,
        "shot_count": project.shot_count,
        "redo_count": project.redo_count,
        "delivered_shot_count": project.delivered_shot_count,
        "composition_count": project.composition_count,
        "latest_composition_at": _iso(project.latest_composition_at),
        "latest_output_version": project.latest_output_version,
        "total_attempts": project.total_attempts,
        "total_attempts_elapsed_ms": project.total_attempts_elapsed_ms,
        "cost_by_currency": dict(project.cost_by_currency),
        "rating_count": project.rating_count,
        "mean_rating": project.mean_rating,
    }


def summary_to_json_dict(
    summary: QcdSummary, *, version: int, generated_at: datetime
) -> dict[str, object]:
    """Return the fixed-key JSON-compatible dict for a QCD summary."""
    return {
        "report_schema_version": QCD_REPORT_SCHEMA_VERSION,
        "summary_schema_version": summary.summary_schema_version,
        "project_id": summary.project_id,
        "version": version,
        "generated_at": generated_at.isoformat(timespec="microseconds"),
        "derived": True,
        "event_count": summary.event_count,
        "per_task": [_task_json(t) for t in summary.per_task],
        "per_shot": [_shot_json(s) for s in summary.per_shot],
        "per_project": _project_json(summary.per_project),
        "reconciliation": [
            {"kind": g.kind, "entity_id": g.entity_id, "detail": g.detail}
            for g in summary.reconciliation
        ],
    }


def summary_to_json_bytes(
    summary: QcdSummary, *, version: int, generated_at: datetime
) -> bytes:
    obj = summary_to_json_dict(summary, version=version, generated_at=generated_at)
    return (
        json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        + "\n"
    ).encode("utf-8")


def summary_to_markdown_bytes(
    summary: QcdSummary, *, version: int, generated_at: datetime
) -> bytes:
    p = summary.per_project
    lines: list[str] = [
        f"# QCD Summary v{version} — {summary.project_id}",
        "",
        "> derived — recomputable from the QCD event log; not a source of truth.",
        "",
        f"- generated_at: {generated_at.isoformat(timespec='microseconds')}",
        f"- event_count (deduplicated): {summary.event_count}",
        "",
        "## Project",
        "",
        f"- tasks: {p.task_count} | shots: {p.shot_count} | "
        f"redos: {p.redo_count} | delivered shots: {p.delivered_shot_count}",
        f"- compositions: {p.composition_count} | "
        f"latest output version: {p.latest_output_version}",
        f"- manual attempts: {p.total_attempts} | "
        f"attempts elapsed ms: {p.total_attempts_elapsed_ms}",
        f"- cost by currency: {_fmt_cost(p.cost_by_currency)}",
        f"- ratings: {p.rating_count} | mean: {p.mean_rating}",
        "",
        "## Per shot",
        "",
        "| scene | shot | tasks | redos | delivered | ratings | mean | fails |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for s in summary.per_shot:
        lines.append(
            f"| {s.scene_id or ''} | {s.shot_id} | {s.task_count} | "
            f"{s.redo_count} | {s.delivered} | {s.rating_count} | "
            f"{s.mean_rating} | {s.validation_failures} |"
        )
    lines += [
        "",
        "## Per task",
        "",
        "| task | shot | origin | status | delivery ms | attempts | val fails |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for t in summary.per_task:
        lines.append(
            f"| {t.task_id} | {t.shot_id or ''} | {t.origin or ''} | "
            f"{t.latest_status or ''} | {t.delivery_ms} | "
            f"{t.attempt_count} | {t.validation_failures} |"
        )
    lines += ["", "## Reconciliation", ""]
    if not summary.reconciliation:
        lines.append("- none")
    else:
        for g in summary.reconciliation:
            lines.append(f"- {g.kind}: {g.entity_id} — {g.detail}")
    lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _fmt_cost(cost: object) -> str:
    items = sorted(dict(cost).items()) if cost else []
    return "none" if not items else ", ".join(f"{c}:{a}" for c, a in items)


def run_qcd_report_step(
    *, project_root: Path, data: ProjectData, observed_at: datetime
) -> QcdReportOutcome:
    """Aggregate the event log and publish a versioned QCD summary report."""
    validate_utc_datetime(observed_at, field_name="observed_at")
    events = read_events(project_root)
    summary = aggregate_events(events, data)

    version, generated_at, reused = _resolve_target(project_root, summary, observed_at)
    json_rel = f"reports/qcd/summary_v{version}.json"
    md_rel = f"reports/qcd/summary_v{version}.md"
    json_bytes = summary_to_json_bytes(
        summary, version=version, generated_at=generated_at
    )
    md_bytes = summary_to_markdown_bytes(
        summary, version=version, generated_at=generated_at
    )

    _publish(resolve_within_root(project_root, json_rel), json_bytes)
    _publish(resolve_within_root(project_root, md_rel), md_bytes)
    return QcdReportOutcome(
        summary=summary,
        version=version,
        json_path=json_rel,
        md_path=md_rel,
        skipped=reused,
    )


def _resolve_target(
    project_root: Path, summary: QcdSummary, observed_at: datetime
) -> tuple[int, datetime, bool]:
    """Return (version, generated_at, reused).

    Probes explicit per-version report paths only (no directory scan). If the
    latest existing report is byte-identical to this summary rebuilt with the
    latest report's own generated_at, that version is reused (a byte-stable
    no-op); otherwise the next version is allocated with the new observed_at.
    """
    highest = 0
    version = 1
    while resolve_within_root(
        project_root, f"reports/qcd/summary_v{version}.json"
    ).exists():
        highest = version
        version += 1
    if highest == 0:
        return 1, observed_at, False
    latest_path = resolve_within_root(
        project_root, f"reports/qcd/summary_v{highest}.json"
    )
    existing_gen = _existing_generated_at(latest_path)
    if existing_gen is not None:
        rebuilt = summary_to_json_bytes(
            summary, version=highest, generated_at=existing_gen
        )
        if latest_path.read_bytes() == rebuilt:
            return highest, existing_gen, True
    return highest + 1, observed_at, False


def _existing_generated_at(json_path: Path) -> datetime | None:
    """Return an existing report's generated_at, or None if unreadable."""
    try:
        obj = json.loads(json_path.read_text(encoding="utf-8"))
        value = obj["generated_at"]
        if isinstance(value, str):
            return validate_utc_datetime(
                datetime.fromisoformat(value), field_name="generated_at"
            )
    except (OSError, ValueError, KeyError, AiVideoWorkflowError):
        pass
    return None


def _publish(path: Path, data: bytes) -> None:
    if path.exists():
        if path.read_bytes() == data:
            return
        raise QcdReportConflictError(
            f"qcd-report: existing file has conflicting content: {path}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(tmp_path, path)
        except FileExistsError as exc:
            raise QcdReportConflictError(
                f"qcd-report: file appeared during publish: {path}"
            ) from exc
    finally:
        tmp_path.unlink(missing_ok=True)
