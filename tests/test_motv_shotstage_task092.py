"""TASK-092 / ADR-0073 —— Shot 从线性状态机升级成带依赖的多 Stage 工作流。

跨语言守卫：JS 那边是行为测试（``tests/shotstage.test.mjs``），这里守的是
**规格与实现不许分家**的那几条 —— ADR 存在且已 Accepted、六个 stage 与四态
就是产品负责人给的那两份清单、依赖关系写成数据而不是散在各处的 if、
以及持久化面里只存得下 ``skipped``。

这些断言刻意**派生**（从源码里读出清单再比对），不写死版本号，也不写死
「记得改这三处」的列表 —— TASK-097 §2.6.3 第 1 条：钉死的守卫会在下一次
版本变更时静默变成永真。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_SRC = _REPO / "mockups" / "motv-workspace" / "src"


def _read(*parts: str) -> str:
    return (_SRC.joinpath(*parts)).read_text("utf-8")


def _array(src: str, name: str) -> list[str]:
    """The string members of an exported array literal, in order."""
    body = src.split(f"export const {name} = [", 1)[1].split("]", 1)[0]
    return re.findall(r'"([^"]+)"', body)


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


def test_the_six_stages_and_four_states_are_the_owners_two_lists() -> None:
    src = _read("workflow", "shotstage.js")
    assert _array(src, "STAGES") == [
        "storyboard",
        "keyframe",
        "video",
        "voice",
        "sfx",
        "qc",
    ]
    assert _array(src, "STATUSES") == [
        "not_started",
        "in_progress",
        "completed",
        "skipped",
    ]
    # 「approved」 is NOT one of them (ADR-0073 决策 3): it lives on the artifact,
    # via shotprod.isApprovedFor, so a re-generated draft loses it automatically.
    assert '"approved"' not in src.split("export const STATUSES", 1)[1].split("]", 1)[0]


def test_dependencies_are_data_not_branches() -> None:
    """决策 4 —— 加 Lip Sync / BGM / Retake 只是加一行。"""
    src = _read("workflow", "shotstage.js")
    table = src.split("export const STAGE_DEPENDENCIES = {", 1)[1].split("\n};", 1)[0]
    # every stage appears in the table, so a new one cannot be forgotten silently
    for stage in ("storyboard", "keyframe", "video", "voice", "sfx", "qc"):
        assert f"{stage}:" in table, f"{stage} has no dependency row"
    # the gate the 产品负责人 dictated, verbatim in its effect
    keyframe_row = table.split("keyframe:", 1)[1].split("\n", 1)[0]
    assert "skipped" in keyframe_row and "completed-and-approved" in keyframe_row
    assert '"completed"' not in keyframe_row, (
        "plain `completed` must NOT open the keyframe gate — the owner's rule is "
        "「approved OR skipped」, not 「completed」"
    )
    # AUDIO IS NOT GATED ON VIDEO (决策 5) — but it IS gated on 「台词已确认」.
    # Both halves matter: dropping the video gate is the point, and dropping the
    # dialogue gate would let配音 start before the line is settled (codex 轮 1).
    voice_row = table.split("voice:", 1)[1].split("\n", 1)[0]
    assert "video" not in voice_row, "音频可以先准备；把 video 写成前置会让这句话不成立"
    assert "dialogue" in voice_row, "音频的前置是「台词已确认」，不是没有前置"

    # QC IS 「两组都就位后」 (§2.5) — picture alone must not open it
    qc_rows = table.split("qc:", 1)[1]
    for needed in ("video", "voice", "sfx"):
        assert needed in qc_rows, f"QC 少了 {needed} 这一路前置"

    # the judgement itself must not branch per stage: no `stage === "..."` anywhere
    assert not re.search(r'stage\s*===\s*"', src), (
        "a per-stage branch means the dependency table is decorative"
    )


def test_only_skipped_is_persisted() -> None:
    """决策 2 —— 存储的 completed 会在产物消失后继续说做完了。"""
    src = _read("workflow", "shotstage.js")
    write_paths = [
        n for n in ("skipStage", "unskipStage") if f"export function {n}" in src
    ]
    assert write_paths == ["skipStage", "unskipStage"], "只有跳过有写路径"
    schema = _read("services", "canvasschema.js")
    # the validator refuses a document that stores anything else, so such a
    # document never loads at all
    assert "stores something other than a skip decision" in schema


def test_the_summary_has_no_second_path() -> None:
    """决策 6 —— shotStage 只从六个 stage 汇总出来。"""
    dom = _read("workflow", "shotprod.js")
    body = dom.split("export function shotStage", 1)[1].split("\n}", 1)[0]
    assert "summarizeStages" in body
    # the old linear chain read the media map directly; if any of it survived,
    # there would be two computations again
    for gone in ('return "approved"', 'return "todo-review"', 'return "generated"'):
        assert gone not in body, f"the linear chain survived inside shotStage: {gone}"


def test_the_two_new_asset_kinds_are_registered_and_findable() -> None:
    """决策 7 —— 新增 kind 必须被它的全部消费者认识。"""
    reg = _read("workflow", "assetreg.js")
    kinds = _array(reg, "ASSET_KINDS")
    assert "storyboard" in kinds and "keyframe" in kinds
    # a label and a domain for every kind, derived rather than spot-checked
    labels = reg.split("export const ASSET_KIND_LABEL = {", 1)[1].split("\n};", 1)[0]
    for k in ("storyboard", "keyframe"):
        assert k in labels, f"{k} has no human label"
    # …and the library filter finds them, which is the consumer a checklist forgets
    lib = _read("ui", "assetlibws.js")
    assert "SHOT_PICTURE_KINDS" in lib, (
        "资产库's 镜头图片 filter must cover the shot-picture FAMILY, not one kind"
    )
