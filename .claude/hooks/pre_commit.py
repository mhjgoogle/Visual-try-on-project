"""git 原生 `pre-commit`：这个仓库**权威**的提交闸门（ADR-0104）。

为什么是它、而不是 `PreToolUse`
------------------------------
`PreToolUse` 闸门实测**会静默不触发**：14 次提交尝试中 5 次未被调用，且不可由
命令形状复现（TASK-147 §6.2 · §8）。它还只覆盖会话自己那棵树 —— 在旁边的
worktree 里提交，钩子按会话的 `CLAUDE_PROJECT_DIR` 定根，`cd` 换得掉 git 的树、
换不掉钩子的树，于是 ruff 必报的文件可以直接提交成功（TASK-143「第 8 种形状」，
2026-09-16 实测）。

git 原生 hook 把这两条一起消掉，而且是**结构性**地消掉，不是多加一层检查：

1. **触发权在 git 手里。** 没有「客户端要不要调用钩子」这一层，也就没有那 5/14。
2. **定根由 git 决定。** hook 的 cwd 就是**正在被提交的那棵树**的根，
   所以「被检查的树」与「被提交的树」是同一棵 —— 按构造成立，不靠约定。
3. **不需要猜意图。** `PreToolUse` 截到的是一串命令文本，于是要有 `inspect_command`
   那一整层 shell 词法分析（ADR-0070）去回答「这是不是一次 commit」「它写的是
   index 还是 worktree」。git 在这里已经知道答案了，整层因此不再参与权威判定。

覆盖面：`git rev-parse --git-path hooks` 在任何 worktree 里都解析到**主仓的**
`.git/hooks`（2026-09-16 实测），所以**装一次覆盖所有树**。

`PreToolUse` 不删除 —— 它降级为 early feedback：在命令真正跑起来之前给出快反馈
仍然有价值，只是不再是唯一防线。
"""

from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from commit_gate_policy import Decision, classify  # noqa: E402

#: 一条检查的墙钟预算。与 gate.ps1 同值 —— 两个实现给出同样的判定是硬要求
#: （AGENTS.md §4 / ADR-0062 决策 3）。
RUFF_TIMEOUT = 15
GIT_TIMEOUT = 8
DOCTOR_TIMEOUT = 60
IMPORTS_TIMEOUT = 120

#: 一条检查：标签、命令、预算、**在哪个目录跑**。
#:
#: 最后那一项不是为了整齐。`ruff` 必须在**索引的快照**里跑，其余在工作树里跑 ——
#: 两者混用正是 codex 2026-09-16 报出的那条 P1：ruff 查工作区、git 提交索引，
#: 于是「暂存一个有问题的版本，再在工作区把问题改掉但不暂存」能让违规版本提交成功。
Check = tuple[str, list[str], int, Path]


class Blocked(Exception):
    """一条检查没过。带上标签与输出 —— 拦住而不说为什么等于没拦。"""

    def __init__(self, label: str, output: str) -> None:
        super().__init__(label)
        self.label = label
        self.output = output


#: git 运行 hook 时导出的**仓库身份**变量。
#:
#: 这里有两个方向相反的要求，**必须分开满足**（两条都是 codex 报出来的，
#: 第二条正是第一条的修复引入的）：
#:
#: - **闸门自己的 git 必须继承它们。** `GIT_INDEX_FILE` 尤其要紧：`git commit -a`
#:   与 `git commit -- <路径>` 会建一个**临时索引**并用这个变量指过去。摘掉它，
#:   闸门就去查普通索引 —— 于是普通索引干净就能放行，而真正被提交的那份含违规内容。
#:   这跟「查工作区、提交索引」是同一个病的第三种拼法。
#: - **被拉起来的检查工具必须摘掉它们。** 不摘的话，pytest 在临时仓库里建的每一条
#:   git 都会指回**正在提交的那个仓库** —— 测试要么莫名失败，要么改到真仓库上去。
#:
#: 所以：`_git()` 用 `os.environ` 原样，`run_check()` 用 `clean_env()`。
_GIT_IDENTITY_VARS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
    "GIT_NAMESPACE",
)


