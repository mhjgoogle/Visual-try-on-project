"""Generate `docs/STATUS.md` from the docs tree itself.

WHY THIS IS DERIVED AND NOT HAND-WRITTEN. A hand-maintained index is the exact
defect this file exists to remove: on 2026-08-23 five separate status claims in
`docs/` were found stale, and one of them (TASK-052's "待开始") had hidden two
real defects for ten days. An index that must be remembered will not be
remembered. So the overview is GENERATED from the directory a document lives in
plus the document's own status line, and `tests/tooling/test_docs_status.py`
fails when the checked-in file no longer matches -- a doc added or moved without
regenerating turns the suite red instead of silently drifting (ADR-0083).

The same argument makes the six-face CURRENT TRUTH block derived rather than a
second hand-written document (AGENTS.md 第 27 条 / ADR-0101 决策 5): Mission /
Strategy / Current Milestone are three anchored lines in `project-context.md`,
the other three faces come from the directories themselves. A missing or empty
anchor is FAIL-CLOSED -- a current truth that cannot be reconstructed is a
defect, not a blank cell, and the Milestone Gate reads face three every time a
new idea arrives.

Run: python .claude/tools/gen_docs_status.py            (rewrite docs/STATUS.md)
     python .claude/tools/gen_docs_status.py --check    (exit 1 if out of date)
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
OUT = DOCS / "STATUS.md"

_STATUS = re.compile(r"^[->\s*]*(?:状态|Status)[:：]\s*(.+)$", re.M)
_TITLE = re.compile(r"^#\s+(.+)$", re.M)

_CONTEXT = DOCS / "project-context.md"
_FACES = ("mission", "strategy", "milestone")
_FACE_LABEL = {
    "mission": "**Mission** —— 这个产品为什么存在",
    "strategy": "**Strategy** —— 用哪条路线达成",
    "milestone": "**Current Milestone** —— 这一轮交付什么",
}
_REQ_REF = re.compile(r"REQ-(\d+)")

#: 从文件名里取那个**标识**（`REQ-008-...md` → `REQ-008`，`TASK-1000-...md` →
#: `TASK-1000`）。定宽切片会在编号长一位的那天**静默错配**：`path.name[4:7]` 把
#: `REQ-1000` 截成 `100`，于是它和 `REQ-100` 的引用混在一起、表里也显示成
#: `REQ-100`（TASK-141 轮 2 审查报的 NON_BLOCKING，TASK-087 §5.29）。
#: 今天最大 `REQ-008`，所以那一天很远 —— 但**切宽度不是判据，前缀加数字才是**，
#: 而按判据写和按宽度写一样短。
_DOC_ID = re.compile(r"^((?:REQ|TASK|ADR)-\d+)")


def _doc_id(name: str) -> str:
    """`REQ-008-foo.md` → `REQ-008`；认不出来就原样返回（不猜）。"""

    hit = _DOC_ID.match(name)
    return hit.group(1) if hit else name


def _doc_num(name: str) -> str:
    """`REQ-008-foo.md` → `008`。取不到就返回空串，绝不返回一个截短的号。"""

    ident = _doc_id(name)
    return ident.split("-", 1)[1] if "-" in ident and ident != name else ""


class CurrentTruthError(RuntimeError):
    """An anchor is missing or empty. Generation stops instead of emitting a
    blank face: a current truth that lies is worse than one that is absent, and
    an absent one at least turns the suite red (ADR-0087 / ADR-0101 决策 5)."""


_PREAMBLE = """# 文档状态总览

> **本文件是生成的，不要手改。** 来源是 `docs/` 的目录结构与各文档自己的状态行；
> 重新生成：`python .claude/tools/gen_docs_status.py`。
> `tests/tooling/test_docs_status.py` 会在它与目录不一致时转红 —— 手写索引一定
> 会漂移，这正是本文件要消除的缺陷（2026-08-23 一天查出五处过期状态，其中一处
> 错标签把两条真缺陷藏了十天）。
>
> **想一眼看到「每条需求做到哪了」，看 [工作进度](WORKSTATUS.md)** —— 同一条命令
> 生成，本文件是**文档清单**，那份是**需求进度**。

## 怎么读这份文档

