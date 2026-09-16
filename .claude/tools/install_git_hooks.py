"""把 git 原生 `pre-commit` 装进共享的 `.git/hooks`（ADR-0104）。

**装一次覆盖所有 worktree。** `git rev-parse --git-path hooks` 在任何一棵树里都
解析到主仓的 `.git/hooks`（2026-09-16 实测），所以这里不需要遍历工作树，
也不需要「N 棵树 N 份工装要同步」那套东西。

装的是一层**极薄的 shim**：真正的闸门是被跟踪的 `.claude/hooks/pre_commit.py`，
随仓库版本走。shim 自己不做判断，只负责把控制权交给**被提交的那棵树**里的那一份
（`git rev-parse --show-toplevel`）—— 所以切换分支、回滚闸门代码，立刻生效，
不需要重装。

shim 是 POSIX `sh`：Windows 上 git 用自带的 MSYS2 `sh.exe` 跑 hook（**不是 WSL**，
所以 ADR-0050 决策 1 当初要躲的那次 WSL 唤醒在这里不会发生），Ubuntu 上是系统 sh。
一份脚本两边都对，不需要 `.ps1`/`.sh` 双实现的行为合同表。

用法：

    python .claude/tools/install_git_hooks.py            # 装 / 更新
    python .claude/tools/install_git_hooks.py --check    # 只报告，装错了退出非零
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HOOK_NAME = "pre-commit"


def git_exe() -> str:
    """AGENTS.md §6：经 `shutil.which` 解析，失败即 fail-closed，不裸名调用。"""

    found = shutil.which("git")
    if found is None:
        raise SystemExit("PATH 上没有 git。")
    return found


#: shim 内容。**不含仓库绝对路径** —— 路径现算，所以同一份 shim 服务所有工作树。
#:
#: `exec` 而不是调用后再退出：让 python 的退出码原样成为 hook 的退出码，中间不留
#: 一层会吞掉它的 shell。
SHIM = """#!/bin/sh
# 由 .claude/tools/install_git_hooks.py 生成（ADR-0104）。不要手改这个文件 ——
# 真正的闸门是被跟踪的 .claude/hooks/pre_commit.py，改那一份。
root=$(git rev-parse --show-toplevel) || exit 1
gate="$root/.claude/hooks/pre_commit.py"
if [ ! -f "$gate" ]; then
    # fail-closed：闸门不在这棵树上（比如切到了没有它的旧分支）时拦住并说清楚，
    # 而不是安静放行。一个安静消失的闸门就是没有闸门。
    echo "pre-commit 闸门不在这棵树上：$gate" >&2
    exit 1
fi
if [ -x "$root/.venv/Scripts/python.exe" ]; then
    exec "$root/.venv/Scripts/python.exe" "$gate"
elif [ -x "$root/.venv/bin/python" ]; then
    exec "$root/.venv/bin/python" "$gate"
else
    echo "这棵树没有自己的 venv：$root/.venv" >&2
    echo "用 .claude/tools/worktree.py new <id> 建树会连 venv 一起建好。" >&2
    exit 1
