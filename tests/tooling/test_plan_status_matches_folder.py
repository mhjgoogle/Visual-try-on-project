"""`docs/implementation_plan.md` 的状态列不得与卡所在目录矛盾。

ADR-0083 定的是「**卡放在哪个目录就是它的状态**」。这份计划表的状态列因此是
**第二个真相来源** —— 而它真的漂了：2026-08-24 一次审查报出 TASK-027 移进
`done/` 而表里仍写 `Planned`，顺手一查发现**五处**（024/025/026/027 都在
`done/` 里写着 `Planned`，TASK-008 在 `active/` 里写着 `Delivered`）。

四张早就做完的卡在这份计划里看起来还没开工。交接文档开头记的那条教训
（TASK-052 错标签把两条真缺陷藏了十天）就是这么来的 —— 所以这里加一道守卫，
而不是改完了事。

**为什么不删掉这一列**（那样也能消除矛盾）：这一列写的是**交付了什么**
（如 TASK-008 的「audio/ 包 + AV 混流步骤」），目录只回答「做完没有」。
两者不重复，所以保留这一列并要求它与目录**不矛盾**，而不是要求它与目录一致。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PLAN = _REPO / "docs" / "implementation_plan.md"

# `TASK-051A` / `051B` 带字母后缀 —— 第一版写的 `TASK-\d+` 把它们漏掉了，
# 而漏掉的行**完全不受检查**。这两行正是加严之后当场抓到的。
_ROW = re.compile(r"^\| \[(TASK-\d+[A-Z]?)\]\(tasks/(active|done)/([^)]+)\)(.*)\|\s*$")


def _rows() -> list[tuple[str, str, str, str]]:
    """(task id, folder, filename, status) —— 状态取表格最后一列。"""
    out = []
    for line in _PLAN.read_text(encoding="utf-8").splitlines():
        m = _ROW.match(line)
        if not m:
            continue
        tid, folder, filename, rest = m.groups()
        status = rest.rsplit("|", 1)[-1].strip() if "|" in rest else ""
        out.append((tid, folder, filename, status))
    return out


def test_every_task_row_is_parsed_none_silently_skipped() -> None:
    """**每一条 TASK 行都必须被解析到，一条都不许被静默跳过。**

    第一版只要求「至少解析出 20 行」（codex 复审非阻塞，判得对）：一条排版
    稍有不同的行会被正则漏掉，于是它带着过期状态或断链**不受任何检查**，
    而总数仍然 ≥ 20，测试照样绿。

    改成对照**原文里所有以 `| [TASK-` 开头的行**：解析到的必须一条不少。
    这是本轮反复出现的那一族（守卫在它要守的东西溜走时仍然绿）的又一个实例。
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
    assert any(f == "done" for _, f, _, _ in rows)
    assert any(f == "active" for _, f, _, _ in rows)
    assert all(s for _, _, _, s in rows), "有行没解析出状态列"


def test_every_linked_card_actually_exists_where_the_plan_says() -> None:
    """链接指向的目录必须真的有这张卡。

    移动卡片却不改链接，表现是这份计划里的链接**点不开** —— 而没有任何地方
    会喊。（`test_docs_links.py` 守的是全仓相对链接，这一条是它在本表上的
    具体化：一起红比只有一条红更容易定位。）
    """
    missing = [
        f"{tid} -> {folder}/{filename}"
        for tid, folder, filename, _ in _rows()
        if not (_REPO / "docs" / "tasks" / folder / filename).is_file()
    ]
    assert not missing, f"计划表指向不存在的卡：{missing}"


def test_a_done_card_is_never_listed_as_not_started() -> None:
    """在 `done/` 里的卡，状态列不得写成「还没开工」。

    这是那五处漂移里的四处。一张做完的卡在计划里显示成 `Planned`，
    下一个人会照着它重做一遍，或者以为某条能力还不存在。
    """
    NOT_STARTED = ("Planned", "Outline", "未开始", "待开始")
    wrong = [
        f"{tid}（{status}）"
        for tid, folder, _, status in _rows()
        if folder == "done" and status.startswith(NOT_STARTED)
    ]
    assert not wrong, (
        f"这些卡在 `done/` 里，计划表却写着还没开工：{wrong}。"
        "ADR-0083：卡放在哪个目录就是它的状态。"
    )


def test_an_active_card_is_never_listed_as_fully_delivered() -> None:
    """在 `active/` 里的卡，状态列不得写成**已完整交付**。

    这是那五处里的另一处（TASK-008）。它确实交付过一部分，所以正确的写法是
    「部分交付」—— **不是抹掉那段描述**：那一列写的是「交付了什么」，
    目录只回答「做完没有」，两者不重复。
    """
    wrong = [
        f"{tid}（{status}）"
        for tid, folder, _, status in _rows()
        if folder == "active"
        and status.startswith(("Delivered", "Done", "已完成", "已交付"))
    ]
    assert not wrong, (
        f"这些卡还在 `active/`，计划表却写着已交付：{wrong}。"
        "部分交付请写「部分交付（…）」，让两件事都说得出来。"
    )
