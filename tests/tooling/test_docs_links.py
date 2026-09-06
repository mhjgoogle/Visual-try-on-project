"""Every relative markdown link in the repo resolves to something that exists.

WHY THIS GUARD EXISTS. ADR-0083 (docs/adr/ADR-0083-docs-partitioned-by-completion.md)
made the *directory* a task card's state: finishing a card means `git mv`-ing it
from `docs/tasks/active/` to `docs/tasks/done/`. That is the right design, and it
has one predictable side effect — **every inbound link to that card breaks, and
every relative link inside it changes depth.** `tests/tooling/test_docs_status.py`
catches a stale `STATUS.md`; nothing caught this.

It is not hypothetical. Moving two cards (TASK-056, TASK-083) broke nine inbound
links in one commit, and the sweep that found them also turned up eight
pre-existing ones: seven cards linking `../../src/ui-gap-audit/` from
`docs/tasks/done/`, which resolves to `docs/src/...` and has never existed.
Nobody noticed because a dead link in a doc fails silently — exactly the
「文档比事实旧」 failure this repo keeps paying for.

Deliberately checks EXISTENCE only, not anchors: a `#section` that drifts is a
different (and much noisier) problem, and a guard that cries wolf gets disabled.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]

#: `[text](target)`. The lazy `[^\]]*` keeps nested brackets in link text from
#: swallowing the rest of the line.
_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")

#: Not ours to resolve.
_EXTERNAL = ("http://", "https://", "mailto:", "#")

#: Directories whose markdown is vendored or generated, not authored here.
_IGNORED_PARTS = frozenset({".venv", "node_modules", ".git", "__pycache__"})

#: Scratch. ADR-0087 决策 6 把 `.claude/tmp/` 定义为一次性产物的去处，`.gitignore`
#: 第 61 行把它排除在仓库之外 —— 它**不是这个仓库的文档**，它的链接断不断与本仓库
#: 无关。
#:
#: 这一条是 2026-09-05 补的，成因值得记：有人把一个外部研究仓库 clone 进
#: `.claude/tmp/`（正确的位置），于是那份 README 里 11 条指向它自己仓库的链接
#: 在这里全部判成断链，**整个工作区的提交闸门被挡住**，而挡住大家的东西根本不在
#: 仓库里。一个会因为 scratch 而变红的守卫，会被人关掉 —— 那才是真正的损失。
_SCRATCH = (".claude", "tmp")

#: ```…``` 或 ~~~…~~~ 围栏。**围栏里的东西不是链接** —— 它是被原样打印的示例文本，
#: markdown 根本不会把它渲染成链接，所以它也不可能「断」。
#:
#: 这一条是 2026-09-06 补的，成因同样值得记：dev-workflow 的 lifecycle.md 里有一段
#: ADR 双向取代的**模板**，写着 `[ADR-XXXX](...)`。目标字面量是三个点。
#: Windows 会把纯点路径规范化掉（`x/...` → `x`，存在），Linux 不会（`...` 是一个
#: 不存在的文件名）—— 于是这条守卫在权威平台上永远绿、在 Ubuntu CI 上永远红，
#: 而红的原因是一段示例代码。ADR-0062 决策 2 的原话：权威归属反转不等于代码可以
#: 开始关心自己跑在哪；一条判定依赖平台的守卫，正是它禁止的东西。
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})", re.MULTILINE)


#: 反引号串（一条或多条连续反引号）。行内代码跨**不用正则整体匹配**：
#: 正则要么把不等长的串回溯成一个假的跨，要么拒绝一个合法跨里更长的内部串
#: 然后从那条内部串一路吞到行尾 —— 两种都会把**真断链**吞掉，而漏报的守卫
#: 比没有守卫更糟：它让人以为查过了（codex 复审 2026-09-06，两轮各报一次，
#: 是同一失效机理的两种拼法）。所以这里直接照 CommonMark 的规则扫，
#: 不再猜。
_BACKTICKS = re.compile(r"`+")


def _strip_code_spans(line: str) -> str:
    """按 CommonMark 扫掉这一行里的行内代码跨。

    规则只有一条：一条开启的反引号串必须由一条**长度完全相同**的串闭合；
    找不到相同长度的串，它就只是普通文本（**不是**跨的开始）。跨的内部
    允许出现更长或更短的串 —— 这正是上一版正则判错的地方。

    只在行内处理，跨行代码跨（罕见）不管：宁可漏掉一次跳过（多查一条链接），
    也不要多跳过一段（少查一份文件）。
    """
    runs = [(m.start(), m.end()) for m in _BACKTICKS.finditer(line)]
    kept: list[str] = []
    pos = 0
    i = 0
    while i < len(runs):
        start, stop = runs[i]
        width = stop - start
        close = next(
            (j for j in range(i + 1, len(runs)) if runs[j][1] - runs[j][0] == width),
            None,
        )
        if close is None:
            i += 1  # 没有等长的闭合串 —— 这一串是普通文本，不开启任何跨
            continue
        kept.append(line[pos:start])
        pos = runs[close][1]
        i = close + 1
    kept.append(line[pos:])
    return "".join(kept)


def _strip_inline_code(text: str) -> str:
    """逐行扫掉行内代码跨。"""
    return "\n".join(_strip_code_spans(x) for x in text.split("\n"))


def _opens_a_fence(match: re.Match, stripped: str) -> bool:
    """反引号围栏的 info 串里不得再有反引号（CommonMark）。

    没有这一条，单独一行的 ```example``` 会被当成一个**没有闭合**的围栏，
    于是它之后的所有链接都不再被检查 —— 守卫从那一行起变瞎，而且悄无声息
    （codex 复审 2026-09-06 · P1）。波浪线围栏的 info 串允许反引号，不受此限。
    """
    run = match.group(1)
    if not run.startswith("`"):
        return True
    return "`" not in stripped[len(run) :]


def _strip_fences(text: str) -> str:
    """去掉围栏代码块，保留行数无关（这里只做存在性判定，不报行号）。

    只认**同种**围栏字符的闭合，且闭合围栏不短于开启的那条 —— 这是 CommonMark 的
    规则，也是让 ```` ```` 包住 ``` 的写法不被误判所必需的。未闭合的围栏一直吃到
    文件尾（同 CommonMark）。
    """
    out: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        stripped = line.lstrip(" ")
        if fence is None:
            m = _FENCE.match(line)
            if m and len(line) - len(stripped) <= 3 and _opens_a_fence(m, stripped):
                fence = m.group(1)
                continue
            out.append(line)
        else:
            char = fence[0]
            run = len(stripped) - len(stripped.lstrip(char))
            if run >= len(fence) and not stripped[run:].strip():
                fence = None
    return "\n".join(out)


def _is_scratch(p: Path) -> bool:
    parts = p.relative_to(_REPO_ROOT).parts
    return any(parts[i : i + 2] == _SCRATCH for i in range(len(parts) - 1))


def _markdown_files() -> list[Path]:
    return [
        p
        for p in _REPO_ROOT.rglob("*.md")
        if not _IGNORED_PARTS & set(p.parts) and not _is_scratch(p)
    ]


def test_every_relative_markdown_link_resolves() -> None:
    broken: list[str] = []
    for md in _markdown_files():
        text = _strip_inline_code(
            _strip_fences(md.read_text(encoding="utf-8", errors="replace"))
        )
        for target in _LINK.findall(text):
            target = target.strip()
            if not target or target.startswith(_EXTERNAL):
                continue
            # `path#anchor` — only the path half is checked (see module docstring)
            path_part = unquote(target.split("#", 1)[0]).strip()
            if not path_part:
                continue
            if not (md.parent / path_part).resolve().exists():
                broken.append(f"{md.relative_to(_REPO_ROOT)} -> {target}")

    assert not broken, "broken relative markdown links:\n  " + "\n  ".join(broken)


