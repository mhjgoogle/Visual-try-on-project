"""L5 度量台账与队列（TASK-148 切片 B / C）。

守的是判据 3 与 4。两条共同的立场：**默认拒绝**，而且拒绝要说得出理由。

这里断言的是**行为**，不是配置里写没写某个数字 —— 每条上限都用「越一格就被拒」
来验，而不是 `assert BATCH_LIMIT == 3`（后者删掉整段执行逻辑仍然绿）。
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


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "docs" / "tasks" / "backlog").mkdir(parents=True)
    (tmp_path / "docs" / "tasks" / "active").mkdir(parents=True)
    return tmp_path


def card(root: Path, folder: str, task: str, *, authorized: str | None) -> Path:
    body = [f"# {task}：一张卡", "", "- 类型：Refactor"]
    if authorized is not None:
        body.append(f"- L5 自动实施授权：{authorized}")
    path = root / "docs" / "tasks" / folder / f"{task}-something.md"
    path.write_text("\n".join(body) + "\n", encoding="utf-8")
    return path


def event(root: Path, name: str, task: str, **extra: str) -> None:
    # 参数叫 `name` 不叫 `kind`：事件本身也有一个 `kind` 字段（介入/质量的种类），
    # 重名会让 `event(..., kind="continue")` 撞上位置参数。
    l5_ledger.append(
        {"event": name, "task": task, "at": l5_ledger.now(), **extra}, root
    )


def finish_one(root: Path, task: str) -> None:
    event(root, "start", task)
    event(root, "finish", task, evidence="tooling green")


# --------------------------------------------------------------------------
# 台账
# --------------------------------------------------------------------------


def test_an_empty_ledger_says_there_is_no_sample_at_all(root: Path) -> None:
    """空台账不能读成「还行」。判据 3 要求它答得出「几个零介入」。"""

    out = l5_ledger.render(root)
    assert "一个试点样本都还没有" in out
    assert "判词：**达标**" not in out


def test_a_task_with_an_intervention_is_not_autonomous(root: Path) -> None:
    event(root, "start", "TASK-201")
    event(root, "intervene", "TASK-201", kind="continue", text="继续")
    event(root, "finish", "TASK-201", evidence="x")

    table = l5_ledger.rows(l5_ledger.read(root))
    assert table["TASK-201"].autonomous is False


def test_an_unfinished_task_is_not_autonomous_either(root: Path) -> None:
    """零介入但没交付 ≠ 自主完成。否则「开个头就放着」会被算成满分。"""

    event(root, "start", "TASK-202")

    table = l5_ledger.rows(l5_ledger.read(root))
    assert table["TASK-202"].autonomous is False


def test_external_blocks_stay_in_the_denominator_with_their_reason(root: Path) -> None:
    """任务书原文：外部阻塞留在分母里并单列原因。

    把被阻塞的任务从分母里拿掉，完成率就永远好看。
    """

    for n in range(4):
        finish_one(root, f"TASK-3{n:02d}")
    event(root, "start", "TASK-399")
    event(root, "block", "TASK-399", reason="CI 配额耗尽")

    out = l5_ledger.render(root)
    assert "/ 5" in out, out
    assert "CI 配额耗尽" in out


def test_the_gate_passes_only_when_every_condition_holds(root: Path) -> None:
    """四条全成立才达标 —— 逐条验，不只验总判词。"""

    for n in range(4):
        finish_one(root, f"TASK-4{n:02d}")
    finish_one(root, "TASK-404")
    event(root, "resume", "TASK-404")

    assert "判词：**达标**" in l5_ledger.render(root)


def test_one_swept_change_sinks_the_gate(root: Path) -> None:
    """零串改是硬条件。串一次就不达标 —— 这条不打折。"""

    for n in range(5):
        finish_one(root, f"TASK-5{n:02d}")
    event(root, "resume", "TASK-504")
    event(root, "quality", "TASK-500", kind="swept-others", note="带走了别人的文件")

    assert "判词：**未达标**" in l5_ledger.render(root)


def test_a_corrupt_line_refuses_to_produce_numbers(root: Path) -> None:
    """坏行**拒绝出数**，不是跳过。会跳过坏行的台账读起来永远漂亮。"""

    finish_one(root, "TASK-601")
    path = l5_ledger.ledger_path(root)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("{ 这不是 json\n")

    with pytest.raises(l5_ledger.Corrupt):
        l5_ledger.read(root)


def test_the_ledger_only_ever_appends(root: Path) -> None:
    """写第二条不能动第一条 —— 台账要当证据，就不能被自己改写。"""

    event(root, "start", "TASK-701")
    first = l5_ledger.ledger_path(root).read_text(encoding="utf-8")
    event(root, "start", "TASK-702")
    after = l5_ledger.ledger_path(root).read_text(encoding="utf-8")

    assert after.startswith(first)


# --------------------------------------------------------------------------
# 队列
# --------------------------------------------------------------------------


def test_the_pool_is_empty_by_default(root: Path) -> None:
    """**判据 4 的核心。** 没标授权的卡一律不进池，哪怕它就躺在 active/。"""

    card(root, "active", "TASK-801", authorized=None)
    card(root, "backlog", "TASK-802", authorized=None)

    assert l5_queue.candidates(root) == []


def test_an_authorization_without_a_reason_does_not_count(root: Path) -> None:
    """没有依据的「授权」就是把「我觉得可以」写成了别人的决定。"""

    path = root / "docs" / "tasks" / "active" / "TASK-803-x.md"
    path.write_text("# TASK-803\n\n- L5 自动实施授权：\n", encoding="utf-8")

    assert l5_queue.candidates(root) == []


def test_an_authorized_card_enters_the_pool_with_its_reason(root: Path) -> None:
    card(root, "backlog", "TASK-804", authorized="产品负责人 2026-09-17「这批你做完」")

    pool = l5_queue.candidates(root)
    assert [(t, r) for t, r, _ in pool] == [
        ("TASK-804", "产品负责人 2026-09-17「这批你做完」")
    ]


def test_next_refuses_while_the_l5_gate_is_not_met(root: Path) -> None:
    """**队列不能在度量达标之前开门。**

    先跑起来再补度量，等于让整套度量变成装饰。
    """

    card(root, "backlog", "TASK-805", authorized="有依据")

    why = l5_queue.refusal(root)
    assert why is not None and "未达标" in why


def _open_the_gate(root: Path) -> None:
    for n in range(5):
        finish_one(root, f"TASK-9{n:02d}")
    event(root, "resume", "TASK-904")
    assert "判词：**达标**" in l5_ledger.render(root)
    l5_ledger.append({"event": "batch", "task": "-", "at": l5_ledger.now()}, root)


def test_next_hands_out_an_authorized_card_once_the_gate_is_open(root: Path) -> None:
    _open_the_gate(root)
    card(root, "backlog", "TASK-806", authorized="有依据")

    assert l5_queue.refusal(root) is None
    assert l5_queue.next_task(root) == ("TASK-806", "有依据")


def test_a_fourth_task_in_one_batch_is_refused(root: Path) -> None:
    """一批最多 3 个（任务书 §6）。断言的是**第 4 个被拒**，不是常量等于 3。"""

    _open_the_gate(root)
    for n in range(3):
        event(root, "start", f"TASK-81{n}")

    why = l5_queue.refusal(root)
    assert why is not None and "上限 3" in why


def test_a_new_batch_clears_the_count(root: Path) -> None:
    _open_the_gate(root)
    for n in range(3):
        event(root, "start", f"TASK-82{n}")
    assert l5_queue.refusal(root) is not None

    l5_ledger.append({"event": "batch", "task": "-", "at": l5_ledger.now()}, root)
    assert l5_queue.refusal(root) is None


def test_each_stop_reason_halts_the_batch(root: Path) -> None:
    """五个停止条件逐个验 —— 少认一个，就是少一条能刹车的路。"""

    for reason in l5_queue.STOP_REASONS:
        _open_the_gate(root)
        l5_ledger.append(
            {"event": "stop", "task": "-", "at": l5_ledger.now(), "reason": reason},
            root,
        )
        why = l5_queue.refusal(root)
        assert why is not None and reason in why, reason


def test_a_third_retry_is_refused(root: Path) -> None:
    """同一外部失败最多重试 2 次；第 3 次要保存状态并报告，不是继续试。"""

    _open_the_gate(root)
    for _ in range(2):
        event(root, "retry", "TASK-830", reason="CI 超时")

    _started, _stop, retries = l5_queue.batch_state(root)
    assert retries["TASK-830"] == l5_queue.RETRY_LIMIT

    why = l5_queue.record_retry(root, "TASK-830", "又超时")
    assert why is not None and "上限 2" in why
    # 拒绝之后**什么都没写** —— 否则计数会被自己的拒绝推高。
    _started, _stop, after = l5_queue.batch_state(root)
    assert after["TASK-830"] == l5_queue.RETRY_LIMIT


def test_a_card_already_started_is_not_handed_out_again(root: Path) -> None:
    _open_the_gate(root)
    card(root, "backlog", "TASK-840", authorized="有依据")
    card(root, "backlog", "TASK-841", authorized="有依据")
    event(root, "start", "TASK-840")

    assert l5_queue.next_task(root) == ("TASK-841", "有依据")
