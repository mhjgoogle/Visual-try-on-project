"""Generate `docs/STATUS.md` and `docs/WORKSTATUS.md` from the docs tree itself.

WHY THIS IS DERIVED AND NOT HAND-WRITTEN. A hand-maintained index is the exact
defect this file exists to remove: on 2026-08-23 five separate status claims in
`docs/` were found stale, and one of them (TASK-052's "待开始") had hidden two
real defects for ten days. An index that must be remembered will not be
remembered. So the overview is GENERATED from each document's own status line,
and `tests/tooling/test_docs_status.py` fails when the checked-in file no longer
matches -- a card whose status changed without regenerating turns the suite red
instead of silently drifting (ADR-0083, as amended by ADR-0105).

WHERE A TASK'S STATE LIVES (ADR-0105 / TASK-150). Product owner, 2026-09-17:
「我希望 folder 不要分 done 和 active 了。这些能在这个仓库的任务管理器里面找到现在
在进行中的任务。」 So `docs/tasks/` is ONE flat folder and every card carries a
machine-readable `- 状态：待办 / 进行中 / 完成` line, read through
`.claude/tools/task_status.py` -- the single source of that grammar. A card with
no legal state line is a DEFECT and generation stops (fail-closed): a task that
silently drops out of 「进行中」 is exactly the lie this file exists to prevent.

The same argument makes the six-face CURRENT TRUTH block derived rather than a
second hand-written document (AGENTS.md 第 27 条 / ADR-0101 决策 5): Mission /
Strategy / Current Milestone are three anchored lines in `project-context.md`,
the other three faces come from the cards' states and the ADR folder.

Run: python .claude/tools/gen_docs_status.py            (rewrite both files)
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

sys.path.insert(0, str(ROOT / ".claude" / "tools"))
import task_status  # noqa: E402

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
    """An anchor is missing or empty, or a card has no legal state. Generation
    stops instead of emitting a blank or a guess: a current truth that lies is
    worse than one that is absent, and an absent one at least turns the suite
    red (ADR-0087 / ADR-0101 决策 5 / ADR-0105)."""


_PREAMBLE = """# 文档状态总览

> **本文件是生成的，不要手改。** 来源是各文档自己的状态行；
> 重新生成：`python .claude/tools/gen_docs_status.py`。
> `tests/tooling/test_docs_status.py` 会在它与文档不一致时转红 —— 手写索引一定
> 会漂移，这正是本文件要消除的缺陷（2026-08-23 一天查出五处过期状态，其中一处
> 错标签把两条真缺陷藏了十天）。
>
> **想一眼看到「每条需求做到哪了」，看 [工作进度](WORKSTATUS.md)** —— 同一条命令
> 生成，本文件是**文档清单**，那份是**需求进度**。

## 怎么读这份文档

| 位置 | 含义 |
| --- | --- |
| `docs/tasks/` | **所有任务卡，平铺一层**；状态看卡头那一行（ADR-0105） |
| `docs/design/active/` | 仍有未闭合项的设计、验收 runbook 与活账清单 |
| `docs/design/done/` | 已通过的评审、已落地的实施记录 —— 历史查阅 |
| `docs/adr/` | **决策记录**，没有「完成」这一维；被取代的写明取代者 |
| `docs/design/` 根 | **稳定合同与参考**，合同不会「做完」 |
| `docs/requirements/` | 需求记录：DRAFT / CONFIRMED / SUPERSEDED |
| `docs/reports/` | 阶段性工作报告与审查记录 —— **历史证据**，默认不读 |
| `docs/auto-push/` · `docs/skill-evolution/` | 工具维护的数据，不手改 |

卡头状态行只有三个词：`待办` 没人在做 · `进行中` 在办 · `完成` 已完成。

**当前**：{n_active} 在办 · {n_backlog} 待办 · {n_done} 已完成 · {n_adr} 条 ADR。

**找在办的任务**：本文件的「进行中 · 任务卡」一节，或
`python .claude/tools/agent_harness.py resume`，加上
[TASK-087 欠账总账](tasks/TASK-087-followup-ledger.md)。

## 默认加载什么（AGENTS.md 第 25 条 · ADR-0087 决策 5）

**默认读**：[AGENTS.md](../AGENTS.md) · 本次 Change 关联的 REQ ·
[当前架构合同](current-architecture.md) 里相关的那几行 ·
`docs/tasks/` 里**本次**这一张卡 · 本文件 · 影响范围内的代码与测试。