#: 守卫**自己**的形状用例。围栏与行内代码跳过是为了不误杀示例文本，但一个
#: 会漏报的守卫比没有守卫更糟 —— 它让人以为查过了。所以每一条「该跳过」的
#: 旁边都钉一条「不许跳过」。最后两条是 codex 复审报出的两条 P1：不等长的
#: 反引号串曾被回溯匹配成代码跨（真断链被吞），同一行的 ```x``` 曾被当成
#: 未闭合围栏（**它之后的整份文件都不再检查**）。
_SHAPES = [
    ("围栏里的模板不是链接", "```\n[a](...)\n```\n", []),
    ("波浪线围栏同理", "~~~\n[a](...)\n~~~\n", []),
    ("更长的围栏可以包住短的", "````\n```\n[a](...)\n```\n````\n", []),
    ("未闭合的围栏吃到文件尾", "```\n[a](...)\n", []),
    ("缩进三格仍是围栏", "   ```\n[a](...)\n   ```\n", []),
    ("围栏之后的散文照抓", "```\n[a](...)\n```\n[b](gone.md)\n", ["gone.md"]),
    ("行内代码里的模板不是链接", "prose `[ADR-XXXX](...)` tail\n", []),
    ("双反引号跨同理", "``[a](`)``\n", []),
    ("代码跨旁边的真链接照抓", "`x` and [b](gone.md)\n", ["gone.md"]),
    ("孤立反引号不得吃掉整行", "a ` b [c](real.md)\n", ["real.md"]),
    ("不等长的反引号串不构成代码跨", "`` [broken](missing.md) `\n", ["missing.md"]),
    ("同一行的三反引号跨不是围栏开启", "```example```\n[b](gone.md)\n", ["gone.md"]),
    ("散文里的断链照抓", "[a](nope.md)\n", ["nope.md"]),
    (
        "合法跨里的更长内部串不得吞掉后面的真链接",
        "``a```b`` [broken](missing.md) ```\n",
        ["missing.md"],
    ),
    ("合法跨里的更短内部串照常被跳过", "``a`b`` [c](gone.md)\n", ["gone.md"]),
    ("跨里的模板仍然不算链接", "``[ADR-XXXX](...)``\n", []),
    ("一行两个跨，中间的真链接照抓", "`x` [a](gone.md) `y`\n", ["gone.md"]),
]


