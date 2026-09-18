"""TASK-155 / REQ-009 判据 5：「把它做成剧集」由服务端选中改编策划 —— 服务端这一半。

盯三件会静默出错的事：

1. **新包真的加载了**（`selectWhen` ≤ 6、intent 在词表里、同 facade 下不重复）。
2. **小说项目里落改编策划**：「把它做成剧集」「分几集、每集讲什么」「改编成剧集」在两个
   facade（开发故事 / 制作这一集）下都选中 `novel-adapter` —— 后者靠 priority 85 压过
   `episode-planner` 的 70。
3. **剧集项目一个字节不变**：`form: "novel"` 把它排除，「分几集、每集讲什么」仍落
   `episode-planner`（TASK-119 不变量）。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
_BUILTIN = _REPO / "product-skills" / "builtin"

_SPEC = importlib.util.spec_from_file_location(
    "skillpkg_task155", _MOCKUP / "skillpkg.py"
)
skillpkg = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = skillpkg
_SPEC.loader.exec_module(skillpkg)

_READY = {"brief", "outline", "characters", "relationships", "world", "novelChapters"}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location(
        "motv_server_adapter_155", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog():
    return skillpkg.load_catalog([("builtin", _BUILTIN)])


def test_the_adapter_loads_and_is_novel_only(catalog):
    assert "novel-adapter" in catalog.skills, [p.reason for p in catalog.problems]
    skill = catalog.skills["novel-adapter"]
    assert skill.inputs == ("novelChapters",)
    assert skill.routing["internalRouting"]["form"] == "novel"
    assert skill.routing["internalRouting"]["intent"] == "novel-adaptation"


def _resolve(srv, catalog, *, goal, form, capability):
    return srv._conv_resolve(
        catalog,
        capability,
        goal=goal,
        scope="project",
        ready=_READY,
        shot_id="",
        form=form,
    )


@pytest.mark.parametrize("capability", ["story-development", "episode-production"])
@pytest.mark.parametrize(
    "goal", ["把它做成剧集", "分几集、每集讲什么", "把这本小说改编成剧集", "拍成短剧"]
)
def test_a_novel_project_gets_the_adapter(srv, catalog, capability, goal):
    plan, refusal = _resolve(
        srv, catalog, goal=goal, form="novel", capability=capability
    )
    assert refusal is None
    assert plan["skillId"] == "novel-adapter", plan["reason"]


@pytest.mark.parametrize("capability", ["story-development", "episode-production"])
def test_an_episode_project_still_gets_the_episode_planner(srv, catalog, capability):
    plan, refusal = _resolve(
        srv, catalog, goal="分几集、每集讲什么", form="episode", capability=capability
    )
    assert refusal is None
    assert plan["skillId"] == "episode-planner", plan["reason"]


def test_writing_a_chapter_still_goes_to_the_novelist(srv, catalog):
    """「剧集」是改编的关键词，但「写这一章」里没有它 —— 小说家那条路不受影响。"""
    plan, refusal = _resolve(
        srv, catalog, goal="写这一章", form="novel", capability="episode-production"
    )
    assert refusal is None
    assert plan["skillId"] == "novel-chapter-writer", plan["reason"]