fi
"""


def hooks_dir() -> Path:
    """共享的 `.git/hooks`，问 git 要，不自己拼。

    `--git-path` 在 worktree 里给的是**主仓**那一份 —— 这正是「装一次覆盖所有树」
    的来源。自己用 `root / ".git" / "hooks"` 拼会在 worktree 里拼到
    `.git` 那个**文件**（不是目录）上，装到一个不存在的地方还以为装好了。
    """

    done = subprocess.run(
        [git_exe(), "rev-parse", "--git-path", "hooks"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
    )
    if done.returncode != 0 or not done.stdout.strip():
        raise SystemExit("git rev-parse --git-path hooks 没有给出 hooks 目录")
    return Path(done.stdout.strip())


def hooks_path_override() -> str | None:
    """`core.hooksPath` 设了就返回它。

    设了这个配置，`.git/hooks` 里的东西**一概不跑** —— 装进去也没用。
    不检查这一条，就会出现「装好了、报告成功、实际上从不触发」，
    而那正是本次要消灭的那种失败。
    """

    done = subprocess.run(
        [git_exe(), "config", "--get", "core.hooksPath"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
    )
    value = done.stdout.strip()
    return value or None


def hook_state(target: Path) -> str | None:
    """`None` = 装好了且是当前版本；否则返回一句「哪里不对」。

    两条都是 codex 2026-09-16 报出来的，两条都会让安装器**给一个 git 不会执行的
    hook 发合格证**：

    1. **按文本比**会把 CRLF 归一成 LF，于是一份被改成 CRLF 的 shim 和原文比出来
       「一样」—— 而 MSYS2 的 sh 读到 `#!/bin/sh\\r` 会报 bad interpreter，
       闸门就这么安静地没了。所以按**字节**比。
    2. **可执行位**没查。Ubuntu 上 git 直接跳过不可执行的 hook，一声不吭 ——
       这正是本卡要消灭的那种失败。
    """

    if not target.is_file():
        return "没有安装"
    if target.read_bytes() != SHIM.encode("utf-8"):
        if not is_ours(target):
            return FOREIGN
        return "内容不是当前版本（可能被改过，或换行被改成了 CRLF）"
    if os.name != "nt" and not os.access(target, os.X_OK):
        return "没有可执行位 —— git 会直接跳过它"
    return None


#: shim 里那行「由 … 生成」的签名。认得出自己写的东西，才谈得上「只覆盖自己写的」。
MARKER = "install_git_hooks.py"

FOREIGN = "已经有一个**不是本工具装的** pre-commit"


def is_ours(target: Path) -> bool:
    try:
        return MARKER in target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def install(check_only: bool = False, force: bool = False) -> int:
    override = hooks_path_override()
    target = hooks_dir() / HOOK_NAME
    if override:
        print(
            f"core.hooksPath 被设成了 {override}，{target} 不会被 git 调用。\n"
            "先 `git config --unset core.hooksPath`，再装。",
            file=sys.stderr,
        )
        return 1

    state = hook_state(target)
    if state is None:
        print(f"已是最新：{target}")
        return 0

    if check_only:
        print(f"pre-commit {state}：{target}", file=sys.stderr)
        return 1

    # 别人的 hook 不动。codex 2026-09-16 报的 P2：直接覆盖会**静默删掉**那个仓库
    # 原有的检查 —— 一个以「闸门不许安静消失」为立论的工具，不能自己去让别的闸门
    # 安静消失。要覆盖必须明说。
    if state == FOREIGN and not force:
        print(
            f"{target} 已经有一个不是本工具装的 pre-commit，不动它。\n"
            "确认可以丢掉它的检查，再加 --force。",
            file=sys.stderr,
        )
        return 1

    target.parent.mkdir(parents=True, exist_ok=True)
    # 换行必须是 LF：Windows 上 git 用 MSYS2 sh 跑它，CRLF 会让 shebang 带上
    # 一个 \r，报 "bad interpreter"。写字节，连「文本模式会不会翻译换行」这个
    # 问题都不给它留（`newline=""` 也行，但字节写不需要读者去记那条规则）。
    target.write_bytes(SHIM.encode("utf-8"))
    target.chmod(0o755)

    # 写完再验一次。安装器唯一的职责就是「装对」，所以它不能靠「我刚写过」自信 ——
    # 前面那两条缺陷恰恰都是「以为装对了」。
    residual = hook_state(target)
    if residual is not None:
        print(f"装完仍然不对（{residual}）：{target}", file=sys.stderr)
        return 1
    print(f"安装完成：{target}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="装 git 原生 pre-commit 闸门")
    ap.add_argument(
        "--check",
        action="store_true",
        help="只报告状态，没装好或不是当前版本就退出非零",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="覆盖一个不是本工具装的 pre-commit（会丢掉它原有的检查）",
    )
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    return install(check_only=args.check, force=args.force)


if __name__ == "__main__":
    raise SystemExit(main())