| 位置 | 含义 |
| --- | --- |
| `docs/tasks/active/` · `docs/design/active/` | **还没做完**，需要有人接手 |
| `docs/tasks/backlog/` | **没人在做**：已立卡但未排期（默认不读） |
| `docs/tasks/done/` · `docs/design/done/` | **已经做完**，只作历史查阅 |
| `docs/adr/` | **决策记录**，没有「完成」这一维；被取代的写明取代者 |
| `docs/design/` 根 | **稳定合同与参考**，合同不会「做完」 |
| `docs/requirements/` | 需求记录：DRAFT / CONFIRMED / SUPERSEDED |
| `docs/reports/` | 阶段性工作报告 —— **历史证据**，默认不读 |
| `docs/auto-push/` · `docs/skill-evolution/` | 工具维护的数据，不手改 |

**当前**：{n_active} 在办 · {n_backlog} 待排期 · {n_done} 已完成 · {n_adr} 条 ADR。

**找待办只看 `active/` 两个目录**，加上
[TASK-087 欠账总账](tasks/active/TASK-087-followup-ledger.md)。

## 默认加载什么（AGENTS.md 第 25 条 · ADR-0087 决策 5）

**默认读**：[AGENTS.md](../AGENTS.md) · 本次 Change 关联的 REQ ·
[当前架构合同](current-architecture.md) 里相关的那几行 ·
`docs/tasks/active/` 里**本次**这一张卡 · 本文件 · 影响范围内的代码与测试。

**默认不读**：`tasks/done/` · `design/done/` · `tasks/backlog/` · `reports/` ·
未被当前架构合同指向的历史 ADR · 被取代的 REQ 版本 · 历史 Change 清单。
只有**回归调查 / 架构理由 / 历史冲突 / 需求演化 / 复现旧决策边界**这五种情形
才按需去读 —— 历史存在，但历史不占日常开发上下文。

---
"""

_TRAILER = """## 稳定参考（没有「完成」这一维）

合同不会「做完」，决策只要 Accepted 就一直有效 —— 所以它们不进 active/done。

