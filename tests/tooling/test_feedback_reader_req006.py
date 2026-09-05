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


# --- 开发 → 他：提案与答复（REQ-006 判据 6） --------------------------------- #


def test_the_dev_can_write_a_proposal_he_will_see(tool, ledger, capsys):
    tool.main(
        ["--path", str(ledger), "--propose", "把版本行收起来", "--body", "只显示最新版"]
    )
    assert "第 1 号提案" in capsys.readouterr().out
    doc = json.loads(ledger.read_text("utf-8"))
    assert doc["proposals"][0]["title"] == "把版本行收起来"
    assert doc["proposals"][0]["body"] == "只显示最新版"
    assert doc["proposals"][0]["decision"] is None


def test_proposals_list_shows_his_answer_and_his_words(tool, ledger, capsys):
    tool.main(["--path", str(ledger), "--propose", "把版本行收起来"])
    doc = json.loads(ledger.read_text("utf-8"))
    doc["proposals"][0]["decision"] = {
        "at": "2026-08-29T02:00:00+00:00",
        "verdict": "changes",
        "note": "同意，但要能一键全展开",
    }
    ledger.write_text(json.dumps(doc, ensure_ascii=False), "utf-8")
    tool.main(["--path", str(ledger), "--proposals"])
    out = capsys.readouterr().out
    assert "要改" in out
    assert "同意，但要能一键全展开" in out


def test_open_proposals_are_counted_so_the_dev_knows_what_is_waiting(
    tool, ledger, capsys
):
    tool.main(["--path", str(ledger), "--propose", "一"])
    tool.main(["--path", str(ledger), "--propose", "二"])
    capsys.readouterr()
    tool.main(["--path", str(ledger), "--proposals"])
    assert "等他答复 2 条" in capsys.readouterr().out


def test_a_ledger_written_before_proposals_existed_still_loads(tool, ledger):
    """fixture 里本来就没有 proposals —— 那正是这条测试要的形状（旧台账）。"""
    doc = json.loads(ledger.read_text("utf-8"))
    assert "proposals" not in doc
    tool.main(["--path", str(ledger), "--propose", "新提案"])
    assert json.loads(ledger.read_text("utf-8"))["proposals"][0]["id"] == 1


def test_the_reader_prints_where_and_which_file_draws_it(tool, ledger, capsys):
    """一条意见到「我打开那个文件」之间，不该还有一步搜索。"""
    doc = json.loads(ledger.read_text("utf-8"))
    doc["items"][0]["where"] = {
        "page": "剧集制作 · 分镜设计",
        "section": "shots",
        "route": "#/p/episode/storyboard/shots",
        "source": "src/ui/storyboard.js",
        "episodeLabel": "EP01 迷雾入城",
        "shotTitle": "招牌 · 雨夜",
    }
    ledger.write_text(json.dumps(doc, ensure_ascii=False), "utf-8")
    tool.main(["--path", str(ledger)])
    out = capsys.readouterr().out
    assert "剧集制作 · 分镜设计" in out
    assert "节：shots" in out
    assert "EP01 迷雾入城" in out
    assert "mockups/motv-workspace/src/ui/storyboard.js" in out
    assert "#/p/episode/storyboard/shots" in out


def test_an_item_without_a_locator_still_reads_fine(tool, ledger, capsys):
    """老条目没有 where —— 不能因此炸掉，也不能印出空行标题。"""
    tool.main(["--path", str(ledger)])
    out = capsys.readouterr().out
    assert "版本太多了，看不过来" in out
    assert "画它的文件" not in out
