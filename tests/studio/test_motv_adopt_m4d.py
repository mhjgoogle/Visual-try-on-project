"""motv adopt-paid + first-frame joins by canonical Shot identity — M4d.

STRICTLY OFFLINE, no spend. The pure resolution logic (server shot_id → M4c
bridge → creativeShotId → slot; re-lock across plans; unresolved fail-safe) and
the unresolved-paid preservation are exercised by the frontend units in
``shotmap.test.mjs`` / ``assets.test.mjs`` (wrapped by the M4a/M3 python tests).
The app.js wiring guards (adopt/first-frame resolve through identity, not
sequence) moved to ``tests/contract/test_frontend_write_path_invariants.py``
in TASK-102 批次 E — every source-level guard on the entry orchestration layer
now lives in one file. What stays here is the Core-untouched contract.
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing


def test_core_contracts_untouched_by_m4d() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("creativeShotId", "resolveAdoptTarget", "unresolvedPaid"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
