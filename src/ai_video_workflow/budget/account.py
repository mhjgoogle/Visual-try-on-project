"""Account-level monthly spend across projects (TASK-014 contract 4).

The monthly hard cap is an **account** scope: it spans every project
under an account root, not one project. Each project converts its own
authoritative costs with **its own locked FX**, and the account monthly
total is the sum of each project's spend for the given Asia/Tokyo
calendar month.

Minimal-risk account model: the account root is a directory whose
immediate subdirectories are project roots. A subdirectory is treated as
a project only if it carries a ``config/wfm1.json``; anything else is
skipped. Symlinked entries are skipped for containment safety.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.budget.errors import LedgerError
from ai_video_workflow.budget.ledger import build_ledger
from ai_video_workflow.budget.reservation import outstanding_holds
from ai_video_workflow.config.errors import ProjectConfigError
from ai_video_workflow.config.project_config import (
    PROJECT_CONFIG_RELPATH,
    load_project_config,
)
from ai_video_workflow.qcd.log import read_events

_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


@dataclass(frozen=True, slots=True)
class AccountMonthLedger:
    """Account-wide yen spend for one JST calendar month."""

    month: str
    total_jpy: int
    per_project_jpy: dict[str, int]


def read_account_month_spent(account_root: Path, month: str) -> AccountMonthLedger:
    """Sum every project's spend for ``month`` (JST), each at its own FX."""
    if _MONTH_RE.match(month) is None:
        raise LedgerError(f"month: expected 'YYYY-MM', got {month!r}")
    if not account_root.is_dir():
        raise LedgerError(f"account root is not a directory: {account_root}")

    total = 0
    per_project: dict[str, int] = {}
    for entry in sorted(account_root.iterdir()):
        if entry.is_symlink() or not entry.is_dir():
            continue
        if not (entry / PROJECT_CONFIG_RELPATH).is_file():
            continue  # not a WFM1 project
        try:
            config = load_project_config(entry)
        except ProjectConfigError as exc:
            raise LedgerError(
                f"project {entry.name!r} has an invalid config: {exc}"
            ) from exc
        ledger = build_ledger(read_events(entry), config.fx)
        spent = ledger.month_spent(month)
        if spent:
            per_project[entry.name] = spent
            total += spent

    return AccountMonthLedger(month=month, total_jpy=total, per_project_jpy=per_project)


def _project_dirs(account_root: Path):
    if not account_root.is_dir():
        raise LedgerError(f"account root is not a directory: {account_root}")
    for entry in sorted(account_root.iterdir()):
        if entry.is_symlink() or not entry.is_dir():
            continue
        if (entry / PROJECT_CONFIG_RELPATH).is_file():
            yield entry


def account_outstanding_holds(account_root: Path) -> int:
    """Sum outstanding reservation holds (yen) across all account projects.

    Reservation ``estimate_jpy`` is already in yen (converted at hold time
    with the holding project's locked FX), so cross-project holds sum
    directly. Included in the monthly budget check so an in-flight hold in
    another project cannot be double-spent past the account monthly cap.
    """
    return sum(
        outstanding_holds(project).total_jpy for project in _project_dirs(account_root)
    )
