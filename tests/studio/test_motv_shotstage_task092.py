"""TASK-092 / ADR-0073 —— Shot 从线性状态机升级成带依赖的多 Stage 工作流。

JS 侧的行为测试在 ``mockups/motv-workspace/tests/shotstage.test.mjs``（由前端
套件 + gate 前端档 + CI 承担）。这里只守文档侧：ADR 存在且已 Accepted，且写明
它可由实施 Agent 自行 Accept 的依据。
"""

from __future__ import annotations

from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


def test_the_adr_exists_and_is_accepted() -> None:
    adr = (_REPO / "docs" / "adr" / "ADR-0073-shot-multi-stage-workflow.md").read_text(
        "utf-8"
    )
    assert "状态：**Accepted" in adr
    # It is a TECHNICAL ADR, so the implementing agent may Accept it (CLAUDE.md
    # 「ADR 的 Accept 权」) — but only because it touches neither 付费 nor an
    # irreversible write. The ADR has to say so out loud.
    assert "不涉及付费口径" in adr
    assert "不不可逆动用户数据" in adr
