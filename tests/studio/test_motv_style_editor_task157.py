"""TASK-157 / REQ-010 判据 1、4、6：「改一改这一章的文字」落到去味的那个能力。

盯三件会静默出错的事：

1. **改 vs 写分得开**：「这一章太有 AI 味了，改一下」→ `novel-style-editor`；
   「写这一章」→ `novel-chapter-writer`。靠的是既有的「修改动作匹配」那一项排序键
   （ADR-0091 决策 2 第 2 项），所以新 intent 必须**真的**进 `_CONV_REVISION_INTENTS` ——
   漏了这一步，它就只是一个普通的创作类候选，「改一下」会被当成「再写一章」。
2. **剧集侧不受影响**：`form: "novel"` 把它排除；剧本那边照旧走它自己的修订能力。
3. **包真的加载了**：`selectWhen` 上限 6、intent 必须在词表里 —— 这两条各撞过一次
   （TASK-152 / TASK-154）。
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

_SPEC = importlib.util.spec_from_file_location(
    "skillpkg_task157", _MOCKUP / "skillpkg.py"
)
skillpkg = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = skillpkg
_SPEC.loader.exec_module(skillpkg)

_READY = {
    "brief",
    "outline",
    "characters",
    "relationships",
    "world",
    "chapterPlan",
    "chapterText",
    "episodeScript",
}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location(
        "motv_server_style_157", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog():
    return skillpkg.load_catalog([("builtin", _BUILTIN)])


def _resolve(srv, catalog, *, goal, form="novel", capability="episode-production"):
    return srv._conv_resolve(
        catalog,
        capability,
        goal=goal,
        scope="project",
        ready=_READY,
        shot_id="",
        form=form,
    )


# --- 3. 包真的加载了 ------------------------------------------------------------ #


def test_the_style_editor_loads_and_declares_what_it_reads(catalog):
    assert "novel-style-editor" in catalog.skills, [p.reason for p in catalog.problems]
    skill = catalog.skills["novel-style-editor"]
    assert skill.inputs == ("chapterText",), "它要改的是已有的正文，那就是必填"
    internal = skill.routing["internalRouting"]
    assert internal["intent"] == "prose-revision"
    assert internal["form"] == "novel"
    assert internal["kind"] == "generative", "它产出可写回的正文，不是一份意见"


def test_the_new_intent_counts_as_a_revision(srv):
    """漏了这一步，「改一下」就会被当成「再写一章」—— 整条判据 4 塌掉。"""
    assert "prose-revision" in srv._CONV_REVISION_INTENTS


def test_the_writer_is_bumped_and_says_what_not_to_sound_like(catalog):
    skill = catalog.skills["novel-chapter-writer"]
    assert skill.version == 3, "提示词变了，版本必须动（ADR-0067）"
    for tell in ("三短句排比", "参差", "不是 X，是 Y", "结尾不要升华"):
        assert tell in skill.instruction, tell


def test_the_writer_does_not_hand_back_what_it_just_forbade(catalog):
    """禁令后面跟一句「一次就够了」，等于没禁（codex 轮 1）。"""
    instruction = catalog.skills["novel-chapter-writer"].instruction
    assert "一章里出现一次就够了" not in instruction


def test_every_edit_gets_an_explanation(catalog):
    """判据 2 要的是「每一处改动」都说得出来。

    第一版改成「挑 3～12 条有代表性的」，是为了把「改多少」与「说几条」拆开；
    但那样他就无法逐条看你有没有把味道之外的东西也改掉。真机重跑证明担心是多余的：
    改成逐条全列之后，改动从 12 处变成 23 处（卡 §7）。
    """
    instruction = catalog.skills["novel-style-editor"].instruction
    assert "每一处改动都要列" in instruction
    assert "代表性" not in instruction, "取样描述已撤销"

    schema = json.loads(
        (_BUILTIN / "novel-style-editor" / "output.schema.json").read_text("utf-8")
    )
    changes = schema["fields"]["changes"]
    assert changes["minItems"] == 1
    assert changes["maxItems"] >= 60, "上限不得低到逼它漏报改动"


# --- 1. 改 vs 写 ---------------------------------------------------------------- #


@pytest.mark.parametrize(
    "goal",
    [
        "这一章太有 AI 味了，改一下",
        "这一章的AI味太重，帮我改改",
        "把这一章的文字润色一下，别那么机器味",
        "改一下这一章的文风",
    ],
)
def test_asking_to_fix_the_prose_goes_to_the_style_editor(srv, catalog, goal):
    plan, refusal = _resolve(srv, catalog, goal=goal)
    assert refusal is None
    assert plan["skillId"] == "novel-style-editor", plan["reason"]


@pytest.mark.parametrize("goal", ["写这一章", "接着往下写 3 章", "写这一章的正文"])
def test_asking_to_write_still_goes_to_the_novelist(srv, catalog, goal):
    plan, refusal = _resolve(srv, catalog, goal=goal)
    assert refusal is None
    assert plan["skillId"] == "novel-chapter-writer", plan["reason"]


# --- 2. 剧集侧不受影响 ---------------------------------------------------------- #


def test_an_episode_project_never_gets_the_novel_style_editor(srv, catalog):
    plan, refusal = _resolve(
        srv, catalog, goal="改一改这一集剧本的文字", form="episode"
    )
    assert refusal is None
    assert plan["skillId"] != "novel-style-editor", plan["reason"]


def test_revising_a_script_still_goes_to_the_script_reviser(srv, catalog):
    plan, refusal = _resolve(
        srv, catalog, goal="按我的意见改这一集的剧本", form="episode"
    )
    assert refusal is None
    assert plan["skillId"] in {"script-reviser", "script-doctor"}, plan["reason"]