**默认不读**：状态为 `完成` 或 `待办` 的卡 · `design/done/` · `reports/` ·
未被当前架构合同指向的历史 ADR · 被取代的 REQ 版本 · 历史 Change 清单。
只有**回归调查 / 架构理由 / 历史冲突 / 需求演化 / 复现旧决策边界**这五种情形
才按需去读 —— 历史存在，但历史不占日常开发上下文。

---
"""

_TRAILER = """## 稳定参考（没有「完成」这一维）

合同不会「做完」，决策只要 Accepted 就一直有效 —— 所以它们没有状态行里的三态。

| 位置 | 放什么 |
| --- | --- |
| [当前架构合同](current-architecture.md) | **现在**成立的边界与约束（NOW） |
| [`docs/adr/`](adr/) | {n_adr} 条决策记录（ADR-0001 … {last}）—— WHY / HISTORY |
| [`docs/design/`](design/) 根 | 系统合同、产品信息架构、L0–S7 I/O 合同 |
| [项目背景与路线](project-context.md) | 这个项目是什么、走到哪了 |
| [实施规划](implementation_plan.md) | 阶段与里程碑路线图 |
| [产品规格](product_spec.md) · [架构](architecture.md) | 规格与架构基线 |
"""

#: 任务卡按状态分三节；设计文档仍按目录（它们不在本次范围里，ADR-0105 §范围）。
_TASK_SECTIONS = [
    (
        "进行中 · 任务卡",
        "进行中",
        "还没做完的任务卡。「部分完成」也在这里 —— 只要还有人要接着做，它就是在办。",
    ),
    (
        "待办 · 任务卡",
        "待办",
        "已立卡但**没人在做**：需求成立、优先级未排。`进行中` 只给正在进行的工作，"
        "否则「待办 = 进行中的那些」会把没人做的也读成待办（ADR-0087 决策 2）。",
    ),
    (
        "完成 · 任务卡",
        "完成",
        "已完成、已验收或已退役。**退役**指目标被后续决策取代，不是被放弃。",
    ),
]

_DESIGN_SECTIONS = [
    (
        "在办 · 设计与验收文档",
        "design/active",
        "仍有未闭合项的设计、验收 runbook 与活账清单。",
    ),
    (
        "已完成 · 设计与验收记录",
        "design/done",
        "已通过的里程碑评审、已落地的实施记录，及其任务卡已收口的设计文档。",
    ),
]


def _named(path: Path) -> str:
    """Repo-relative when it is inside the repo, absolute otherwise."""
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _anchored_lines() -> dict[str, str]:
    """The three hand-written faces, read from `project-context.md` anchors.

    Anchors, not prose extraction: a generator that scrapes a section would go
    on silently scraping the WRONG paragraph the first time someone reorders the
    file, and a wrong current truth is worse than a missing one.
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


def _cards() -> dict[str, list[task_status.Card]]:
    """Every card grouped by state. A card without a legal state line, or two
    cards sharing one id, stops generation -- fail-closed (ADR-0105)."""
    # `DOCS.parent`，不是 `ROOT`：测试把 `DOCS` 指向一棵假仓库，卡必须从那里读。
    try:
        return task_status.by_state(DOCS.parent)
    except (task_status.MissingState, ValueError) as exc:
        raise CurrentTruthError(str(exc)) from exc


def _cell(text: str) -> str:
    """A `|` inside a cell would split the row; the pipe is never load-bearing."""
    return text.replace("|", "／").strip()


def _binding(status: str) -> bool:
    """Does this REQ bind an Agent TODAY? (AGENTS.md 第 24 条的状态机)"""
    s = status.upper()
    return "SUPERSEDED" not in s and "DRAFT" not in s


def _head(path: Path) -> str:
    """The card header (before the first `## `) -- citations there are
    ownership; citations in the body are just references."""
    return path.read_text("utf-8").split("## ", 1)[0]


def _active_requirements(
    groups: dict[str, list[task_status.Card]] | None = None,
) -> list[str]:
    """Every REQ that binds today, tagged with the 进行中 cards citing it."""
    groups = _cards() if groups is None else groups
    req_dir = DOCS / "requirements"
    if not req_dir.is_dir():
        return []
    citations: dict[str, list[str]] = {}
    for card in groups["进行中"]:
        for num in sorted(set(_REQ_REF.findall(_head(card.path)))):
            citations.setdefault(num, []).append(card.task)
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


