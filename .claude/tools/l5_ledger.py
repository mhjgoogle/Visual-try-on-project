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

**记的是推不出来的那些**：工程介入（只有当事人知道用户是不是催了）、外部阻塞的
理由、质量事故、产品反馈与付费决定（**分开记，不算工程介入**）、用量。

## 三条 fail-closed 的立场

1. **窗口是「连续开工的 5 个」，不是「挑出来的 5 个成功」。** 在办的、被放弃的、
   被介入过的，全都留在窗口里并算作**不自主** —— 否则五个精选成功就能在一堆失败
   中间开出 L5（codex 2026-09-17 报的第一条）。代价是：手上还有在办任务时闸就不
   达标。**那不是噪声，那是实话** —— 还没做完的事不能算成功。
2. **质量事故不看任务有没有结论。** 串改就是串改，不因为那张卡还没收口而不算。
3. **坏行拒绝出数**，不跳过。缺字段也算坏行 —— 一条缺 `kind` 的质量事件会被读成
   `"?"` 然后逃出致命清单（同一轮报出的另一条）。

用法：

    python .claude/tools/l5_ledger.py start TASK-149 --note "..."
    python .claude/tools/l5_ledger.py intervene TASK-149 --kind continue --text "..."
    python .claude/tools/l5_ledger.py feedback TASK-149 --text "这个界面我不喜欢"
    python .claude/tools/l5_ledger.py spend TASK-149 --text "批准调用付费 API"
    python .claude/tools/l5_ledger.py usage TASK-149 --amount "1.2M tokens"
    python .claude/tools/l5_ledger.py block TASK-149 --reason "CI 配额耗尽"
    python .claude/tools/l5_ledger.py quality TASK-149 --kind swept-others --note "..."
    python .claude/tools/l5_ledger.py finish TASK-149 --evidence "tooling 505 passed"
    python .claude/tools/l5_ledger.py report
