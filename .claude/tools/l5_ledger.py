"""L5 试点台账：把「自主交付到底行不行」这件事记成可复核的事实（TASK-148 切片 B）。

L5 的开放条件是一组**数字**（任务书 §6，结论提炼在 TASK-148 卡上）：连续 5 个真实
任务、至少 4 个无需工程介入、至少一次跨会话恢复、零串改零错误放行。没有台账，
这些数字只能靠感觉答 —— 而「感觉还行」正是本仓库反复付账的那一类判断。

## 只记推导不出来的东西

能从 Git 和仓库派生的，**一律不记**（记了就是第二份会撒谎的状态，AGENTS.md §24）：

| 事实 | 哪里来 |
| --- | --- |
| 交付耗时 | 事件自己的时间戳 |
| 交付后被回退 | `git log` 里的 revert，`report` 现查 |
| 谁在哪张卡上 | `git worktree list` + 卡头（TASK-147 的 `resume`） |

**记的只有三类推不出来的**：工程介入（只有当事人知道用户是不是催了）、外部阻塞的
理由、质量事故。用量单列 —— 取得到就记，取不到记 `未知`，**不把估算当账单**。

## append-only，且坏行不跳过

一行一个事件，只追加。`report` 读不动某一行时**拒绝出数**而不是跳过它 ——
一份会自己跳过坏行的台账，读起来永远是漂亮的（AGENTS.md §20 fail-closed）。

用法：

    python .claude/tools/l5_ledger.py start TASK-149 --note "..."
    python .claude/tools/l5_ledger.py intervene TASK-149 --kind continue --text "..."
    python .claude/tools/l5_ledger.py block TASK-149 --reason "CI 配额耗尽"
    python .claude/tools/l5_ledger.py quality TASK-149 --kind swept-others --note "..."
    python .claude/tools/l5_ledger.py finish TASK-149 --evidence "tooling 487 passed"
    python .claude/tools/l5_ledger.py report
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

LEDGER = Path("docs") / "l5-pilot-ledger.jsonl"

#: 工程介入的四种形状。产品反馈与付费决定**不在其中** —— 任务书要求分开记：
#: 用户说「这个界面我不喜欢」不是自主性失败，用户说「继续」才是。
INTERVENTION_KINDS = ("continue", "order", "command", "fix")

#: 质量事故。四条都来自本仓库真实付过的账，不是想象出来的分类。
QUALITY_KINDS = (
    "wrong-merge",  # 合错了
    "swept-others",  # 把别人的改动带进了我的提交
    "invalid-evidence",  # 失效证据被当成有效结论接受
    "post-delivery-defect",  # 交付之后才暴露的缺陷
)

EVENTS = ("start", "intervene", "block", "quality", "finish", "resume")


def repo_root() -> Path:
    """从脚本自身位置定根，所以可以从任何子目录调用（TASK-131 起的纪律）。"""

    return Path(__file__).resolve().parents[2]


def ledger_path(root: Path | None = None) -> Path:
    return (root or repo_root()) / LEDGER


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def append(event: dict, root: Path | None = None) -> None:
    path = ledger_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False, sort_keys=True)
    # `a` 模式 + 一次写入。**只追加** —— 台账要能当证据，就不能被自己改写。
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line + "\n")


class Corrupt(Exception):
    """台账里有读不动的行。拒绝出数，而不是跳过它。"""


def read(root: Path | None = None) -> list[dict]:
    path = ledger_path(root)
    if not path.is_file():
        return []
    events: list[dict] = []
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise Corrupt(f"{path}:{number} 读不动：{exc}") from exc
        if not isinstance(event, dict) or "event" not in event or "task" not in event:
            raise Corrupt(f"{path}:{number} 不是一个事件：缺 event 或 task")
        events.append(event)
    return events


@dataclass
class TaskRow:
    task: str
    started: str | None = None
    finished: str | None = None
    interventions: int = 0
    intervention_kinds: Counter | None = None
    blocks: list[str] | None = None
    quality: list[str] | None = None
    resumed: bool = False

    def __post_init__(self) -> None:
        self.intervention_kinds = self.intervention_kinds or Counter()
        self.blocks = self.blocks or []
        self.quality = self.quality or []

    @property
    def autonomous(self) -> bool:
        """零工程介入 **且** 真的交付了。

        没交付的不算自主完成 —— 否则「开了个头就放着」会被算成满分。
        """

        return self.finished is not None and self.interventions == 0

    @property
    def concluded(self) -> bool:
        """有结论了：交付了，或者被外部挡住并记下了理由。

        **正在做的不算。** 窗口只看有结论的任务，否则「手上开着三件」会把前面
        五个真实样本挤出窗口，达标状态跟着在办数量上下跳 —— 那不是度量，是噪声。
        在办的仍然逐行显示（见 `render`），只是不进分母。
        """

        return self.finished is not None or bool(self.blocks)

    @property
    def duration(self) -> str:
        if not (self.started and self.finished):
            return "—"
        try:
            delta = datetime.fromisoformat(self.finished) - datetime.fromisoformat(
                self.started
            )
        except ValueError:
            return "—"
        minutes = int(delta.total_seconds() // 60)
        return f"{minutes} 分钟"


def rows(events: list[dict]) -> dict[str, TaskRow]:
    table: dict[str, TaskRow] = {}
    for event in events:
        task = str(event["task"])
        row = table.setdefault(task, TaskRow(task=task))
        kind = event.get("event")
        if kind == "start" and row.started is None:
            row.started = event.get("at")
        elif kind == "finish":
            row.finished = event.get("at")
        elif kind == "intervene":
            row.interventions += 1
            row.intervention_kinds[str(event.get("kind", "?"))] += 1
        elif kind == "block":
            row.blocks.append(str(event.get("reason", "?")))
        elif kind == "quality":
            row.quality.append(str(event.get("kind", "?")))
        elif kind == "resume":
            row.resumed = True
    return table


def reverts_since(root: Path, count: int = 200) -> list[str]:
    """交付后被回退的提交 —— **现查 Git，不记进台账**（记了就会过期）。"""

    done = subprocess.run(
        ["git", "log", f"-{count}", "--format=%h %s"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if done.returncode != 0:
        return []
    return [
        line
        for line in done.stdout.splitlines()
        if line.split(" ", 1)[-1].lower().startswith(("revert", "回退"))
    ]


#: L5 的开放条件（任务书 §6）。**连续 5 个**真实任务里至少 4 个零介入，
#: 至少一次跨会话恢复，零串改、零错误放行。
WINDOW = 5
NEEDED_AUTONOMOUS = 4
FATAL_QUALITY = ("wrong-merge", "swept-others", "invalid-evidence")


def render(root: Path) -> str:
    events = read(root)
    table = rows(events)
    order = [r for r in table.values() if r.started]
    order.sort(key=lambda r: r.started or "")
    window = [r for r in order if r.concluded][-WINDOW:]
    in_flight = [r for r in order if not r.concluded]

    out: list[str] = ["# L5 试点度量", ""]
    if not order:
        out += [
            "台账是空的 —— **一个试点样本都还没有**。",
            "",
            f"L5 的开放条件是连续 {WINDOW} 个真实任务里至少 {NEEDED_AUTONOMOUS} 个"
            "零工程介入，现在离达标不是差一点，是还没开始记。",
        ]
        return "\n".join(out) + "\n"

    out += [
        "| 任务 | 耗时 | 工程介入 | 外部阻塞 | 质量事故 | 跨会话恢复 | 自主完成 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in window:
        kinds = (
            "·".join(f"{k}×{n}" for k, n in sorted(row.intervention_kinds.items()))
            or "0"
        )
        out.append(
            f"| {row.task} | {row.duration} | {kinds} | "
            f"{len(row.blocks)} | {'·'.join(row.quality) or '无'} | "
            f"{'是' if row.resumed else '否'} | "
            f"{'是' if row.autonomous else '否'} |"
        )

    autonomous = sum(1 for r in window if r.autonomous)
    blocked = [r for r in window if r.blocks]
    fatal = [q for r in window for q in r.quality if q in FATAL_QUALITY]
    resumed = any(r.resumed for r in window)

    out += ["", "## 自主完成率", ""]
    # 外部阻塞**留在分母里**，理由单列（任务书原文）—— 把被阻塞的任务从分母里拿掉，
    # 完成率就永远好看。
    out.append(f"- {autonomous} / {len(window)}（外部阻塞留在分母里，理由见下）")
    for row in blocked:
        for reason in row.blocks:
            out.append(f"  - {row.task}：{reason}")

    if in_flight:
        out += ["", "## 还在做（不进分母，也不算成功）", ""]
        out += [f"- {r.task}（开工 {r.started}）" for r in in_flight]

    out += ["", "## 用量", "", "- **未知** —— 取不到调用量/token，不把估算当账单。"]

    reverts = reverts_since(root)
    out += ["", "## 交付后回退（现查 Git，不记台账）", ""]
    out += [f"- {line}" for line in reverts] or ["- 无"]

    out += ["", "## L5 闸", ""]
    checks = [
        (len(window) >= WINDOW, f"连续 {WINDOW} 个真实任务（现在 {len(window)}）"),
        (
            autonomous >= NEEDED_AUTONOMOUS,
            f"其中至少 {NEEDED_AUTONOMOUS} 个零工程介入（现在 {autonomous}）",
        ),
        (resumed, "至少一次跨会话恢复成功"),
        (not fatal, f"零串改、零错误放行（现在 {len(fatal)} 条）"),
    ]
    for ok, text in checks:
        out.append(f"- {'✅' if ok else '❌'} {text}")
    verdict = "**达标**" if all(ok for ok, _ in checks) else "**未达标**"
    out += ["", f"判词：{verdict}。"]
    if not all(ok for ok, _ in checks):
        out.append("")
        out.append(
            "小样本不能证明长期收益 —— 达标只是开放**有限** L5 的条件，不是结论。"
        )
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="L5 试点台账（append-only）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("start", help="一个试点任务开始")
    p.add_argument("task")
    p.add_argument("--note", default="")

    p = sub.add_parser(
        "intervene", help="记一次工程介入（用户为继续/排序/命令/修复补发消息）"
    )
    p.add_argument("task")
    p.add_argument("--kind", choices=INTERVENTION_KINDS, required=True)
    p.add_argument("--text", default="")

    p = sub.add_parser("block", help="记一次外部阻塞（留在分母里，理由单列）")
    p.add_argument("task")
    p.add_argument("--reason", required=True)

    p = sub.add_parser("quality", help="记一次质量事故")
    p.add_argument("task")
    p.add_argument("--kind", choices=QUALITY_KINDS, required=True)
    p.add_argument("--note", default="")

    p = sub.add_parser("resume", help="记一次跨会话恢复成功")
    p.add_argument("task")
    p.add_argument("--note", default="")

    p = sub.add_parser("finish", help="交付完成，带证据")
    p.add_argument("task")
    p.add_argument("--evidence", required=True)

    sub.add_parser("report", help="五项度量 + L5 闸判词")

    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    root = repo_root()
    if args.cmd == "report":
        try:
            sys.stdout.write(render(root))
        except Corrupt as exc:
            sys.stderr.write(f"台账坏了，拒绝出数：{exc}\n")
            return 1
        return 0

    event = {"event": args.cmd, "task": args.task, "at": now()}
    for field in ("note", "text", "reason", "evidence", "kind"):
        value = getattr(args, field, None)
        if value:
            event[field] = value
    append(event, root)
    sys.stdout.write(f"记下了：{args.cmd} {args.task}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
