"""TASK-093 / TASK-097 批次 3 —— 单镜画布可编辑的跨层守卫。

守一件 JS 行为测试守不到的事：**两份 ADR 存在且已 Accept**，并且它们各自那条最难
的决定写进了实现。

断言刻意派生（从源码读清单再比对），不写死行数、不写死「记得改这几处」。

§2.5c 的接线账（每个新增导出都要有一条非测试调用路径 / 零调用者数只能下降）以及
画布只读那一份阶段计算、探针三态不塌成两态 —— 这几条读 ``app.js``（入口编排层），
已随 TASK-102 批次 E 移到
``tests/contract/test_frontend_write_path_invariants.py``。
"""

from __future__ import annotations

from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_MOTV = _REPO / "mockups" / "motv-workspace"
_SRC = _MOTV / "src"


def test_both_adrs_exist_accepted_and_carry_their_hard_decision() -> None:
    adr74 = (_REPO / "docs" / "adr" / "ADR-0074-character-from-image.md").read_text(
        "utf-8"
    )
    adr75 = (_REPO / "docs" / "adr" / "ADR-0075-camera-motion-presets.md").read_text(
        "utf-8"
    )
    for adr in (adr74, adr75):
        assert "状态：**Accepted" in adr
        assert "不涉及付费口径" in adr
        assert "不不可逆动用户数据" in adr

    # ADR-0074's load-bearing decision: it does NOT invent profile content
    assert "不臆造档案" in adr74
    grow = (_SRC / "workflow" / "canvasgrow.js").read_text("utf-8")
    proposal = grow.split("export function characterFromImage", 1)[1].split(
        "\n/* =", 1
    )[0]
    for invented in ("appearance:", "costume:", "personality:"):
        assert invented not in proposal, (
            f"the proposal must not fill {invented} -- the image did not say it"
        )
    assert "leftBlank" in proposal, (
        "and the blanks are stated, so they read as deliberate"
    )

    # ADR-0075's load-bearing decision: apply COPIES TEXT, keeps no preset id
    assert "与预设脱钩" in adr75
    apply_block = grow.split("export function applyCameraPreset", 1)[1].split(
        "\n/**", 1
    )[0]
    assert "preset.text" in apply_block
    # the returned value must never carry an id -- that is what makes "the preset
    # changed" a non-event for shots already using it
    assert "id:" not in apply_block, (
        "applying a preset must produce TEXT only; storing an id would let editing a "
        "template retroactively rewrite 60 shots"
    )
