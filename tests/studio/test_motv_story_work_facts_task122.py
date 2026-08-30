"""前端 Agent 必须看得见故事开发这四页的**当前内容**（TASK-122）。

产品负责人 2026-08-30 写完 869 字的故事核心，问前端 Agent「你审查一下」，得到的回答是：

    「我这边读到的项目事实里，故事核心和创意简报都还是空的，故事大纲也是 0 版」

—— 屏幕上明明有。原因是服务端喂给模型的那段事实**从来没读过 `story.work`**，只读了
旧的创意简报与大纲版本链。他接着说「我明明写了你怎么看不到」「这个前端的 agent 还是
改不了」，两件事其实是同一件：一个被告知「那里是空的」的模型，不会去改它。

这份测试钉的就是这条回路：**屏幕上有的，事实里必须也有**。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SERVER = REPO / "mockups" / "motv-workspace" / "server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_task122", SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _canvas(work: dict) -> dict:
    return {
        "schemaVersion": 19,
        "story": {
            "idea": "",
            "brief": {"versions": [], "draft": {}, "active": 0},
            "versions": [],
            "work": work,
        },
        "production": {"episodes": [], "characters": []},
        "nodes": [],
    }


@pytest.fixture()
def app(tmp_path, srv):
    account = tmp_path / "MotvProjects"
    root = account / "作品"
    (root / "studio").mkdir(parents=True)
    a = srv._App(account)
    a._projects["作品"] = root

    def write(work):
        (root / "studio" / "canvas.json").write_text(
            json.dumps(_canvas(work), ensure_ascii=False), "utf-8"
        )

    a._write_work = write  # type: ignore[attr-defined]
    return a


def test_the_core_he_wrote_is_in_the_facts(app):
    """他写了 869 字，Agent 说「还是空的」—— 就是这条。"""
    app._write_work({"core": "世界管理者为了维持现实稳定，围绕源律制定了一套规则。"})
    facts = app._conv_facts("作品")
    assert "世界管理者" in facts, "他写下的故事核心必须出现在事实里"
    assert "故事核心：还没写" not in facts


def test_an_empty_core_still_says_so_honestly(app):
    app._write_work({"core": ""})
    assert "故事核心：还没写" in app._conv_facts("作品")


def test_the_outline_nodes_and_their_stable_ids_reach_the_agent(app):
    """结构规划靠节点 id 引用大纲 —— Agent 要能指名道姓地说「§2 那一段」。"""
    app._write_work(
        {
            "outline": {
                "nodes": [
                    {"id": "on-a1", "kind": "para", "text": "开端：他丢了名字"},
                    {"id": "on-b2", "kind": "para", "text": "结局：他换回来"},
                ]
            }
        }
    )
    facts = app._conv_facts("作品")
    assert "§1" in facts and "§2" in facts
    assert "on-a1" in facts, "节点 id 要给到模型，否则它没法把某一行关联到某一段"
    assert "他丢了名字" in facts


def test_the_nine_column_plan_reaches_the_agent_with_row_ids(app):
    app._write_work(
        {
            "plan": {
                "rows": [
                    {
                        "id": "sp-r01",
                        "unitNo": "1",
                        "scene": "酒吧 · 打烊后",
                        "purpose": "让他决定不交出录音",
                        "conflict": "交出去等于毁掉自己",
                        "outlineRefs": ["on-a1"],
                        "hidden": None,
                    },
                    {"id": "sp-r02", "unitNo": "2", "hidden": {"at": "T1"}},
                ]
            }
        }
    )
    facts = app._conv_facts("作品")
    assert "sp-r01" in facts, "要能指名改哪一行"
    assert "酒吧 · 打烊后" in facts and "交出去等于毁掉自己" in facts
    assert "on-a1" in facts, "关联到的大纲节点"
    assert "sp-r02" not in facts, "删掉的行不该继续出现在事实里"


def test_the_draft_reports_form_planned_and_what_is_written(app):
    app._write_work(
        {
            "form": "novel",
            "planned": {"novel": 3, "episode": 0},
            "units": [
                {
                    "id": "u-1",
                    "kind": "novel",
                    "no": 1,
                    "title": "最后一个客人",
                    "body": "酒吧打烊后，林晚把录音笔推到桌子中间。",
                    "finalized": [],
                },
                {
                    "id": "u-2",
                    "kind": "novel",
                    "no": 2,
                    "title": "",
                    "body": "",
                    "finalized": [],
                },
            ],
        }
    )
    facts = app._conv_facts("作品")
    assert "小说创作" in facts and "计划 3 章" in facts
    assert "已经动过笔 1 章" in facts
    assert "最后一个客人" in facts
    assert "录音笔推到桌子中间" in facts, "正文的开头要给到模型"
    assert "还是空的" in facts, "没写的那一章要如实说，不许含糊过去"


def test_no_form_chosen_is_reported_as_such(app):
    app._write_work({})
    assert "正文创作：还没选" in app._conv_facts("作品")


def test_the_facts_reach_the_prompt(app, srv):
    """事实进了 `_conv_facts` 还不够 —— 要真的进到发给模型的那段提示词里。"""
    app._write_work({"core": "被世界抹除的人并没有消失"})
    prompt = srv._conv_prompt("审查一下故事核心", app._conv_facts("作品"))
    assert "被世界抹除的人并没有消失" in prompt


# --- Agent 不许再用已经不存在的页面名字 ------------------------------------- #
#
# 产品负责人 2026-08-30 被前端 Agent 问到「创意简报还是空的」时的反应是：
#
#     「什么是创意简报。你是不是没有根据变动更改前端服务要看到的内容。」
#
# 他说中了：页面改了，喂给模型的那份「世界观」没跟着改，于是它拿着旧地图给他指路。


def test_every_prompt_carries_the_current_page_map(srv):
    """三种提示词都要带**现在的**四页，否则模型只能照旧地图说话。"""
    for prompt in (
        srv._conv_prompt("先写故事大纲吧", "项目：X"),
        srv._conv_prompt("这一页不合适", "项目：X", intent="feedback"),
        srv._dev_prompt("把版本行收起来", "故事开发 · 故事核心", "项目：X"),
    ):
        for page in ("故事核心", "故事大纲", "结构规划", "正文创作"):
            assert page in prompt, f"提示词里没有「{page}」"
        assert "不要提" in prompt and "创意简报" in prompt, "旧名字要被显式禁掉"


def test_the_facts_never_call_it_a_creative_brief_again(app):
    """字段本身仍是事实，但**换成他屏幕上的说法**：它们写在故事核心里。"""
    app._write_work({"core": "有内容"})
    facts = app._conv_facts("作品")
    assert "创意简报" not in facts, "这一页已经不存在了，不许再催他去填"


def test_the_three_episode_counts_are_named_apart(app, tmp_path):
    """结构规划 12 行 / 正文创作计划 2 集 / 生产文档 12 集 —— 三个不同的数。

    他撞到的是 Agent 把它们读成「对不上」。事实里要各自说清楚是什么，
    模型才问得出**一个具体的问题**，而不是报一句矛盾。
    """
    import json

    # 先落一份文档（fixture 只建目录，不写文件）
    app._write_work({})
    root = app._projects["作品"]
    doc = json.loads((root / "studio" / "canvas.json").read_text("utf-8"))
    doc["story"]["work"] = {
        "form": "episode",
        "planned": {"novel": 0, "episode": 2},
        "plan": {"rows": [{"id": f"sp-{i}", "unitNo": str(i)} for i in range(1, 13)]},
        "units": [],
    }
    doc["production"]["episodes"] = [
        {"episodeId": f"ep-{i}", "title": f"第 {i} 集"} for i in range(1, 13)
    ]
    (root / "studio" / "canvas.json").write_text(
        json.dumps(doc, ensure_ascii=False), "utf-8"
    )
    facts = app._conv_facts("作品")
    assert "结构规划（12 行" in facts
    assert "计划 2 集" in facts
    # 产品负责人 2026-08-30：「结构规划和集数要一致这本来就是错误的思考模式。
    # 不一定要一致」——事实里要**明说它不是矛盾**，否则 Agent 每一轮都提醒他一次。
    assert "不必一致，也不是问题" in facts
    assert "除非他主动问，否则不要提这件事" in facts
    assert "生产文档里的分集（12 集" in facts, "生产侧的集数要标明它是生产侧的"
