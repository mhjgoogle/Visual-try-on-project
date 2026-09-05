"""Repository lifecycle convergence guard.

WHY THIS IS A GUARD AND NOT A CHECKLIST. ADR-0083 决策 3 already proved it once:
an index that must be REMEMBERED will not be remembered, and a checklist that
must be REMEMBERED is the same defect wearing different clothes. So the parts of
the document lifecycle (ADR-0087) that a machine can decide are decided here,
and `tests/tooling/test_lifecycle_check.py` runs them -- which puts this file in
the tooling domain's commit gate and in every pre-merge full run, without anyone
having to remember it.

What it deliberately does NOT judge: whether a document still has value, whether
an ADR is "really" superseded, whether a card is finished. Those need a reader.
Guessing there would either nag on every run or delete something real; both end
with the guard being switched off. **Under-report, never mis-kill.**

Run: python .claude/tools/lifecycle_check.py            (report; exit 1 if any)
     python .claude/tools/lifecycle_check.py --json     (machine-readable)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"

# A card whose status line STARTS with one of these is finished, and a finished
# card in active/ is exactly the drift ADR-0083 removed (「部分完成」starts with
# 部分, so it is not matched -- partial work belongs in active/).
_DONE_PREFIXES = (
    "完成",
    "已完成",
    "已交付",
    "已合并",
    "已收口",
    "Done",
    "Completed",
    "Delivered",
)

# Names that say "this file was scratch". ADR-0087 决策 6: scratch does not live
# in docs/ -- it lives in .claude/tmp/ (gitignored) or the session scratchpad.
_TEMP_NAME = re.compile(
    r"(^|[-_])(scratch|tmp|temp|wip|untitled|copy|notes?)([-_.]|$)"
    r"|(^|[-_])(debug|investigation)[-_]",
    re.I,
)

# Shadow implementations kept "just in case". Git already carries code history.
_SHADOW_DIR = re.compile(
    r"^(old\d*|backup\d*|bak|legacy[-_]copy|deprecated[-_]but[-_]kept)$", re.I
)

_SKIP_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".eggs",
    "dist",
    "build",
    "tmp",
}

_STATUS_LINE = re.compile(r"^[->\s*]*(?:状态|Status)[:：]\s*(.+)$", re.M)
_ADR_ID = re.compile(r"ADR-(\d{4})")
_SUPERSEDE_WORD = re.compile(r"supersede|superseded|取代|被取代", re.I)
# A supersede relation counts only when it is declared in a LABELLED header
# field. Prose cannot be parsed: `ADR-0006` writes "TASK-010 后由 TASK-016/017
# 取代；…由 ADR-0008/0009 延续" (the 取代 is about tasks, the ADRs are merely
# continued) and `ADR-0051` writes "**无决策被取代。**" -- a keyword-anywhere
# rule reads both as claims. Labels make the claim explicit instead of guessed.
_DECLARATION_LABEL = re.compile(
    r"^[->*\s]*(?:\*\*)?\s*"
    r"(?:状态|Status|取代|被取代|Supersedes?|Superseded\s+in\s+part\s+by"
    r"|Superseded\s+by|Partially\s+superseded\s+by)",
    re.I,
)
# Which way the declaration points. A `状态：…被 X 取代` line reads either way
# depending on the sentence, so it stays AMBIGUOUS and is accepted opposite
# anything; the dedicated fields are directional, and two ADRs that BOTH claim
# to supersede the other are a contradiction the guard must not certify
# (codex review, 轮 2).
_FORWARD_LABEL = re.compile(
    r"^[->*\s]*(?:\*\*)?\s*(?:取代|Supersedes?)\s*[:：*]?", re.I
)
_BACKWARD_LABEL = re.compile(
    r"^[->*\s]*(?:\*\*)?\s*(?:被取代|(?:Partially\s+)?Superseded\s+(?:in\s+part\s+)?by)",
    re.I,
)


def _direction(item: str) -> str:
    """`forward` = I supersede it · `backward` = it supersedes me · `` = unclear."""
    if _BACKWARD_LABEL.match(item):
        return "backward"
    if _FORWARD_LABEL.match(item):
        return "forward"
    return ""


# A card must name WHY it exists, in its header, where the next reader will see
# it: a requirement, or -- for work with no product requirement (bug / refactor /
# perf / tooling) -- a technical objective. A card with neither cannot be
# reviewed against anything, and it is what ADR-0088 决策 2 calls ORPHAN_TASK.
#
# Only the HEADER counts: a basis buried three sections down is not what the
# reader (or the Review Package) picks up, and this repo has already paid for
# "the information exists somewhere" once (ADR-0083 决策 3).
#
# The anchor must be a LABELLED basis field, or an explicit `REQ-NNN`. A bare
# `ADR-NNNN` anywhere in the header used to satisfy this and must not: almost
# every card cites some ADR while describing its context, so accepting that let
# a card pass while naming neither a requirement nor a technical objective
# (codex review, TASK-108 轮 1).
# The labelled field must also CARRY something: an empty `依据：` line is a label,
# not a basis, and accepting it would make the guard check spelling instead of
# content (codex review, TASK-108 轮 2).
_TASK_ANCHOR = re.compile(
    r"REQ-\d+"
    r"|^[->*\s]*(?:\*\*)?\s*(?:关联\s*Requirement"
    r"|技术目标"
    r"|依据"
    r"|起因"
    r"|Requirements?"
    r"|Technical\s+objective)"
    # Horizontal whitespace only, never a generic space class: a newline would
    # let an empty label line be satisfied by the first non-space character of
    # the NEXT line, so the label would pass while carrying nothing.
    r"(?:\*\*)?[ \t]*[:：][ \t]*[^\s]",
    re.I | re.M,
)

# Cards written under the ADR-0088 field set carry `架构约束：`. That marker is
# what lets the guard keep watching a card AFTER it moves out of active/ --
# without it, moving a card to done/ (which Done 判定 requires) would take it out
# of the guard's sight exactly at merge time (codex review, TASK-108 轮 1).
# Finished legacy cards are deliberately grandfathered: retro-filling a basis
# into 100 closed cards is the one-time tidy-up ADR-0087 exists to avoid, and
# inventing one for work nobody remembers would be fiction, not traceability.
_NEW_FIELD_SET = re.compile(r"^[->*\s]*(?:\*\*)?\s*架构约束\s*[:：]", re.M)

_CURRENT_ARCH = DOCS / "current-architecture.md"
_CURRENT_ARCH_MAX_LINES = 200

# The two index docs (ADR-0098). They answer WHAT THINGS ARE CALLED and WHAT WE
# WON'T BUILD; the rules stay in whatever they point at. The failure mode is that
# an index slowly gets copied full of contract text and becomes a second source
# of truth -- which is the exact defect the system contract keeps naming
# (「不是第二份记录」: two copies necessarily drift). So the guard checks SHAPE:
# a line budget, a pointer on every entry, and -- the load-bearing one -- that a
# definition does not carry rules. Someone copying a contract writes 必须; when
# they cannot write 必须 they are left with naming the thing, which is the job.
_GLOSSARY = DOCS / "glossary.md"
_OUT_OF_SCOPE = DOCS / "out-of-scope.md"
_INDEX_DOC_MAX_LINES = 170
_INDEX_DEFINITION_MAX_LINES = 2
_NORMATIVE_VERB = re.compile(r"必须|不得|禁止|只能|一律|应当")
_MD_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
# The label has to CARRY something -- an empty `_Avoid_：` is a label, not a list
# of names, and accepting it would make the guard check spelling instead of
# content (the same trap `_TASK_ANCHOR` was fixed for in TASK-108 轮 2).
_AVOID_LINE = re.compile(r"^_Avoid_\s*[：:]\s*\S")


def _status_first_clause(text: str) -> str:
    m = _STATUS_LINE.search(text)
    if not m:
        return ""
    raw = re.sub(r"~~.*?~~", "", m.group(1))
    raw = re.split(r"——|。|；", raw)[0]
    return re.sub(r"[*`\[\]]", "", raw).strip()


def _header(text: str) -> str:
    """Everything before the first `## ` heading: an ADR's metadata block."""
    return re.split(r"^## ", text, maxsplit=1, flags=re.M)[0]