| 位置 | 放什么 |
| --- | --- |
| [当前架构合同](current-architecture.md) | **现在**成立的边界与约束（NOW） |
| [`docs/adr/`](adr/) | {n_adr} 条决策记录（ADR-0001 … {last}）—— WHY / HISTORY |
| [`docs/design/`](design/) 根 | 系统合同、产品信息架构、L0–S7 I/O 合同 |
| [项目背景与路线](project-context.md) | 这个项目是什么、走到哪了 |
| [实施规划](implementation_plan.md) | 阶段与里程碑路线图 |
| [产品规格](product_spec.md) · [架构](architecture.md) | 规格与架构基线 |
"""

_SECTIONS = [
    (
        "在办 · 任务卡",
        "tasks/active",
        "还没做完的任务卡。「部分完成」也在这里 —— 只要还有人要接着做，它就是在办。",
    ),
    (
        "在办 · 设计与验收文档",
        "design/active",
        "仍有未闭合项的设计、验收 runbook 与活账清单。",
    ),
    (
        "待排期 · 任务卡",
        "tasks/backlog",
        "已立卡但**没人在做**：需求成立、优先级未排。`active/` 只放正在进行的工作，"
        "否则「待办 = ls active/」会把没人做的也读成待办（ADR-0087 决策 2）。",
    ),
    (
        "已完成 · 任务卡",
        "tasks/done",
        "已完成、已验收或已退役。**退役**指目标被后续决策取代，不是被放弃。",
    ),
    (
        "已完成 · 设计与验收记录",
        "design/done",
        "已通过的里程碑评审、已落地的实施记录，及其任务卡已收口的设计文档。",
    ),
]


def _named(path: Path) -> str:
    """Repo-relative when it is inside the repo, absolute otherwise.

    The error path must not itself raise: a bare `relative_to` turns「锚点没了」
    into a ValueError traceback, which hides the very message the reader needs.
    """
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _anchored_lines() -> dict[str, str]:
    """The three hand-written faces, read from `project-context.md` anchors.

    Anchors, not prose extraction: a generator that scrapes a section would go
    on silently scraping the WRONG paragraph the first time someone reorders the
    file, and a wrong current truth is worse than a missing one (ADR-0087's
    test: does it lie once it is stale).
    """
    if not _CONTEXT.is_file():
        raise CurrentTruthError(f"{_named(_CONTEXT)} 不存在 —— 当前真相的前三面无源")
    text = _CONTEXT.read_text("utf-8")
    out: dict[str, str] = {}
    for face in _FACES:
        m = re.search(
            r"<!--\s*current-truth:\s*" + face + r"\s*-->[ \t]*\r?\n([^\r\n]*)",
            text,
        )
        # An anchor whose next line is blank, another anchor, or a heading is an
        # EMPTY face: the label is there, the fact is not. Accepting it would
        # make this guard check spelling instead of content.
        value = m.group(1).strip() if m else ""
        if value.startswith(("<!--", "#")):
            value = ""
        if not value:
            raise CurrentTruthError(
                f"{_named(_CONTEXT)} 缺少或留空了 "
                f"`<!-- current-truth: {face} -->` 的下一行 —— "
                "当前真相生成不出来即缺陷（AGENTS.md 第 27 条 / ADR-0101 决策 5）"
            )
        out[face] = value
    return out


def _cell(text: str) -> str:
    """A `|` inside a cell would split the row; the pipe is never load-bearing."""
    return text.replace("|", "／").strip()


def _binding(status: str) -> bool:
    """Does this REQ bind an Agent TODAY? (AGENTS.md 第 24 条的状态机)

    `SUPERSEDED` is history and `DRAFT` is not confirmed yet -- publishing either
    under 「现在必须成立的产品需求」 is exactly the lie this face exists to
    prevent. An UNRECOGNISED status stays listed on purpose: a face that hides a
    row it cannot classify fails silently, and silence is the worse failure.
    """
    s = status.upper()
    return "SUPERSEDED" not in s and "DRAFT" not in s


def _active_requirements() -> list[str]:
    """Every REQ that binds today, tagged with the active cards citing it.

    「Active」 means what an Agent must not contradict today, so a REQ nobody is
    working on is still listed -- it is still binding. The card column shows
    where the in-flight work is; it does not decide membership. What DOES decide
    membership is the lifecycle status (`_binding`).
    """
    req_dir = DOCS / "requirements"
    if not req_dir.is_dir():
        return []
    citations: dict[str, list[str]] = {}
    for card in sorted(
        (DOCS / "tasks" / "active").glob("TASK-*.md"), key=lambda p: p.name
    ):
        head = card.read_text("utf-8").split("## ", 1)[0]
        for num in sorted(set(_REQ_REF.findall(head))):
            citations.setdefault(num, []).append(_doc_id(card.name))
    rows = []
    for path in sorted(req_dir.glob("REQ-*.md"), key=lambda p: p.name):
        title, status = _describe(path)
        if not _binding(status):
            continue
        cards = "、".join(citations.get(_doc_num(path.name), [])) or "—"
        rel = path.relative_to(DOCS).as_posix()
        ident = _doc_id(path.name)
        rows.append(
            f"| [{ident}]({rel}) | {_cell(title)} | {_cell(status)} | {cards} |"
        )
    return rows


def _not_yet_binding() -> list[str]:
    """DRAFT / SUPERSEDED REQs, named but kept OUT of the binding table.

    They are one line below it rather than absent: a requirement that vanishes
    from the current truth is how a DRAFT gets forgotten and a SUPERSEDED one
    gets re-implemented.
    """
    req_dir = DOCS / "requirements"
    if not req_dir.is_dir():
        return []
    out = []
    for path in sorted(req_dir.glob("REQ-*.md"), key=lambda p: p.name):
        _, status = _describe(path)
        if _binding(status):
            continue
        rel = path.relative_to(DOCS).as_posix()
        out.append(f"[{_doc_id(path.name)}]({rel})（{_cell(status)}）")
    return out


def _deferred() -> list[str]:
    rows = []
    for path in sorted(
        (DOCS / "tasks" / "backlog").glob("TASK-*.md"), key=lambda p: p.name
    ):
        title, _ = _describe(path)
        rel = path.relative_to(DOCS).as_posix()
        rows.append(f"[{_doc_id(path.name)}]({rel}) {_cell(title)}")
    return rows


def _recent_decisions(n: int = 5) -> list[str]:
    rows = []
    for path in sorted((DOCS / "adr").glob("ADR-*.md"), key=lambda p: p.name)[-n:]:
        title, status = _describe(path)
        rel = path.relative_to(DOCS).as_posix()
        rows.append(
            f"| [{_doc_id(path.name)}]({rel}) | {_cell(title)} | {_cell(status)} |"
        )
    return list(reversed(rows))


def _current_truth() -> list[str]:
    """The six faces, in one place, at the top -- because the Milestone Gate has
    to read face three on EVERY new idea, and a gate whose input is not already
    loaded stops being run by week two (ADR-0101 决策 5)."""
    faces = _anchored_lines()
    lines = [
        "## 当前真相（六面）",
        "",
        "> **生成的。** 前三面来自 [project-context.md](project-context.md) 的",
        "> `<!-- current-truth: … -->` 锚点（仓库里仅有的三行手写排期事实），",
        "> 后三面从目录派生（AGENTS.md 第 27 条 ·",
        "> [ADR-0101](adr/ADR-0101-idea-intake-level-and-milestone-gate.md) 决策 5）。",
        "",
        "**新想法先过 Milestone Gate**：读下面第三面，四问（在当前里程碑交付面上 /",
        "阻塞在办主线 / 不做会造成不可逆损害 / 是几分钟的当前事实修正）**全 No 就落**",
        "`tasks/backlog/` **一张卡，不实施**。"
        "闸判错可逆，因此不问用户（AGENTS.md §1–2）。",
        "",
        "| 面 | 现在是什么 |",
        "| --- | --- |",
    ]
    for face in _FACES:
        lines.append(f"| {_FACE_LABEL[face]} | {_cell(faces[face])} |")
    lines += [
        "",
        "### Active Requirements",
        "",
        "现在必须成立的产品需求。「在办卡」列是 `tasks/active/` 里卡头引用它的那些 ——",
        "**空不代表失效**，只代表这一轮没人在动它。",
        "",
        "| REQ | 标题 | 状态 | 在办卡 |",
        "| --- | --- | --- | --- |",
    ]
    lines += _active_requirements() or ["| — | （`docs/requirements/` 为空） | — | — |"]
    pending = _not_yet_binding()
    if pending:
        lines += [
            "",
            "不在上表里（今天不约束任何人，但也没消失）：" + "、".join(pending),
        ]
    deferred = _deferred()
    lines += [
        "",
        "### Deferred",
        "",
        f"里程碑闸判「现在不做」的 {len(deferred)} 张卡（`tasks/backlog/`）——",
        "**队列，不是垃圾桶**：每张卡都要写清什么条件下它会变成该做。",
        "跨任务欠账另见 [TASK-087 总账](tasks/active/TASK-087-followup-ledger.md)。",
        "",
    ]
    lines += [f"- {row}" for row in deferred] or ["- （空）"]
    lines += [
        "",
        "### Recent Decisions",
        "",
        "最近 5 条 ADR（新→旧）。**WHY / HISTORY 在这里**，**WHAT IS TRUE NOW 在**",
        "[当前架构合同](current-architecture.md)，两者不合并（ADR-0098）。",
        "",
        "| ADR | 标题 | 状态 |",
        "| --- | --- | --- |",
    ]
    lines += _recent_decisions()
    lines.append("")
    return lines


def _first_clause(raw: str, limit: int = 92) -> str:
    """The verdict is the FIRST clause. Everything after 「——」 is the reason or
    the superseded wording, and strikethrough is always history."""
    text = re.sub(r"~~.*?~~", "", raw)
    text = re.split(r"——|。|；", text)[0]
    # 状态行里的相对链接是按它自己那份文档的位置写的，抄进 STATUS.md 就指错了 ——
    # 压成纯文本（表格格子里本来也不该再挂链接）。
    text = re.sub(r"\[([^]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*`]", "", text).strip()
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def _describe(path: Path) -> tuple[str, str]:
    text = path.read_text("utf-8")
    title_m = _TITLE.search(text)
    title = re.sub(r"[*`]", "", title_m.group(1)).strip() if title_m else path.stem
    status_m = _STATUS.search(text)
    status = _first_clause(status_m.group(1)) if status_m else "—"
    return title, status


def _section(heading: str, rel_folder: str, blurb: str) -> list[str]:
    folder = DOCS / rel_folder
    if not folder.is_dir():
        return []
    rows = [f"## {heading}", "", blurb, ""]
    rows.append("| 文档 | 标题 | 状态行（首句） |")
    rows.append("| --- | --- | --- |")
    # 按**文件名字符串**排，不是按 Path 排。`sorted()` 比较 Path 时用的是
    # `_str_normcase`：Windows 上先折叠大小写，POSIX 上原样比 —— 同一份代码
    # 因此在两个平台给出不同顺序，而这个文件是要被 `test_docs_status` 逐字节
    # 比对的。于是它在权威平台上永远绿、在 Ubuntu CI 上永远红（TASK-140：
    # `design/done/` 里 M1-/TASK-/WFM1-/WSM3- 那 8 行的位置差异）。
    # AGENTS §3「平台中立，不是 POSIX」——一个排序结果取决于自己跑在哪的
    # 生成器，正是它禁止的东西。
    for path in sorted(folder.iterdir(), key=lambda p: p.name):
        if path.suffix.lower() not in {".md", ".patch"}:
            continue
        rel = path.relative_to(DOCS).as_posix()
        if path.suffix.lower() == ".patch":
            rows.append(f"| [{path.name}]({rel}) | （patch 留痕） | — |")
            continue
        title, status = _describe(path)
        rows.append(f"| [{path.name}]({rel}) | {title} | {status} |")
    rows.append("")
    return rows


def render() -> str:
    adr = sorted((DOCS / "adr").glob("ADR-*.md"), key=lambda p: p.name)
    n_active = len(list((DOCS / "tasks" / "active").glob("*.md")))
    n_backlog = len(list((DOCS / "tasks" / "backlog").glob("*.md")))
    n_done = len(list((DOCS / "tasks" / "done").glob("*")))
    lines = _PREAMBLE.format(
        n_active=n_active, n_backlog=n_backlog, n_done=n_done, n_adr=len(adr)
    ).splitlines()
    lines += _current_truth()
    for heading, folder, blurb in _SECTIONS:
        lines += _section(heading, folder, blurb)
    last = _doc_id(adr[-1].name) if adr else "—"
    lines += _TRAILER.format(n_adr=len(adr), last=last).splitlines()
    return "\n".join(lines).rstrip() + "\n"


# --- 工作进度（docs/WORKSTATUS.md）-------------------------------------------
#
# 产品负责人 2026-09-07：「我想做一个 workstatus。让我能够掌握各个开发需求完成的
# 进度。但是不要写需求。只需要有需求的 link 就可以了。」
#
# 所以这份文件**一个字需求内容都不写**，只写「做到哪了」+ 链接。理由不只是他这么
# 要求：需求正文抄第二遍，就会有两份各自漂移的真相，而文档漂移是本仓库记录在案的
# 最高频缺陷。
#
# 进度**从卡派生**，不手写：卡头 `关联 Requirement` 行里的 `REQ-NNN`，加上卡所在
# 目录（`done/` `active/` `backlog/` 就是它的状态，ADR-0083）。
#
# **为什么不做判据级进度**（那才是理想粒度）：8 份 REQ 里只有 3 份把判据写成了可
# 解析的顶层有序列表，其余混在散文与版本说明里。硬做会让 5 条需求显示「0 条判据」
# —— 比没有更糟，因为它看起来像事实。要做得先统一 REQ 的判据格式，那是改需求文件，
# 不在本次范围里。

WORK_OUT = DOCS / "WORKSTATUS.md"

_WORK_HEAD = """# 工作进度

