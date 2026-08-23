"""`docs/STATUS.md` must stay in sync with the docs tree.

A hand-maintained index drifts — that is the defect this pins down. On
2026-08-23 five status claims across `docs/` were found stale, and one of them
(TASK-052 标着「待开始」) had hidden two real defects for ten days. So the
overview is generated, and adding or moving a doc without regenerating it turns
this test red instead of silently producing another wrong index.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_GEN = _ROOT / ".claude" / "tools" / "gen_docs_status.py"
_STATUS = _ROOT / "docs" / "STATUS.md"


def _load():
    spec = importlib.util.spec_from_file_location("gen_docs_status", _GEN)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_status_file_matches_the_tree() -> None:
    assert _STATUS.exists(), "docs/STATUS.md missing — run gen_docs_status.py"
    expected = _load().render()
    assert _STATUS.read_text("utf-8") == expected, (
        "docs/STATUS.md is stale — run `python .claude/tools/gen_docs_status.py`"
    )


@pytest.mark.parametrize(
    "folder",
    ["tasks/active", "tasks/done", "design/active", "design/done"],
)
def test_the_four_status_folders_exist(folder: str) -> None:
    """The active/done split is the answer to 「哪些要求是完成的看起来很不清晰」
    (产品负责人 2026-08-23). A doc's FOLDER is the status; losing the folders
    loses the answer."""
    assert (_ROOT / "docs" / folder).is_dir(), f"docs/{folder}/ is missing"


def test_no_task_card_sits_outside_active_or_done() -> None:
    """A card dropped straight into docs/tasks/ has no status by location —
    exactly the ambiguity the split removes."""
    stray = sorted(p.name for p in (_ROOT / "docs" / "tasks").glob("*.md"))
    assert not stray, f"task cards must live in active/ or done/: {stray}"
