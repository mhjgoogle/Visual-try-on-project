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
import subprocess
import sys
from pathlib import Path

HOOK_NAME = "pre-commit"

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
        ["git", "rev-parse", "--git-path", "hooks"],
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
        ["git", "config", "--get", "core.hooksPath"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
    )
    value = done.stdout.strip()
    return value or None


def install(check_only: bool = False) -> int:
    override = hooks_path_override()
    target = hooks_dir() / HOOK_NAME
    if override:
        print(
            f"core.hooksPath 被设成了 {override}，{target} 不会被 git 调用。\n"
            "先 `git config --unset core.hooksPath`，再装。",
            file=sys.stderr,
        )
        return 1

    current = target.read_text(encoding="utf-8") if target.is_file() else None
    if current == SHIM:
        print(f"已是最新：{target}")
        return 0

    if check_only:
        state = "内容不是当前版本" if current is not None else "没有安装"
        print(f"pre-commit {state}：{target}", file=sys.stderr)
        return 1

    target.parent.mkdir(parents=True, exist_ok=True)
    # 换行必须是 LF：Windows 上 git 用 MSYS2 sh 跑它，CRLF 会让 shebang 带上
    # 一个 \r，报 "bad interpreter"。`newline=""` 让下面写进去的 \n 原样落盘。
    with open(target, "w", encoding="utf-8", newline="") as handle:
        handle.write(SHIM)
    target.chmod(0o755)
    print(f"{'更新' if current is not None else '安装'}完成：{target}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="装 git 原生 pre-commit 闸门")
    ap.add_argument(
        "--check",
        action="store_true",
        help="只报告状态，没装好或不是当前版本就退出非零",
    )
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    return install(check_only=args.check)


if __name__ == "__main__":
    raise SystemExit(main())
