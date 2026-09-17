"""L5 队列：在**已授权且已过里程碑闸**的候选里自动取下一项（TASK-148 切片 C）。

## 授权只是两道闸里的一道

任务书原文是「只从**已授权**、**通过当前里程碑闸**的任务中自动串行取下一项」。
授权是用户给的，里程碑闸是 AGENTS.md §2 那四问的结论 —— 两者不是一回事，
第一版只查了前者（codex 2026-09-17）。

第二道闸不需要新机制，仓库里已经有了：**目录即状态**（ADR-0083）。
`backlog/` 的定义就是「里程碑闸判现在不做」，`active/` 才是在办。所以

    候选 = `active/` 里带授权行的卡

要把一张 backlog 卡放进来，正确动作是 `git mv` 进 `active/` —— 那正是「重新过闸」
这个决定本身，而不是让队列去替它判。

## 授权写在卡上，不做第二份名单

    - L5 自动实施授权：产品负责人 2026-09-17「这批你自己做完」

**依据必须和冒号在同一行**。第一版的正则用 `\\s*` 吃掉了换行，于是一个空授权行
会把**下一行**认成依据 —— 一张没授权的卡就这么进了池。

## 串行、留痕、可停

- `next` 成功时写一条 `dispatch`：发出去的牌要算进本批上限，也要挡住重复发同一张。
  不留痕的发牌等于没有上限（codex 2026-09-17）。
- **手上那张没有结论之前，不发下一张** —— 任务书要的是「串行取下一项」。
- 池子空了记 `stop(queue-done)`，否则「队列结束」之后新加一张卡就能让同一批
  死而复生。
- 重试次数**跨批累计**：同一个外部失败不会因为划了新批次就重新拿到两次机会。
  停止生效期间一律不许重试。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import l5_ledger  # noqa: E402

#: 卡上的授权行。`[ \t]*` 而**不是** `\s*` —— 后者吃换行，会把下一行认成依据。
#: 冒号后面必须当场有字：一个没有依据的「授权」就是把「我觉得可以」写成别人的决定。
AUTHORIZED = re.compile(
    r"^-[ \t]*L5[ \t]*自动实施授权[ \t]*[：:][ \t]*(?P<reason>\S[^\r\n]*)$", re.M
)

#: 从文件名取任务号：`TASK-148-xxx.md` → `TASK-148`。切片会被 `-` 的个数骗到，
#: 所以用正则锚住形状。
TASK_ID = re.compile(r"^(?P<id>TASK-\d+)\b")

#: 一批最多几个（任务书 §6：先限制为一批最多 3 个任务）。
BATCH_LIMIT = 3

#: 同一外部失败最多重试几次（任务书 §6：初期最多 2 次，无进展则保存状态并报告）。
RETRY_LIMIT = 2

#: 停止条件（任务书 §6 原文五条）。
STOP_REASONS = (
    "queue-done",  # 队列结束
    "user-stop",  # 用户停止
    "permission-denied",  # 权限拒绝
    "quota",  # 配额耗尽
    "unauthorized-spend",  # 未授权花费 —— AGENTS.md §1 唯一必须问的那件事
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def candidates(root: Path | None = None) -> list[tuple[str, str, Path]]:
    """池子里的卡：`(任务号, 授权依据, 路径)`。

    **只扫 `active/`** —— 见模块注释第一节：`backlog/` 的定义就是里程碑闸判
    「现在不做」，`done/` 按定义已经做完了（ADR-0083 目录即状态）。
    """

    root = root or repo_root()
    directory = (root or repo_root()) / "docs" / "tasks" / "active"
    found: list[tuple[str, str, Path]] = []
    if not directory.is_dir():
        return found
    for card in sorted(directory.glob("TASK-*.md")):
        name = TASK_ID.match(card.name)
        if not name:
            continue
        match = AUTHORIZED.search(card.read_text(encoding="utf-8", errors="replace"))
        if match:
            found.append((name.group("id"), match.group("reason").strip(), card))
    return sorted(found)


def batch_state(root: Path) -> tuple[int, str | None]:
    """`(本批已发几张, 生效中的停止理由)`。

    「本批」= 最后一个 `batch` 事件之后。没有 `batch` 事件时，整条台账算一批 ——
    偏严的那一侧：宁可早点拒绝，也不要在没划批次的情况下无限发牌。
    """

    events = l5_ledger.read(root)
    cut = 0
    for index, event in enumerate(events):
        if event.get("event") == "batch":
            cut = index + 1
    recent = events[cut:]

    dispatched = sum(1 for e in recent if e.get("event") == "dispatch")
    stop: str | None = None
    for event in recent:
        if event.get("event") == "stop":
            stop = str(event["reason"])
    return dispatched, stop


def retries_for(root: Path, task: str) -> int:
    """同一个任务**跨批**累计的重试次数。

    按批清零会让「划个新批次」变成刷新重试额度的办法 —— 而外部失败不会因为我们
    换了批次就变好。
    """

    return sum(
        1
        for e in l5_ledger.read(root)
        if e.get("event") == "retry" and str(e["task"]) == task
    )


def unfinished_dispatch(root: Path) -> str | None:
    """手上那张还没有结论的牌（发过、既没交付也没被外部挡住）。"""

    events = l5_ledger.read(root)
    table = l5_ledger.rows(events)
    for event in reversed(events):
        if event.get("event") != "dispatch":
            continue
        task = str(event["task"])
        row = table.get(task)
        if row and (row.finished or row.blocks):
            return None
        return task
    return None


def refusal(root: Path) -> str | None:
    """现在能不能发下一张牌？不能就返回一句为什么。"""

    status = l5_ledger.gate_status(root)
    if not status.met:
        missing = "；".join(text for ok, text in status.checks if not ok)
        return (
            f"L5 台账**未达标**：{missing}。\n"
            "跑 `python .claude/tools/l5_ledger.py report` 看全貌。\n"
            "—— 达标是开放有限 L5 的条件；先跑起来再补度量，等于让度量变成装饰。"
        )

    dispatched, stop = batch_state(root)
    if stop:
        return f"本批已停止（{stop}）。要继续先划新批次：`l5_queue.py batch`。"
    running = unfinished_dispatch(root)
    if running:
        return (
            f"{running} 还没有结论，**串行**取下一项意味着先把它做完或记下阻塞。\n"
            "（`l5_ledger.py finish <任务> --evidence ...` 或 `block --reason ...`）"
        )
    if dispatched >= BATCH_LIMIT:
        return (
            f"本批已经发出 {dispatched} 张，上限 {BATCH_LIMIT}（任务书 §6）。\n"
            "停下来报告，等下一批。"
        )
    return None


def record_retry(root: Path, task: str, reason: str) -> str | None:
    """记一次重试；到上限或已停止就返回拒绝理由，**什么都不写**。

    逻辑住在这里而不是 `main()` 里，所以测试可以对着临时仓库验它 —— 对着
    `main()` 验会写进**真仓库**的台账（自测时当场撞到，残留还被审查者看见了）。
    """

    _dispatched, stop = batch_state(root)
    if stop:
        return f"本批已停止（{stop}），不许重试。保存状态并报告。"
    done = retries_for(root, task)
    if done >= RETRY_LIMIT:
        return (
            f"{task} 已经重试 {done} 次，上限 {RETRY_LIMIT}（任务书 §6）。\n"
            "保存状态并报告，不要继续试。"
        )
    l5_ledger.append(
        {"event": "retry", "task": task, "at": l5_ledger.now(), "reason": reason},
        root,
    )
    return None


def record_stop(root: Path, reason: str, note: str = "") -> None:
    event = {"event": "stop", "task": "-", "at": l5_ledger.now(), "reason": reason}
    if note:
        event["note"] = note
    l5_ledger.append(event, root)


def take_next(root: Path) -> tuple[str, str] | str:
    """发一张牌并留痕，或者返回一句为什么不发。

    池子空了会**记下 `queue-done`** —— 不记的话，「队列结束」之后新加一张卡就能让
    同一批死而复生。
    """

    why = refusal(root)
    if why:
        return why

    events = l5_ledger.read(root)
    seen = {str(e["task"]) for e in events if e.get("event") in ("dispatch", "start")}
    for task, reason, _path in candidates(root):
        if task not in seen:
            l5_ledger.append(
                {"event": "dispatch", "task": task, "at": l5_ledger.now()}, root
            )
            return task, reason

    record_stop(root, "queue-done")
    return "授权池里没有还没开工的卡 —— 队列结束（已记 queue-done）。"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="L5 队列：在已授权的候选里取下一项")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="池子里有哪些卡（active/ 里带授权行的）")
    sub.add_parser("next", help="下一项 —— 未达标 / 手上有活 / 到上限 / 已停止时拒绝")
    sub.add_parser("batch", help="划一个新批次（清掉上一批的计数与停止）")
    p = sub.add_parser("retry", help="记一次外部失败重试")
    p.add_argument("task")
    p.add_argument("--reason", required=True)
    p = sub.add_parser("stop", help="停止本批")
    p.add_argument("--reason", choices=STOP_REASONS, required=True)
    p.add_argument("--note", default="")

    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    root = repo_root()

    if args.cmd == "list":
        pool = candidates(root)
        if not pool:
            sys.stdout.write(
                "授权池是空的。\n"
                "这是**默认状态**，不是故障 —— 一张卡要进池，得同时满足两条：\n"
                "  1. 它在 docs/tasks/active/（里程碑闸放行过）\n"
                "  2. 卡上写明：- L5 自动实施授权：<依据>\n"
            )
            return 0
        for task, reason, path in pool:
            sys.stdout.write(f"{task}  {reason}  ({path.name})\n")
        return 0

    if args.cmd == "batch":
        l5_ledger.append({"event": "batch", "task": "-", "at": l5_ledger.now()}, root)
        sys.stdout.write("新批次开始。\n")
        return 0

    if args.cmd == "retry":
        why = record_retry(root, args.task, args.reason)
        if why:
            sys.stderr.write(why + "\n")
            return 1
        sys.stdout.write(f"记下了：retry {args.task}\n")
        return 0

    if args.cmd == "stop":
        record_stop(root, args.reason, args.note)
        sys.stdout.write(f"本批停止：{args.reason}\n")
        return 0

    picked = take_next(root)
    if isinstance(picked, str):
        sys.stderr.write(picked + "\n")
        return 1
    task, reason = picked
    sys.stdout.write(f"{task}\n授权依据：{reason}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
