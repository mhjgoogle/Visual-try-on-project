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
import shutil
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


def test_cheap_checks_come_before_expensive_ones(tmp_path: Path) -> None:
    """ruff 在 pytest 之前。

    反过来写的代价很具体：一个 ruff 一秒能报的错，要等十分钟全量跑完才看得到。
    断言的是**组合出来的顺序**，不是某一行代码长什么样。
    """

    cheap = pre_commit.always_checks(Path("python"), tmp_path, tmp_path / "snap")
    assert cheap[0][0] == "ruff format --check"
    assert cheap[1][0] == "ruff check"


def test_ruff_reads_the_index_snapshot_not_the_working_tree(tmp_path: Path) -> None:
    """**codex 2026-09-16 那条 P1 的结构性断言。**

    两条 ruff 的工作目录必须是快照目录 —— 断言的是「它在哪儿跑」这个执行事实，
    不是代码里出现过 `snapshot` 这个词。
    """

    root = tmp_path / "tree"
    snapshot = tmp_path / "snap"
    checks = pre_commit.always_checks(Path("python"), root, snapshot)

    by_label = {label: cwd for label, _argv, _t, cwd in checks}
    assert by_label["ruff check"] == snapshot
    assert by_label["ruff format --check"] == snapshot
    # 索引那条本来就问索引，留在工作树里跑是对的。
    assert by_label["git diff --cached --check"] == root


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


def _wire_real_gate(repo: Path) -> None:
    """把**真的**闸门装进临时仓库：闸门源码 + 一个能用的 `.venv`。

    早先这里放的是一个「直接 exit 1」的桩，codex 因此判判据 2 `NOT_EVIDENCED` ——
    桩证明的是「shim 会调起某个东西」，不是「真闸门跑起来了」。

    `.venv` 用链接而不是复制：闸门要跑 ruff，而 ruff 装在本仓库的 venv 里；
    裸复制一个解释器过去，`site-packages` 是空的，测到的会是「ruff 不存在」。
    """

    gate_dir = repo / ".claude" / "hooks"
    gate_dir.mkdir(parents=True, exist_ok=True)
    for name in ("pre_commit.py", "commit_gate_policy.py"):
        shutil.copy2(HOOKS / name, gate_dir / name)

    link = repo / ".venv"
    real = REPO_ROOT / ".venv"
    try:
        link.symlink_to(real, target_is_directory=True)
        return
    except OSError:
        pass
    if os.name == "nt":
        done = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(real)],
            capture_output=True,
            text=True,
            check=False,
        )
        if done.returncode == 0:
            return
    pytest.skip(
        "这台机器既建不了 symlink 也建不了 junction，无法把真 venv 接进临时仓库"
    )


