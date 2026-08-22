"""motv Production Bible — checkpoint M7.

STRICTLY OFFLINE, no spend. What stays here is the Core-untouched contract
(bibledoc transitions / resolvers / v6→v7 migration / v7 validation behavior is
covered by the frontend suite, ``tests/bible.test.mjs``).

The wiring guard —— bible 与 production 同乘**一份**文档（唯一写路径），没有工作流
节点 import 或持有它 —— reads ``app.js``（入口编排层）and moved to
``tests/contract/test_frontend_write_path_invariants.py`` (TASK-102 批次 E).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing


def test_core_contracts_untouched_by_m7() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("characterId", "locationId", "bibledoc", "resolveCharacter"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
