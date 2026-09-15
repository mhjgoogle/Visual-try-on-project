"""`worktree.py` —— 一个会话一棵树的那条薄入口。

只测**判断**，不测 git 自己：建树是 `git worktree add` 的事，它不需要我们再验一遍。
会出错的是两件事，而它们都被写成了纯函数，所以这里不需要真的造一棵工作树：

1. 目标路径解析（含空格的仓库路径、以及「别把树建进仓库里」）；
2. 回收前的放行判断（「没提交」与「没交付」是两件事，读不出来也不放行）。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_TOOL = _ROOT / ".claude" / "tools" / "worktree.py"


@pytest.fixture(scope="module")
def wt():
    spec = importlib.util.spec_from_file_location("motv_worktree", _TOOL)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_the_tool_exists_and_resolves_the_repo_from_its_own_location(wt) -> None:
    """根从**脚本位置**解析，不问 cwd。

    与 gate_dispatch / agent_harness 同一条纪律。
    """
    assert wt.repo_root() == _ROOT


def test_a_path_with_spaces_is_handled(wt, tmp_path: Path) -> None:
    """Windows 上带空格的仓库路径是常态，不是边缘情形。

    解析必须靠 `Path`，不靠拼字符串；真正执行时 `_git` 走的是 argv 列表，
    所以也不需要引号学。
    """
    root = tmp_path / "My Work" / "Visual try-on project"
    root.mkdir(parents=True)
    target = wt.resolve_target(root, "novel-slice-2")
    assert target.name == "novel-slice-2"
    assert target.parent.name == wt.WT_DIRNAME
    assert " " in str(target), "前提：这条用例本身要真的带空格"
    assert not target.is_relative_to(root)


def test_the_worktree_lives_outside_the_repo(wt, tmp_path: Path) -> None:
    """建在仓库内会被主树的全仓检查扫进去 —— 那正是这套隔离要消掉的病。"""
    root = tmp_path / "repo"
    root.mkdir()
    target = wt.resolve_target(root, "x")
    assert not target.is_relative_to(root)


@pytest.mark.parametrize(
    "bad",
    ["../escape", "a/b", "a\\b", "", ".hidden", "with space", "x" * 80],
)
def test_a_change_id_that_could_escape_is_refused(wt, tmp_path: Path, bad: str) -> None:
    """放行路径分隔符，`new ../../x` 就能写到仓库外任意位置。"""
    root = tmp_path / "repo"
    root.mkdir()
    with pytest.raises(wt.Refused):
        wt.resolve_target(root, bad)


def test_branch_name_is_derived_not_invented(wt) -> None:
    """分支名 = `change/<id>`，与目录名、与 auto-push 的 change_id 同一个字符串。"""
    assert wt.branch_name("l4-loop") == "change/l4-loop"


def test_a_clean_delivered_worktree_may_be_recycled(wt) -> None:
    assert wt.undelivered_reasons(0, "", 0, "") == []


def test_uncommitted_work_blocks_recycling(wt) -> None:
    reasons = wt.undelivered_reasons(0, " M src/app.js\n?? new.py\n", 0, "")
    assert len(reasons) == 1
    assert "2" in reasons[0]


def test_unpushed_commits_block_recycling(wt) -> None:
    """`git worktree remove` 自己不看这个 —— 而它恰恰是「删掉就真没了」的那一种。"""
    reasons = wt.undelivered_reasons(0, "", 0, "abc1234 feat: x\ndef5678 fix: y\n")
    assert len(reasons) == 1
    assert "2" in reasons[0]


@pytest.mark.parametrize("dirty_rc,unpushed_rc", [(128, 0), (0, 128), (128, 128)])
def test_an_unreadable_state_blocks_recycling(
    wt, dirty_rc: int, unpushed_rc: int
) -> None:
    """**判不了就不删。**

    另一种写法是「没发现问题所以删」—— 那是本仓库反复付账的同一类 fail-open
    （AGENTS §20 的 fail-closed 在回收这一步的形态）。
    """
    assert wt.undelivered_reasons(dirty_rc, "", unpushed_rc, "") != []


def test_a_detached_worktree_is_checked_for_unpushed_commits_too(wt) -> None:
    """**没有分支名不等于没有东西会丢。**

    回归守卫（codex 轮 1 的 BLOCKING）：第一版在 detached 时整个跳过未推送检查，
    于是一棵 detached 的树上做了提交却没推时，回收掉它的工作树引用之后那些提交
    只剩 reflog 兜着，等一次 gc 就真的没了 —— 而「删掉就真没了」正是这道闸要挡的。
    修法是让未推送检查从**这棵树自己的 HEAD** 起算，两种情形共用一条路径。
    """
    assert wt.undelivered_reasons(0, "", 0, "abc1234 detached work\n") != []
    assert wt.undelivered_reasons(0, "", 0, "") == []


def test_the_base_is_the_main_worktree_not_the_current_one(wt) -> None:
    """本工具会**从某棵 worktree 里**被调用，基准必须仍然是主树。

    回归守卫：第一版用「脚本所在的树」的父目录当基准，于是在 `motv-wt/l4-loop`
    里跑 `drop l4-loop`，它去找 `motv-wt/motv-wt/l4-loop` —— 一个不存在的地方。
    自测当场抓到；这条用例保证它不会再回来。
    """
    porcelain = (
        "worktree D:/02_Work/repo\nHEAD abc\nbranch refs/heads/main\n"
        "\n"
        "worktree D:/02_Work/motv-wt/l4-loop\nHEAD def\n"
        "branch refs/heads/change/l4-loop\n"
    )
    base = wt.main_root_from(porcelain)
    assert base == Path("D:/02_Work/repo"), "第一条就是主工作树（git 的文档行为）"
    target = wt.resolve_target(base, "l4-loop")
    assert target == Path("D:/02_Work/motv-wt/l4-loop").resolve()
    assert "motv-wt/motv-wt" not in target.as_posix()


def test_the_nul_separated_form_is_parsed_and_non_ascii_paths_survive(wt) -> None:
    """真正跑的是 `--porcelain -z`，夹具就得是 NUL 形式。

    回归守卫（codex 轮 2 的 BLOCKING，与轮 1 的 `ls-files` 是**同一个失效机理**）：
    不带 `-z` 时 git 会把含非 ASCII 的路径 C-quote 成
    `"D:/…/\\344\\270\\255\\346\\226\\207"` —— 那个字符串不是路径，主树基准、
    `new` 与 `drop` 会一起指错地方。格式已实测：属性间一个 NUL，条目间两个。
    """
    porcelain = (
        "worktree D:/02_Work/中文 仓库\0HEAD abc\0branch refs/heads/main\0"
        "\0"
        "worktree D:/02_Work/motv-wt/l4-loop\0HEAD def\0"
        "branch refs/heads/change/l4-loop\0"
    )
    rows = wt.parse_worktree_list(porcelain, exists=lambda _p: False)
    assert [r["branch"] for r in rows] == ["main", "change/l4-loop"]
    assert rows[0]["path"].endswith("中文 仓库"), "中文与空格都必须原样留住"
    assert "\\344" not in rows[0]["path"], "不许出现 C-quote 的转义序列"
    assert wt.main_root_from(porcelain) == Path("D:/02_Work/中文 仓库")


def test_the_base_is_always_resolved_in_the_calling_tree(wt) -> None:
    """**基准一个都不透传，全部先在调用者那棵树里解析成 sha。**

    回归守卫（codex 轮 3 + 轮 4 的 BLOCKING）：git 以主树为执行根，于是任何相对量
    都会在主树上解析。轮 3 只修了字面量 `HEAD`，轮 4 立刻报回 `HEAD~1` ——
    同一个机理的另一个拼法。枚举相对 ref 是修不完的
    （`HEAD^` / `@{-1}` / `HEAD@{2}` / `@{u}` …），所以改成一律解析。
    """
    assert wt.resolve_base("HEAD", "cafe1234") == "cafe1234"
    assert wt.resolve_base("HEAD~1", "beef5678") == "beef5678"
    assert wt.resolve_base("origin/main", "d00d9999") == "d00d9999"


def test_an_unresolvable_base_refuses_rather_than_defaulting(wt) -> None:
    """解析不出就不建树 —— 别默认落到主树上（那正是上面那条缺陷）。"""
    for spelling in ("HEAD", "HEAD~1", "no-such-ref"):
        with pytest.raises(wt.Refused):
            wt.resolve_base(spelling, None)
        with pytest.raises(wt.Refused):
            wt.resolve_base(spelling, "")


def test_an_unreadable_worktree_list_yields_no_base(wt) -> None:
    """读不出登记表就没有基准 —— 调用方据此拒绝，而不是拿一个猜的基准动手。"""
    assert wt.main_root_from("") is None


def test_worktree_list_is_parsed_from_git_itself(wt) -> None:
    """登记表就是 `git worktree list`，没有第二份状态文件（TASK-143 OUT OF SCOPE）。"""
    porcelain = (
        "worktree D:/repo\nHEAD abc\nbranch refs/heads/main\n"
        "\n"
        "worktree D:/motv-wt/l4 loop\nHEAD def\nbranch refs/heads/change/l4-loop\n"
        "\n"
        "worktree D:/tmp/detached\nHEAD 999\ndetached\n"
    )
    rows = wt.parse_worktree_list(porcelain, exists=lambda p: "l4" in str(p))
    assert [r["branch"] for r in rows] == ["main", "change/l4-loop", "(detached)"]
    assert [r["venv"] for r in rows] == [False, True, False]
    assert rows[1]["path"].endswith("l4 loop"), "含空格的工作树路径不能被切开"
