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
NL = chr(10)


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
    ["tasks/active", "tasks/backlog", "tasks/done", "design/active", "design/done"],
)
def test_the_four_status_folders_exist(folder: str) -> None:
    """The active/done split is the answer to 「哪些要求是完成的看起来很不清晰」
    (产品负责人 2026-08-23). A doc's FOLDER is the status; losing the folders
    loses the answer."""
    assert (_ROOT / "docs" / folder).is_dir(), f"docs/{folder}/ is missing"


@pytest.mark.parametrize("dropped", ["mission", "strategy", "milestone"])
def test_a_missing_anchor_fails_closed(tmp_path: Path, dropped: str) -> None:
    """当前真相生成不出来是缺陷，不是可以留白的格子（ADR-0101 决策 5）。

    Every face is checked separately on purpose: dropping all three at once only
    ever proves the FIRST one is guarded, and the Milestone Gate reads the third.
    """
    mod = _load()
    faces = {
        "mission": "有 Mission。",
        "strategy": "有 Strategy。",
        "milestone": "有 Milestone。",
    }
    text = "".join(
        f"<!-- current-truth: {face} -->{NL}{line}{NL}"
        for face, line in faces.items()
        if face != dropped
    )
    ctx = tmp_path / f"no-{dropped}.md"
    ctx.write_text(f"# 项目背景{NL}{NL}" + text, "utf-8")
    mod._CONTEXT = ctx
    with pytest.raises(mod.CurrentTruthError) as exc:
        mod._anchored_lines()
    assert dropped in str(exc.value)


@pytest.mark.parametrize("blanked", ["mission", "strategy", "milestone"])
@pytest.mark.parametrize(
    "shape",
    ["", "<!-- current-truth: other -->", "## 下一节"],
    ids=["blank-line", "next-anchor", "heading"],
)
def test_an_anchor_carrying_nothing_is_not_a_face(
    tmp_path: Path, blanked: str, shape: str
) -> None:
    """标签在、事实不在 —— 接受它就等于让守卫检查拼写而不是内容。

    Three shapes of "empty" (a blank line, another anchor, a heading) times three
    faces: a guard covering only `strategy` + blank line leaves eight holes open.
    """
    mod = _load()
    faces = {
        "mission": "有 Mission。",
        "strategy": "有 Strategy。",
        "milestone": "有 Milestone。",
    }
    faces[blanked] = shape
    ctx = tmp_path / f"empty-{blanked}.md"
    ctx.write_text(
        "".join(f"<!-- current-truth: {f} -->{NL}{v}{NL}" for f, v in faces.items()),
        "utf-8",
    )
    mod._CONTEXT = ctx
    with pytest.raises(mod.CurrentTruthError) as exc:
        mod._anchored_lines()
    assert blanked in str(exc.value)


def test_the_cli_exits_nonzero_when_current_truth_cannot_be_rebuilt(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """fail-closed 要一直开到出口：写不出六面却 exit 0，就是一次看上去成功的重生成。"""
    mod = _load()
    ctx = tmp_path / "no-anchors.md"
    ctx.write_text(f"# 项目背景{NL}{NL}没有任何锚点。{NL}", "utf-8")
    out = tmp_path / "STATUS.md"
    mod._CONTEXT = ctx
    mod.OUT = out
    monkeypatch.setattr(mod.sys, "argv", ["gen_docs_status.py"])
    assert mod.main() == 2
    assert "当前真相无法重建" in capsys.readouterr().err
    assert not out.exists(), "fail-closed 不得写出一份缺六面的 STATUS.md"


def test_a_superseded_requirement_is_not_published_as_binding(tmp_path: Path) -> None:
    """SUPERSEDED / DRAFT 不得出现在「现在必须成立的产品需求」里，但也不得就此
    消失 —— 一条消失的 DRAFT 就是一条被忘掉的需求。"""
    mod = _load()
    docs = tmp_path / "docs"
    (docs / "requirements").mkdir(parents=True)
    (docs / "tasks" / "active").mkdir(parents=True)
    for name, status in (
        ("REQ-001-live.md", "CONFIRMED"),
        ("REQ-002-old.md", "SUPERSEDED by REQ-003"),
        ("REQ-003-new.md", "DRAFT"),
    ):
        (docs / "requirements" / name).write_text(
            f"# {name[:7]}：标题{NL}{NL}- 状态：{status}{NL}", "utf-8"
        )
    mod.DOCS = docs
    rows = NL.join(mod._active_requirements())
    assert "REQ-001" in rows
    assert "REQ-002" not in rows and "REQ-003" not in rows
    pending = NL.join(mod._not_yet_binding())
    assert "REQ-002" in pending and "REQ-003" in pending


def test_the_six_faces_reach_the_generated_file() -> None:
    """六个面一次读到 —— 而且第三面必须是 project-context 里那一行本身，
    不是一句转述（AGENTS.md 第 27 条）。"""
    mod = _load()
    faces = mod._anchored_lines()
    status = _STATUS.read_text("utf-8")
    for face, line in faces.items():
        assert line in status, f"{face} 那一行没有出现在 STATUS.md 里"
    for heading in ("Active Requirements", "Deferred", "Recent Decisions"):
        assert f"### {heading}" in status, f"缺少派生面：{heading}"


def test_no_task_card_sits_outside_active_or_done() -> None:
    """A card dropped straight into docs/tasks/ has no status by location —
    exactly the ambiguity the split removes."""
    stray = sorted(p.name for p in (_ROOT / "docs" / "tasks").glob("*.md"))
    assert not stray, f"task cards must live in active/ or done/: {stray}"