_ITEM_START = re.compile(r"^[>\s]*(?:[-*]\s|\d+\.\s|#)")


def _header_items(text: str) -> list[str]:
    """The header's metadata items, with soft-wrapped continuations joined.

    Markdown wraps: `- 取代：` can sit on one line and the `ADR-0060` it names on
    the next. Reading line by line would make the guard depend on where someone
    happened to press Enter -- valid declarations would silently stop being
    checked, which is this repo's most-repeated defect shape (a guard that goes
    green on the very thing it guards). An item starts at a bullet / heading and
    ends at the next bullet or a blank line.
    """
    items: list[str] = []
    fresh = True
    for line in _header(text).splitlines():
        stripped = line.strip()
        if not stripped:
            fresh = True
            continue
        if fresh or _ITEM_START.match(line):
            items.append(stripped)
        else:
            items[-1] += " " + stripped
        fresh = False
    return items


def check_no_finished_card_in_active() -> list[str]:
    out = []
    for card in sorted((DOCS / "tasks" / "active").glob("TASK-*.md")):
        status = _status_first_clause(card.read_text("utf-8"))
        if status.startswith(_DONE_PREFIXES):
            rel = card.relative_to(ROOT).as_posix()
            out.append(
                f"{rel}：状态写着「{status}」却还在 active/ —— "
                "做完的卡要 `git mv` 进 docs/tasks/done/（ADR-0083 决策 1）"
            )
    return out


