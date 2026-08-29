"""TASK-119 / ADR-0091：前端 Agent 只认三类工作，选哪个专业能力归服务端。

这份测试盯的是四件会静默出错的事：

1. **收敛是真的**（决策 1）。提示词里只出现三个用户能力，长度**不随装了多少包
   增长**，而且一个内部专业能力的名字、关键词、输入契约都不许漏进去。漏一个进去，
   模型下一轮就会去点名它 —— 而那正是这次收敛要去掉的路由争抢。
2. **模型无权指定内部能力**（决策 1）。它给的 `skillId` 一律被丢掉；能出现在计划里
   的 skillId 只可能来自服务端的 resolver。
3. **resolver 的选择是确定性的、可复核的**（决策 2）。同一句话永远选同一个；
   「检查这一集剧本」「检查镜头连续性」「各层还同步吗」不会被同一个泛化能力吞掉。
4. **不就绪就说缺什么，不静默降级**（决策 2）。选中的仍然是最合适的那个，
   action 变成 `ask` 并列出缺的材料 —— 「我不知道你要什么」和「我知道但你还缺材料」
   是两个不同的答案，后者他能照着补。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"

#: 一个「什么都有」的项目：就绪状态由前端报，这里直接给全集。
_ALL_READY = {
    "brief",
    "outline",
    "characters",
    "relationships",
    "world",
    "episodePlan",
    "currentPlan",
    "episodeScript",
    "scenes",
    "shots",
    "references",
    "assets",
    "generations",
    "timeline",
    "shotAudio",
    "subtitles",
}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_caps_119", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog(srv):
    return srv._load_skill_catalog()


@pytest.fixture(scope="module")
def caps(srv, catalog):
    return srv._conv_capabilities(catalog, srv._user_capabilities())


# --- 1. 收敛：提示词里只有三类 ------------------------------------------------ #


def test_the_agent_sees_exactly_three_capabilities(srv, caps) -> None:
    assert [c["id"] for c in caps] == [
        "story-development",
        "episode-production",
        "story-review",
    ]
    # 文件里的 id 集合与代码里的封闭元组必须逐字相等 —— 两处各持一份名单必然漂移，
    # 而漂移的表现是「某一类请求安静地永远选不中」，屏幕上看不出来。
    import sys

    sys.path.insert(0, str(_REPO / "mockups" / "motv-workspace"))
    import skillpkg

    assert tuple(c["id"] for c in caps) == skillpkg.USER_CAPABILITIES


def test_the_prompt_names_no_internal_capability(srv, caps, catalog) -> None:
    """决策 1 的硬判据：内部能力的 id、关键词、输入契约一个都不进提示词。"""
    prompt = srv._conv_prompt("帮我看看这一集", "事实", None, "work", caps)
    facades = {c["id"] for c in caps}
    for skill in catalog.available():
        if skill.skill_id in facades:
            # `story-development` 既是一个 facade 名也是一个内部能力名 —— 它出现在
            # 提示词里是**作为 facade**。两者活在不同字段里（capability / skillId），
            # 协议上不可能混淆，见下面那条测试。
            continue
        assert skill.skill_id not in prompt, f"{skill.skill_id} 漏进了提示词"
        if skill.routing:
            # 关键词是 resolver 私有的。判据是**这一串有没有被整体渲染进去** ——
            # 逐词断言是错的判法：`这一镜` 这类词在正常中文里本来就会出现
            # （提示词里那句「他说『这个』『当前』『这一页』『这一镜』时」），
            # 那不是泄漏，而 selectWhen 整串出现才是。
            words = skill.routing["internalRouting"]["selectWhen"]
            for sep in ("、", "／", "/", ", ", ","):
                assert sep.join(words) not in prompt, (
                    f"{skill.skill_id} 的关键词整串泄漏"
                )
    for word in ("selectWhen", "internalRouting", "outputSchema", "skillId"):
        assert word not in prompt


def test_the_prompt_does_not_grow_with_the_catalog(srv, caps) -> None:
    """这一段的长度与装了多少包无关 —— 收敛本身就是这一条。"""
    block = srv._conv_capability_text(caps)
    # 三条能力 + 每条一行例句 = 6 行。装第 29 个包也还是 6 行。
    assert len(block.splitlines()) == 6
    assert block.count("story-development") == 1


def test_the_feedback_window_gets_no_capabilities_at_all(srv, caps) -> None:
    """「开发」窗口里作品能力根本不该被提起 —— 词汇表本身就是那道闸。"""
    prompt = srv._conv_prompt("这一页不好用", "事实", None, "feedback", caps)
    for cap in caps:
        assert cap["id"] not in prompt


def test_no_capabilities_means_the_whole_mechanism_is_absent(srv) -> None:
    """目录读不出来时不描述一个不存在的机制 —— 那会教模型承诺做不到的事。"""
    prompt = srv._conv_prompt("帮我写剧本", "事实", None, "work", [])
    assert "capability" not in prompt
    assert srv._conv_prompt("x", "y", None, "work", None)  # None 也不能炸


# --- 2. 模型无权指定内部能力 -------------------------------------------------- #


def test_a_model_supplied_skill_id_is_dropped(srv) -> None:
    """模型即使报了 skillId 也不作数（决策 1）。"""
    route = srv._adapt_route(
        {"capability": "story-review", "goal": "查一下", "skillId": "story-zoom"}
    )
    assert route is not None
    assert "skillId" not in route, "内部执行什么，从来不由模型说了算"


def test_an_unknown_capability_is_not_a_route(srv) -> None:
    for bad in (
        {"capability": "make-me-a-movie"},
        {"capability": ""},
        {"capability": 7},
        {"skillId": "story-zoom"},  # 只给内部 id：不是一条合法 route
        "not-an-object",
        None,
    ):
        assert srv._adapt_route(bad) is None


def test_route_fields_are_bounded(srv) -> None:
    route = srv._adapt_route(
        {
            "capability": "story-review",
            "goal": "长" * 5000,
            "scope": "宇宙",
            "missing": ["a" * 500] * 50,
        }
    )
    assert len(route["goal"]) <= srv._CONV_ROUTE_WHY_MAX
    assert route["scope"] == "", "不认识的范围读成没说，而不是原样带走"
    assert len(route["modelMissing"]) <= srv._CONV_ROUTE_MISSING_MAX
    assert all(len(x) <= 80 for x in route["modelMissing"])


# --- 3. resolver：确定性、可复核、不互相吞 ------------------------------------- #


@pytest.mark.parametrize(
    "capability,goal,scope,expected",
    [
        # 「检查」这三句必须分别落到三个不同的诊断器上（验收标准 4）
        ("story-review", "这一集剧本有什么问题", "episode", "script-doctor"),
        ("story-review", "镜头之间的连续性对得上吗", "episode", "continuity-reviewer"),
        (
            "story-review",
            "我改了大纲，各层还同步吗",
            "project",
            "story-zoom",
        ),
        (
            "story-review",
            "观众会不会觉得无聊",
            "project",
            "audience-engagement-reviewer",
        ),
        # 制作侧
        ("episode-production", "把这一集拆成分镜", "episode", "storyboard-director"),
        ("episode-production", "帮我改一下这一集的剧本", "episode", "script-reviser"),
        # 故事侧
        ("story-development", "帮我搭建世界观", "episode", "world-director"),
        (
            "story-development",
            "这几个人物之间是什么关系",
            "project",
            "relationship-director",
        ),
        ("story-development", "分几集、每集讲什么", "project", "episode-planner"),
    ],
)
def test_the_resolver_picks_the_right_internal_skill(
    srv, catalog, capability, goal, scope, expected
) -> None:
    plan, refusal = srv._conv_resolve(
        catalog, capability, goal=goal, scope=scope, ready=_ALL_READY, shot_id="s-1"
    )
    assert refusal is None, refusal
    assert plan["skillId"] == expected, plan["reason"]
    assert plan["capability"] == capability
    # 可观测性（决策 5）：为什么选它，必须说得出来
    assert plan["reason"].strip()


def test_story_zoom_does_not_swallow_a_plain_check(srv, catalog) -> None:
    """「检查一下」不该总是跑跨层诊断（验收标准 4 的反面）。

    它的优先级是这一类里最低的，而且只认跨层措辞 —— 泛泛一句「检查」点不到它的
    关键词，所以关键词命中这一档它排不进去，落回优先级顺序。
    """
    plan, _ = srv._conv_resolve(
        catalog,
        "story-review",
        goal="检查一下",
        scope="episode",
        ready=_ALL_READY,
        shot_id="",
    )
    assert plan["skillId"] != "story-zoom"
    assert plan["skillId"] == "script-doctor", "站在某一集上时，默认查的是这一集的剧本"


def test_the_same_sentence_always_resolves_the_same_way(srv, catalog) -> None:
    """确定性：没有一处依赖目录遍历顺序或字典顺序的偶然。"""
    picks = {
        srv._conv_resolve(
            catalog,
            "story-review",
            goal="连续性有没有问题",
            scope="episode",
            ready=_ALL_READY,
            shot_id="",
        )[0]["skillId"]
        for _ in range(5)
    }
    assert len(picks) == 1


def test_an_unknown_capability_is_refused_not_silently_downgraded(srv, catalog) -> None:
    plan, refusal = srv._conv_resolve(
        catalog,
        "no-such-capability",
        goal="随便",
        scope="",
        ready=_ALL_READY,
        shot_id="",
    )
    assert plan is None
    assert "no-such-capability" in refusal


# --- 4. 不就绪就说缺什么 ------------------------------------------------------- #


def test_missing_inputs_become_an_ask_not_a_silent_run(srv, catalog) -> None:
    """一个空项目里要写剧本 —— 仍然选中写剧本那个，但说清缺什么。"""
    plan, refusal = srv._conv_resolve(
        catalog,
        "episode-production",
        goal="写这一集的剧本",
        scope="episode",
        ready=set(),
        shot_id="",
    )
    assert refusal is None
    assert plan["skillId"] == "script-writer", "缺材料不改变「他要做什么」"
    assert plan["action"] == "ask"
    assert plan["missing"], "要说得出缺哪几样"
    # 说的是**他看得懂的名字**，不是上下文键名（决策 5）
    assert all(not m.isascii() for m in plan["missing"]), plan["missing"]


def test_a_shot_scoped_pick_without_a_shot_asks_for_one(srv, catalog) -> None:
    """镜头域能力没有选中的镜头 —— 这是 scope 在这里唯一的硬约束。"""
    plan, _ = srv._conv_resolve(
        catalog,
        "story-review",
        goal="这一镜和前后镜衔接得上吗",
        scope="shot",
        ready=_ALL_READY,
        shot_id="",
    )
    assert plan["skillId"] == "shot-continuity-reviewer"
    assert plan["action"] == "ask"
    assert "选中的镜头" in plan["missing"]


def test_the_revision_request_is_his_own_sentence_never_a_missing_input(
    srv, catalog
) -> None:
    """修改类能力要的「修改要求」就是他说的那句话 —— 不该反过来问他要。"""
    plan, _ = srv._conv_resolve(
        catalog,
        "story-development",
        goal="把大纲的结局改得更狠一点",
        scope="project",
        ready=_ALL_READY,
        shot_id="",
    )
    assert plan["action"] == "run"
    assert "修改要求" not in plan["missing"]


# --- 5. 窗口闸与拒绝的可读性 --------------------------------------------------- #


def _run(context, capability="story-review", goal="查一下这一集剧本"):
    return {
        "context": context,
        "outputs": {
            "conversation": {"route": {"capability": capability, "goal": goal}}
        },
    }


def test_the_feedback_window_refuses_every_work_capability(srv, tmp_path) -> None:
    app = srv._App(tmp_path)
    plan, rejected = app._conv_check_route(
        "无此项目",
        _run({"intent": "feedback"}),
        {"capability": "story-review", "goal": "查一下"},
    )
    assert plan is None
    assert rejected is not None
    assert "开发" in rejected["reason"] and "作品" in rejected["reason"]


def test_a_rejection_says_why_rather_than_vanishing(srv, tmp_path) -> None:
    app = srv._App(tmp_path)
    app._projects["p"] = tmp_path / "p"
    plan, rejected = app._conv_check_route(
        "p", _run({"intent": "work"}), {"capability": "not-a-capability"}
    )
    assert plan is None
    assert rejected["reason"].strip(), (
        "被静默丢掉的路由，看起来就是它答应了然后什么都没干"
    )


def test_ready_inputs_come_from_the_turns_own_context(srv) -> None:
    """就绪状态看这一轮 run **自己的** context，不是前端事后声称的。"""
    assert srv._conv_ready_inputs({"readyInputs": ["outline", "brief"]}) == {
        "outline",
        "brief",
    }
    assert srv._conv_ready_inputs({"readyInputs": "不是列表"}) == set()
    assert srv._conv_ready_inputs(None) == set()
    # 有界：它进 resolver
    big = srv._conv_ready_inputs({"readyInputs": [f"k{i}" for i in range(200)]})
    assert len(big) <= srv._CONV_READY_MAX


def test_the_plan_is_observable(srv, catalog) -> None:
    """决策 5：交出去的是哪一类、最后选中哪个、为什么、什么范围、缺什么。"""
    plan, _ = srv._conv_resolve(
        catalog,
        "story-review",
        goal="这一集剧本有什么问题",
        scope="episode",
        ready=_ALL_READY,
        shot_id="",
    )
    for key in (
        "capability",
        "skillId",
        "skillVersion",
        "title",
        "intent",
        "kind",
        "scope",
        "reason",
        "missing",
        "action",
        "goal",
    ):
        assert key in plan, f"缺少可观测字段 {key}"
    assert json.dumps(plan, ensure_ascii=False), "计划要能整份写进 run 记录"
