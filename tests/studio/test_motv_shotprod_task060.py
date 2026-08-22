"""motv shot production state + Dailies — TASK-060 / ADR-0057.

STRICTLY OFFLINE, no spend. Guards the contract halves the frontend suite
cannot see (the module-level behavior lives in ``tests/shotprod.test.mjs`` and
runs via the frontend suite + gate + CI):

- the Core contract is untouched (all of this is mockup/client-side).

The four guards whose sole call sites live in ``app.js``（入口编排层，no
``.test.mjs`` can import it）—— 没有视频不得通过、生成成功 != 镜头完成（只有显式
人工动作能记录通过）、删除的参考不留幻影、通过 = 一条点名版本的层 1
ReviewDecision —— 已随 TASK-102 批次 E 移到
``tests/contract/test_frontend_write_path_invariants.py``。
"""

from __future__ import annotations

from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


def test_core_contracts_untouched_by_cp4() -> None:
    core = _REPO / "src" / "ai_video_workflow"
    hits = [
        p.name
        for p in core.rglob("*.py")
        if "shotProduction" in p.read_text("utf-8", errors="ignore")
    ]
    assert hits == [], f"core modules must not know about the mockup state: {hits}"