def check_adr_supersede_links_are_bidirectional() -> list[str]:
    """A supersede claimed on one side must be readable from the other side.

    The defect this catches is real and was found on 2026-08-26: ADR-0060 and
    ADR-0069 had been superseded by ADR-0080/0081 for four days and said so
    NOWHERE in their own text -- so anyone opening the old ADR read a rule that
    no longer applied, marked `Accepted`.

    **The counterpart must DECLARE, not merely mention.** Accepting any
    occurrence of `ADR-<num>` anywhere in the other file would let a background
    paragraph that happens to cite the old ADR satisfy the requirement -- and
    citing an old ADR while discussing history is the single most common way an
    ADR mentions another one. The reciprocal side must therefore carry its own
    header ITEM that names this ADR next to a supersede word (codex review,
    TASK-107 轮 1).
    """
    adrs = {p.name[4:8]: p for p in sorted((DOCS / "adr").glob("ADR-*.md"))}
    items = {num: _header_items(p.read_text("utf-8")) for num, p in adrs.items()}
    out = []

    def back_declarations(other_num: str, mine: str) -> list[str]:
        return [
            item
            for item in items[other_num]
            if _DECLARATION_LABEL.match(item)
            and _SUPERSEDE_WORD.search(item)
            and f"ADR-{mine}" in item
        ]

    for num, path in adrs.items():
        for item in items[num]:
            if not (_DECLARATION_LABEL.match(item) and _SUPERSEDE_WORD.search(item)):
                continue
            mine = _direction(item)
            for other in sorted(set(_ADR_ID.findall(item)) - {num}):
                rel = path.relative_to(ROOT).as_posix()
                if other not in adrs:
                    out.append(f"{rel}：头部声明的取代关系指向不存在的 ADR-{other}")
                    continue
                backs = back_declarations(other, num)
                other_rel = adrs[other].relative_to(ROOT).as_posix()
                if not backs:
                    out.append(
                        f"{rel} 声明与 ADR-{other} 的取代关系，但 "
                        f"{other_rel} 的头部没有声明它 —— "
                        "取代关系必须双向可读，仅在正文提一句不算（ADR-0087 决策 3）"
                    )
                    continue
                if mine and all(_direction(b) == mine for b in backs):
                    claim = "取代" if mine == "forward" else "被取代于"
                    out.append(
                        f"{rel} 与 {other_rel} 都声明自己「{claim}」对方 —— "
                        "方向矛盾，一份 ADR 不能既取代又被取代于同一份"
                    )
    return out