def gate_env() -> dict[str, str]:
    """闸门**自己的 git** 用的环境：git 给什么就用什么，一个字不改。

    它描述的正是「这次提交」——包括 `commit -a` 那个临时索引。
    """

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def clean_env() -> dict[str, str]:
    """**被拉起来的检查工具**用的环境：摘掉仓库身份，免得它们指回这个仓库。"""

    env = {k: v for k, v in gate_env().items() if k not in _GIT_IDENTITY_VARS}
    return env


def git_exe() -> str:
    """`git` 的解析路径，找不到就拦住。

    AGENTS.md §6：外部工具一律经 `shutil.which` 解析、**失败即 fail-closed**，
    不得裸名调用。闸门比别的工具更没有资格赌 PATH —— 它是决定提交发不发生的那个东西。
    """

    found = shutil.which("git")
    if found is None:
        raise Blocked("git", "PATH 上没有 git。")
    return found


def _git(
    root: Path, *args: str, timeout: int = GIT_TIMEOUT
) -> subprocess.CompletedProcess:
    return subprocess.run(
        [git_exe(), *args],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=gate_env(),
    )


def repo_root() -> Path:
    """**正在被提交的那棵树**的根。

    刻意问 git，不从 `__file__` 推：`__file__` 指向的是 hook 脚本住的那棵树，
    而 `.git/hooks` 是所有 worktree 共享的一份 —— 从自身位置定根会让每一棵旁树
    都被按主树检查，正是本文件要消掉的那个缺陷。git 运行 hook 时的 cwd 就是
    被提交的那棵树，所以这里问到的是对的那一棵。
    """

    done = subprocess.run(
        [git_exe(), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=GIT_TIMEOUT,
        env=gate_env(),
    )
    if done.returncode != 0 or not done.stdout.strip():
        raise Blocked("repo-root", "git rev-parse --show-toplevel 没有给出仓库根")
    return Path(done.stdout.strip())


def venv_python(root: Path) -> Path:
    """这棵树**自己的** venv 解释器，缺了就拦住。

    每棵树一个 venv 不是偏好：`pip install -e .` 写进 site-packages 的
    `__editable__*.pth` 是绝对路径，共享一份 venv 会让 `import ai_video_workflow`
    解析到建它的那棵树的 `src/` —— **测试全绿而测的是别人的代码**
    （TASK-147 决定 A-2）。所以这里不回退到 `sys.executable`，也不找 PATH 上的
    python：找不到就 fail-closed（AGENTS.md §6）。
    """

    relative = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    candidate = root / ".venv" / relative
    if not candidate.is_file():
        raise Blocked(
            "venv",
            f"这棵树没有自己的 venv：{candidate}\n"
            "用 `.claude/tools/worktree.py new <id>` 建树会连 venv 一起建好；"
            "已有的树补建后再提交。",
        )
    return candidate


def staged_paths(root: Path) -> list[str]:
    r"""暂存区里的路径。

    `-z`：NUL 分隔且**永不 C-quote**。少了它，git 会把含非 ASCII 的路径包成
    `"docs/\344\270\255\346\226\207.md"`，分类器读到的就不是那个路径 —— 单是开头
    那个引号就能让每一条前缀判定落空，于是高风险文件拿到便宜档位。仓库今天没有
    非 ASCII 的已跟踪路径，**这正是它一直看不见的原因**。
    （同一个机理 TASK-147 的审查轮 1/2 也撞到过。）
    """

    done = _git(
        root, "diff", "--cached", "--name-only", "--no-renames", "-z", timeout=15
    )
    if done.returncode != 0:
        raise Blocked("staged-paths", f"列不出暂存路径：{done.stderr.strip()}")
    return [p for p in done.stdout.split("\0") if p]


# ADR-0068 的连续修改链在本闸门里**没有对应开关**，这是刻意的。
#
# 那个一次性开关写在**提交命令最前面**，由 `PreToolUse` 从命令文本里读。git 原生
# hook 看不到命令文本，唯一的替代载体是环境变量 —— 而 AGENTS.md §20 写的是
# 「**不是环境变量**，不得持久化」。那句话不是文体偏好：命令前缀天然只活一条命令，
# 环境变量则一个 `setx` 或一行 profile 就永久生效，而同一节还写着
# 「不存在永久关闭测试的全局开关」。
#
# 所以这里不换载体，直接不实现。代价明确且是**朝严的方向**：链的中间提交在这里
# 拿到的是它按归属映射该跑的那些测试，而不是「跳过」。快反馈仍由 `PreToolUse`
# 那一层按原样提供（它仍然读命令文本）。


@contextlib.contextmanager
def index_snapshot(root: Path) -> Iterator[Path]:
    """把**索引**整棵物化到一个临时目录，交出它的路径。

    为什么要整棵、而不是只导出改动的那几个文件：AGENTS.md §20 与 TASK-143 的
    OUT OF SCOPE 都写死了「不改闸门的严格度」——「把 `ruff format --check` 改成
    只查改动文件」被点名为免罪符。所以范围仍然是全仓，变的只是**查哪一份全仓**：
    从「工作区此刻的样子」换成「这次提交真正写进去的样子」。

    `pyproject.toml`（ruff 的配置）本身是被跟踪文件，所以它随索引一起出来，
    快照里的 ruff 用的还是同一套规则。
    """

    with tempfile.TemporaryDirectory(prefix="motv-gate-index-") as tmp:
        # `--prefix` 必须以分隔符结尾，且用正斜杠 —— git 在 Windows 上也吃正斜杠，
        # 而反斜杠会被它当转义看待。
        prefix = Path(tmp).as_posix().rstrip("/") + "/"
        done = _git(
            root, "checkout-index", "-a", "-f", f"--prefix={prefix}", timeout=120
        )
        if done.returncode != 0:
            raise Blocked("index-snapshot", f"导不出索引：{done.stderr.strip()}")
        yield Path(tmp)


def frontend_check(root: Path) -> Check:
    node = shutil.which("node")
    if node is None:
        raise Blocked("frontend tests", "PATH 上没有 node。")
    tests_dir = root / "mockups" / "motv-workspace" / "tests"
    files = sorted(str(p) for p in tests_dir.glob("*.test.mjs"))
    if not files:
        raise Blocked("frontend tests", f"没有找到前端测试文件：{tests_dir}")
    return ("frontend tests", [node, "--test", *files], 90, root)


def build_checks(root: Path, py: Path, decision: Decision) -> list[Check]:
    """档位 → 检查清单。与 gate.ps1 的 `switch ($policy.tier)` 同一张表。"""

    checks: list[Check] = []
    tier = decision.tier

    if tier == "full":
        checks.append(
            (
                "pytest (full, parallel)",
                [str(py), "-m", "pytest", "-n", "8", "-m", "not serial"],
                600,
                root,
            )
        )
        checks.append(
            (
                "pytest (full, serial)",
                [str(py), "-m", "pytest", "-m", "serial"],
                180,
                root,
            )
        )
        if decision.frontend:
            checks.append(frontend_check(root))
    elif tier == "pytest-targeted":
        if decision.pytest_targets:
            argv = [
                str(py),
                "-m",
                "pytest",
                "-n",
                "8",
                "-m",
                "not serial",
                *decision.pytest_targets,
            ]
            checks.append(("pytest (targeted)", argv, 480, root))
        if decision.serial_targets:
            argv = [str(py), "-m", "pytest", *decision.serial_targets]
            checks.append(("pytest (targeted, serial)", argv, 120, root))
        if decision.frontend:
            checks.append(frontend_check(root))
    elif tier == "frontend":
        checks.append(frontend_check(root))
    elif tier in ("lint", "continuous-chain", "skip"):
        pass
    else:
        # 预期之外的档位一律拦住。fail-closed（AGENTS.md §20）。
        raise Blocked("commit-risk-policy", f"不认识的风险档位：{tier}")

    if decision.doctor:
        doctor = root / ".claude" / "tools" / "motv_doctor.py"
        checks.append(("motv doctor", [str(py), str(doctor)], DOCTOR_TIMEOUT, root))

    if decision.import_contracts:
        linter = py.parent / ("lint-imports.exe" if os.name == "nt" else "lint-imports")
        if not linter.is_file():
            # 缺二进制**拦住**，不是跳过：看不见的跳过就是临时缺口变永久
            # （AGENTS.md §6 fail-closed）。
            raise Blocked(
                "lint-imports",
                'import-linter 不在 .venv 里。装 dev extra：pip install -e ".[dev]"',
            )
        checks.append(("lint-imports", [str(linter)], IMPORTS_TIMEOUT, root))

    return checks


def always_checks(py: Path, root: Path, snapshot: Path) -> list[Check]:
    """每次提交都跑的那些。

    ruff 两条在 **snapshot**（索引的样子）里跑，`git diff --cached --check` 本来
    就问索引 —— 三条问的都是「这次提交写进去的是什么」。
    """

    git = git_exe()
    return [
        (
            "ruff format --check",
            [str(py), "-m", "ruff", "format", "--check", "."],
            RUFF_TIMEOUT,
            snapshot,
        ),
        ("ruff check", [str(py), "-m", "ruff", "check", "."], RUFF_TIMEOUT, snapshot),
        (
            "git diff --cached --check",
            [git, "diff", "--cached", "--check"],
            GIT_TIMEOUT,
            root,
        ),
    ]


def run_check(label: str, argv: list[str], timeout: int, cwd: Path) -> None:
    # `clean_env()` 摘掉 git 传给 hook 的仓库身份变量。不摘的话，子进程里的每一条
    # git（尤其 pytest 在临时仓库里建的那些）都会指回正在提交的这个仓库。
    env = clean_env()
    try:
        done = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        raise Blocked(label, f"[{timeout}s 超时]\n{out}") from exc
    except OSError as exc:
        raise Blocked(label, f"跑不起来这条检查：{exc}") from exc
    if done.returncode != 0:
        raise Blocked(label, f"{done.stdout}{done.stderr}")


def _say_blocked(exc: Blocked) -> None:
    sys.stderr.write(f"=== 提交被 pre-commit 拦下：'{exc.label}' 没过 ===\n")
    if exc.output:
        sys.stderr.write(exc.output.rstrip() + "\n")
    sys.stderr.write("=== 修好上面这些再提交 ===\n")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        root = repo_root()
        py = venv_python(root)
        paths = staged_paths(root)
        decision = classify(paths, chain_mode=False)
    except Blocked as exc:
        _say_blocked(exc)
        return 1

    try:
        with index_snapshot(root) as snapshot:
            # 便宜的先跑 —— 与 gate.ps1 的顺序一致（它也是先 ruff 再按档位追加）。
            # 反过来写的代价很具体：一个 ruff 一秒就能报的错，要等十分钟全量
            # pytest 跑完才看得到。
            checks = always_checks(py, root, snapshot) + build_checks(
                root, py, decision
            )
            for label, argv, timeout, cwd in checks:
                run_check(label, argv, timeout, cwd)
    except Blocked as exc:
        _say_blocked(exc)
        return 1

    # **过了也要说一声。** 那两条破口合起来是「闸门的沉默有两种含义」：检查全过了，
    # 或者它根本没跑。留下这一行之后，沉默只剩一种解释 —— 没跑。（TASK-148 判据 2。）
    if decision.notice:
        sys.stderr.write(f"[gate] {decision.notice}\n")
    sys.stderr.write(
        f"[gate] pre-commit ok · 档位 {decision.tier} · {len(checks)} 项检查 · {root}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