@pytest.mark.parametrize(("name", "text", "expected"), _SHAPES)
def test_code_blocks_are_skipped_without_going_blind(
    name: str, text: str, expected: list[str]
) -> None:
    found = _LINK.findall(_strip_inline_code(_strip_fences(text)))
    assert found == expected, name


def test_the_guard_actually_scans_the_docs_tree() -> None:
    """A self-check, TASK-087 §7 项 2: a scanner whose glob silently matched
    nothing would pass the test above forever while asserting nothing."""
    scanned = _markdown_files()
    assert len(scanned) > 100, f"only {len(scanned)} markdown files found"
    assert any(p.parts[-3:-1] == ("tasks", "done") for p in scanned)
    assert any(p.parts[-2] == "adr" for p in scanned)


def test_scratch_is_out_of_scope_but_nothing_else_is() -> None:
    """`.claude/tmp/` 不在扫描范围里 —— 而**只有它**不在。

    两个方向都要断言。只写前一半的话，一个「把 `.claude/` 整个跳过」的实现也能
    变绿，而那会连技能文档一起漏掉（`agent_harness.py` 的 source 维度查的就是
    那些链接，两道守卫各查一半，不该互相盖住）。
    """
    assert _is_scratch(_REPO_ROOT / ".claude" / "tmp" / "x" / "README.md")
    assert _is_scratch(_REPO_ROOT / "mockups" / "m" / ".claude" / "tmp" / "a.md")
    assert not _is_scratch(_REPO_ROOT / ".claude" / "skills" / "x" / "SKILL.md")
    assert not _is_scratch(_REPO_ROOT / "docs" / "tmp-and-not-scratch.md")

    scanned = {p.relative_to(_REPO_ROOT).as_posix() for p in _markdown_files()}
    assert not [s for s in scanned if "/.claude/tmp/" in f"/{s}"], "scratch 漏进来了"
    assert any(s.startswith(".claude/skills/") for s in scanned), (
        "技能文档被误伤 —— 它们是仓库文档，不是 scratch"
    )
