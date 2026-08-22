"""motv Project Asset Registry — checkpoint M3 (v2→v3 migration).

STRICTLY OFFLINE, no spend. Source-level guards on the ownership boundaries
that live inside DOM-bound closures (the registry/migration behavior itself
is covered by the frontend suite, ``tests/assets.test.mjs``):

- the edit node appends finals via the registry, not node state;
- Core ``src/ai_video_workflow/`` remains untouched by creator asset identity.

The two entry-orchestration guards — the serializer being the ONE authoritative
durable media owner, and ``mediaref.addVersion`` being the single media write
path — moved to ``tests/contract/test_frontend_write_path_invariants.py``
(TASK-102 批次 E).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def test_edit_finals_go_through_the_registry() -> None:
    src = (_SRC / "workflow" / "nodes" / "edit.js").read_text("utf-8")
    assert "ctx.addFinal" in src
    assert "ctx.finalUrls" in src
    assert "node.finals" not in src  # the node no longer owns finals


def test_core_contracts_untouched_by_m3() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    assert core_files_containing("assetId", core) == []
