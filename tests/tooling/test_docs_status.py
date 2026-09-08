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
_WORK = _ROOT / "docs" / "WORKSTATUS.md"
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


def test_workstatus_matches_the_tree() -> None:
    """`docs/WORKSTATUS.md` 同理 —— 它是**派生**的，不是手写的看板。

    手写的进度板比手写的索引更危险：索引过期只是找不到东西，进度板过期会让人
    **按一个不存在的状态做决定**（本仓库有实例：一张卡的错标签把两条真缺陷盖了
    十天）。所以它和 STATUS.md 同一个生成器、同一条命令、同一道闸。
    """
    assert _WORK.exists(), "docs/WORKSTATUS.md missing — run gen_docs_status.py"
    expected = _load().render_work()
    assert _WORK.read_text("utf-8") == expected, (
        "docs/WORKSTATUS.md is stale — run `python .claude/tools/gen_docs_status.py`"
    )


def test_workstatus_links_the_requirement_instead_of_restating_it() -> None:
    """产品负责人 2026-09-07：「不要写需求。只需要有需求的 link 就可以了。」

    守的是**性质不是写法**：每条生效需求各出现一次、且是链接；除了表头的口径
    说明之外，不搬运需求正文。判据是「有没有从 REQ 文件里抄行过来」——
    抄一行就会有两份各自漂移的真相。
    """
    import re

    text = _WORK.read_text("utf-8")
    reqs = sorted((_ROOT / "docs" / "requirements").glob("REQ-*.md"))
    linked = set(re.findall(r"\[(REQ-\d+)\]\(requirements/", text))
    assert linked, "一条需求链接都没有 —— 这块板子就没用了"
    for path in reqs:
        body = path.read_text("utf-8")
        for line in body.splitlines():
            line = line.strip()
            # 只查有实质内容的正文行；短行（标题片段、列表符号）会误报
            if len(line) > 40 and line in text:
                raise AssertionError(
                    f"{path.name} 的正文被搬进了 WORKSTATUS：{line[:60]}"
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


def test_a_four_digit_requirement_number_does_not_collide(tmp_path: Path) -> None:
    """REQ 号取的是**号**，不是「第 4 到第 7 个字符」（TASK-087 §5.29）。

    定宽切片 `path.name[4:7]` 把 `REQ-1000` 截成 `100`，于是：
    ① 它抢走 `REQ-100` 的引用（哪张卡引了谁，从此对不上）；
    ② 表里也把它显示成 `REQ-100` —— **两条都是静默的**。

    今天最大 `REQ-008`，所以这条在今天不可达。写它是因为**判据不是宽度**：
    「前缀 + 数字」和「切 3 个字符」一样短，而只有前者在编号长一位时仍然成立。
    """
    mod = _load()
    docs = tmp_path / "docs"
    (docs / "requirements").mkdir(parents=True)
    (docs / "tasks" / "active").mkdir(parents=True)
    for name in ("REQ-100-hundred.md", "REQ-1000-thousand.md"):
        (docs / "requirements" / name).write_text(
            f"# {mod._doc_id(name)}：标题{NL}{NL}- 状态：CONFIRMED{NL}", "utf-8"
        )
    # 一张只引用 REQ-1000 的卡
    (docs / "tasks" / "active" / "TASK-1234-card.md").write_text(
        f"# TASK-1234：卡{NL}{NL}"
        f"- 关联 Requirement：REQ-1000 判据 1{NL}{NL}## 正文{NL}",
        "utf-8",
    )
    mod.DOCS = docs
    rows = mod._active_requirements()
    by_req = {}
    for row in rows:
        ident = row.split("[", 1)[1].split("]", 1)[0]
        by_req[ident] = row

    assert "REQ-1000" in by_req, f"四位号被截短了：{sorted(by_req)}"
    assert "REQ-100" in by_req
    # 引用只能落在被引用的那一条上
    assert "TASK-1234" in by_req["REQ-1000"], "四位号的引用没有落在它自己身上"
    assert "TASK-1234" not in by_req["REQ-100"], "引用被截短的号抢走了"
    # 四位任务号也不许被切掉最后一位
    assert "TASK-123]" not in by_req["REQ-1000"], "TASK 号被截成了三位"


def test_doc_id_reads_the_prefix_and_the_number(tmp_path: Path) -> None:
    """`_doc_id` / `_doc_num` 的形状 —— 认不出来就原样返回，绝不返回截短的号。"""
    mod = _load()
    assert mod._doc_id("REQ-008-agent.md") == "REQ-008"
    assert mod._doc_id("TASK-1000-x.md") == "TASK-1000"
    assert mod._doc_id("ADR-0102-x.md") == "ADR-0102"
    assert mod._doc_num("REQ-1000-x.md") == "1000"
    assert mod._doc_num("REQ-008-x.md") == "008"
    # 认不出来的名字：原样回，不猜
    assert mod._doc_id("notes.md") == "notes.md"
    assert mod._doc_num("notes.md") == ""