def check_requirement_index_matches_files() -> list[str]:
    req_dir = DOCS / "requirements"
    index = req_dir / "index.md"
    out: list[str] = []
    if not index.exists():
        return [
            f"{index.relative_to(ROOT).as_posix()} 缺失 —— REQ 没有索引就找不到当前需求"
        ]
    text = index.read_text("utf-8")
    rows = re.findall(r"\[REQ-(\d+)\]\(([^)]+)\)", text)
    listed = dict(rows)
    statuses = dict(re.findall(r"\[REQ-(\d+)\]\([^)]+\)\s*[—-]+\s*([A-Z]+)", text))
    on_disk = {p.name[4:7]: p for p in sorted(req_dir.glob("REQ-*.md"))}

    # Two rows for one REQ = two places to update, which is how a status goes
    # stale in the first place. `dict(rows)` would silently keep the last one
    # (codex review, 轮 2).
    seen: set[str] = set()
    for num, _ in rows:
        if num in seen:
            out.append(
                f"requirements/index.md：REQ-{num} 有重复的索引行 —— 一条需求一行"
            )
        seen.add(num)

    # The link TARGET must be that REQ's own file. Checking only the id would
    # pass a row whose link points at a different (existing) REQ -- and the row
    # is how an agent gets to the requirement, so a mislabeled link hands it the
    # wrong one while everything still looks consistent (codex review, 轮 1).
    req_root = req_dir.resolve()
    for num, target in sorted(listed.items()):
        resolved = (req_dir / target).resolve()
        if not resolved.is_relative_to(req_root):
            # `../` or an absolute path can land on a file that merely happens to
            # be named REQ-<id>*, outside the requirements directory entirely
            # (codex review, 轮 3). REQ 记录只住 docs/requirements/。
            out.append(
                f"requirements/index.md：REQ-{num} 的链接 `{target}` 指到了 "
                "docs/requirements/ 之外 —— REQ 记录只住这个目录"
            )
        elif not resolved.is_file():
            out.append(
                f"requirements/index.md：REQ-{num} 的链接 `{target}` 指向不存在的文件"
            )
        elif not resolved.name.startswith(f"REQ-{num}"):
            out.append(
                f"requirements/index.md：REQ-{num} 那一行链到的是 `{resolved.name}` —— "
                "索引行必须链到它自己那份 REQ"
            )

    for num in sorted(set(on_disk) - set(listed)):
        out.append(
            f"{on_disk[num].relative_to(ROOT).as_posix()} 不在 requirements/index.md 里"
        )
    for num in sorted(set(listed) - set(on_disk)):
        out.append(f"requirements/index.md 列了 REQ-{num}，但文件不存在")
    # 「没写状态」不是「通过」。Skipping a row with no status token, or a file
    # with no status line, lets a requirement with NO lifecycle state pass the
    # convergence guard — the guard would be silent exactly where the record is
    # malformed (codex review, 轮 2).
    for num, path in sorted(on_disk.items()):
        rel = path.relative_to(ROOT).as_posix()
        actual = _status_first_clause(path.read_text("utf-8"))
        if not actual:
            out.append(f"{rel} 没有状态行 —— REQ 必须写 DRAFT / CONFIRMED / SUPERSEDED")
        if num in listed and num not in statuses:
            out.append(
                f"requirements/index.md：REQ-{num} 那一行没写状态 —— "
                "索引行必须是「REQ-NNN — 状态 — 一句话」"
            )
        if num in statuses and actual and not actual.upper().startswith(statuses[num]):
            out.append(
                f"REQ-{num}：索引写 {statuses[num]}，文件写「{actual}」—— "
                "状态只能有一个真相来源"
            )
    return out


def _walk(base: Path):
    """Walk `base`, PRUNING skipped trees instead of filtering after the fact.

    `rglob("*")` would descend into `.venv/`, `node_modules/` and `.git/` and
    only then drop the results — thousands of stat calls per run for a guard
    that is supposed to be free, on a machine where some agent scratch
    directories are not even readable (codex review, 轮 2).
    """
    for parent, dirnames, filenames in os.walk(base):
        dirnames[:] = [
            d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".claude")
        ]
        here = Path(parent)
        for name in dirnames:
            yield here / name
        for name in filenames:
            yield here / name


def check_no_orphan_task_in_active() -> list[str]:
    """A card whose header names no requirement and no technical objective is an
    ORPHAN_TASK: nothing states what it is for, so review gate 1 (requirement
    fulfilment) has nothing to check it against and the Merge Gate cannot pass
    (ADR-0088 决策 2 / 决策 6).

    Scope: every card in active/, plus cards in backlog/ and done/ that carry the
    ADR-0088 field set (`架构约束：`). The second half matters because Done 判定
    MOVES the card to done/ before merge -- checking active/ alone would look
    away at the one moment the Merge Gate reads the answer.

    Still deliberately generous about WORDING: `REQ-NNN`, 关联 Requirement,
    技术目标, 依据, 起因 all satisfy it. The target is a card that says nothing
    at all about why it exists, not one that words its basis differently.
    """
    out = []
    cards = [(p, True) for p in sorted((DOCS / "tasks" / "active").glob("TASK-*.md"))]
    for folder in ("backlog", "done"):
        cards += [
            (p, False) for p in sorted((DOCS / "tasks" / folder).glob("TASK-*.md"))
        ]
    for card, always in cards:
        header = _header(card.read_text("utf-8"))
        if not always and not _NEW_FIELD_SET.search(header):
            continue
        if not _TASK_ANCHOR.search(header):
            rel = card.relative_to(ROOT).as_posix()
            out.append(
                f"{rel}：头部没有「关联 Requirement」也没有「技术目标」—— "
                "ORPHAN_TASK：说不出为什么做的卡，审查第 1 闸无从对账"
                "（ADR-0088 决策 2）"
            )
    return out


