"""L5 队列：在**已授权**的候选里自动取下一项（TASK-148 切片 C）。

三条设计约束，每条都对应一个「不这么做会怎样」：

1. **授权池 fail-closed，默认空。** 一张卡必须自己写明被授权了，才进池。
   不把所有 `active/` 卡视为可自动实施，也不把建议当批准（任务书原文）。
   错误方向的自动实施，代价远高于多标一次。
2. **授权写在卡上，不做第二份名单。** 名单会和卡漂移，而漂移的那一刻，
   「谁被授权了」就有了两个答案。TASK-143 的 OUT OF SCOPE 已经写死不造第二份状态。
3. **队列的状态就是 L5 台账**（`l5_ledger.py`）。批次计数、重试次数、停止条件
   全从事件流里现算 —— 同一个理由：不造会撒谎的第二份。

卡上的授权行长这样（**必须带依据**，空依据不算授权）：

    - L5 自动实施授权：产品负责人 2026-09-17「这批你自己做完」

闸在前面：**L5 台账未达标时，`next` 一律拒绝**。这不是提醒，是拒绝 —— 否则
「先跑起来再说」会让整套度量变成装饰。
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

#: 卡上的授权行。**冒号后面必须有字**（依据），否则不算授权 —— 一个没有依据的
#: 「授权」就是把「我觉得可以」写成了别人的决定。
AUTHORIZED = re.compile(r"^-\s*L5\s*自动实施授权\s*[：:]\s*(?P<reason>\S.*)$", re.M)

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
    """池子里的卡：`(任务号, 授权依据, 路径)`，按任务号排序。

    只扫 `backlog/` 与 `active/` —— `done/` 里的卡按定义已经做完了
    （目录即状态，ADR-0083）。
    """

    root = root or repo_root()
    found: list[tuple[str, str, Path]] = []
    for folder in ("backlog", "active"):
        directory = root / "docs" / "tasks" / folder
        if not directory.is_dir():
            continue
        for card in sorted(directory.glob("TASK-*.md")):
            match = AUTHORIZED.search(
                card.read_text(encoding="utf-8", errors="replace")
            )
            if match:
                task = card.name.split("-")[0] + "-" + card.name.split("-")[1]
                found.append((task, match.group("reason").strip(), card))
    return sorted(found)


def batch_state(root: Path) -> tuple[int, str | None, dict[str, int]]:
    """`(本批已开工几个, 生效中的停止理由, 每个任务重试了几次)`，全部从台账现算。

    「本批」= 最后一个 `batch` 事件之后。没有 `batch` 事件时，整条台账算一批 ——
    偏严的那一侧：宁可早点拒绝，也不要在没划批次的情况下无限发牌。
    """

    events = l5_ledger.read(root)
    cut = 0
    for index, event in enumerate(events):
        if event.get("event") == "batch":
            cut = index + 1
    recent = events[cut:]

    started = sum(1 for e in recent if e.get("event") == "start")
    stop: str | None = None
    retries: dict[str, int] = {}
    for event in recent:
        if event.get("event") == "stop":
            stop = str(event.get("reason", "?"))
        elif event.get("event") == "retry":
            retries[str(event["task"])] = retries.get(str(event["task"]), 0) + 1
    return started, stop, retries


def refusal(root: Path) -> str | None:
    """现在能不能发下一张牌？不能就返回一句为什么。"""

    report = l5_ledger.render(root)
    if "判词：**达标**" not in report:
        return (
            "L5 台账**未达标**，队列不开。\n"
            "跑 `python .claude/tools/l5_ledger.py report` 看差哪一条。\n"
            "—— 达标是开放有限 L5 的条件；先跑起来再补度量，等于让度量变成装饰。"
        )

    started, stop, _ = batch_state(root)
    if stop:
        return f"本批已停止（{stop}）。要继续先划新批次：`l5_queue.py batch`。"
    if started >= BATCH_LIMIT:
        return (
            f"本批已经开工 {started} 个，上限 {BATCH_LIMIT}（任务书 §6）。\n"
            "停下来报告，等下一批。"
        )
    return None


def record_retry(root: Path, task: str, reason: str) -> str | None:
    """记一次重试；到上限就返回拒绝理由，什么都不写。

    逻辑住在这里而不是 `main()` 里，所以测试可以对着临时仓库验它 —— 对着
    `main()` 验会写进**真仓库**的台账（自测时当场撞到）。
    """

    _started, _stop, retries = batch_state(root)
    done = retries.get(task, 0)
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


def next_task(root: Path) -> tuple[str, str] | None:
    """下一张该做的卡，没有就 `None`。已经开过工的不再发。"""

    events = l5_ledger.read(root)
    seen = {str(e["task"]) for e in events if e.get("event") == "start"}
    for task, reason, _path in candidates(root):
        if task not in seen:
            return task, reason
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="L5 队列：在已授权的候选里取下一项")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="池子里有哪些卡（授权写在卡上）")
    sub.add_parser("next", help="下一项 —— 未达标 / 到上限 / 已停止时拒绝")
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
                "这是**默认状态**，不是故障 —— 一张卡要进池，得在卡上写明：\n"
                "    - L5 自动实施授权：<依据>\n"
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
        event = {
            "event": "stop",
            "task": "-",
            "at": l5_ledger.now(),
            "reason": args.reason,
        }
        if args.note:
            event["note"] = args.note
        l5_ledger.append(event, root)
        sys.stdout.write(f"本批停止：{args.reason}\n")
        return 0

    # next
    why = refusal(root)
    if why:
        sys.stderr.write(why + "\n")
        return 1
    picked = next_task(root)
    if picked is None:
        sys.stderr.write("授权池里没有还没开工的卡 —— 队列结束。\n")
        return 1
    task, reason = picked
    sys.stdout.write(f"{task}\n授权依据：{reason}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
