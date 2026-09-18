"""TASK-156：命中更具体的那个词就该赢 —— 真实项目上「请填充内容」落错了能力。

2026-09-18 产品负责人在「照见未明」的结构规划页说「请填充内容」，界面回「好，我来填结构
规划表……」，表却完全是空的。线程记录里那一轮的 route 是 `story-development`：模型没错
（capability 报的是「开发故事」，goal 也写明了「把结构规划表…填上」），
错的是服务端排序 ——

    story-development  命中「故事、大纲」    2 个，最长 2，priority 80  ← 原来赢
    structure-planner  命中「结构规划、规划表」2 个，最长 4，priority 75

他的话里既有**对象**（结构规划表）也有**输入材料**（故事大纲），排序把两者当成同等证据，
再让 priority 决胜负。修法：在命中数与 priority 之间插一个键 —— **最长命中词的长度**。

这份测试钉三件事：

1. **真实那条 goal** 现在落到 `structure-planner`（回归守卫：去掉那个键就红）。
2. **泛问仍归泛能力**：只提故事 / 大纲的说法照旧 `story-development`。
3. **键的语义**：命中数仍是第一位；一个词都没命中时行为不变。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"

_SPEC = importlib.util.spec_from_file_location(
    "skillpkg_task156", _MOCKUP / "skillpkg.py"
)
skillpkg = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = skillpkg
_SPEC.loader.exec_module(skillpkg)

#: 真实那一轮，模型报上来的 goal（逐字，取自 照见未明/studio/conversation.json）。
_REAL_GOAL = (
    "请填充内容：把结构规划表的 12 行（九列）按故事大纲和人物设定填上，"
    "从当前的 EP01 第 1 集开始，每一集讲什么、对应大纲哪些节点"
)

_READY = {"brief", "outline", "characters", "relationships", "world", "episodePlan"}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location(
        "motv_server_specificity_156", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog():
    return skillpkg.load_catalog([("builtin", _REPO / "product-skills" / "builtin")])


def _resolve(srv, catalog, *, goal, form="", capability="story-development"):
    return srv._conv_resolve(
        catalog,
        capability,
        goal=goal,
        scope="project",
        ready=_READY,
        shot_id="",
        form=form,
    )


# --- 1. 真实那一条 ------------------------------------------------------------- #


@pytest.mark.parametrize("form", ["episode", "novel", ""])
def test_the_real_goal_now_lands_on_the_structure_planner(srv, catalog, form):
    """他站在结构规划页说的那句话，要落到填那张表的能力上。"""
    plan, refusal = _resolve(srv, catalog, goal=_REAL_GOAL, form=form)
    assert refusal is None
    assert plan["skillId"] == "structure-planner", plan["reason"]


def test_the_two_candidates_really_were_tied_on_hit_count(srv, catalog):
    """把当初打平的那一对钉住：命中数相同、具体度不同 —— 这条红了说明前提变了。"""
    rows = {r["skillId"]: r for r in srv._conv_candidates(catalog, "story-development")}
    generic, specific = rows["story-development"], rows["structure-planner"]
    assert srv._conv_hits(_REAL_GOAL, generic["selectWhen"]) == srv._conv_hits(
        _REAL_GOAL, specific["selectWhen"]
    )
    assert srv._conv_specificity(
        _REAL_GOAL, specific["selectWhen"]
    ) > srv._conv_specificity(_REAL_GOAL, generic["selectWhen"])
    assert specific["priority"] < generic["priority"], (
        "本条的意义正是「更具体但 priority 更低也要赢」"
    )


# --- 2. 泛问仍归泛能力 ---------------------------------------------------------- #


@pytest.mark.parametrize(
    "goal",
    [
        "根据故事核心来生成大纲",
        "帮我把这个想法发展成一个故事",
        "把大纲的主线再理一遍",
    ],
)
def test_a_plain_story_request_still_goes_to_story_development(srv, catalog, goal):
    plan, refusal = _resolve(srv, catalog, goal=goal)
    assert refusal is None
    assert plan["skillId"] == "story-development", plan["reason"]


# --- 3. 键的语义 ---------------------------------------------------------------- #


def test_specificity_is_the_longest_matched_keyword(srv):
    words = ["故事", "结构规划", "规划表"]
    assert srv._conv_specificity("把结构规划表填上", words) == 4
    assert srv._conv_specificity("讲个故事", words) == 2
    assert srv._conv_specificity("什么都没点到", words) == 0
    assert srv._conv_specificity("", words) == 0
    assert srv._conv_specificity("结构规划", []) == 0


def test_hit_count_still_outranks_specificity(srv, catalog):
    """命中数仍是第一位 —— 具体度只在命中数打平时说话。

    `world-director` 只命中「设定」一个词；`story-development` 命中「故事、大纲」两个。
    即使前者的词一样长，也不该因为具体度而翻盘。
    """
    plan, _ = _resolve(srv, catalog, goal="按这份设定把故事大纲理一遍")
    assert plan["skillId"] == "story-development", plan["reason"]


def test_with_no_hits_at_all_the_old_order_decides(srv, catalog):
    """一个词都没命中时行为不变：仍由 scope / 就绪 / priority 决定。

    具体度为 0 时它对排序**没有话说**，所以理由里也不许冒出一句「点到了某某」——
    编一句听起来合理的理由，正是决策 5 要挡的那种（ADR-0091）。
    """
    plan, refusal = _resolve(srv, catalog, goal="随便做点什么")
    assert refusal is None
    assert plan["skillId"] == "story-development", plan["reason"]
    assert "点到了" not in plan["reason"], plan["reason"]
    assert "范围是整个项目" in plan["reason"]
