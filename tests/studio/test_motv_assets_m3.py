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
    """合成节点不自己存成片，一律经登记表。

    TASK-074 §1.7 之后它登记的是**候选**（`ctx.addCut`）而不是成片：渲染完 ≠ 出片，
    登记 `kind: "final"` 的唯一入口是过了 G4 的那次显式导出。
    """
    src = (_SRC / "workflow" / "nodes" / "edit.js").read_text("utf-8")
    assert "ctx.addCut" in src
    assert "ctx.addFinal" not in src, (
        "合成节点不得直接登记成片 —— 那正是 G4 从来没被问过的原因（TASK-074 §1.7）"
    )
    assert "ctx.finalUrls" in src
    assert "node.finals" not in src  # the node no longer owns finals


def test_core_contracts_untouched_by_m3() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    assert core_files_containing("assetId", core) == []
