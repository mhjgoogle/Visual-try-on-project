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
        text = md.read_text(encoding="utf-8", errors="replace")
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