def check_no_temporary_artifacts_in_docs() -> list[str]:
    out = []
    for path in _walk(DOCS):
        if path.is_file() and _TEMP_NAME.search(path.stem):
            out.append(
                f"{path.relative_to(ROOT).as_posix()}：看起来是一次性产物。"
                "有长期价值就提炼进 REQ / 任务卡 / ADR / 当前架构合同再删原件；"
                "没有就删（ADR-0087 决策 6）"
            )
    return out


def check_no_shadow_directories() -> list[str]:
    out = []
    for path in _walk(ROOT):
        if path.is_dir() and _SHADOW_DIR.match(path.name):
            out.append(
                f"{path.relative_to(ROOT).as_posix()}/：影子实现目录。"
                "代码历史由 Git 承担（ADR-0087 决策 6）"
            )
    return out


def check_current_architecture_contract() -> list[str]:
    if not _CURRENT_ARCH.exists():
        return [
            "docs/current-architecture.md 缺失 —— 当前架构事实必须有一份短文档回答，"
            "否则又要靠遍历 ADR 推导（ADR-0087 决策 4）"
        ]
    n = len(_CURRENT_ARCH.read_text("utf-8").splitlines())
    if n > _CURRENT_ARCH_MAX_LINES:
        return [
            f"docs/current-architecture.md 有 {n} 行，"
            f"超过 {_CURRENT_ARCH_MAX_LINES} 行上限 —— "
            "它是索引不是副本，细节留在它指向的合同里（ADR-0087 决策 4）"
        ]
    return []


def _broken_pointers(path: Path) -> list[str]:
    """Repo-relative link targets in `path` that do not exist.

    A pointer is the whole mechanism here: an entry without a working pointer is
    an entry that copied its content instead of referring to it. External URLs
    and pure anchors are skipped -- this guard cannot reach the network, and
    guessing would nag on every run (see the module docstring).
    """
    out = []
    for raw in _MD_LINK.findall(path.read_text("utf-8")):
        target = raw.split("#", 1)[0].strip()
        if not target or "://" in target or target.startswith("mailto:"):
            continue
        if not (path.parent / target).exists():
            out.append(target)
    return out


def check_index_docs_are_indexes() -> list[str]:
    """ADR-0098: glossary / out-of-scope stay indexes, never a second contract.

    Deliberately NOT judged: whether a definition is *correct*, whether a term
    deserves an entry, whether some other term should have one. Those need a
    reader. And deliberately not grepping the repo for the synonyms listed under
    `_Avoid_`: searching for 「素材」 across the tree would flag every ordinary
    mention as drift, the guard would be red every day, and a guard that is red
    every day gets switched off -- the failure shape this file's docstring warns
    about. **Under-report, never mis-kill.**
    """
    out = []
    for doc, label in (
        (_GLOSSARY, "docs/glossary.md"),
        (_OUT_OF_SCOPE, "docs/out-of-scope.md"),
    ):
        if not doc.exists():
            out.append(
                f"{label} 缺失 —— 「这个概念叫什么」与「什么我们决定不做」"
                "各要有一个落点，否则又回到翻合同和 ADR 猜（ADR-0098 决策 1）"
            )
            continue
        text = doc.read_text("utf-8")
        lines = text.splitlines()
        if len(lines) > _INDEX_DOC_MAX_LINES:
            out.append(
                f"{label} 有 {len(lines)} 行，超过 {_INDEX_DOC_MAX_LINES} 行上限 —— "
                "它是索引不是副本，在膨胀说明有人把合同抄了进来（ADR-0098 决策 3）"
            )
        for target in _broken_pointers(doc):
            out.append(
                f"{label} 指向不存在的 `{target}` —— 指针是这份文件的全部机制，"
                "断了的条目等于没有出处（ADR-0098 决策 3）"
            )

    if _GLOSSARY.exists():
        out.extend(_glossary_entry_findings(_GLOSSARY.read_text("utf-8")))
    if _OUT_OF_SCOPE.exists():
        out.extend(_out_of_scope_row_findings(_OUT_OF_SCOPE.read_text("utf-8")))
    return out


