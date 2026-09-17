"""任务卡之间的前置边（TASK-149），状态住在卡上（ADR-0105）。

守四条判据：现有写法不改就能读出（1）· 三种坏边各自转红（2）· 等前置的卡不发且
说得出在等谁（3）· B 前置 A 时先发 A，A 的状态改成 `完成` 后才发 B（4）。

最后一条对着**真仓库**跑 `check()`：一条机器读的边写错了，必须当场有人知道。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS = REPO_ROOT / ".claude" / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import l5_ledger  # noqa: E402
import l5_queue  # noqa: E402
import task_graph  # noqa: E402
import task_status  # noqa: E402


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "docs" / "tasks").mkdir(parents=True)
    return tmp_path


def card(root: Path, task: str, state: str, *lines: str) -> Path:
    """一张卡：状态写在卡头（ADR-0105），其余行原样追加。"""

    path = root / "docs" / "tasks" / f"{task}-x.md"
    body = [f"- 状态：{state}", *lines]
    path.write_text(f"# {task}\n\n" + "\n".join(body) + "\n", encoding="utf-8")
    return path


def set_state(path: Path, state: str) -> None:
    text = path.read_text(encoding="utf-8")
    new = task_status.ANY_STATE_LINE.sub(f"- 状态：{state}", text, count=1)
    assert new != text or state in text
    path.write_text(new, encoding="utf-8")


# --------------------------------------------------------------------------
# 判据 1：现有写法不改就能读出
# --------------------------------------------------------------------------


def test_the_existing_task_074_line_is_read_without_rewriting_it(root: Path) -> None:
    """TASK-074 那一行的原样：带链接、带尾注。解析器去认它，不要求人改写。"""

    card(root, "TASK-073", "完成")
    card(
        root,
        "TASK-074",
        "进行中 · **部分实施。**",
        "- 依据：[ADR-0066](../../adr/ADR-0066.md)",
        "- 前置：[TASK-073](TASK-073-fixed-ia.md) 全部验收通过",
        "- 性质：**这是唯一允许删除的阶段。**",
    )

    assert task_graph.edges(root) == {"TASK-074": ["TASK-073"]}


def test_bare_ids_with_chinese_commas_and_duplicates_are_read_once(root: Path) -> None:
    path = card(root, "TASK-080", "进行中", "- 前置：TASK-001、TASK-002, TASK-001")
    card(root, "TASK-001", "完成")
    card(root, "TASK-002", "完成")

    assert task_graph.prerequisites(path) == ["TASK-001", "TASK-002"]


def test_a_letter_suffixed_id_is_a_card_too(root: Path) -> None:
    """`TASK-051A` / `051B` 是仓库里真实存在的写法。只认 `\\d+` 会把它们**都漏掉**。"""

    card(root, "TASK-051A", "完成")
    card(root, "TASK-051B", "进行中", "- 前置：TASK-051A")

    assert set(task_graph.cards(root)) == {"TASK-051A", "TASK-051B"}
    assert task_graph.edges(root) == {"TASK-051B": ["TASK-051A"]}


def test_a_prereq_mention_in_prose_is_not_an_edge(root: Path) -> None:
    """只认卡头那一行。正文里提「前置」的段落不是边 —— 否则每次讨论都在改图。"""

    card(
        root,
        "TASK-081",
        "进行中",
        "",
        "正文里说：§1.5 的硬前置是 §1.4 全绿，TASK-999 无关。",
    )

    assert task_graph.edges(root) == {}


# --------------------------------------------------------------------------
# 判据 2：三种坏边各自转红
# --------------------------------------------------------------------------


def test_a_dangling_prereq_is_reported(root: Path) -> None:
    card(root, "TASK-090", "进行中", "- 前置：TASK-999")

    problems = task_graph.check(root)
    assert any("TASK-999" in p and "悬空" in p for p in problems), problems


def test_a_self_prereq_is_reported(root: Path) -> None:
    card(root, "TASK-091", "进行中", "- 前置：TASK-091")

    assert any("自己" in p for p in task_graph.check(root))


def test_a_cycle_is_reported_and_refuses_to_order(root: Path) -> None:
    card(root, "TASK-092", "进行中", "- 前置：TASK-093")
    card(root, "TASK-093", "进行中", "- 前置：TASK-092")

    assert any("成环" in p for p in task_graph.check(root))
    with pytest.raises(ValueError):
        task_graph.order(["TASK-092", "TASK-093"], root)


def test_a_clean_graph_reports_nothing(root: Path) -> None:
    card(root, "TASK-100", "完成")
    card(root, "TASK-101", "进行中", "- 前置：TASK-100")

    assert task_graph.check(root) == []


def test_two_cards_with_one_id_are_refused(root: Path) -> None:
    """一个任务号只能有一张卡。目录不再帮忙区分它们（ADR-0105），静默取其一会让
    「完成了没」有两个答案 —— 迁移当天在真仓库里抓到 TASK-061 / TASK-102 各两张。"""

    card(root, "TASK-110", "进行中")
    (root / "docs" / "tasks" / "TASK-110-other.md").write_text(
        "# TASK-110\n\n- 状态：完成\n", encoding="utf-8"
    )

    with pytest.raises(ValueError):
        task_graph.cards(root)


def test_the_real_repository_has_no_bad_edges() -> None:
    """**对着真仓库跑。** 这条进 commit gate 与 CI —— 边写错了当场有人知道。"""

    assert task_graph.check(REPO_ROOT) == []


# --------------------------------------------------------------------------
# 判据 3 / 4：队列按图排、等前置的不发
# --------------------------------------------------------------------------


def _open_gate(root: Path) -> None:
    for n in range(5):
        for name, extra in (("start", {}), ("finish", {"evidence": "ok"})):
            l5_ledger.append(
                {
                    "event": name,
                    "task": f"TASK-9{n:02d}",
                    "at": l5_ledger.now(),
                    **extra,
                },
                root,
            )
    l5_ledger.append(
        {"event": "resume", "task": "TASK-904", "at": l5_ledger.now()}, root
    )
    l5_ledger.append({"event": "batch", "task": "-", "at": l5_ledger.now()}, root)
    assert l5_ledger.gate_status(root).met


def test_candidates_come_out_in_dependency_order_not_id_order(root: Path) -> None:
    """**判据 4 的前半。** 早先按任务号排：B 的号更小就先发 B，哪怕 B 前置 A。"""

    card(root, "TASK-120", "进行中", "- L5 自动实施授权：有", "- 前置：TASK-125")
    card(root, "TASK-125", "进行中", "- L5 自动实施授权：有")

    assert [t for t, _r, _p in l5_queue.candidates(root)] == ["TASK-125", "TASK-120"]


def test_a_card_waiting_on_a_prereq_is_listed_but_not_ready(root: Path) -> None:
    """**判据 3。** 显示它、说明在等谁、但不发。"""

    card(root, "TASK-130", "进行中", "- L5 自动实施授权：有", "- 前置：TASK-131")
    card(root, "TASK-131", "进行中")  # 没授权，也没做完

    assert [t for t, _r, _p in l5_queue.candidates(root)] == ["TASK-130"]
    assert l5_queue.ready(root) == []
    assert task_graph.blocked_by("TASK-130", root) == ["TASK-131"]


def test_next_dispatches_the_prereq_first_and_the_dependent_only_after_done(
    root: Path,
) -> None:
    """**判据 4 全文。** B 前置 A：先发 A；A 的状态改成 `完成` 之后才发 B。"""

    _open_gate(root)
    card(root, "TASK-140", "进行中", "- L5 自动实施授权：有", "- 前置：TASK-141")
    a = card(root, "TASK-141", "进行中", "- L5 自动实施授权：有")

    assert l5_queue.take_next(root) == ("TASK-141", "有")
    l5_ledger.append(
        {
            "event": "finish",
            "task": "TASK-141",
            "at": l5_ledger.now(),
            "evidence": "ok",
        },
        root,
    )

    # 台账里 A 交付了，但**卡的状态还没改** —— 状态住在卡上，B 仍然在等。
    why = l5_queue.take_next(root)
    assert isinstance(why, str) and "等 TASK-141" in why, why

    set_state(a, "完成 · 交付了")
    assert l5_queue.take_next(root) == ("TASK-140", "有")


def test_waiting_cards_do_not_count_as_queue_done(root: Path) -> None:
    """池里还有卡但都在等前置 → 不是「队列结束」，不记 `queue-done`。"""

    _open_gate(root)
    card(root, "TASK-150", "进行中", "- L5 自动实施授权：有", "- 前置：TASK-151")
    card(root, "TASK-151", "进行中")

    why = l5_queue.take_next(root)
    assert isinstance(why, str) and "等前置" in why
    _d, stop = l5_queue.batch_state(root)
    assert stop is None
