"""任务卡之间的前置边（TASK-149）。

「先做什么」里有一部分是**事实**而不是意见：A 没做完，B 做不了。这一部分不该靠人记。
本工具把卡头那一行 `- 前置：…` 读成边，回答三件事：

- `deps`     全仓有哪些边
- `check`    有没有坏边 —— 悬空（指向不存在的卡）、自指、成环。任一存在即退出非零
- `order`    给一组卡排拓扑序（同层按任务号）
- `blocked`  某张卡还在等谁

## 边只住在卡上

不建 `deps.json`，不给卡加 metadata（ADR-0101 §4）。解析器**去认现有写法**，
不要求人改写 —— TASK-074 那一行写成
`- 前置：[TASK-073](../done/TASK-073-….md) 全部验收通过`，链接、尾注都容忍。

## 「完成」= 卡头状态行写着 `完成`

状态住在卡上（ADR-0105），语法只有 `task_status.py` 一个源；这里只问它 `.done`。

## 坏边 fail-closed

一条没人读的边可以随便写；一条**机器读**的边写错了，必须当场有人知道。所以
`tests/tooling/` 里有一条对着真仓库跑 `check()`，它因此自动进 commit gate 与 CI。
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import task_status  # noqa: E402

#: 卡头的前置行。冒号中英文都行；标签可以包在 `**` 里 —— 仓库里真有
#: `- **前置：TASK-077 …**` 这种写法，只认裸标签的版本会把它**当作没有前置**，
#: 于是依赖它的授权卡能在前置没完成时被发出去（codex 2026-09-17）。
PREREQ_LINE = re.compile(
    r"^-[ \t]*\**[ \t]*前置[ \t]*\**[ \t]*[：:](?P<rest>.*)$", re.M
)

#: 行里所有的任务号。链接文字、链接路径、顿号之间的裸号，一网打尽 —— 再去重。
TASK_ID = re.compile(r"TASK-\d+[A-Z]?")

#: 卡的清单、任务号、状态全部来自 `task_status`（ADR-0105：状态住在卡上）。
#: 这里不再有自己的 `Card` / `cards()`：状态语法只能有一个源。
Card = task_status.Card
cards = task_status.cards


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def prerequisites(path: Path) -> list[str]:
    """一张卡声明的前置，按出现顺序去重。"""

    text = path.read_text(encoding="utf-8", errors="replace")
    seen: list[str] = []
    for line in PREREQ_LINE.finditer(text):
        for task in TASK_ID.findall(line.group("rest")):
            if task not in seen:
                seen.append(task)
    return seen


def edges(root: Path | None = None) -> dict[str, list[str]]:
    """任务号 → 它的前置列表。只包含声明了前置的卡。"""

    table = cards(root)
    return {
        task: deps for task, card in table.items() if (deps := prerequisites(card.path))
    }


def check(root: Path | None = None) -> list[str]:
    """坏边清单。空 = 干净。三种：悬空、自指、成环。"""

    table = cards(root)
    graph = edges(root)
    problems: list[str] = []

    for task, deps in graph.items():
        for dep in deps:
            if dep == task:
                problems.append(f"{task} 把自己列为前置")
            elif dep not in table:
                problems.append(f"{task} 的前置 {dep} 不存在（悬空）")

    for cycle in _cycles(graph):
        problems.append("成环：" + " → ".join(cycle))
    return problems


def _cycles(graph: dict[str, list[str]]) -> list[list[str]]:
    """找环。DFS 三色标记；每个环只报一次。"""

    white, grey, black = 0, 1, 2
    colour: dict[str, int] = defaultdict(int)
    stack: list[str] = []
    found: list[list[str]] = []

    def visit(node: str) -> None:
        colour[node] = grey
        stack.append(node)
        for nxt in graph.get(node, []):
            if colour[nxt] == grey:
                start = stack.index(nxt)
                found.append(stack[start:] + [nxt])
            elif colour[nxt] == white:
                visit(nxt)
        stack.pop()
        colour[node] = black

    for node in sorted(graph):
        if colour[node] == white:
            visit(node)
    return found


def blocked_by(task: str, root: Path | None = None) -> list[str]:
    """*task* 还在等哪些前置。**状态不是 `完成` 的都算在等**，包括不存在的
    （悬空按「等一个永远不会完成的东西」处理 —— fail-closed，`check` 会另外报它）。"""

    table = cards(root)
    card = table.get(task)
    if card is None:
        return []
    return [
        dep
        for dep in prerequisites(card.path)
        if not table.get(dep, None) or not table[dep].done
    ]


def order(tasks: list[str], root: Path | None = None) -> list[str]:
    """给 *tasks* 排拓扑序：前置在前，同层按任务号。

    只考虑 *tasks* 内部的边 —— 指向集合外（比如状态已是 `完成`）的前置不影响排序，
    它们由 `blocked_by` 另行判断「能不能发」。成环则抛出：一个环里没有「先」。
    """

    wanted = set(tasks)
    graph = edges(root)
    inner: dict[str, set[str]] = {
        t: {d for d in graph.get(t, []) if d in wanted and d != t} for t in wanted
    }
    result: list[str] = []
    remaining = dict(inner)
    while remaining:
        ready = sorted(t for t, deps in remaining.items() if not deps)
        if not ready:
            raise ValueError("成环，排不出先后：" + ", ".join(sorted(remaining)))
        result.extend(ready)
        for t in ready:
            del remaining[t]
        for deps in remaining.values():
            deps.difference_update(ready)
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="任务卡之间的前置边")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("deps", help="全仓每条前置边")
    sub.add_parser("check", help="悬空 / 自指 / 成环；任一存在退出非零")
    p = sub.add_parser("order", help="给一组卡排拓扑序")
    p.add_argument("tasks", nargs="+")
    p = sub.add_parser("blocked", help="某张卡还在等谁")
    p.add_argument("task")
    args = ap.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    root = repo_root()
    if args.cmd == "deps":
        graph = edges(root)
        if not graph:
            sys.stdout.write("没有任何卡声明前置。\n")
            return 0
        table = cards(root)
        for task in sorted(graph):
            for dep in graph[task]:
                state = table[dep].state if dep in table else "**不存在**"
                sys.stdout.write(f"{task} ← {dep}  ({state})\n")
        return 0

    if args.cmd == "check":
        problems = check(root)
        for line in problems:
            sys.stderr.write(line + "\n")
        sys.stdout.write(
            "前置边干净。\n" if not problems else f"{len(problems)} 条坏边。\n"
        )
        return 1 if problems else 0

    if args.cmd == "order":
        try:
            for task in order(args.tasks, root):
                sys.stdout.write(task + "\n")
        except ValueError as exc:
            sys.stderr.write(f"{exc}\n")
            return 1
        return 0

    waiting = blocked_by(args.task, root)
    if not waiting:
        sys.stdout.write(f"{args.task} 没有在等的前置。\n")
        return 0
    sys.stdout.write(f"{args.task} 在等：{'、'.join(waiting)}\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
