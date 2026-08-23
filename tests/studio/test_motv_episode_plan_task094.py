"""TASK-094 批次 A / TASK-088：「用 AI 改分集规划」变成真的改。

产品负责人 2026-08-17 在真实项目 `照见未明rev2` 上看到的：目标 24 集，四版规划
各 12 条，剧集实体 **48 个**。成因是可测量的：

    planEpisodes({ outline, instruction })      # 当前规划根本不进上下文

所以每次「改」都是从头重写，四版的 EP01 标题完全不同；而每次「确认规划」都新建
12 集（提案的 episodeId 一律是 null）。

本文件钉住三件事：
1. 端点两模式（`episode-planner` / `episode-plan-reviser`），当前规划是**声明输入**；
2. 产品负责人的七项进了契约，而 3～6 条是**提示不是闸门**；
3. 身份来自**文档**，绝不来自模型答案（ADR-0072 决策 1）。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"

_PLAN_ANSWER = json.dumps(
    {
        "episodes": [
            {
                "epNumber": 1,
                "title": "被抹除的核验员",
                "coreGoal": "确立世界规则与越界的代价",
                "keyEvents": ["她救下不可被救的人", "世界开始收走她", "她醒在终局世界"],
                "characterBeats": [{"who": "林照", "change": "第一次越界"}],
                "reveals": ["抹除不等于死亡"],
                "emotionArc": "平静 → 紧张 → 转折",
                "endingBeat": "她捡到刻着自己名字的旧校准牌",
                "hook": "被抹除的人为什么还活着？",
            }
        ]
    },
    ensure_ascii=False,
)


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        f"motv_server_094a_{tmp_path.name}", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "APP_DATA_DIR", tmp_path)
    # the legacy scratch too: `runs.json` falls back to the old in-repo
    # location when the app data dir has none (TASK-056), and the repo has a
    # real 300 KB journal that would otherwise boot into this test
    monkeypatch.setattr(module, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(module, "_RUNS", None)
    monkeypatch.setattr(module, "_executor_argv", lambda n: (["fake", n], "path"))
    return module


def _stub(module, monkeypatch, answer=_PLAN_ANSWER):
    seen: list[str] = []

    def fake(name, prompt, timeout, on_spawn=None):
        seen.append(prompt)
        return answer, None

    monkeypatch.setattr(module, "_run_executor", fake)
    return seen


def _post(app, payload, headers=None):
    resp = app.handle_post(
        "/api/agent/episode-plan", json.dumps(payload).encode("utf-8"), headers or {}
    )
    return resp.status, json.loads(resp.body.decode("utf-8"))


_CURRENT = [
    {"epNumber": 1, "title": "不可被救的人", "coreGoal": "建立", "keyEvents": ["a"]},
    {"epNumber": 2, "title": "回声", "coreGoal": "推进", "keyEvents": ["b"]},
]


# --- 两模式 ------------------------------------------------------------------ #


def test_the_mode_is_decided_in_one_place(srv) -> None:
    """当前规划 + 修改要求 = 修订；缺任何一个 = 重新规划。"""
    assert srv._skill_id_for("episode-plan", {"outline": {}}) == "episode-planner"
    assert (
        srv._skill_id_for("episode-plan", {"outline": {}, "instruction": "偏权谋"})
        == "episode-planner"
    ), "「重新规划」带方向指令，仍然是写一版新的"
    assert (
        srv._skill_id_for("episode-plan", {"current_plan": _CURRENT})
        == "episode-planner"
    ), "没有修改要求就没有要改的东西"
    assert (
        srv._skill_id_for(
            "episode-plan", {"current_plan": _CURRENT, "instruction": "第 2 集钩子太弱"}
        )
        == "episode-plan-reviser"
    )


def test_the_current_plan_actually_reaches_the_model(srv, monkeypatch) -> None:
    """TASK-088 §1.1 的直接反面：这是整个 48 集缺陷的根因。"""
    seen = _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(
        app,
        {
            "outline": {"logline": "l"},
            "current_plan": _CURRENT,
            "instruction": "第 2 集钩子太弱",
        },
    )
    assert status == 200, body
    prompt = seen[0]
    assert "不可被救的人" in prompt, "修订失去了它要修订的那份规划"
    assert "回声" in prompt
    assert "第 2 集钩子太弱" in prompt
    # 它是 DOMAIN CONTEXT，走 compile_prompt 的围栏，键名说明它是什么
    assert '<数据 键="currentPlan">' in prompt
    assert '<数据 键="revisionRequest">' in prompt
    # …而且修改要求**只出现一次**：reviser 模式下它是声明输入，不再另外围一遍
    assert prompt.count("第 2 集钩子太弱") == 1
    assert "### 当前分集规划" in prompt, "裸键名说明 skill-inputs.json 里缺标签"


def test_revision_runs_the_reviser_and_the_run_records_it(srv, monkeypatch) -> None:
    """答案要由**真正回答的那个包**的 schema 判定（ADR-0067 决策 3）。"""
    _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(
        app,
        {"outline": {"a": "b"}, "current_plan": _CURRENT, "instruction": "改第 2 集"},
    )
    assert status == 200, body
    run = srv.runs().get(body["run_id"])
    assert run["params"]["skillId"] == "episode-plan-reviser"
    assert run["params"]["skillVersion"] == 1
    assert run["params"]["skillDigest"].startswith("sha256:")
    # …而写一版新的记的是 planner，且版本是升过的那个
    _stub(srv, monkeypatch)
    status, body2 = _post(app, {"outline": {"a": "b"}})
    assert status == 200, body2
    planner_run = srv.runs().get(body2["run_id"])
    assert planner_run["params"]["skillId"] == "episode-planner"
    assert planner_run["params"]["skillVersion"] == 2


def test_the_cast_is_sent_so_characterBeats_can_name_a_real_person(
    srv, monkeypatch
) -> None:
    """`characters` 一直在 `optionalInputs` 里，但从来没有人送过 —— 于是
    「不得发明人物」这条约束在这个端点上是空的（TASK-088 §2.1）。"""
    seen = _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(
        app,
        {
            "outline": {"logline": "l"},
            "characters": [{"characterId": "c1", "name": "林照", "tier": "formal"}],
        },
    )
    assert status == 200, body
    assert "林照" in seen[0]
    assert '<数据 键="characters">' in seen[0]


# --- 请求校验（畸形的当前规划不得靠截断「修好」） ----------------------------- #


@pytest.mark.parametrize(
    "bad",
    [
        {"current_plan": "不是列表"},
        {"current_plan": [1, 2, 3]},
        {"current_plan": [{"epNumber": 1}] * 51},
    ],
)
def test_a_malformed_current_plan_is_refused_not_truncated(srv, bad) -> None:
    app = srv._App(None, None)
    status, body = _post(app, {"outline": {"a": "b"}, **bad})
    assert status == 400, body
    assert body["error"]["category"] in ("bad_request", "too_large")


def test_an_oversized_current_plan_is_refused_rather_than_cut_mid_episode(srv) -> None:
    """上下文 cap 会**截断**以保住可回答性；一份被截到一半的规划正是 reviser 会
    「原样保留」的那种坏拷贝，所以请求层直接拒。"""
    app = srv._App(None, None)
    huge = [{"epNumber": 1, "title": "x" * 70_000, "coreGoal": "g", "keyEvents": ["e"]}]
    status, body = _post(app, {"outline": {"a": "b"}, "current_plan": huge})
    assert status == 400
    assert body["error"]["category"] == "too_large"


def test_characters_must_be_a_list(srv) -> None:
    app = srv._App(None, None)
    status, body = _post(app, {"outline": {"a": "b"}, "characters": {"name": "林照"}})
    assert status == 400
    assert body["error"]["category"] == "bad_request"


# --- 契约：产品负责人的七项 -------------------------------------------------- #


def test_the_seven_facets_are_required_and_the_range_is_only_a_hint(srv) -> None:
    catalog = srv._load_skill_catalog()
    planner = catalog.skills["episode-planner"]
    reviser = catalog.skills["episode-plan-reviser"]
    assert planner.version == 2, "改了内容必须升版本（ADR-0067 §1.2）"

    entry = planner.output_schema["fields"]["episodes"]["of"]
    assert set(entry["required"]) == {"epNumber", "title", "coreGoal", "keyEvents"}
    for key in ("characterBeats", "reveals", "emotionArc", "endingBeat", "hook"):
        assert key in entry["fields"], f"产品负责人清单里的 {key} 不在契约里"
    # endingBeat 与 hook 是**两个**字段：真实数据里它们是两件事，合并会丢一个
    assert entry["fields"]["endingBeat"]["type"] == "string"
    assert entry["fields"]["hook"]["type"] == "string"
    # 两个包的输出契约必须一致 —— 修订的产物和新写的产物是同一种东西
    assert reviser.output_schema == planner.output_schema
    assert reviser.inputs == ("currentPlan", "revisionRequest")


def test_a_two_event_episode_is_accepted_by_the_contract(srv, monkeypatch) -> None:
    """「不足/超出如实提示，不拦死」（TASK-088 §2.3）——所以 schema 不能拦。
    写到一半的创作者不是在犯错，而拒收整份答案是最粗暴的拦法。"""
    answer = json.dumps(
        {
            "episodes": [
                {
                    "epNumber": 1,
                    "title": "t",
                    "coreGoal": "g",
                    "keyEvents": ["一", "二"],
                }
            ]
        },
        ensure_ascii=False,
    )
    _stub(srv, monkeypatch, answer)
    app = srv._App(None, None)
    status, body = _post(app, {"outline": {"a": "b"}})
    assert status == 200, body
    assert body["episodes"][0]["keyEvents"] == ["一", "二"]


def test_an_episode_with_no_key_events_at_all_is_refused(srv, monkeypatch) -> None:
    """空列表不是「写到一半」，是没有回答。"""
    answer = json.dumps(
        {"episodes": [{"epNumber": 1, "title": "t", "coreGoal": "g", "keyEvents": []}]},
        ensure_ascii=False,
    )
    _stub(srv, monkeypatch, answer)
    app = srv._App(None, None)
    status, body = _post(app, {"outline": {"a": "b"}})
    assert status == 502, body


def test_the_legacy_response_key_is_unchanged(srv, monkeypatch) -> None:
    """契约 §5.9c：调用方看到的键不变。"""
    _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(app, {"outline": {"a": "b"}})
    assert status == 200
    assert "episodes" in body
    assert body["episodes"][0]["title"] == "被抹除的核验员"
    assert body["episodes"][0]["coreGoal"] == "确立世界规则与越界的代价"
