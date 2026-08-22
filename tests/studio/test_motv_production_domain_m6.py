"""motv Production domain structure — checkpoint M6.

STRICTLY OFFLINE, no spend. What stays here is the Core-untouched contract
(proddoc transitions / episode read model / v5→v6 migration / v6 validation
behavior is covered by the frontend suite, ``tests/proddoc.test.mjs``).

The wiring guard —— Project → Episodes → Scenes → Shots 是**项目级**持久化文档
（顶层 ``production``），不是工作流节点状态 —— reads ``app.js``（入口编排层）and
moved to ``tests/contract/test_frontend_write_path_invariants.py``
(TASK-102 批次 E).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing


def test_core_contracts_untouched_by_m6() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("episodeId", "sceneId", "createProduction", "proddoc"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
