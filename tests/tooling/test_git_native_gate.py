"""git 原生 `pre-commit` 闸门（ADR-0104 / TASK-148 切片 A）。

守的是两条判据，都来自实测出来的缺陷，不是想象出来的风险：

- **判据 1**：在**任意**一棵工作树里提交 ruff 必报的文件都会被拒绝。
  2026-09-16 实测：在 `motv-wt/pilot-143` 里同样的提交**成功了**，闸门零输出
  （TASK-143「第 8 种形状」）。
- **判据 2**：闸门的沉默不再有两种含义 —— 过了要留下一行，所以「什么都没说」
  从此只能解释为「它没跑」。

这里**断言执行构造**，不是断言字符串出现过：`test_the_shim_hands_control_to_the
_tracked_gate` 检查 shim 真的 `exec` 那个文件，`test_an_unknown_tier_blocks`
检查不认识的档位真的抛出 —— 查「文件里有没有这个词」会被一行注释满足。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOOKS = REPO_ROOT / ".claude" / "hooks"
if str(HOOKS) not in sys.path:
    sys.path.insert(0, str(HOOKS))

import pre_commit  # noqa: E402
from commit_gate_policy import Decision  # noqa: E402

sys.path.insert(0, str(REPO_ROOT / ".claude" / "tools"))
import install_git_hooks  # noqa: E402

VIOLATING = "import os\nimport sys\ndef  f( a,b ):\n    x=1\n    return a+b\n"


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """一个真实的 git 仓库。**不是**假件 —— 闸门的整个论点就是「git 说了算」。"""

    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.invalid")
    _git(root, "config", "user.name", "t")
    (root / "seed.txt").write_text("seed\n", encoding="utf-8")
    _git(root, "add", "seed.txt")
    _git(root, "commit", "-qm", "seed")
    return root


# --------------------------------------------------------------------------
# 判据 1 的结构性依据：hooks 目录是所有工作树共享的一份
# --------------------------------------------------------------------------


def test_a_worktree_resolves_to_the_main_repo_hooks_dir(repo: Path) -> None:
    """装一次覆盖所有树 —— 这条不是约定，是 git 的行为，所以钉住它。

    它失效的那天，`install_git_hooks` 就从「装一次」退化成「每棵树各装一次」，
    而**没人会收到通知**：旁树照样能提交，只是不再有闸门 —— 正是本卡要消掉的
    那个失败形状。
    """

    tree = repo.parent / "wt"
    _git(repo, "worktree", "add", "-q", "-b", "side", str(tree))

    # `--git-path` 可能给相对路径，它是相对**那次 git 调用的 cwd**说的，
    # 不是相对本测试进程的 cwd —— 直接 `Path(...).resolve()` 会把相对的那个
    # 解到 pytest 的工作目录去，于是两边永远不等，而测试会显得像是机理不成立。
    from_main = _git(repo, "rev-parse", "--git-path", "hooks").stdout.strip()
    from_tree = _git(tree, "rev-parse", "--git-path", "hooks").stdout.strip()

    assert (repo / from_main).resolve() == (tree / from_tree).resolve()


def test_repo_root_follows_the_tree_being_committed(repo: Path) -> None:
    """`repo_root()` 给的是**被提交的那棵树**，不是 hook 脚本住的那棵。

    这正是旧闸门错的地方：它按会话的 `CLAUDE_PROJECT_DIR` 定根，于是旁树的提交
    被拿主树的状态去检查（主树干净 → 放行）。
    """

    tree = repo.parent / "wt2"
    _git(repo, "worktree", "add", "-q", "-b", "side2", str(tree))

    cwd = Path.cwd()
    try:
        os.chdir(tree)
        assert pre_commit.repo_root().resolve() == tree.resolve()
    finally:
        os.chdir(cwd)


# --------------------------------------------------------------------------
# 判据 1：真的拦得住，而且是因为 ruff 拦的
# --------------------------------------------------------------------------


def _run_gate(root: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> int:
    """在 *root* 里跑闸门主函数。

    只替换 `venv_python` —— 临时仓库没有自己的 venv，而那条 fail-closed 有它
    单独的测试。其余全部走真路径：真 git、真 `classify`、真 ruff 子进程。
    """

    monkeypatch.setattr(pre_commit, "venv_python", lambda _root: Path(sys.executable))
    monkeypatch.chdir(root)
    return pre_commit.main()


def test_a_ruff_violation_is_blocked_in_a_plain_repo(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    (repo / "bad.py").write_text(VIOLATING, encoding="utf-8")
    _git(repo, "add", "bad.py")

    assert _run_gate(repo, monkeypatch, capsys) == 1
    assert "ruff" in capsys.readouterr().err


def test_a_ruff_violation_is_blocked_in_a_worktree_too(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """**判据 1 本体。** 2026-09-16 这一条的实测结果是「提交成功」。

    旁树与主树走的是同一段代码、同一个 cwd 约定，所以这里没有第二套逻辑要测 ——
    要测的正是「没有第二套逻辑」这件事本身。
    """

    tree = repo.parent / "wt3"
    _git(repo, "worktree", "add", "-q", "-b", "side3", str(tree))
    (tree / "bad.py").write_text(VIOLATING, encoding="utf-8")
    _git(tree, "add", "bad.py")

    assert _run_gate(tree, monkeypatch, capsys) == 1
    assert "ruff" in capsys.readouterr().err


# --------------------------------------------------------------------------
# 判据 2：过了也要说一声
# --------------------------------------------------------------------------


def test_a_clean_commit_still_says_the_gate_ran(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """**判据 2 本体。** 沉默从此只剩一种解释：闸门没跑。

    刻意暂存一份 `docs/` 下的文档：它按归属映射拿到的是最便宜的那一档，
    所以这个测试测的是「过了会不会说话」，而不是在临时仓库里跑一次全量
    （那里一个用例都收集不到，pytest 退出 5，测到的会是另一回事）。
    """

    (repo / "docs").mkdir()
    (repo / "docs" / "notes.md").write_text("# notes\n", encoding="utf-8")
    _git(repo, "add", "docs/notes.md")

    assert _run_gate(repo, monkeypatch, capsys) == 0
    assert "[gate] pre-commit ok" in capsys.readouterr().err


# --------------------------------------------------------------------------
# fail-closed：缺东西一律拦住，不跳过
# --------------------------------------------------------------------------


def test_a_tree_without_its_own_venv_is_blocked(repo: Path) -> None:
    """共享 venv 会让测试绿着却测别人的代码（TASK-147 A-2），所以缺 venv 拦住。"""

    with pytest.raises(pre_commit.Blocked) as caught:
        pre_commit.venv_python(repo)
    assert caught.value.label == "venv"


def test_an_unknown_tier_blocks(tmp_path: Path) -> None:
    """不认识的档位 → 拦住。放行会让策略层新增一个档位时闸门安静失效。"""

    with pytest.raises(pre_commit.Blocked):
        pre_commit.build_checks(
            tmp_path, tmp_path / "python", Decision("something-new", "")
        )


def test_missing_import_linter_blocks_instead_of_skipping(tmp_path: Path) -> None:
    """缺二进制**拦住**，不是跳过（AGENTS.md §6）。看不见的跳过会变成永久缺口。"""

    with pytest.raises(pre_commit.Blocked) as caught:
        pre_commit.build_checks(
            tmp_path,
            tmp_path / "nowhere" / "python",
            Decision("lint", "", import_contracts=True),
        )
    assert caught.value.label == "lint-imports"


def test_cheap_checks_come_before_expensive_ones() -> None:
    """ruff 在 pytest 之前。

    反过来写的代价很具体：一个 ruff 一秒能报的错，要等十分钟全量跑完才看得到。
    断言的是**组合出来的顺序**，不是某一行代码长什么样。
    """

    py = Path("python")
    cheap = pre_commit.always_checks(py)
    assert cheap[0][0] == "ruff format --check"
    assert cheap[1][0] == "ruff check"


# --------------------------------------------------------------------------
# 安装器
# --------------------------------------------------------------------------


def test_the_shim_hands_control_to_the_tracked_gate() -> None:
    """shim 自己不判断，只把控制权交给被跟踪的那一份。

    断言的是 `exec` 那个**执行动作** —— 查「文件里有没有 pre_commit.py 这个词」
    会被一行注释满足（本仓库付过这个账）。
    """

    shim = install_git_hooks.SHIM
    assert "exec " in shim
    assert ".claude/hooks/pre_commit.py" in shim
    # 路径现算，所以同一份 shim 服务所有工作树；写死仓库路径就只服务一棵。
    assert "git rev-parse --show-toplevel" in shim
    assert str(REPO_ROOT) not in shim


def test_the_shim_is_lf_only() -> None:
    """CRLF 会让 shebang 带上一个 \\r，MSYS2 sh 报 bad interpreter —— 闸门静默消失。"""

    assert "\r" not in install_git_hooks.SHIM


def test_the_shim_fails_closed_when_the_gate_is_absent() -> None:
    """闸门不在这棵树上（比如切到了没有它的旧分支）→ 拦住，不是放行。"""

    assert "exit 1" in install_git_hooks.SHIM


def test_check_mode_reports_a_missing_hook(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(repo)
    assert install_git_hooks.install(check_only=True) == 1


def test_install_then_check_is_clean(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    assert install_git_hooks.install(check_only=True) == 0
    hook = Path(_git(repo, "rev-parse", "--git-path", "hooks").stdout.strip())
    assert (hook / "pre-commit").is_file()


def test_git_itself_invokes_the_shim_and_the_commit_is_refused(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**端到端：由 git 自己调用。**

    上面那些测试直接调 `pre_commit.main()`，证明的是闸门的判断对；这一条证明的是
    **它会被调用** —— 而「会不会被调用」正是 `PreToolUse` 栽的地方（14 次里漏 5 次）。
    所以真的跑一次 `git commit`，看提交有没有落下去。

    整件事发生在临时仓库里：往共享的 `.git/hooks` 里装东西会波及同仓其他会话的树
    （他们的分支上没有这个闸门文件，shim 会 fail-closed 拦住他们）。
    """

    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    # shim 交棒给「被提交的那棵树」里的闸门，所以临时仓库里也得有一份。
    gate_dir = repo / ".claude" / "hooks"
    gate_dir.mkdir(parents=True)
    (gate_dir / "pre_commit.py").write_text(
        "import sys\nsys.stderr.write('refused by gate\\n')\nraise SystemExit(1)\n",
        encoding="utf-8",
    )
    venv = repo / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    venv.mkdir(parents=True)
    target = venv / ("python.exe" if os.name == "nt" else "python")
    # shim 找的是这棵树自己的 venv 解释器。裸复制一个 python 还不够 ——
    # 它会去找 `pyvenv.cfg`，找不到就在启动时死掉，于是提交被拦住的原因变成
    # 「解释器起不来」而不是「闸门拒绝」，测试就会为了错误的理由变绿。
    target.write_bytes(Path(sys.executable).read_bytes())
    (repo / ".venv" / "pyvenv.cfg").write_text(
        f"home = {sys.base_prefix}\ninclude-system-site-packages = false\n",
        encoding="utf-8",
    )

    (repo / "bad.py").write_text(VIOLATING, encoding="utf-8")
    _git(repo, "add", "bad.py")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    done = _git(repo, "commit", "-m", "should not land")

    assert done.returncode != 0, "hook 没拦住：提交落下去了"
    assert "refused by gate" in (done.stderr + done.stdout)
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == before


def test_a_hooks_path_override_is_refused(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`core.hooksPath` 一设，`.git/hooks` 里的东西一概不跑。

    不检查这条就会出现「装好了、报告成功、从不触发」—— 正是本卡要消灭的那种失败。
    """

    _git(repo, "config", "core.hooksPath", ".githooks")
    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 1
