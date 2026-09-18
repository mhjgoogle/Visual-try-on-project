"""TASK-153：问题永远排在它的答案前面 —— 两天三条偶发红的同一个根因。

`test_motv_conversation_task109.py` 在 `-n 8` 下红过三条不同的测试，单跑全绿。共同
机理只有一个：**问题的时间戳与答案的时间戳来自两个时钟**。问题那一轮以前取
`datetime.now()`（微秒、`+00:00`），在 run **建好之后**才取；答案那一轮取 run 的
`endedAt`（登记表时钟，秒级、`Z`）。一个立刻答完的假执行器只要跨过一个整秒边界，
答案的戳就小于问题的戳，线程按戳排序后答案排在问题前面 —— 三条测试都取
`turns[-1]` 当答案，于是各自以不同的样子红：顺序反了、`KeyError: 'failure'`、
「答案没落进线程」。并行时 CPU 争用把那个窗口拉宽，所以只在 `-n 8` 下现身。

这里钉的是机理，不是重跑到红：

1. 问题的戳**就是** run 的 `createdAt`（同一个时钟、同一种格式，且 ≤ `endedAt`）。
2. 即便问题的戳被取得比答案晚（用一个快 5 秒的假 `datetime` 模拟旧行为的窗口），
   线程里仍是先问后答 —— 因为问题不再读那个时钟。
3. 同一秒内戳相等时，排序由角色定：问题在前。
"""

from __future__ import annotations

import importlib.util
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"
_PROJECT = "夜班沉默"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_conv_153", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def app(srv, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(srv, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(srv, "APP_DATA_DIR", tmp_path / "app-data")
    monkeypatch.setattr(srv, "_RUNS", None)
    account = tmp_path / "account"
    root = account / _PROJECT
    (root / "studio").mkdir(parents=True)
    (root / "project.json").write_text(
        json.dumps({"name": _PROJECT, "project_id": _PROJECT}), "utf-8"
    )
    (root / "studio" / "canvas.json").write_text(json.dumps({"story": {}}), "utf-8")
    a = srv._App(account)
    a._projects[_PROJECT] = root
    return a


def _post(app, srv, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    resp = app.handle_post(
        f"/api/projects/{_PROJECT}/conversation",
        body,
        headers={srv._SKILL_RUN_HEADER: "1"},
    )
    return json.loads(resp.body.decode("utf-8"))


def _get(app):
    resp = app.handle(f"/api/projects/{_PROJECT}/conversation")
    return json.loads(resp.body.decode("utf-8"))


def _await(srv, run_id, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = srv.runs().get(run_id, project=_PROJECT)
        if run.get("status") not in ("queued", "running", "cancelling"):
            return run
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} 没有在 {timeout}s 内结束")


def _instant_answer(srv, monkeypatch):
    monkeypatch.setattr(
        srv,
        "_run_executor",
        lambda *a, **k: ('{"reply": "立刻答完", "edits": []}', "claude-x"),
    )


class _LateClock:
    """一个快 5 秒的 `datetime`：模拟旧代码里「问题的戳在 run 建好很久之后才取」。"""

    @staticmethod
    def now(tz=None):
        return datetime.now(tz or timezone.utc) + timedelta(seconds=5)


def test_the_question_is_stamped_with_the_runs_own_clock(app, srv, monkeypatch):
    _instant_answer(srv, monkeypatch)
    out = _post(app, srv, {"message": "问一句"})
    assert out["turn"]["createdAt"] == out["run"]["createdAt"], (
        "问题的戳不是 run 的 createdAt —— 又回到两个时钟"
    )
    assert out["turn"]["createdAt"].endswith("Z"), "格式不是登记表那一种"


def test_a_late_question_stamp_can_no_longer_sort_after_its_answer(
    app, srv, monkeypatch
):
    """旧行为的窗口被放大到 5 秒仍然先问后答 —— 因为问题不再读那个时钟。"""
    _instant_answer(srv, monkeypatch)
    monkeypatch.setattr(srv, "datetime", _LateClock)
    out = _post(app, srv, {"message": "这一场几个镜头"})
    _await(srv, out["run"]["run_id"])
    thread = _get(app)
    assert [t["role"] for t in thread["turns"]] == ["user", "agent"]
    assert thread["turns"][-1]["text"] == "立刻答完"


def test_equal_stamps_put_the_question_first(app, srv, monkeypatch):
    """登记表的时钟钉在一秒之内：问与答的戳字符串相等，次序由角色定。"""
    _instant_answer(srv, monkeypatch)
    frozen = time.time()
    store = srv.runs()
    monkeypatch.setattr(store, "_clock", lambda: frozen)
    out = _post(app, srv, {"message": "同一秒"})
    run = _await(srv, out["run"]["run_id"])
    assert run["createdAt"] == run["endedAt"], "时钟没钉住，这条测试的前提不成立"
    thread = _get(app)
    assert [t["role"] for t in thread["turns"]] == ["user", "agent"]
    # 再读一次不重排、不重复
    thread2 = _get(app)
    assert [t["role"] for t in thread2["turns"]] == ["user", "agent"]


def test_the_order_key_itself(srv):
    key = srv._conv_turn_order
    user = {"role": "user", "createdAt": "2026-09-18T00:32:39Z"}
    agent = {"role": "agent", "createdAt": "2026-09-18T00:32:39Z"}
    later = {"role": "user", "createdAt": "2026-09-18T00:32:40Z"}
    assert sorted([agent, user, later], key=key) == [user, agent, later]
    assert key({}) == ("", 1), "没有戳、没有角色也不许抛"
