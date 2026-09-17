"""任务卡的状态：**住在卡上，不住在目录里**（ADR-0105 / TASK-150）。

产品负责人 2026-09-17：「我希望 folder 不要分 done 和 active 了。这些能在这个仓库
的任务管理器里面找到现在在进行中的任务。」

于是 `docs/tasks/` 只剩一个平铺目录，每张卡的卡头有一行**机器可读**的状态：

    - 状态：进行中 · <原来那一行的全文>
    - 状态：完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批）
    - 状态：待办

枚举只有三个词：**待办 / 进行中 / 完成**。它们后面可以跟任何散文（「· 原文」），
但枚举词必须**紧跟冒号**出现 —— 这是解析器唯一认的位置，也是 `lifecycle_check`
守的位置：**每张卡必须有，且只有这三个词之一**。

## 为什么这个文件存在

状态的语法只能有**一个**源。早先「目录即状态」时，五个工具各自 `glob("active/…")`；
换成状态行之后，如果五个工具各自写一遍正则，哪天有人把「完成」写成「已完成」，
就会出现三个工具认、两个不认 —— 那正是 ADR-0083 当初要消灭的「多份真相」，
只是换了个地方长出来。所以正则、枚举、读卡函数都在这里，别处只 import。

用法（别处）：

    sys.path.insert(0, str(<repo>/".claude"/"tools"))
    import task_status
    for card in task_status.cards(root).values():
        if card.state == "进行中": ...
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: 三个枚举词。顺序就是生命周期的顺序。
STATES: tuple[str, ...] = ("待办", "进行中", "完成")

#: 卡头的状态行。枚举词紧跟冒号（允许包在 `**` 里）；后面接什么都行。
#: `(?=…|$)` 那一截保证「完成」不会把「完成度」「完成率」这类词的前缀也认成枚举。
#: 字符类里有 `\r`：按**字节**读卡的调用方（`agent_harness._read_text`）拿到的是
#: `\r\n`，而 `$` 只认 `\n` —— 少了它，`**进行中**\r` 在 Windows 工作树上一张都
#: 认不出来，`resume` 会说「没有在办的卡」。文本模式读的调用方看不见这个坑，
#: 所以它藏得住（TASK-150 迁移当天实测）。
STATE_LINE = re.compile(
    r"^-[ \t]*(?:状态|Status)[ \t]*[：:][ \t]*\**(?P<state>待办|进行中|完成)\**"
    r"(?=[ \t\r·（(—\-:：]|$)",
    re.M,
)

#: 任何一条状态行（不管枚举对不对）—— 迁移与诊断用它找到「那一行」。
ANY_STATE_LINE = re.compile(r"^-[ \t]*(?:状态|Status)[ \t]*[：:](?P<rest>.*)$", re.M)

#: 从文件名取任务号：`TASK-148-xxx.md` → `TASK-148`；`TASK-051A-xxx.md` → `TASK-051A`。
#: 字母后缀是仓库里真实存在的写法（051A / 051B），只认 `\d+` 会把它们**两张都漏掉**
#: —— 漏掉的卡在「进行中的有哪些」里静默消失，比重号更糟。
CARD_ID = re.compile(r"^(?P<id>TASK-\d+[A-Z]?)(?=-|\.md$)")

TASKS_DIR = Path("docs") / "tasks"


class MissingState(ValueError):
    """卡上没有合法的状态行。**不猜**：一张没状态的卡在「待办 = 进行中的那些」这类
    查询里会静默消失，而消失比报错糟。"""


@dataclass(frozen=True)
class Card:
    task: str
    state: str
    path: Path

    @property
    def done(self) -> bool:
        return self.state == "完成"

    @property
    def active(self) -> bool:
        return self.state == "进行中"

    @property
    def backlog(self) -> bool:
        return self.state == "待办"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def tasks_dir(root: Path | None = None) -> Path:
    return (root or repo_root()) / TASKS_DIR


def state_of_text(text: str) -> str | None:
    """文本里的状态枚举；没有合法状态行返回 `None`。"""

    match = STATE_LINE.search(text)
    return match.group("state") if match else None


def task_state(path: Path) -> str:
    """一张卡的状态。缺或不合法 → `MissingState`。"""

    state = state_of_text(path.read_text(encoding="utf-8", errors="replace"))
    if state is None:
        raise MissingState(
            f"{path.as_posix()} 没有合法的状态行 —— 卡头必须有 "
            f"`- 状态：{' / '.join(STATES)}`（ADR-0105）"
        )
    return state


def card_paths(root: Path | None = None) -> list[Path]:
    """`docs/tasks/` 里所有的卡，按文件名字符串排（平台中立，AGENTS §3）。"""

    directory = tasks_dir(root)
    if not directory.is_dir():
        return []
    return sorted(
        (p for p in directory.glob("TASK-*.md") if CARD_ID.match(p.name)),
        key=lambda p: p.name,
    )


def cards(root: Path | None = None) -> dict[str, Card]:
    """任务号 → 卡。同号两张是坏状态：抛出，不静默取其一。"""

    found: dict[str, Card] = {}
    for path in card_paths(root):
        task = CARD_ID.match(path.name).group("id")  # type: ignore[union-attr]
        if task in found:
            raise ValueError(
                f"{task} 有两张卡：{found[task].path.name} 与 {path.name} —— "
                "一个任务号只能有一张卡"
            )
        found[task] = Card(task=task, state=task_state(path), path=path)
    return found


def by_state(root: Path | None = None) -> dict[str, list[Card]]:
    """按状态分组，三个键都在（空组也在）—— 调用方不用判 `KeyError`。"""

    groups: dict[str, list[Card]] = {state: [] for state in STATES}
    for card in cards(root).values():
        groups[card.state].append(card)
    return groups
