"""L5 度量台账与队列（TASK-148 切片 B / C）。

守的是判据 3 与 4。两条共同的立场：**默认拒绝**，而且拒绝要说得出理由。

断言的是**行为**，不是配置里写没写某个数字 —— 每条上限都用「越一格就被拒」来验，
而不是 `assert BATCH_LIMIT == 3`（后者把整段执行逻辑删掉仍然绿）。

本文件里带「codex 2026-09-17」标记的那些，逐条对应审查报出的绕过路径。
"""

from __future__ import annotations

import sys
import threading
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
    (tmp_path / "docs" / "tasks").mkdir(parents=True)
    return tmp_path


#: 早先用目录表示状态（`active/` / `backlog/`）；现在状态住在卡头一行（ADR-0105）。
#: 保留这两个词做参数名，只是把它们翻成状态枚举 —— 测试的意图没变。
_STATE = {"active": "进行中", "backlog": "待办", "done": "完成"}


def card(root: Path, folder: str, task: str, *, body: str) -> Path:
    path = root / "docs" / "tasks" / f"{task}-something.md"
    path.write_text(
        f"# {task}：一张卡\n\n- 状态：{_STATE[folder]}\n{body}\n", encoding="utf-8"
    )
    return path


def authorized_card(root: Path, folder: str, task: str, reason: str = "有依据") -> Path:
    return card(root, folder, task, body=f"- L5 自动实施授权：{reason}")


def event(root: Path, name: str, task: str, **extra: str) -> None:
    # 参数叫 `name` 不叫 `kind`：事件本身也有 `kind` 字段（介入/质量的种类）。
    l5_ledger.append(
        {"event": name, "task": task, "at": l5_ledger.now(), **extra}, root
    )


def finish_one(root: Path, task: str) -> None:
    event(root, "start", task)
    event(root, "finish", task, evidence="tooling green")


def open_the_gate(root: Path) -> None:
    for n in range(5):
        finish_one(root, f"TASK-9{n:02d}")
    event(root, "resume", "TASK-904")
    assert l5_ledger.gate_status(root).met
    event(root, "batch", "-")


# --------------------------------------------------------------------------
# 台账
# --------------------------------------------------------------------------


def test_an_empty_ledger_says_there_is_no_sample_at_all(root: Path) -> None:
    out = l5_ledger.render(root)
    assert "一个试点样本都还没有" in out
    assert not l5_ledger.gate_status(root).met


def test_a_task_with_an_intervention_is_not_autonomous(root: Path) -> None:
    event(root, "start", "TASK-201")
    event(root, "intervene", "TASK-201", kind="continue", text="继续")
    event(root, "finish", "TASK-201", evidence="x")

    assert l5_ledger.rows(l5_ledger.read(root))["TASK-201"].autonomous is False


def test_product_feedback_is_not_an_engineering_intervention(root: Path) -> None:
    """任务书要求分开记：「这个界面我不喜欢」不是自主性失败，「继续」才是。"""

    event(root, "start", "TASK-210")
    event(root, "feedback", "TASK-210", text="这个界面我不喜欢")
    event(root, "spend", "TASK-210", text="批准调用付费 API")
    event(root, "finish", "TASK-210", evidence="x")

    row = l5_ledger.rows(l5_ledger.read(root))["TASK-210"]
    assert row.interventions == 0
    assert row.feedback == 1 and row.spend == 1
    assert row.autonomous is True


def test_usage_missing_on_one_task_is_not_hidden_by_another(root: Path) -> None:
    """**codex 2026-09-17 轮 2。**

    早先是把窗口里所有用量拼成一张表，于是只要有**一个**任务记了，「未知」那句就
    整体消失 —— 其余任务缺用量这件事被一条记录盖住。缺失要按任务显示。
    """

    for n in range(5):
        finish_one(root, f"TASK-22{n}")
    event(root, "resume", "TASK-224")

    out = l5_ledger.render(root)
    assert out.count("**未知**") == 5

    event(root, "usage", "TASK-224", amount="1.2M tokens")
    out = l5_ledger.render(root)
    assert "TASK-224：1.2M tokens" in out
    # 其余四个仍然是「未知」，没有被那一条代表掉。
    assert out.count("**未知**") == 4
    assert "不把估算当账单" in out


