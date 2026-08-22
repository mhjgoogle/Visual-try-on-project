"""Derived spend ledger, recomputed from the QCD event log (TASK-B3).

The append-only QCD event log is the single source of the raw money
facts (original ``cost_minor_units`` + ``currency``); this ledger is
purely *derived* — it converts each money-bearing event to yen with the
project's locked FX and buckets the spend by shot, by project (one
project == one episode in WFM1), and by calendar month. It never writes
back to the log or to any business state.

Cost is read from **any** event whose payload carries a non-null
``cost_minor_units`` + ``currency`` pair, so the ledger does not hardcode
which event type carries money — whatever emits cost later is aggregated
automatically.

Months are bucketed in Japan Standard Time. Japan observes no daylight
saving, so JST is the fixed offset UTC+9; no timezone database is needed.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import timedelta, timezone
from pathlib import Path

from ai_video_workflow.budget.fx import convert_to_base_minor
from ai_video_workflow.config.project_config import FxConfig
from ai_video_workflow.qcd.events import QcdEvent
from ai_video_workflow.qcd.log import read_events

_JST = timezone(timedelta(hours=9))


@dataclass(frozen=True, slots=True)
class BudgetLedger:
    """Derived yen spend, bucketed by shot, project(=episode), and month."""

    project_total_jpy: int
    per_shot_jpy: Mapping[str, int]
    per_month_jpy: Mapping[str, int]

    def shot_spent(self, shot_id: str) -> int:
        return self.per_shot_jpy.get(shot_id, 0)

    def month_spent(self, month: str) -> int:
        return self.per_month_jpy.get(month, 0)


def month_key_jst(occurred_at) -> str:
    """Return the ``YYYY-MM`` calendar month of ``occurred_at`` in JST."""
    return occurred_at.astimezone(_JST).strftime("%Y-%m")


def build_ledger(events: Iterable[QcdEvent], fx: FxConfig) -> BudgetLedger:
    """Aggregate yen spend from already-read events."""
    project_total = 0
    per_shot: dict[str, int] = defaultdict(int)
    per_month: dict[str, int] = defaultdict(int)

    for event in events:
        payload = event.payload
        amount = payload.get("cost_minor_units")
        currency = payload.get("currency")
        if amount is None or currency is None:
            continue
        jpy = convert_to_base_minor(fx, amount, currency)
        project_total += jpy
        if event.shot_id is not None:
            per_shot[event.shot_id] += jpy
        per_month[month_key_jst(event.occurred_at)] += jpy

    return BudgetLedger(
        project_total_jpy=project_total,
        per_shot_jpy=dict(per_shot),
        per_month_jpy=dict(per_month),
    )


def read_ledger(project_root: Path, fx: FxConfig) -> BudgetLedger:
    """Read the project's QCD log and aggregate yen spend."""
    return build_ledger(read_events(project_root), fx)
