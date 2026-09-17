"""TASK-152 / REQ-009 判据 4：「接着往下写几章」由服务端认出来，挂在写章的计划上。

前端只透传 `route.continuation`，不读他的话（ADR-0091 决策 1 的边界）。所以这里盯的
是服务端这一半会静默出错的三件事：

1. **认得出**：带「接着 / 继续 / 往下 / 连着 / 连续 / 再写」的写章请求 →
   `continuation`；章数从「N 章」读，阿拉伯数字与中文数字都认，读不到 = None
   （到 Planned 为止）。
2. **不乱认**：「写这一章」没有这些词，仍是切片一的单章路径 —— 没有 `continuation`。
3. **只挂在写章上**：剧集项目里「继续写这一集的剧本」选中的是 `script-writer`，
   计划上**没有** `continuation`；剧集侧一个字节不变（TASK-146 判据 4/5 的延续）。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"

_READY = {"brief", "outline", "characters", "relationships", "world", "episodePlan"}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_novel_152", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog(srv):
    return srv._load_skill_catalog()


# --- 1. 认得出 ---------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("goal", "count"),
    [
        ("接着往下写", None),
        ("接着写", None),
        ("继续写小说", None),
        ("接着往下写 3 章", 3),
        ("接着往下写3章", 3),
        ("再写两章", 2),
        ("连着写十二章", 12),
        ("继续写二十章", 20),
        ("一直写到底", None),
    ],
)
def test_a_continuation_is_recognised_with_its_count(srv, goal, count) -> None:
    assert srv._conv_continuation(goal) == {"count": count}


@pytest.mark.parametrize("goal", ["写这一章", "写第 3 章", "把这一章重写一遍", ""])
def test_a_single_chapter_request_is_not_a_continuation(srv, goal) -> None:
    assert srv._conv_continuation(goal) is None


@pytest.mark.parametrize("goal", ["接着写 0 章", "接着写零章", "接着写 abc 章"])
def test_an_unreadable_or_zero_count_means_to_the_end_not_a_guess(srv, goal) -> None:
    """读不懂的数不猜：连写照常成立，只是「几章」回落到 Planned。"""
    assert srv._conv_continuation(goal) == {"count": None}


def test_chinese_numerals_are_read_not_guessed(srv) -> None:
    assert srv._conv_cn_int("三") == 3
    assert srv._conv_cn_int("十") == 10
    assert srv._conv_cn_int("十二") == 12
    assert srv._conv_cn_int("二十") == 20
    assert srv._conv_cn_int("二十三") == 23
    assert srv._conv_cn_int("两") == 2
    assert srv._conv_cn_int("零") is None
    assert srv._conv_cn_int("十十") is None


# --- 2/3. 挂在哪张计划上 ----------------------------------------------------- #


def _holder(srv):
    """定义了 `_conv_check_route` 的那个类 —— 它是实例方法，但只用到 `_projects`。"""
    for name in dir(srv):
        obj = getattr(srv, name)
        if isinstance(obj, type) and "_conv_check_route" in vars(obj):
            return obj
    raise AssertionError("server.py 里没有定义 _conv_check_route 的类")


def _check(srv, *, goal: str, form: str):
    """跑**真实的** `_conv_check_route`：项目名为空 → 目录取内置那一份。

    与真实调用同一段代码，只是 self 换成一个只有 `_projects` 的假件。
    """
    cls = _holder(srv)
    fake = type("S", (), {})()
    fake._projects = {}
    run = {"context": {"readyInputs": sorted(_READY), "form": form}}
    route = {"capability": "episode-production", "goal": goal, "scope": "project"}
    return cls._conv_check_route(fake, "", run, route)


def test_a_novel_continuation_lands_on_the_novelist_with_its_count(srv) -> None:
    plan, rejected = _check(srv, goal="接着往下写 3 章", form="novel")
    assert rejected is None
    assert plan["skillId"] == "novel-chapter-writer"
    assert plan["continuation"] == {"count": 3}


def test_a_single_chapter_in_a_novel_has_no_continuation(srv) -> None:
    plan, rejected = _check(srv, goal="写这一章", form="novel")
    assert rejected is None
    assert plan["skillId"] == "novel-chapter-writer"
    assert "continuation" not in plan, "「写这一章」被当成了连写"


def test_an_episode_project_never_gets_a_continuation(srv) -> None:
    """剧集侧一个字节不变：即使句子里有「继续」，计划上也没有这个字段。"""
    plan, rejected = _check(srv, goal="继续写这一集的剧本", form="episode")
    assert rejected is None
    assert plan["skillId"] == "script-writer"
    assert "continuation" not in plan
