"""Paid outcome → M1 lifecycle adapter and lineage (TASK-021, ADR-0020).

Bridges a settled paid generation (cost committed, trusted media at the
contract staging path) back into the existing M1 loop with a ONE-WAY
adapter: the manual-provider lifecycle (prepare → submit →
report-artifact → collect) is driven through the untouched
WorkflowDriver/Orchestrator, then TASK-005 validation imports and
registers the media as the formal VideoAsset, and TASK-006 composition
consumes it — one authoritative path, no second asset location, no new
competing writer.

Money-safety guards (per TASK-014/016 contracts):

- integration requires a COMMITTED reservation for the task — a held
  operation is resumed only via ``poll-media``; a needs_reconciliation
  operation is a human decision; released-only means the attempt failed
  cleanly and a redo needs a NEW task (``create-redo-task``). Nothing
  here ever re-submits or re-pays.
- integration requires the staged media to match its trusted download
  receipt; unverified media never enters validation.

``build_lineage`` reassembles, read-only and purely from authoritative
records (reservations, QCD events, task/asset records, task packets),
the packet → operation → provider/model → staging → formal-asset chain.
"""

from __future__ import annotations

import json
from pathlib import Path

from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.app.paid_coordinator import media_receipt_matches
from ai_video_workflow.budget.reservation import (
    COMMITTED,
    HELD,
    NEEDS_RECONCILIATION,
    Reservation,
    list_reservations,
)
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus
from ai_video_workflow.orchestration import OrchestrationAction
from ai_video_workflow.persistence import read_model_json
from ai_video_workflow.qcd.log import read_events
from ai_video_workflow.security.paths import resolve_within_root

_RUN_LIFECYCLE = (
    OrchestrationAction.PREPARE,
    OrchestrationAction.SUBMIT,
    OrchestrationAction.REPORT_ARTIFACT,
    OrchestrationAction.COLLECT,
)


class PaidLifecycleError(AiVideoWorkflowError):
    """Raised when a paid outcome cannot be integrated into the M1 loop."""


def committed_operation(project_root: Path, task_id: str) -> Reservation:
    """Return the task's committed paid operation, or explain what to do.

    Typed, action-oriented failures: a held operation must be resumed
    with ``poll-media``; a needs_reconciliation one is a manual decision;
    released-only means the attempt failed with no charge and a redo
    requires a NEW task. No path here re-submits or re-pays.
    """
    task_ops = [r for r in list_reservations(project_root) if r.task_id == task_id]
    if not task_ops:
        raise PaidLifecycleError(
            f"task {task_id!r} has no paid operations; run paid-submit first"
        )
    committed = [r for r in task_ops if r.status == COMMITTED]
    if committed:
        return committed[0]
    if any(r.status == HELD for r in task_ops):
        raise PaidLifecycleError(
            f"task {task_id!r} has an unsettled held operation; "
            "resume it with poll-media (never re-submit)"
        )
    if any(r.status == NEEDS_RECONCILIATION for r in task_ops):
        raise PaidLifecycleError(
            f"task {task_id!r} awaits manual reconciliation; integration is "
            "blocked until a human resolves the charge state"
        )
    raise PaidLifecycleError(
        f"task {task_id!r} has only released (cleanly failed) operations; "
        "a new attempt requires create-redo-task"
    )


def require_trusted_media(project_root: Path, task_id: str) -> Path:
    """The staged media must exist AND match its trusted download receipt."""
    dest = resolve_within_root(project_root, staging_ref_for(task_id))
    receipt = resolve_within_root(
        project_root, staging_ref_for(task_id) + ".fetched.json"
    )
    if not dest.is_file():
        raise PaidLifecycleError(
            f"no staged media for {task_id!r}; recover it with poll-media"
        )
    if not media_receipt_matches(receipt, dest):
        raise PaidLifecycleError(
            f"staged media for {task_id!r} does not match its download "
            "receipt; refusing to integrate unverified media"
        )
    return dest


