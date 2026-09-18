"""TASK-154 / REQ-009 判据 3：前三步在小说语境下成立 —— 服务端这一半。

盯三件会静默出错的事：

1. **形态进了提示词**：`story-development` 的编译结果在 `workForm` 给出时带着
   「作品形态」那一块，且提示词正文不再自称「短剧编剧」。
2. **结构规划有人接**：小说项目里「帮我做结构规划」选中 `structure-planner`；
   剧集项目也一样（它不声明 form）；而「分几集、每集讲什么」**仍然**落
   `episode-planner` —— TASK-119 那条不变量一个字节不变。
3. **新包真的加载了**：`selectWhen` 超过 6 个整个包会静默消失（TASK-152 撞过），所以这里
   直接断言目录里有它、problems 里没有它。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
_BUILTIN = _REPO / "product-skills" / "builtin"
_INPUTS = _REPO / "product-skills" / "skill-inputs.json"

_SPEC = importlib.util.spec_from_file_location(
    "skillpkg_task154", _MOCKUP / "skillpkg.py"
)
skillpkg = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = skillpkg
_SPEC.loader.exec_module(skillpkg)

_READY = {"brief", "outline", "characters", "relationships", "world"}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location(
        "motv_server_structure_154", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog():
    return skillpkg.load_catalog([("builtin", _BUILTIN)])


@pytest.fixture(scope="module")
def labels():
    return skillpkg.load_input_labels(_INPUTS)


# --- 3. 新包真的加载了 ---------------------------------------------------------- #


def test_the_structure_planner_loads_and_the_two_new_inputs_have_labels(
    catalog, labels
):
    assert "structure-planner" in catalog.skills, [p.reason for p in catalog.problems]
    assert not [p for p in catalog.problems if p.skill_id == "structure-planner"]
    skill = catalog.skills["structure-planner"]
    assert skill.inputs == ("outline",)
    assert (
        "workForm" in skill.optional_inputs and "structurePlan" in skill.optional_inputs
    )
    assert labels["workForm"] and labels["structurePlan"], "新键没有中文标签"


def test_story_development_is_v4_and_declares_the_form(catalog):
    skill = catalog.skills["story-development"]
    assert skill.version == 4, "提示词变了，版本必须动（ADR-0067）"
    assert "workForm" in skill.optional_inputs


# --- 1. 形态进了提示词 ---------------------------------------------------------- #


def test_the_novel_form_reaches_the_compiled_prompt(catalog, labels):
    skill = catalog.skills["story-development"]
    context = {
        "brief": "深海考古队发现一座会说话的城市",
        "workForm": {"form": "novel", "word": "章", "planned": 12},
    }
    prompt = skillpkg.compile_prompt(skill, context, labels)
    # 看的是**数据块**，不是指令正文：指令里本来就写着「先看作品形态」，那不算证据
    assert '<数据 键="workForm">' in prompt, "workForm 没进提示词"
    assert '"form": "novel"' in prompt
    assert "短剧编剧" not in skill.instruction, "小说项目仍会被当成短剧来发展"
    assert "按**章**" in skill.instruction or "按章" in skill.instruction
    # 无条件句一律形态中立（codex 轮 1）：只按集写的举例会让小说项目拿到互相矛盾的用语
    for episode_only in ("例如「第 7 集前后」", "（目标集数）", "（单集时长方向）"):
        assert episode_only not in skill.instruction, episode_only
    assert "第 7 章前后" in skill.instruction


def test_without_a_form_the_prompt_has_no_form_block(catalog, labels):
    """旧端点不传 workForm —— 缺省行为要与之前一致：没有那一块，不是空的一块。"""
    skill = catalog.skills["story-development"]
    prompt = skillpkg.compile_prompt(skill, {"brief": "一个想法"}, labels)
    assert '<数据 键="workForm">' not in prompt


# --- 2. 结构规划有人接，分集不被抢 ------------------------------------------------ #


def _resolve(srv, catalog, *, goal, form, capability="story-development"):
    return srv._conv_resolve(
        catalog,
        capability,
        goal=goal,
        scope="project",
        ready=_READY,
        shot_id="",
        form=form,
    )


@pytest.mark.parametrize("form", ["novel", "episode", ""])
@pytest.mark.parametrize("goal", ["帮我做结构规划", "帮我分章", "填一下结构表"])
def test_structure_planning_lands_on_the_structure_planner(srv, catalog, form, goal):
    plan, refusal = _resolve(srv, catalog, goal=goal, form=form)
    assert refusal is None
    assert plan["skillId"] == "structure-planner", plan["reason"]


@pytest.mark.parametrize("form", ["episode", ""])
def test_episode_splitting_still_goes_to_the_episode_planner(srv, catalog, form):
    """TASK-119 的不变量：「分几集、每集讲什么」→ episode-planner，一个字节不变。"""
    plan, refusal = _resolve(srv, catalog, goal="分几集、每集讲什么", form=form)
    assert refusal is None
    assert plan["skillId"] == "episode-planner", plan["reason"]


def test_developing_the_story_still_goes_to_story_development(srv, catalog):
    plan, refusal = _resolve(
        srv, catalog, goal="帮我把这个想法发展成一个故事", form="novel"
    )
    assert refusal is None
    assert plan["skillId"] == "story-development", plan["reason"]


def test_the_flow_pin_follows_the_new_version():
    flow = json.loads(
        (_REPO / "product-flows" / "builtin" / "episode-from-scratch" / "manifest.json")
        .read_bytes()
        .decode("utf-8")
    )
    step = next(s for s in flow["steps"] if s["skillId"] == "story-development")
    assert step["skillVersion"] == 4, "流程还钉着旧版本，加载时会指名道姓地报缺"
