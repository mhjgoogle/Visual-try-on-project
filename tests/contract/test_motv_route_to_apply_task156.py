"""TASK-156：**选中的能力，跑完要有人能把它用上** —— 服务端选择与前端写回之间那道缝。

2026-09-18 真实项目上那次「说是写好了但是内容完全没有」，是两件事叠出来的：

1. 服务端选错了能力（TASK-156 的排序修复，守卫在 `tests/studio/`）；
2. **没有任何一处保证「服务端选得出的 skillId」与「前端写得回的 skillId」是同一批**。

第 2 件正是跨边界的东西，按 ADR-0080 决策 3 住 `tests/contract/`（读前端 `skillapply.js`
的先例在 `test_motv_skill_routing_task119.py` 里已经有）。

这份测试钉的是那道缝：**resolver 对那句真实的话选出来的能力，必须有一条 `can: true` 的
写回路径，且写的是「结构规划」那张表。** 提案真的按九列落进表、旧行进回收区、可恢复 ——
那一半在 `mockups/motv-workspace/tests/structureplan.test.mjs` 的真 controller 测试里
（TASK-154）；这里接上的是它前面那一环。
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
    "skillpkg_route_apply_156", _MOCKUP / "skillpkg.py"
)
skillpkg = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = skillpkg
_SPEC.loader.exec_module(skillpkg)

#: 真实那一轮模型报上来的 goal（逐字，取自 照见未明/studio/conversation.json）。
_REAL_GOAL = (
    "请填充内容：把结构规划表的 12 行（九列）按故事大纲和人物设定填上，"
    "从当前的 EP01 第 1 集开始，每一集讲什么、对应大纲哪些节点"
)

_READY = {"brief", "outline", "characters", "relationships", "world", "episodePlan"}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location(
        "motv_server_route_apply_156", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog():
    return skillpkg.load_catalog([("builtin", _BUILTIN)])


@pytest.fixture(scope="module")
def applier_js():
    return (_MOCKUP / "src" / "workflow" / "skillapply.js").read_text("utf-8")


def _apply_block(js: str, skill_id: str) -> str:
    """`APPLY_TARGETS` 里这个能力那一段（够看清 can / target / label）。"""
    parts = js.split(f'"{skill_id}":')
    assert len(parts) > 1, f"{skill_id} 在 APPLY_TARGETS 里根本没有条目"
    return parts[1][:400]


def test_the_capability_chosen_for_the_real_goal_can_be_written_back(
    srv, catalog, applier_js
):
    """他那句话选出来的能力，必须写得回「结构规划」那张表。

    这条把两个域接起来：Python 侧选出 skillId，JS 侧按同一个 skillId 找写回路径。
    两边任何一侧改了名字而另一侧没跟上，它就红 —— 而屏幕上的表现正是那次的
    「说是写好了但是内容完全没有」。
    """
    plan, refusal = srv._conv_resolve(
        catalog,
        "story-development",
        goal=_REAL_GOAL,
        scope="project",
        ready=_READY,
        shot_id="",
        form="episode",
    )
    assert refusal is None
    skill_id = plan["skillId"]
    assert skill_id == "structure-planner", plan["reason"]

    block = _apply_block(applier_js, skill_id)
    assert "can: true" in block, f"{skill_id} 跑完没人能把它用上"
    assert 'target: "plan"' in block, f"{skill_id} 写回的不是结构规划那张表"


def test_every_capability_this_chain_added_has_a_write_back_path(catalog, applier_js):
    """REQ-009 这条链新增的三个生成类能力，每一个都写得回去。

    只钉这三个，不钉全部 `kind: generative`：目录里还有本次之前就存在的不一致
    （`script-doctor` 的写回路径拿不到东西可写，见 TASK-119 那份测试的说明），
    在这里一并断言等于让这张卡去修它没碰过的缺陷（AGENTS.md 第 17 条）。
    """
    for skill_id in ("novel-chapter-writer", "structure-planner", "novel-adapter"):
        assert skill_id in catalog.skills
        internal = catalog.skills[skill_id].routing["internalRouting"]
        assert internal["kind"] == "generative"
        assert "can: true" in _apply_block(applier_js, skill_id), skill_id
