"""`media-audit?measure=` 的具名状态：服务端产出什么，前端就必须说得出什么。

TASK-087 §3.5.4 把逐镜时长测量从 `/api/delivery/probe`（ffprobe + 一次完整解码）
切到 `media-audit?measure=`（ffprobe-only）。轻端点刻意把失败分成**五种具名
状态**，因为每一种把创作者送到**不同的下一步**：装 ffprobe、去找文件、改文件名、
换一条视频。

于是出现一条跨语言合同：`server.py` 新增一种状态而 `app.js` 的
`SHOT_MEASURE_STATE` 没跟上时，那一种会静默落到兜底的「探测失败」——
**恰好把这个端点专门保留下来的区分丢掉**，而且不会有任何东西报错。
这正是 ADR-0080 决策 3 说的「跨 py↔js 合同只住 tests/contract/」。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"
_APP_JS = _REPO / "mockups" / "motv-workspace" / "src" / "app.js"


def _server_measure_states() -> set[str]:
    """`_measure_media` 回得出的每一种 state，从**函数体本身**取。

    不从一份手写名单取 —— 那样这条测试就变成「我抄的名单和我抄的名单一致」，
    服务端加一种状态时它照样绿。
    """
    src = _SERVER.read_text(encoding="utf-8")
    start = src.index("def _measure_media(")
    # 到下一个同级 `def ` 为止
    body = src[start:]
    nxt = re.search(r"\n    def [A-Za-z_]", body)
    body = body[: nxt.start()] if nxt else body
    return set(re.findall(r'"state":\s*"([a-z_]+)"', body))


def _js_named_states() -> set[str]:
    """`SHOT_MEASURE_STATE` 里逐个给了说法的状态。"""
    src = _APP_JS.read_text(encoding="utf-8")
    start = src.index("const SHOT_MEASURE_STATE = {")
    body = src[start : src.index("};", start)]
    return set(re.findall(r"^\s*([a-z_]+):\s*\"", body, re.MULTILINE))


def test_the_server_really_names_several_measure_states() -> None:
    """先证明扫描面不是空的。

    上面两个函数都靠正则从源码里挖。挖不到东西时集合是空的，而
    `空集 <= 任何集合` 恒真 —— 下面那条断言会变成一句永远成立的空话。
    这条测试是那条断言的**非空前提**。
    """
    states = _server_measure_states()
    assert len(states) >= 4, f"从 _measure_media 里只挖出 {states} —— 扫描面坏了"
    assert "ok" in states, states


def test_every_server_failure_state_has_something_to_say_in_the_ui() -> None:
    """服务端每一种**失败**状态，界面都必须有一句自己的话。

    `ok` 不在其列：它走的是显示时长那条路，不需要一句错误说明。
    """
    server = _server_measure_states() - {"ok"}
    js = _js_named_states()
    missing = server - js
    assert not missing, (
        "服务端会回这些状态，但 `SHOT_MEASURE_STATE` 里没有对应的说法："
        f"{sorted(missing)}。"
        "它们会静默落到兜底的「探测失败」—— 恰好把这个轻端点专门保留下来的区分丢掉。"
    )


def test_the_ui_does_not_invent_states_the_server_never_returns() -> None:
    """反方向也钉住：界面不得为一种服务端永远不回的状态编一句话。

    多出来的那句话本身无害，但它是**一条读起来像事实的死代码** —— 下一个人
    会以为存在这种情况。服务端改了名字（比如 `not_found` → `missing`）时，
    这条测试会和上一条一起红，指出是**改名**而不是新增。
    """
    server = _server_measure_states() - {"ok"}
    extra = _js_named_states() - server
    assert not extra, (
        "`SHOT_MEASURE_STATE` 给这些状态写了说法，但服务端从不返回它们："
        f"{sorted(extra)}"
    )