def test_git_itself_invokes_the_real_gate_and_the_commit_is_refused(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**端到端：由 git 自己调用，而且调起的是真闸门。**

    上面那些测试直接调 `pre_commit.main()`，证明的是闸门的判断对；这一条证明的是
    **它会被调用** —— 而「会不会被调用」正是 `PreToolUse` 栽的地方（14 次里漏 5 次）。

    整件事发生在临时仓库里：往共享的 `.git/hooks` 里装东西会波及同仓其他会话的树
    （他们的分支上没有这个闸门文件，shim 会 fail-closed 拦住他们）。
    """

    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    _wire_real_gate(repo)

    (repo / "bad.py").write_text(VIOLATING, encoding="utf-8")
    _git(repo, "add", "bad.py")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    done = _git(repo, "commit", "-m", "should not land")
    combined = done.stderr + done.stdout

    assert done.returncode != 0, "hook 没拦住：提交落下去了"
    assert "ruff" in combined, combined[:2000]
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == before


def test_commit_dash_a_is_checked_against_gits_temporary_index(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**codex 2026-09-16 轮 2 的 P1。**

    `git commit -a` 不写普通索引：git 另建一个**临时索引**，用 `GIT_INDEX_FILE`
    指过去。闸门若把这个变量摘掉，查的就是普通索引 —— 普通索引干净就放行，
    而真正被提交的那份含违规内容。这是「查的和提交的不是同一份」的第三种拼法，
    前两种是「查工作区」和「查旁边那棵树」。
    """

    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    _wire_real_gate(repo)

    # 先让一个干净版本进普通索引并落地 —— 于是「普通索引是干净的」为真。
    tracked = repo / "mod.py"
    tracked.write_text("x = 1\n", encoding="utf-8")
    _git(repo, "add", "mod.py")
    _git(repo, "commit", "-m", "clean")

    # 再在工作区把它改违规，不暂存。`-a` 会把它带进临时索引。
    tracked.write_text(VIOLATING, encoding="utf-8")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    done = _git(repo, "commit", "-a", "-m", "should not land")
    combined = done.stderr + done.stdout

    assert done.returncode != 0, "commit -a 没被拦住：" + combined[:2000]
    assert "ruff" in combined, combined[:2000]
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == before


def test_a_path_limited_commit_is_checked_against_what_it_commits(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`git commit -- <路径>` 同理：也走临时索引。"""

    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    _wire_real_gate(repo)

    bad = repo / "bad.py"
    bad.write_text(VIOLATING, encoding="utf-8")
    _git(repo, "add", "bad.py")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    done = _git(repo, "commit", "-m", "should not land", "--", "bad.py")
    combined = done.stderr + done.stdout

    assert done.returncode != 0, "路径限定提交没被拦住：" + combined[:2000]
    assert "ruff" in combined, combined[:2000]
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == before


def test_the_gates_own_git_keeps_the_index_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两个环境方向相反，断言两边各自成立 —— 不是断言「有一个函数叫 clean_env」。"""

    monkeypatch.setenv("GIT_INDEX_FILE", "/tmp/whatever/index")

    assert pre_commit.gate_env()["GIT_INDEX_FILE"] == "/tmp/whatever/index"
    assert "GIT_INDEX_FILE" not in pre_commit.clean_env()


def test_an_existing_foreign_hook_is_not_destroyed(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**codex 2026-09-16 轮 2 的 P2。**

    直接覆盖会**静默删掉**那个仓库原有的检查。一个以「闸门不许安静消失」立论的
    工具，不能自己去让别的闸门安静消失。
    """

    monkeypatch.chdir(repo)
    hook_dir = Path(_git(repo, "rev-parse", "--git-path", "hooks").stdout.strip())
    target = (hook_dir if hook_dir.is_absolute() else repo / hook_dir) / "pre-commit"
    target.parent.mkdir(parents=True, exist_ok=True)
    foreign = "#!/bin/sh\necho someone elses check\n"
    target.write_text(foreign, encoding="utf-8")

    assert install_git_hooks.install() == 1
    assert target.read_text(encoding="utf-8") == foreign, "别人的 hook 被覆盖了"

    # 明说了就可以覆盖 —— 拒绝的是**静默**覆盖，不是覆盖本身。
    assert install_git_hooks.install(force=True) == 0
    assert install_git_hooks.is_ours(target)


def test_a_clean_commit_through_git_says_the_gate_ran(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**判据 2 的端到端那一半**：真提交落下去了，而且闸门留了话。"""

    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    _wire_real_gate(repo)

    (repo / "docs").mkdir()
    (repo / "docs" / "notes.md").write_text("# notes\n", encoding="utf-8")
    _git(repo, "add", "docs/notes.md")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    done = _git(repo, "commit", "-m", "docs: notes")
    combined = done.stderr + done.stdout

    assert done.returncode == 0, combined[:2000]
    assert "[gate] pre-commit ok" in combined, combined[:2000]
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() != before


def test_a_violation_hidden_by_an_unstaged_fix_is_still_refused(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """**codex 2026-09-16 的 P1。** 暂存一个违规版本，再在工作区把它改干净但不暂存。

    闸门若查工作区，看到的是已经改好的那一份 → 放行，而 git 提交的是**索引里**
    那个违规版本。这是判据 1 的一个更阴的拼法：文件确实被提交了，而且 ruff 确实
    会报它。
    """

    bad = repo / "bad.py"
    bad.write_text(VIOLATING, encoding="utf-8")
    _git(repo, "add", "bad.py")
    bad.write_text("x = 1\n", encoding="utf-8")  # 工作区干净了，但没暂存

    assert _run_gate(repo, monkeypatch, capsys) == 1
    assert "ruff" in capsys.readouterr().err


def test_the_gate_does_not_leak_gits_repository_identity_into_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """**codex 2026-09-16 的 P1。** git 跑 hook 时导出的仓库身份变量必须摘掉。

    不摘的话，子进程里的每一条 git（尤其 pytest 在临时仓库里建的那些）都会指回
    **正在提交的那个仓库** —— 测试要么莫名其妙失败，要么改到真仓库上去。
    """

    monkeypatch.setenv("GIT_DIR", "/somewhere/else/.git")
    monkeypatch.setenv("GIT_INDEX_FILE", "/somewhere/else/index")
    monkeypatch.setenv("GIT_WORK_TREE", "/somewhere/else")

    env = pre_commit.clean_env()

    assert "GIT_DIR" not in env
    assert "GIT_INDEX_FILE" not in env
    assert "GIT_WORK_TREE" not in env


def test_the_gate_refuses_when_git_is_not_on_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AGENTS.md §6：外部工具经 `shutil.which` 解析，失败即 fail-closed。"""

    monkeypatch.setattr(pre_commit.shutil, "which", lambda _name: None)
    with pytest.raises(pre_commit.Blocked) as caught:
        pre_commit.git_exe()
    assert caught.value.label == "git"


def test_a_crlf_mangled_hook_is_not_certified_as_current(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**codex 2026-09-16 的 P1。** 按文本比会把 CRLF 归一掉，坏 shim 比出来「一样」。

    而 MSYS2 的 sh 读到 `#!/bin/sh\\r` 报 bad interpreter —— 闸门就这么安静地没了。
    """

    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    hook = Path(_git(repo, "rev-parse", "--git-path", "hooks").stdout.strip())
    target = (
        repo / hook / "pre-commit" if not hook.is_absolute() else hook / "pre-commit"
    )
    target.write_bytes(install_git_hooks.SHIM.replace("\n", "\r\n").encode("utf-8"))

    assert install_git_hooks.install(check_only=True) == 1
    assert install_git_hooks.install() == 0  # 修得回来
    assert install_git_hooks.install(check_only=True) == 0


@pytest.mark.skipif(os.name == "nt", reason="Windows 没有可执行位；git 也不看它")
def test_a_non_executable_hook_is_not_certified_as_current(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**codex 2026-09-16 的 P1。** Ubuntu 上 git 直接跳过不可执行的 hook，一声不吭。"""

    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 0
    hook = Path(_git(repo, "rev-parse", "--git-path", "hooks").stdout.strip())
    target = (hook if hook.is_absolute() else repo / hook) / "pre-commit"
    target.chmod(0o644)

    assert install_git_hooks.install(check_only=True) == 1


def test_a_hooks_path_override_is_refused(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`core.hooksPath` 一设，`.git/hooks` 里的东西一概不跑。

    不检查这条就会出现「装好了、报告成功、从不触发」—— 正是本卡要消灭的那种失败。
    """

    _git(repo, "config", "core.hooksPath", ".githooks")
    monkeypatch.chdir(repo)
    assert install_git_hooks.install() == 1