"""

from __future__ import annotations

import argparse
import contextlib
import json
import shutil
import subprocess
import sys
import threading
import time
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

LEDGER = Path("docs") / "l5-pilot-ledger.jsonl"

#: 工程介入的四种形状。**产品反馈与付费决定不在其中** —— 任务书要求分开记：
#: 用户说「这个界面我不喜欢」不是自主性失败，用户说「继续」才是。
INTERVENTION_KINDS = ("continue", "order", "command", "fix")

#: 质量事故。四条都来自本仓库真实付过的账，不是想象出来的分类。
QUALITY_KINDS = (
    "wrong-merge",  # 合错了
    "swept-others",  # 把别人的改动带进了我的提交
    "invalid-evidence",  # 失效证据被当成有效结论接受
    "post-delivery-defect",  # 交付之后才暴露的缺陷
)

#: 每种事件**必须**带哪些字段。缺了就是坏行 —— 见模块注释第 3 条。
REQUIRED: dict[str, tuple[str, ...]] = {
    "start": (),
    "finish": ("evidence",),
    "intervene": ("kind",),
    "feedback": (),
    "spend": (),
    "usage": ("amount",),
    "block": ("reason",),
    "quality": ("kind",),
    "resume": (),
    "retry": ("reason",),
    "dispatch": (),
    "batch": (),
    "stop": ("reason",),
}

#: 取值受限的字段。写错一个词就不该被默默收下。
ENUMS = {"intervene": ("kind", INTERVENTION_KINDS), "quality": ("kind", QUALITY_KINDS)}


def repo_root() -> Path:
    """从脚本自身位置定根，所以可以从任何子目录调用（TASK-131 起的纪律）。"""

    return Path(__file__).resolve().parents[2]


def ledger_path(root: Path | None = None) -> Path:
    return (root or repo_root()) / LEDGER


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


#: 拿锁最多等多久。等不到就**抛**，不是「那就不加锁写吧」——
#: 后者正是会丢事件的那条路。
LOCK_TIMEOUT = 10.0


#: 本进程当前持有的锁（路径 → 嵌套深度）。锁做成**可重入**，是为了让调用方能把
#: 「读台账 → 做判断 → 落账」整段包起来 —— 只给写加锁挡不住「两个 `next` 同时通过
#: 检查、再各自发一张牌」（codex 2026-09-17 轮 2）。
#: 线程局部：跨进程那一半由下面的 `mkdir` 负责。
_HELD = threading.local()


@contextlib.contextmanager
def transaction(root: Path | None = None) -> Iterator[None]:
    """把一整段「读 → 判断 → 写」变成原子的。

    没有它，每一条上限都只是**建议**：检查通过之后、落账之前，别人可以插进来。
    批次上限、重试上限、停止状态，三条全是这个形状。
    """

    with _locked(ledger_path(root)):
        yield


@contextlib.contextmanager
def _locked(path: Path) -> Iterator[None]:
    """用 `mkdir` 做的跨进程锁。

    为什么不是「`a` 模式单次写就够原子」：**实测不够**。四个线程各写 20 条，
    读回来只有 76 条 —— 丢了 4 条（2026-09-17，codex 点名让查并发时撞到）。
    Python 的缓冲文本层在追加模式下不保证跨进程的读-改-写原子性，Windows CRT 的
    `_O_APPEND` 也是先 seek 再 write。

    `mkdir` 在 POSIX 与 NTFS 上都是原子的「存在即失败」，所以它是本仓库能用的
    最便宜、且**不需要平台专属 syscall** 的互斥（AGENTS.md §3）。
    这不是 TASK-143 禁的那种「锁服务」—— 没有进程、没有守护、没有中央协调，
    只是一个目录。
    """

    depth: dict[str, int] = getattr(_HELD, "depth", None) or {}
    _HELD.depth = depth
    key = str(path)
    if depth.get(key):
        # 已经持有：直接放行。不可重入的话，`transaction()` 里再调 `append()`
        # 会把自己锁死 —— 而那正是我们要的用法。
        depth[key] += 1
        try:
            yield
        finally:
            depth[key] -= 1
        return

    lock = path.with_suffix(path.suffix + ".lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + LOCK_TIMEOUT
    while True:
        try:
            lock.mkdir()
            break
        except (FileExistsError, PermissionError):
            # `PermissionError` 不是权限问题，是 **Windows 的删除挂起**：
            # 上一个持有者刚 `rmdir`，NTFS 把目录标成 delete-pending，这期间
            # 同名 `mkdir` 返回 ERROR_ACCESS_DENIED 而不是「已存在」。
            # 只认 `FileExistsError` 的版本会在并发下把这条异常抛给调用方，
            # 表现成「丢了几条事件」（2026-09-17 在 `-n 8` 整域跑里实测到；
            # 单跑不复现 —— 这正是 AGENTS.md §2 说 Windows 是裁决者的那类差异）。
            if time.monotonic() > deadline:
                raise TimeoutError(f"{LOCK_TIMEOUT}s 内拿不到台账锁：{lock}") from None
            time.sleep(0.005)
    depth[key] = 1
    try:
        yield
    finally:
        depth[key] = 0
        try:
            lock.rmdir()
        except OSError:
            pass


def append(event: dict, root: Path | None = None) -> None:
    path = ledger_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False, sort_keys=True)
    # **只追加** —— 台账要当证据，就不能被自己改写。
    with _locked(path), open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line + "\n")


class Corrupt(Exception):
    """台账里有读不动的行。拒绝出数，而不是跳过它。"""


def validate(event: dict, where: str) -> None:
    if not isinstance(event, dict):
        raise Corrupt(f"{where} 不是一个事件")
    for key in ("event", "task", "at"):
        if not event.get(key):
            raise Corrupt(f"{where} 缺 {key}")
    name = str(event["event"])
    if name not in REQUIRED:
        raise Corrupt(f"{where} 不认识的事件：{name}")
    for key in REQUIRED[name]:
        if not event.get(key):
            raise Corrupt(f"{where} 的 {name} 缺 {key}")
    if name in ENUMS:
        key, allowed = ENUMS[name]
        if event.get(key) not in allowed:
            raise Corrupt(
                f"{where} 的 {name}.{key} 不在 {allowed} 里：{event.get(key)}"
            )


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
        validate(event, f"{path}:{number}")
        events.append(event)
    return events


@dataclass
class TaskRow:
    task: str
    started: str | None = None
    finished: str | None = None
    interventions: int = 0
    intervention_kinds: Counter = field(default_factory=Counter)
    blocks: list[str] = field(default_factory=list)
    quality: list[str] = field(default_factory=list)
    feedback: int = 0
    spend: int = 0
    usage: list[str] = field(default_factory=list)
    resumed: bool = False

    @property
    def autonomous(self) -> bool:
        """零工程介入 **且** 真的交付了 **且** 没有质量事故。

        没交付的不算 —— 否则「开了个头就放着」会被算成满分。
        有质量事故的也不算 —— 串了别人的改动还叫自主完成，那是自欺。
        """

        return (
            self.finished is not None and self.interventions == 0 and not self.quality
        )

    @property
    def state(self) -> str:
        if self.finished:
            return "已交付"
        if self.blocks:
            return "外部阻塞"
        return "**在办**"

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
        return f"{int(delta.total_seconds() // 60)} 分钟"


def rows(events: list[dict]) -> dict[str, TaskRow]:
    table: dict[str, TaskRow] = {}
    for event in events:
        task = str(event["task"])
        row = table.setdefault(task, TaskRow(task=task))
        name = event.get("event")
        if name == "start" and row.started is None:
            row.started = event.get("at")
        elif name == "finish":
            row.finished = event.get("at")
        elif name == "intervene":
            row.interventions += 1
            row.intervention_kinds[str(event["kind"])] += 1
        elif name == "feedback":
            row.feedback += 1  # 产品反馈：**单独计**，不算工程介入
        elif name == "spend":
            row.spend += 1  # 付费决定：同上
        elif name == "usage":
            row.usage.append(str(event["amount"]))
        elif name == "block":
            row.blocks.append(str(event["reason"]))
        elif name == "quality":
            row.quality.append(str(event["kind"]))
        elif name == "resume":
            row.resumed = True
    return table


def reverts_since(root: Path, count: int = 200) -> list[str] | None:
    """交付后被回退的提交 —— **现查 Git，不记进台账**（记了就会过期）。

    `None` = **问不到**（没有 git，或 git 报错），不是「没有」。
    早先这两种都返回空列表，于是报告把「取不到证据」显示成「无事故」——
    质量这一项因此在最不该乐观的时候最乐观（codex 2026-09-17 轮 2）。
    """

    git = shutil.which("git")
    if git is None:
        return None
    done = subprocess.run(
        [git, "log", f"-{count}", "--format=%h %s"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if done.returncode != 0:
        return None
    return [
        line
        for line in done.stdout.splitlines()
        if line.split(" ", 1)[-1].lower().startswith(("revert", "回退"))
    ]


#: L5 的开放条件（任务书 §6）。
WINDOW = 5
NEEDED_AUTONOMOUS = 4
FATAL_QUALITY = ("wrong-merge", "swept-others", "invalid-evidence")


@dataclass
class GateStatus:
    """闸的结论，**结构化**。

    早先 `l5_queue` 是拿「报告文本里有没有『达标』这四个字」判闸的 —— 于是一条
    外部阻塞理由里只要写上那四个字，闸就开了（codex 2026-09-17）。判词是数据，
    不是排版；文本由它生成，反过来不行。
    """

    met: bool
    checks: list[tuple[bool, str]]
    window: list[TaskRow]
    in_flight: list[TaskRow]


def gate_status(root: Path) -> GateStatus:
    table = rows(read(root))
    started = sorted(
        (r for r in table.values() if r.started), key=lambda r: r.started or ""
    )
    # **连续开工的最后 5 个**，不是挑出来的 5 个成功。在办与被放弃的都留在窗口里。
    window = started[-WINDOW:]

    autonomous = sum(1 for r in window if r.autonomous)
    # 质量事故**不看结论**：串改就是串改，不因为那张卡还没收口而不算。
    fatal = [q for r in window for q in r.quality if q in FATAL_QUALITY]
    checks = [
        (len(window) >= WINDOW, f"连续 {WINDOW} 个真实任务（现在 {len(window)}）"),
        (
            autonomous >= NEEDED_AUTONOMOUS,
            f"其中至少 {NEEDED_AUTONOMOUS} 个零工程介入且已交付（现在 {autonomous}）",
        ),
        (any(r.resumed for r in window), "至少一次跨会话恢复成功"),
        (not fatal, f"零串改、零错误放行（现在 {len(fatal)} 条）"),
    ]
    return GateStatus(
        met=all(ok for ok, _ in checks),
        checks=checks,
        window=window,
        in_flight=[r for r in window if not (r.finished or r.blocks)],
    )


def render(root: Path) -> str:
    status = gate_status(root)
    out: list[str] = ["# L5 试点度量", ""]

    if not status.window:
        out += [
            "台账是空的 —— **一个试点样本都还没有**。",
            "",
            f"L5 的开放条件是连续 {WINDOW} 个真实任务里至少 {NEEDED_AUTONOMOUS} 个"
            "零工程介入，现在离达标不是差一点，是还没开始记。",
        ]
        return "\n".join(out) + "\n"

    out += [
        "| 任务 | 状态 | 耗时 | 工程介入 | 产品反馈 | 付费决定 | 质量事故 | 自主完成 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in status.window:
        kinds = (
            "·".join(f"{k}×{n}" for k, n in sorted(row.intervention_kinds.items()))
            or "0"
        )
        out.append(
            f"| {row.task} | {row.state} | {row.duration} | {kinds} | "
            f"{row.feedback} | {row.spend} | {'·'.join(row.quality) or '无'} | "
            f"{'是' if row.autonomous else '否'} |"
        )

    autonomous = sum(1 for r in status.window if r.autonomous)
    out += ["", "## 自主完成率", ""]
    # 外部阻塞**留在分母里**，理由单列（任务书原文）—— 把被阻塞的任务从分母里拿掉，
    # 完成率就永远好看。在办的同样留在分母里，见模块注释第 1 条。
    out.append(
        f"- {autonomous} / {len(status.window)}（分母是连续开工的那些，一个不减）"
    )
    for row in status.window:
        for reason in row.blocks:
            out.append(f"  - {row.task} 外部阻塞：{reason}")
    for row in status.in_flight:
        out.append(f"  - {row.task} 仍在办，按「不自主」计")

    # **逐个任务列。** 早先是把窗口里所有用量拼成一张表，于是只要有**一个**任务
    # 记了，「未知」那句就整体消失 —— 其余任务缺用量这件事被一条记录盖住了
    # （codex 2026-09-17 轮 2）。缺失要按任务显示，不能被别人的记录代表。
    out += ["", "## 用量", ""]
    for row in status.window:
        shown = "·".join(row.usage) if row.usage else "**未知**"
        out.append(f"- {row.task}：{shown}")
    if any(not r.usage for r in status.window):
        out.append("")
        out.append("「未知」就是没取到，**不把估算当账单**。")

    reverts = reverts_since(root)
    out += ["", "## 交付后回退（现查 Git，不记台账）", ""]
    if reverts is None:
        # 「问不到」不是「没有」。
        out.append("- **取不到** —— git 不可用或查询失败，这一项没有证据。")
    else:
        out += [f"- {line}" for line in reverts] or ["- 无"]

    out += ["", "## L5 闸", ""]
    for ok, text in status.checks:
        out.append(f"- {'✅' if ok else '❌'} {text}")
    out += ["", f"判词：{'**达标**' if status.met else '**未达标**'}。"]
    if not status.met:
        out += [
            "",
            "小样本不能证明长期收益 —— 达标只是开放**有限** L5 的条件，不是结论。",
        ]
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="L5 试点台账（append-only）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("start", help="一个试点任务开始")
    p.add_argument("task")
    p.add_argument("--note", default="")

    p = sub.add_parser(
        "intervene", help="工程介入（用户为继续/排序/命令/修复补发消息）"
    )
    p.add_argument("task")
    p.add_argument("--kind", choices=INTERVENTION_KINDS, required=True)
    p.add_argument("--text", default="")

    p = sub.add_parser("feedback", help="产品反馈 —— **分开记**，不算工程介入")
    p.add_argument("task")
    p.add_argument("--text", default="")

    p = sub.add_parser("spend", help="付费决定 —— **分开记**，不算工程介入")
    p.add_argument("task")
    p.add_argument("--text", default="")

    p = sub.add_parser("usage", help="实测用量（取不到就别记，不要写估算）")
    p.add_argument("task")
    p.add_argument("--amount", required=True)

    p = sub.add_parser("block", help="外部阻塞（留在分母里，理由单列）")
    p.add_argument("task")
    p.add_argument("--reason", required=True)

    p = sub.add_parser("quality", help="质量事故")
    p.add_argument("task")
    p.add_argument("--kind", choices=QUALITY_KINDS, required=True)
    p.add_argument("--note", default="")

    p = sub.add_parser("resume", help="跨会话恢复成功")
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
    for name in ("note", "text", "reason", "evidence", "kind", "amount"):
        value = getattr(args, name, None)
        if value:
            event[name] = value
    validate(event, "要写的这条")
    append(event, root)
    sys.stdout.write(f"记下了：{args.cmd} {args.task}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