def _deferred(groups: dict[str, list[task_status.Card]]) -> list[str]:
    rows = []
    for card in groups["待办"]:
        title, _ = _describe(card.path)
        rel = card.path.relative_to(DOCS).as_posix()
        rows.append(f"[{card.task}]({rel}) {_cell(title)}")
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


def _current_truth(groups: dict[str, list[task_status.Card]]) -> list[str]:
    faces = _anchored_lines()
    lines = [
        "## 当前真相（六面）",
        "",
        "> **生成的。** 前三面来自 [project-context.md](project-context.md) 的",
        "> `<!-- current-truth: … -->` 锚点（仓库里仅有的三行手写排期事实），",
        "> 后三面从卡的状态行与 ADR 目录派生（AGENTS.md 第 27 条 ·",
        "> [ADR-0101](adr/ADR-0101-idea-intake-level-and-milestone-gate.md) 决策 5 ·",
        "> [ADR-0105](adr/ADR-0105-task-state-lives-on-the-card.md)）。",
        "",
        "**新想法先过 Milestone Gate**：读下面第三面，四问（在当前里程碑交付面上 /",
        "阻塞在办主线 / 不做会造成不可逆损害 / 是几分钟的当前事实修正）**全 No 就立",
        "一张 `状态：待办` 的卡，不实施**。",
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
        "现在必须成立的产品需求。「在办卡」列是状态为 `进行中` 的卡里",
        "卡头引用它的那些 —— **空不代表失效**，只代表这一轮没人在动它。",
        "",
        "| REQ | 标题 | 状态 | 在办卡 |",
        "| --- | --- | --- | --- |",
    ]
    lines += _active_requirements(groups) or [
        "| — | （`docs/requirements/` 为空） | — | — |"
    ]
    pending = _not_yet_binding()
    if pending:
        lines += [
            "",
            "不在上表里（今天不约束任何人，但也没消失）：" + "、".join(pending),
        ]
    deferred = _deferred(groups)
    lines += [
        "",
        "### Deferred",
        "",
        f"里程碑闸判「现在不做」的 {len(deferred)} 张卡（状态 `待办`）——",
        "**队列，不是垃圾桶**：每张卡都要写清什么条件下它会变成该做。",
        "跨任务欠账另见 [TASK-087 总账](tasks/TASK-087-followup-ledger.md)。",
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


def _task_section(heading: str, cards: list[task_status.Card], blurb: str) -> list[str]:
    rows = [f"## {heading}", "", blurb, ""]
    rows.append("| 文档 | 标题 | 状态行（首句） |")
    rows.append("| --- | --- | --- |")
    # 按**文件名字符串**排，不是按 Path 排 —— Windows 与 POSIX 对 Path 的排序不同，
    # 而这个文件要被 `test_docs_status` 逐字节比对（TASK-140；AGENTS §3）。
    for card in sorted(cards, key=lambda c: c.path.name):
        rel = card.path.relative_to(DOCS).as_posix()
        title, status = _describe(card.path)
        rows.append(f"| [{card.path.name}]({rel}) | {title} | {status} |")
    rows.append("")
    return rows


def _folder_section(heading: str, rel_folder: str, blurb: str) -> list[str]:
    folder = DOCS / rel_folder
    if not folder.is_dir():
        return []
    rows = [f"## {heading}", "", blurb, ""]
    rows.append("| 文档 | 标题 | 状态行（首句） |")
    rows.append("| --- | --- | --- |")
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


def _task_patches() -> list[str]:
    """`.patch` files left next to the cards are 留痕, listed but never parsed."""
    patches = sorted((DOCS / "tasks").glob("*.patch"), key=lambda p: p.name)
    if not patches:
        return []
    rows = ["## 任务卡旁的 patch 留痕", "", "| 文件 |", "| --- |"]
    rows += [f"| [{p.name}]({p.relative_to(DOCS).as_posix()}) |" for p in patches]
    rows.append("")
    return rows


def render() -> str:
    groups = _cards()
    adr = sorted((DOCS / "adr").glob("ADR-*.md"), key=lambda p: p.name)
    lines = _PREAMBLE.format(
        n_active=len(groups["进行中"]),
        n_backlog=len(groups["待办"]),
        n_done=len(groups["完成"]),
        n_adr=len(adr),
    ).splitlines()
    lines += _current_truth(groups)
    for heading, state, blurb in _TASK_SECTIONS:
        lines += _task_section(heading, groups[state], blurb)
    lines += _task_patches()
    for heading, folder, blurb in _DESIGN_SECTIONS:
        lines += _folder_section(heading, folder, blurb)
    last = _doc_id(adr[-1].name) if adr else "—"
    lines += _TRAILER.format(n_adr=len(adr), last=last).splitlines()
    return "\n".join(lines).rstrip() + "\n"


# --- 工作进度（docs/WORKSTATUS.md）-------------------------------------------
#
# 产品负责人 2026-09-07：「我想做一个 workstatus。让我能够掌握各个开发需求完成的
# 进度。但是不要写需求。只需要有需求的 link 就可以了。」
#
# 所以这份文件**一个字需求内容都不写**，只写「做到哪了」+ 链接。需求正文抄第二遍，
# 就会有两份各自漂移的真相。进度**从卡派生**：卡头引用了哪条 REQ，加上卡头那一行
# 状态（ADR-0105）。判据级进度暂不做 —— REQ 的判据格式今天还不统一。

WORK_OUT = DOCS / "WORKSTATUS.md"

_WORK_HEAD = """# 工作进度

> **这份文件是生成的，别手改** —— `python .claude/tools/gen_docs_status.py`。
>
> 一行一条需求：**做到哪了、谁在做、还差什么**。这里不写需求内容，只给链接 ——
> 需求正文在链接那一头，抄第二遍就会有两份各自漂移的真相。
>
> 进度是**从卡派生**的：卡头引用了哪条 REQ，加上卡头那一行 `状态：待办 / 进行中 /
> 完成`（ADR-0105，状态住在卡上）。**它衡量的是「这条需求的工作做了多少」，不是
> 「这条需求满足了多少」** —— 后者要判据级对账，而 REQ 的判据格式今天还不统一。
"""

_DOT = "·"
_DASH = "—"


def _cards_by_req(groups: dict[str, list[task_status.Card]]) -> dict:
    """每条 REQ 被哪些卡引用，按卡的状态分组。只读卡头。"""
    out: dict[str, dict[str, list[str]]] = {}
    for state, cards in groups.items():
        for card in cards:
            for num in sorted(set(_REQ_REF.findall(_head(card.path)))):
                out.setdefault(num, {}).setdefault(state, []).append(card.task)
    return out


def _bar(done: int, total: int, width: int = 10) -> str:
    """进度条。**分母是「引用这条需求的卡」的总数，不是判据数。** 满格写成
    「卡都做完了」而不是「完成」—— 那两件事不是一回事。"""
    if not total:
        return _DASH
    filled = round(width * done / total)
    bar = "█" * filled + "░" * (width - filled)
    tail = "卡都做完了" if done == total else f"{done}/{total}"
    return f"{bar} {tail}"


def render_work() -> str:
    """`docs/WORKSTATUS.md` —— 一屏看完每条需求做到哪了。"""
    groups = _cards()
    req_dir = DOCS / "requirements"
    cites = _cards_by_req(groups)
    lines = _WORK_HEAD.strip().splitlines()
    lines += ["", "## 每条需求做到哪了", ""]
    lines.append("| 需求 | 进度（卡） | 已完成 | 在办 | 待办 |")
    lines.append("| --- | --- | --- | --- | --- |")
    orphans = []
    for path in sorted(req_dir.glob("REQ-*.md"), key=lambda p: p.name):
        _title, status = _describe(path)
        if not _binding(status):
            continue
        by = cites.get(_doc_num(path.name), {})
        done = by.get("完成", [])
        active = by.get("进行中", [])
        backlog = by.get("待办", [])
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
    loose = []
    for card in sorted(groups["进行中"], key=lambda c: c.path.name):
        if not _REQ_REF.search(_head(card.path)):
            rel = card.path.relative_to(DOCS).as_posix()
            loose.append(f"- [{card.task}]({rel})")
    lines += loose or ["（没有。）"]
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        text = render()
        work = render_work()
    except CurrentTruthError as exc:
        # Fail closed: writing the rest without the six faces, or with a card
        # silently dropped, would look like a successful regeneration.
        print(f"当前真相无法重建：{exc}", file=sys.stderr)
        return 2
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
    OUT.write_text(text, "utf-8")
    WORK_OUT.write_text(work, "utf-8")
    for out in (OUT, WORK_OUT):
        print(f"wrote {out.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