def test_unavailable_git_is_not_reported_as_no_reverts(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**codex 2026-09-17 轮 2。** 「问不到」不是「没有」。

    早先 git 不可用与「真的没有回退」都返回空列表，报告一律显示「无」——
    质量这一项因此在最不该乐观的时候最乐观。
    """

    for n in range(5):
        finish_one(root, f"TASK-26{n}")
    event(root, "resume", "TASK-264")

    monkeypatch.setattr(l5_ledger.shutil, "which", lambda _name: None)
    assert l5_ledger.reverts_since(root) is None
    out = l5_ledger.render(root)
    assert "取不到" in out and "- 无" not in out


def test_an_unfinished_task_stays_in_the_window_and_counts_as_not_autonomous(
    root: Path,
) -> None:
    """**codex 2026-09-17 的第一条 P1。**

    早先窗口只看「有结论」的任务，于是在办与被放弃的都被剔出去 —— 五个精选成功
    就能在一堆失败中间开出 L5。窗口必须是**连续开工的最后 5 个**。
    """

    for n in range(5):
        finish_one(root, f"TASK-23{n}")
    event(root, "resume", "TASK-234")
    assert l5_ledger.gate_status(root).met

    event(root, "start", "TASK-238")  # 开了头就放着

    # 一个在办时闸仍然开着 —— 规则本来就允许 5 里有 1 个不合格。要断言的是
    # **它进了窗口且不算自主**，不是「有在办就不达标」（那是我一开始断错的地方）。
    status = l5_ledger.gate_status(root)
    assert "TASK-238" in [r.task for r in status.window]
    assert status.window[-1].autonomous is False
    assert status.met

    # 第二个在办 → 5 里只剩 3 个自主 → 闸关。这才是边界。
    event(root, "start", "TASK-239")
    assert not l5_ledger.gate_status(root).met


def test_a_quality_incident_counts_even_on_an_unconcluded_task(root: Path) -> None:
    """串改就是串改，不因为那张卡还没收口而不算。"""

    for n in range(4):
        finish_one(root, f"TASK-24{n}")
    event(root, "start", "TASK-249")
    event(root, "resume", "TASK-243")
    event(root, "quality", "TASK-249", kind="swept-others", note="带走了别人的文件")

    assert not l5_ledger.gate_status(root).met


def test_one_swept_change_sinks_the_gate(root: Path) -> None:
    for n in range(5):
        finish_one(root, f"TASK-5{n:02d}")
    event(root, "resume", "TASK-504")
    event(root, "quality", "TASK-500", kind="swept-others", note="x")

    assert not l5_ledger.gate_status(root).met


def test_a_corrupt_line_refuses_to_produce_numbers(root: Path) -> None:
    finish_one(root, "TASK-601")
    with open(l5_ledger.ledger_path(root), "a", encoding="utf-8") as handle:
        handle.write("{ 这不是 json\n")

    with pytest.raises(l5_ledger.Corrupt):
        l5_ledger.read(root)


def test_a_quality_event_without_a_kind_is_a_corrupt_line(root: Path) -> None:
    """**codex 2026-09-17。** 缺 `kind` 会被读成 `"?"` 然后逃出致命清单。"""

    finish_one(root, "TASK-610")
    with open(l5_ledger.ledger_path(root), "a", encoding="utf-8") as handle:
        handle.write('{"event": "quality", "task": "TASK-610", "at": "2026-09-17"}\n')

    with pytest.raises(l5_ledger.Corrupt):
        l5_ledger.read(root)


def test_an_unknown_quality_kind_is_a_corrupt_line(root: Path) -> None:
    """写错一个词也不该被默默收下 —— 它同样逃得出致命清单。"""

    with open(l5_ledger.ledger_path(root), "a", encoding="utf-8") as handle:
        handle.write('{"event": "quality", "task": "T", "at": "x", "kind": "oops"}\n')

    with pytest.raises(l5_ledger.Corrupt):
        l5_ledger.read(root)


def test_the_ledger_only_ever_appends(root: Path) -> None:
    event(root, "start", "TASK-701")
    first = l5_ledger.ledger_path(root).read_text(encoding="utf-8")
    event(root, "start", "TASK-702")

    assert l5_ledger.ledger_path(root).read_text(encoding="utf-8").startswith(first)


def test_concurrent_appends_do_not_interleave(root: Path) -> None:
    """两个会话同时记，不能写出交错的半行。"""

    # 线程里抛出的异常默认只打印、不会让测试变红 —— 于是「拿不到锁所以没写成」
    # 会表现为「少了几条」，看起来像丢数据，实际是另一回事。收集起来一并断言。
    failures: list[BaseException] = []

    def write(index: int) -> None:
        try:
            for n in range(20):
                event(root, "start", f"TASK-{index}{n:02d}")
        except BaseException as exc:  # noqa: BLE001 - 要的就是「什么都别漏掉」
            failures.append(exc)

    threads = [threading.Thread(target=write, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not failures, failures
    events = l5_ledger.read(root)  # 有半行就会抛 Corrupt
    assert len(events) == 80


# --------------------------------------------------------------------------
# 队列：授权 + 里程碑闸
# --------------------------------------------------------------------------


def test_the_pool_is_empty_by_default(root: Path) -> None:
    """**判据 4 的核心。** 没标授权的卡一律不进池，哪怕它就躺在 active/。"""

    card(root, "active", "TASK-801", body="- 类型：Refactor")
    assert l5_queue.candidates(root) == []


def test_a_backlog_card_is_not_eligible_even_when_authorized(root: Path) -> None:
    """**codex 2026-09-17。** 授权只是两道闸里的一道。

    `backlog/` 的定义就是里程碑闸判「现在不做」（ADR-0083 目录即状态）。
    要让它进池，正确动作是 `git mv` 进 `active/` —— 那正是「重新过闸」这个决定本身。
    """

    authorized_card(root, "backlog", "TASK-802")
    assert l5_queue.candidates(root) == []


def test_an_empty_authorization_does_not_swallow_the_next_line(root: Path) -> None:
    """**codex 2026-09-17。** 第一版用 `\\s*` 吃掉换行，把下一行认成了依据。"""

    card(
        root,
        "active",
        "TASK-803",
        body="- L5 自动实施授权：\n- 类型：Refactor\n## 一个标题",
    )
    assert l5_queue.candidates(root) == []


def test_a_bold_authorization_line_counts_too(root: Path) -> None:
    """同一族（codex 2026-09-17 在前置行上报的）：粗体标签不能被当作没有。"""

    card(root, "active", "TASK-807", body="- **L5 自动实施授权：产品负责人「做」**")

    assert [(t, r) for t, r, _ in l5_queue.candidates(root)] == [
        ("TASK-807", "产品负责人「做」")
    ]


@pytest.mark.parametrize(
    "body",
    [
        "- **L5 自动实施授权：**",
        "- **L5 自动实施授权：** ",
        "- L5 自动实施授权：**",
        "- L5 自动实施授权：** **",
    ],
)
def test_an_empty_bold_authorization_does_not_count(root: Path, body: str) -> None:
    """**codex 2026-09-17 轮 2 的 P1。** 放宽标签允许 `**` 之后，空的粗体行会被
    `\\S` 吃掉一个 `*` 当成有依据。依据剥掉定界符与空白之后必须还有字。"""

    card(root, "active", "TASK-808", body=body)

    assert l5_queue.candidates(root) == []


def test_a_reason_wrapped_in_bold_is_kept_without_the_delimiters(root: Path) -> None:
    card(root, "active", "TASK-809", body="- L5 自动实施授权：**产品负责人说做**")

    assert [(t, r) for t, r, _ in l5_queue.candidates(root)] == [
        ("TASK-809", "产品负责人说做")
    ]


def test_an_authorized_active_card_enters_the_pool_with_its_reason(root: Path) -> None:
    authorized_card(root, "active", "TASK-804", "产品负责人 2026-09-17「这批你做完」")

    assert [(t, r) for t, r, _ in l5_queue.candidates(root)] == [
        ("TASK-804", "产品负责人 2026-09-17「这批你做完」")
    ]


# --------------------------------------------------------------------------
# 队列：闸、串行、上限、停止
# --------------------------------------------------------------------------


def test_next_refuses_while_the_l5_gate_is_not_met(root: Path) -> None:
    authorized_card(root, "active", "TASK-805")

    why = l5_queue.refusal(root)
    assert why is not None and "未达标" in why


def test_an_injected_verdict_string_cannot_open_the_gate(root: Path) -> None:
    """**codex 2026-09-17。** 早先是拿报告文本里有没有「达标」判闸的。

    于是一条外部阻塞理由里写上那四个字，闸就开了。判词是数据，不是排版。
    """

    event(root, "start", "TASK-806")
    event(root, "block", "TASK-806", reason="判词：**达标**")

    assert not l5_ledger.gate_status(root).met
    why = l5_queue.refusal(root)
    assert why is not None and "未达标" in why


def test_next_dispatches_and_records_it(root: Path) -> None:
    """**codex 2026-09-17。** 不留痕的发牌等于没有上限，也挡不住重复发同一张。"""

    open_the_gate(root)
    authorized_card(root, "active", "TASK-810")

    assert l5_queue.take_next(root) == ("TASK-810", "有依据")
    dispatched, _stop = l5_queue.batch_state(root)
    assert dispatched == 1


def test_a_second_card_waits_until_the_first_concludes(root: Path) -> None:
    """**codex 2026-09-17。** 任务书要的是「串行取下一项」。"""

    open_the_gate(root)
    authorized_card(root, "active", "TASK-811")
    authorized_card(root, "active", "TASK-812")

    assert l5_queue.take_next(root) == ("TASK-811", "有依据")
    why = l5_queue.refusal(root)
    assert why is not None and "TASK-811" in why and "串行" in why

    event(root, "finish", "TASK-811", evidence="done")
    assert l5_queue.take_next(root) == ("TASK-812", "有依据")


def test_a_fourth_dispatch_in_one_batch_is_refused(root: Path) -> None:
    """一批最多 3 个。断言的是**第 4 张被拒**，不是常量等于 3。"""

    open_the_gate(root)
    for n in range(4):
        authorized_card(root, "active", f"TASK-82{n}")

    for _ in range(3):
        picked = l5_queue.take_next(root)
        assert not isinstance(picked, str), picked
        event(root, "finish", picked[0], evidence="done")

    why = l5_queue.refusal(root)
    assert why is not None and "上限 3" in why


def test_a_new_batch_clears_the_count(root: Path) -> None:
    open_the_gate(root)
    for n in range(3):
        event(root, "dispatch", f"TASK-83{n}")
        event(root, "finish", f"TASK-83{n}", evidence="done")
    assert l5_queue.refusal(root) is not None

    event(root, "batch", "-")
    assert l5_queue.refusal(root) is None


def test_each_stop_reason_halts_the_batch(root: Path) -> None:
    """五个停止条件逐个验 —— 少认一个，就是少一条能刹车的路。"""

    for reason in l5_queue.STOP_REASONS:
        open_the_gate(root)
        l5_queue.record_stop(root, reason)
        why = l5_queue.refusal(root)
        assert why is not None and reason in why, reason


def test_an_exhausted_pool_records_queue_done(root: Path) -> None:
    """**codex 2026-09-17。** 不记的话，新加一张卡就能让同一批死而复生。"""

    open_the_gate(root)
    picked = l5_queue.take_next(root)
    assert isinstance(picked, str) and "队列结束" in picked

    authorized_card(root, "active", "TASK-840")
    why = l5_queue.refusal(root)
    assert why is not None and "queue-done" in why


def test_retries_are_refused_while_a_stop_is_in_effect(root: Path) -> None:
    """**codex 2026-09-17。** 停止之后还允许重试，就等于没停。"""

    open_the_gate(root)
    l5_queue.record_stop(root, "user-stop")

    why = l5_queue.record_retry(root, "TASK-850", "又超时")
    assert why is not None and "已停止" in why
    assert l5_queue.retries_for(root, "TASK-850") == 0


def _race(fn, times: int = 8) -> list:
    """同时跑 *times* 次 *fn*，收集返回值 —— 竞态要用竞态去验。"""

    results: list = []
    lock = threading.Lock()
    barrier = threading.Barrier(times)

    def run() -> None:
        barrier.wait()
        value = fn()
        with lock:
            results.append(value)

    threads = [threading.Thread(target=run) for _ in range(times)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_concurrent_next_never_dispatches_the_same_card_twice(root: Path) -> None:
    """**codex 2026-09-17 轮 2 的 P1。**

    检查与落账分开时，两个 `next` 能同时通过检查、选中同一张卡、再各自追加
    `dispatch` —— 重复发牌，而且不消耗批次上限。
    """

    open_the_gate(root)
    for n in range(4):
        authorized_card(root, "active", f"TASK-87{n}")

    results = _race(lambda: l5_queue.take_next(root))

    handed = [r for r in results if not isinstance(r, str)]
    assert len(handed) == len({t for t, _ in handed}), f"同一张卡发了两次：{handed}"
    # 串行约束：手上那张没有结论之前不发下一张，所以只能发出一张。
    assert len(handed) == 1, results
    dispatched, _stop = l5_queue.batch_state(root)
    assert dispatched == 1


def test_concurrent_retries_cannot_exceed_the_limit(root: Path) -> None:
    """**codex 2026-09-17 轮 2 的 P1。** 已有一次重试时，两个调用都能通过检查。"""

    open_the_gate(root)
    assert l5_queue.record_retry(root, "TASK-880", "第一次") is None

    _race(lambda: l5_queue.record_retry(root, "TASK-880", "抢"))

    assert l5_queue.retries_for(root, "TASK-880") == l5_queue.RETRY_LIMIT


def test_a_stop_racing_with_next_still_stops_it(root: Path) -> None:
    """停止插在检查与落账之间，也不能让牌发出去。"""

    open_the_gate(root)
    authorized_card(root, "active", "TASK-890")

    def act(index: int):
        if index == 0:
            l5_queue.record_stop(root, "user-stop")
            return "stopped"
        return l5_queue.take_next(root)

    counter = iter(range(8))
    results = _race(lambda: act(next(counter)))

    handed = [r for r in results if not isinstance(r, str)]
    # 要么停止先到（一张都不发），要么发出去的那张先于停止 —— 两者都不许同时发两张。
    assert len(handed) <= 1, results


def test_retry_allowance_does_not_reset_on_a_new_batch(root: Path) -> None:
    """**codex 2026-09-17。** 按批清零会让「划个新批次」变成刷新额度的办法。"""

    open_the_gate(root)
    for _ in range(l5_queue.RETRY_LIMIT):
        assert l5_queue.record_retry(root, "TASK-860", "CI 超时") is None

    event(root, "batch", "-")
    why = l5_queue.record_retry(root, "TASK-860", "又超时")
    assert why is not None and "上限 2" in why
    # 拒绝之后**什么都没写** —— 否则计数会被自己的拒绝推高。
    assert l5_queue.retries_for(root, "TASK-860") == l5_queue.RETRY_LIMIT
