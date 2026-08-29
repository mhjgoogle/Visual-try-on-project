"""意见台账的读口（REQ-006 的后端一半）。

产品负责人 2026-08-29：「可以给后端反馈意见…你在后端接收到反馈以后提出修改方案。」

这条回路只有在**开发 Agent 真的读得到**时才成立：意见写在运行期的应用数据目录里，
不进仓库，所以必须有一个工具把它取出来。这份测试守那个工具。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_TOOL = _REPO / ".claude" / "tools" / "read_feedback.py"


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("motv_read_feedback", _TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def ledger(tmp_path: Path) -> Path:
    p = tmp_path / "feedback.json"
    p.write_text(
        json.dumps(
            {
                "version": 1,
                "items": [
                    {
                        "id": 1,
                        "runId": "run-a",
                        "createdAt": "2026-08-29T10:00:00+00:00",
                        "project": "照见未明rev2",
                        "page": "项目与创意",
                        "text": "版本太多了，看不过来",
                        "expect": "只显示最新版",
                        "status": "new",
                    },
                    {
                        "id": 2,
                        "runId": "run-b",
                        "createdAt": "2026-08-29T10:05:00+00:00",
                        "project": "照见未明rev2",
                        "page": "故事大纲",
                        "text": "已经处理过的那条",
                        "expect": "",
                        "status": "done",
                    },
                ],
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    return p


def test_it_shows_what_he_said_and_what_he_wanted(tool, ledger, capsys):
    tool.main(["--path", str(ledger)])
    out = capsys.readouterr().out
    assert "版本太多了，看不过来" in out
    assert "只显示最新版" in out
    assert "项目与创意" in out
    # 默认只列待处理的 —— 开发时要看的是「还没做的」
    assert "已经处理过的那条" not in out


def test_all_includes_what_was_already_handled(tool, ledger, capsys):
    tool.main(["--path", str(ledger), "--all"])
    assert "已经处理过的那条" in capsys.readouterr().out


def test_marking_done_writes_back_and_never_deletes(tool, ledger, capsys):
    tool.main(["--path", str(ledger), "--done", "1"])
    assert "已标记：[1]" in capsys.readouterr().out
    doc = json.loads(ledger.read_text("utf-8"))
    assert [x["status"] for x in doc["items"]] == ["done", "done"]
    # 第 13 条：不静默丢用户的东西 —— 条目还在，只是状态变了
    assert doc["items"][0]["text"] == "版本太多了，看不过来"


def test_an_unknown_id_is_reported_not_silently_ignored(tool, ledger, capsys):
    tool.main(["--path", str(ledger), "--done", "99"])
    assert "没找到：[99]" in capsys.readouterr().out


def test_json_output_is_machine_readable(tool, ledger, capsys):
    tool.main(["--path", str(ledger), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert [x["id"] for x in payload["items"]] == [1]


def test_a_missing_ledger_is_not_an_error(tool, tmp_path, capsys):
    tool.main(["--path", str(tmp_path / "nope.json")])
    assert "没有待处理的意见" in capsys.readouterr().out


def test_a_malformed_ledger_says_so_instead_of_pretending(tool, tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"items": "不是数组"}', "utf-8")
    with pytest.raises(SystemExit):
        tool.main(["--path", str(bad)])


def test_the_default_location_matches_the_server(tool):
    """两边算的必须是同一个文件，否则他提的意见永远没人看见。"""
    spec = importlib.util.spec_from_file_location(
        "motv_server_feedback", _REPO / "mockups" / "motv-workspace" / "server.py"
    )
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    assert tool.default_path() == server._feedback_path()