> **这份文件是生成的，别手改** —— `python .claude/tools/gen_docs_status.py`。
>
> 一行一条需求：**做到哪了、谁在做、还差什么**。这里不写需求内容，只给链接 ——
> 需求正文在链接那一头，抄第二遍就会有两份各自漂移的真相。
>
> 进度是**从卡派生**的：卡头引用了哪条 REQ，加上卡在 `done/` `active/` `backlog/`
> 的哪一格（目录即状态）。**它衡量的是「这条需求的工作做了多少」，不是「这条需求
> 满足了多少」** —— 后者要判据级对账，而 REQ 的判据格式今天还不统一（见生成器注释）。
"""

_DOT = "\u00b7"
_DASH = "\u2014"


def _cards_by_req() -> dict:
    """每条 REQ 被哪些卡引用，按卡所在目录分组（目录即状态）。

    只读卡头（第一个 `## ` 之前）—— 正文里提到别的 REQ 是引用，不是归属。
    """
    out: dict[str, dict[str, list[str]]] = {}
    for state in ("done", "active", "backlog"):
        folder = DOCS / "tasks" / state
        if not folder.is_dir():
            continue
        for card in sorted(folder.glob("TASK-*.md"), key=lambda p: p.name):
            head = card.read_text("utf-8").split("## ", 1)[0]
            for num in sorted(set(_REQ_REF.findall(head))):
                out.setdefault(num, {}).setdefault(state, []).append(_doc_id(card.name))
    return out


def _bar(done: int, total: int, width: int = 10) -> str:
    """进度条。**分母是「引用这条需求的卡」的总数，不是判据数。**

    满格不写成「完成」，写成「卡都做完了」—— 这两件事不是一回事，而一根满格的
    绿条本身就是一句很强的断言。实例：REQ-006 的判据 1 在 TASK-128 落地之前
    始终是 `PARTIAL`（codex 2026-09-05 判过），可如果那时引用它的卡恰好都在
    `done/`，这一列就会显示满格 —— **它说的是「没有在办/待排期的卡了」，
    不是「这条需求满足了」。**
    """
    if not total:
        return _DASH
    filled = round(width * done / total)
    bar = "\u2588" * filled + "\u2591" * (width - filled)
    tail = "卡都做完了" if done == total else f"{done}/{total}"
    return f"{bar} {tail}"


def render_work() -> str:
    """`docs/WORKSTATUS.md` —— 一屏看完每条需求做到哪了。"""
    req_dir = DOCS / "requirements"
    cites = _cards_by_req()
    lines = _WORK_HEAD.strip().splitlines()
    lines += ["", "## 每条需求做到哪了", ""]
    lines.append("| 需求 | 进度（卡） | 已完成 | 在办 | 待排期 |")
    lines.append("| --- | --- | --- | --- | --- |")
    orphans = []
    for path in sorted(req_dir.glob("REQ-*.md"), key=lambda p: p.name):
        _title, status = _describe(path)
        if not _binding(status):
            continue
        by = cites.get(_doc_num(path.name), {})
        done = by.get("done", [])
        active = by.get("active", [])
        backlog = by.get("backlog", [])
        total = len(done) + len(active) + len(backlog)
        if not total:
            orphans.append(path)
        rel = path.relative_to(DOCS).as_posix()
        cells = [
            f"[{_doc_id(path.name)}]({rel})",
            _bar(len(done), total),
            _DOT.join(done) or _DASH,
            _DOT.join(active) or _DASH,
            _DOT.join(backlog) or _DASH,
        ]
        lines.append("| " + " | ".join(cells) + " |")
    lines.append("")

    lines += ["## 没有任何卡引用的需求", ""]
    if orphans:
        lines.append(
            "**这几条今天没有落点** —— 不是「做完了」，是**没人把它变成过一张卡**。"
        )
        lines.append("")
        for path in orphans:
            rel = path.relative_to(DOCS).as_posix()
            lines.append(f"- [{_doc_id(path.name)}]({rel})")
    else:
        lines.append("（没有 —— 每条生效需求都至少有一张卡。）")
    lines.append("")

    lines += ["## 在办、但不服务任何需求的卡", ""]
    lines.append(
        "Bug / 工装 / Refactor 这类写的是**技术目标**而不是 REQ（AGENTS §20）。"
        "列在这里，是因为一块只显示需求的板子会让人以为「没别的事在做」。"
    )
    lines.append("")
    folder = DOCS / "tasks" / "active"
    loose = []
    if folder.is_dir():
        for card in sorted(folder.glob("TASK-*.md"), key=lambda p: p.name):
            head = card.read_text("utf-8").split("## ", 1)[0]
            if not _REQ_REF.search(head):
                rel = card.relative_to(DOCS).as_posix()
                loose.append(f"- [{_doc_id(card.name)}]({rel})")
    lines += loose or ["（没有。）"]
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        text = render()
    except CurrentTruthError as exc:
        # Fail closed: writing the rest of STATUS.md without the six faces would
        # look like a successful regeneration (ADR-0101 决策 5).
        print(f"当前真相无法重建：{exc}", file=sys.stderr)
        return 2
    work = render_work()
    if args.check:
        stale = [
            out.relative_to(ROOT).as_posix()
            for out, want in ((OUT, text), (WORK_OUT, work))
            if (out.read_text("utf-8") if out.exists() else "") != want
        ]
        if stale:
            print(" / ".join(stale) + " is out of date -- regenerate it")
            return 1
        print("docs/STATUS.md + docs/WORKSTATUS.md up to date")
        return 0
    # **一条命令生成两份**，而不是两个工具：两份都从同一棵树派生，分开跑就会
    # 出现「一份新一份旧」，那正是这两份文件存在的理由要防的东西。
    OUT.write_text(text, "utf-8")
    WORK_OUT.write_text(work, "utf-8")
    for out in (OUT, WORK_OUT):
        print(f"wrote {out.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
