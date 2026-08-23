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


def _markdown_files() -> list[Path]:
    return [p for p in _REPO_ROOT.rglob("*.md") if not _IGNORED_PARTS & set(p.parts)]


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