def _glossary_entry_findings(text: str) -> list[str]:
    out = []
    for block in re.split(r"^### ", text, flags=re.M)[1:]:
        block_lines = [ln.rstrip() for ln in block.splitlines()]
        term = block_lines[0].strip()
        body = [ln for ln in block_lines[1:] if ln.strip() and not ln.startswith("## ")]
        definition = [ln for ln in body if not ln.startswith("_")]
        has_avoid = any(_AVOID_LINE.match(ln) for ln in body)
        has_authority = any(
            ln.startswith("_权威_") and _MD_LINK.search(ln) for ln in body
        )
        if not has_avoid:
            out.append(
                f"docs/glossary.md「{term}」没有 `_Avoid_` —— "
                "不列禁用叫法的条目只是普通名词解释，收它没有意义（ADR-0098 决策 2）"
            )
        if not has_authority:
            out.append(
                f"docs/glossary.md「{term}」的 `_权威_` 没有可解析的指针 —— "
                "没有指针就是抄，规则得留在它指向的合同里（ADR-0098 决策 3）"
            )
        if len(definition) > _INDEX_DEFINITION_MAX_LINES:
            out.append(
                f"docs/glossary.md「{term}」的定义有 {len(definition)} 行，"
                f"超过 {_INDEX_DEFINITION_MAX_LINES} 行 —— 超出这个长度就是在抄合同"
                "（ADR-0098 决策 3）"
            )
        for ln in definition:
            if _NORMATIVE_VERB.search(ln):
                verb = _NORMATIVE_VERB.search(ln).group(0)
                out.append(
                    f"docs/glossary.md「{term}」的定义里有「{verb}」—— 那是规则的语气。"
                    "把这句搬回它指向的合同，条目只留指称（ADR-0098 决策 3）"
                )
                break
    return out


def _out_of_scope_row_findings(text: str) -> list[str]:
    """Every boundary row needs a ruling to point at.

    Table rows only. A header is identified STRUCTURALLY -- it is the line
    immediately before a `| --- |` separator -- never by matching its wording.
    Matching the wording would mean that renaming a column turns the header into
    a data row, and the guard would start reporting the header itself as a
    boundary without a ruling: a false positive, which is the failure direction
    this file refuses (see the module docstring). Structure survives renames and
    reordering alike.
    """
    lines = text.splitlines()
    separators = {
        i for i, ln in enumerate(lines) if ln.startswith("|") and set(ln) <= set("| -:")
    }
    out = []
    for i, line in enumerate(lines):
        if not line.startswith("|") or i in separators or i + 1 in separators:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        if not _MD_LINK.search(cells[1]):
            out.append(
                f"docs/out-of-scope.md「{cells[0][:24]}」没有指向正式裁决的链接 —— "
                "论证留在 ADR 里，这份文件只放结论加指针（ADR-0098 决策 1）"
            )
    return out


CHECKS = {
    "finished-card-in-active": check_no_finished_card_in_active,
    "adr-supersede-bidirectional": check_adr_supersede_links_are_bidirectional,
    "requirement-index": check_requirement_index_matches_files,
    "orphan-task": check_no_orphan_task_in_active,
    "temporary-artifact-in-docs": check_no_temporary_artifacts_in_docs,
    "shadow-directory": check_no_shadow_directories,
    "current-architecture-contract": check_current_architecture_contract,
    "index-docs-are-indexes": check_index_docs_are_indexes,
}


def run() -> dict[str, list[str]]:
    return {name: fn() for name, fn in CHECKS.items()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Repository lifecycle convergence guard"
    )
    parser.add_argument("--json", action="store_true")
    # `--check` is what the docs (ADR-0087, AGENTS.md 第 26 条) and the sibling
    # tool `gen_docs_status.py --check` say — and it is already the default
    # behaviour here (report + non-zero exit). Accept it rather than let the
    # documented invocation die on an argparse error (codex review, 轮 2).
    parser.add_argument(
        "--check", action="store_true", help="alias for the default behaviour"
    )
    args = parser.parse_args()
    findings = run()
    total = sum(len(v) for v in findings.values())
    if args.json:
        print(json.dumps({"total": total, "findings": findings}, ensure_ascii=False))
        return 1 if total else 0
    for name, items in findings.items():
        for item in items:
            print(f"[{name}] {item}")
    print(f"lifecycle_check: {total} finding(s)")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
