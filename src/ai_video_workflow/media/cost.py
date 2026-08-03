"""Unified media cost recording (TASK-035 / ADR-0038).

Paid media cost is NOT a second ledger — it REUSES the existing money-safety
chain verbatim: budget reservation (``budget/reservations/``), the pre-flight
guard (``budget/guard.py``), and the authoritative ``provider_cost_recorded``
QCD event. The ledger (``budget/ledger.py``) sums ``cost_minor_units`` +
``currency`` from ANY event, so a media cost booked here rolls up into the same
per-shot / per-project / per-month spend with no new code path.

This module is a thin, media-labelled booking helper; the offline stub provider
reports no cost, so real spend stays zero unless a real paid provider is wired
in under explicit opt-in (ADR-0006/0009).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from ai_video_workflow.budget.reservation import commit_reservation, load_reservation
from ai_video_workflow.media.errors import MediaValidationError
from ai_video_workflow.qcd.events import build_provider_cost_recorded_event
from ai_video_workflow.qcd.log import append_event

MEDIA_BILLING_SOURCE = "media_generation"


def book_media_cost(
    project_root: Path,
    *,
    project_id: str,
    shot_id: str,
    task_id: str,
    provider_id: str,
    model_id: str,
    operation_id: str,
    cost_minor_units: int,
    currency: str,
    occurred_at: datetime,
    billing_source: str = MEDIA_BILLING_SOURCE,
) -> None:
    """Record a paid-media cost exactly once through the shared cost event.

    Requires a prior budget RESERVATION for ``(task_id, operation_id)`` — the
    reservation only exists if the pre-flight budget guard passed and a hold was
    taken — so a caller can never book spend that bypasses the budget limits.
    The cost event is appended (event id
    ``provider_cost_recorded:{task_id}:{operation_id}``; the QCD log dedups
    first-wins) and the reservation is committed; both are idempotent, so a
    replayed booking never double-charges.
    """
    if not (
        isinstance(cost_minor_units, int)
        and not isinstance(cost_minor_units, bool)
        and cost_minor_units >= 0
    ):
        raise MediaValidationError(
            f"cost_minor_units must be a non-negative int: {cost_minor_units!r}"
        )
    reservation = load_reservation(project_root, task_id, operation_id)
    if reservation is None:
        raise MediaValidationError(
            f"media cost for {task_id}/{operation_id} requires a prior budget "
            "reservation (the guard-gated hold); refusing to book uncontrolled spend"
        )
    # the cost must be attributed to EXACTLY what was reserved — a mismatch would
    # misbook spend onto another project/shot/provider/model
    if (
        reservation.project_id != project_id
        or reservation.shot_id != shot_id
        or reservation.provider_id != provider_id
        or reservation.model_id != model_id
    ):
        raise MediaValidationError(
            "media cost attributes do not match the reservation "
            "(project/shot/provider/model)"
        )
    event = build_provider_cost_recorded_event(
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        provider_id=provider_id,
        model_id=model_id,
        operation_id=operation_id,
        cost_minor_units=cost_minor_units,
        currency=currency,
        billing_source=billing_source,
        occurred_at=occurred_at,
    )
    append_event(project_root, event)
    commit_reservation(
        project_root, task_id, operation_id, resolved_at=occurred_at.isoformat()
    )