def drive_manual_lifecycle(driver, task_id: str) -> None:
    """Drive one task's M1 generation lifecycle, resuming from any point.

    Each fixed lifecycle action runs only when the orchestrator reports
    it legal now, so a resumed task advances without an illegal
    re-prepare; a terminal task stops the drive. The contract staging
    path is always used.
    """
    staged = staging_ref_for(task_id)
    for action in _RUN_LIFECYCLE:
        assessment = driver.status(task_id)
        if assessment.is_terminal:
            return
        if action not in assessment.legal_actions:
            continue
        if action is OrchestrationAction.PREPARE:
            driver.prepare(task_id)
        elif action is OrchestrationAction.SUBMIT:
            driver.submit(task_id)
        elif action is OrchestrationAction.REPORT_ARTIFACT:
            driver.report_artifact(task_id, staged)  # verifies the staged file
        else:  # COLLECT
            driver.collect(task_id)


def integrate_paid_media(driver, project_root: Path, task_id: str):
    """One-way adapter: settled paid media → M1 task/validation/asset.

    Pre-conditions (typed failures, nothing mutated on failure): a
    committed reservation and receipt-verified staged media. Then the
    manual lifecycle is driven through the existing orchestrator, the
    task must end DONE, and TASK-005 validation registers the formal
    VideoAsset. Idempotent: a finished task and an already-registered
    asset re-validate as no-ops.
    """
    committed_operation(project_root, task_id)
    require_trusted_media(project_root, task_id)
    drive_manual_lifecycle(driver, task_id)

    task = read_model_json(
        resolve_within_root(project_root, f"records/generation-tasks/{task_id}.json"),
        GenerationTask,
    )
    if task.status is not GenerationTaskStatus.DONE:
        raise PaidLifecycleError(
            f"task {task_id!r} is {task.status.value}, not done; cannot integrate"
        )
    outcome = driver.validate(task_id)
    if not outcome.report.passed:
        raise PaidLifecycleError(
            f"validation did not pass for {task_id!r}; see the validation "
            "report — a redo requires create-redo-task"
        )
    return outcome


def build_lineage(project_root: Path, task_id: str) -> dict:
    """Reassemble the packet→operation→provider→media→asset chain, read-only.

    Everything is derived from authoritative records: reservations (with
    provider/model/spec/external ref), QCD events (cost, import,
    validation), the GenerationTask record, and the shot's task packets
    (matched by the generation spec the reservation locked). No file is
    written; deleting nothing changes nothing — this is a projection.
    """
    reservations = [r for r in list_reservations(project_root) if r.task_id == task_id]
    events = [
        e.to_envelope() for e in read_events(project_root) if e.task_id == task_id
    ]
    task_path = resolve_within_root(
        project_root, f"records/generation-tasks/{task_id}.json"
    )
    task = None
    if task_path.is_file():
        record = read_model_json(task_path, GenerationTask)
        task = {
            "task_id": record.task_id,
            "shot_id": record.shot_id,
            "status": record.status.value,
            "provider_id": record.provider_id,
        }

    shot_id = (
        task["shot_id"] if task else (reservations[0].shot_id if reservations else None)
    )
    packets: list[dict] = []
    if shot_id is not None:
        packets_dir = resolve_within_root(project_root, "planning/packets")
        if packets_dir.is_dir():
            for path in sorted(packets_dir.glob(f"{shot_id}_v*.json")):
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                matched = any(
                    r.resolution == raw.get("resolution")
                    and r.duration_seconds == raw.get("duration_seconds")
                    and r.model_id == raw.get("model_id")
                    for r in reservations
                )
                packets.append(
                    {
                        "packet_version": raw.get("packet_version"),
                        "input_digest": raw.get("input_digest"),
                        "prompt": raw.get("prompt"),
                        "matched_operation_spec": matched,
                    }
                )

    return {
        "task_id": task_id,
        "task": task,
        "operations": [
            {
                "operation_id": r.operation_id,
                "status": r.status,
                "provider_id": r.provider_id,
                "model_id": r.model_id,
                "resolution": r.resolution,
                "duration_seconds": r.duration_seconds,
                "external_task_ref": r.external_task_ref,
                "estimate_jpy": r.estimate_jpy,
                "quote": {
                    "amount_minor_units": r.quote_minor_units,
                    "currency": r.quote_currency,
                },
            }
            for r in reservations
        ],
        "events": events,
        "packets": packets,
    }
