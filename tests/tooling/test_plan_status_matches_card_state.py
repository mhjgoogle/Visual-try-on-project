"""`docs/implementation_plan.md` 的状态列不得与卡头的状态行矛盾。

ADR-0083 定的是「卡放在哪个目录就是它的状态」，这份计划表的状态列因此曾是**第二个
真相来源** —— 而它真的漂了：2026-08-24 一次审查报出 TASK-027 做完了而表里仍写
`Planned`，顺手一查发现**五处**。所以这里加一道守卫，而不是改完了事。

ADR-0105（2026-09-17）把状态从目录搬进了卡头一行：`- 状态：待办 / 进行中 / 完成`。
守卫跟着换载体，守的东西不变：**表里那一列不许和卡自己说的矛盾。**

**为什么不删掉这一列**（那样也能消除矛盾）：这一列写的是**交付了什么**
（如 TASK-008 的「audio/ 包 + AV 混流步骤」），卡的状态只回答「做完没有」。
两者不重复，所以保留这一列并要求它与卡**不矛盾**，而不是要求它与卡一致。
判不了的（一列里写的既不是「完成」类也不是「未开始」类的词）**不判** ——
宁可漏报不误杀（AGENTS §26 那条守卫纪律）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PLAN = _REPO / "docs" / "implementation_plan.md"
_TOOLS = _REPO / ".claude" / "tools"
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))

import task_status  # noqa: E402

# `TASK-051A` / `051B` 带字母后缀 —— 第一版写的 `TASK-\d+` 把它们漏掉了，
# 而漏掉的行**完全不受检查**。这两行正是加严之后当场抓到的。
_ROW = re.compile(r"^\| \[(TASK-\d+[A-Z]?)\]\(tasks/([^)/]+)\)(.*)\|\s*$")

#: 表里那一列若写这些词，说的是「做完了」。
_SAYS_DONE = ("delivered", "done", "completed", "完成", "已完成", "已交付", "已合并")
#: 若写这些词，说的是「还没开始」。
_SAYS_NOT_STARTED = ("planned", "not started", "todo", "未开始", "待开始", "计划中")


def _rows() -> list[tuple[str, str, str]]:
    """(task id, filename, status) —— 状态取表格最后一列。"""
    out = []
    for line in _PLAN.read_text(encoding="utf-8").splitlines():
        m = _ROW.match(line)
        if not m:
            continue
        tid, filename, rest = m.groups()
        status = rest.rsplit("|", 1)[-1].strip() if "|" in rest else ""
        out.append((tid, filename, status))
    return out


def test_every_task_row_is_parsed_none_silently_skipped() -> None:
    """**每一条 TASK 行都必须被解析到，一条都不许被静默跳过。**

    只要求「至少解析出 20 行」的版本会让一条排版稍有不同的行带着过期状态或断链
    **不受任何检查**，而总数仍然 ≥ 20。改成对照**原文里所有以 `| [TASK-` 开头的行**。
    """
    text = _PLAN.read_text(encoding="utf-8")
    declared = [ln for ln in text.splitlines() if ln.startswith("| [TASK-")]
    rows = _rows()
    assert len(declared) >= 20, f"计划表里只有 {len(declared)} 条 TASK 行，扫描面坏了"
    missed = [ln[:70] for ln in declared if not _ROW.match(ln)]
    assert not missed, (
        f"这些 TASK 行没被解析到，于是它们的状态与链接**完全没被检查**：{missed}"
    )
    assert len(rows) == len(declared)
    assert all(s for _, _, s in rows), "有行没解析出状态列"


def test_every_linked_card_actually_exists() -> None:
    """链接指向的卡必须真的存在于 `docs/tasks/`。

    移动卡片却不改链接，表现是这份计划里的链接**点不开** —— 而没有任何地方会喊。
    （`test_docs_links.py` 守的是全仓相对链接，这一条是它在本表上的具体化。）
    """
    missing = [
        f"{tid} -> tasks/{filename}"
        for tid, filename, _ in _rows()
        if not (_REPO / "docs" / "tasks" / filename).is_file()
    ]
    assert not missing, f"计划表链接指向不存在的卡：{missing}"


def test_the_plan_status_column_does_not_contradict_the_card() -> None:
    """表里写「Delivered」的卡，卡头不能是 `待办` / `进行中`；表里写「Planned」的，
    卡头不能是 `完成`。判不了的词不判。"""
    cards = task_status.cards(_REPO)
    contradictions = []
    for tid, _filename, status in _rows():
        card = cards.get(tid)
        if card is None:
            continue  # 上一条测试会报它
        lowered = status.lower()
        says_done = any(w in lowered for w in _SAYS_DONE)
        says_not_started = any(w in lowered for w in _SAYS_NOT_STARTED)
        if says_done and not card.done:
            contradictions.append(f"{tid}：表写「{status}」，卡头是 {card.state}")
        if says_not_started and card.done:
            contradictions.append(f"{tid}：表写「{status}」，卡头是 {card.state}")
    assert not contradictions, "计划表与卡头状态矛盾：\n  " + "\n  ".join(
        contradictions
    )
