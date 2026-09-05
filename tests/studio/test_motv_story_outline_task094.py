"""TASK-094 批次 C / TASK-089：故事大纲写这八项就够了。

产品负责人 2026-08-17 逐条给了八项（原话见 TASK-089 §0）。本文件钉住：

1. 八项进了 `story-development` 的输出契约，且**是新版本**（ADR-0067 §1.2）；
2. 清单外的四个字段（`episodeCount` / `durationNote` / `genreTone` / `premise`）
   **一个都没被静默删掉**（TASK-089 §2.2 —— 删一个正在被用的字段而没人发现，
   是本仓库反复出现的那类缺陷）；
3. 「AI 改」走 reviser，修改要求是**声明输入**而不是 steer。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"

_EIGHT = {
    "storyCore": "被世界抹除的人并没有消失，她要走回去",
    "protagonist": {"who": "林照", "initialWant": "回到原世界"},
    "conflict": {
        "external": "源律不禁止尝试，只禁止成功",
        "internal": "她无法接受自己救人是个错误",
    },
    "worldAndRules": {
        "where": "「存在」终局世界",
        "rules": ["抹除不等于死亡", "被救成功者会被无限外推"],
    },
    "keyRelationships": [
        {
            "between": ["林照", "许渡"],
            "nature": "交易关系",
            "howItChanges": "从买路变成同伴",
        },
    ],
    "mainline": {
        "setup": "她救下不可被救的人",
        "development": "她在终局世界找路",
        "midpointTurn": "她发现校准官也被抹除过",
        "climax": "她自愿成为证据",
        "ending": "她建立第二套稳定答案",
    },
    "secretsAndReveals": [
        {
            "truth": "校准官也被抹除过",
            "whyNotUpfront": "他是她唯一的路",
            "revealAround": "第 8 集前后",
        },
    ],
    "themeAndChange": {
        "theme": "被规则否定的人如何证明自己存在",
        "protagonistBecomes": "从想回家的人，变成给别人留下路的人",
    },
}
_ANSWER = json.dumps(_EIGHT, ensure_ascii=False)


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        f"motv_server_094c_{tmp_path.name}", _MOCKUP / "server.py"
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


def _stub(module, monkeypatch, answer=_ANSWER):
    seen: list[str] = []

    def fake(name, prompt, timeout, on_spawn=None):
        seen.append(prompt)
        return answer, None

    monkeypatch.setattr(module, "_run_executor", fake)
    return seen


def _post(app, payload, headers=None):
    resp = app.handle_post(
        "/api/agent/story-develop", json.dumps(payload).encode("utf-8"), headers or {}
    )
    return resp.status, json.loads(resp.body.decode("utf-8"))


# --- 契约：八项 -------------------------------------------------------------- #


def test_the_eight_items_are_the_contract(srv) -> None:
    skill = srv._load_skill_catalog().skills["story-development"]
    # 至少 v2 —— 八项契约是在 v2 落的（TASK-089 §2.1）。写死等号会让
    # 任何后续合法升版撞红一条与版本号无关的测试。
    assert skill.version >= 2, "改了内容必须升版本（ADR-0067 §1.2）"
    fields = skill.output_schema["fields"]
    required = set(skill.output_schema["required"])

    # 一、故事核心
    assert "storyCore" in required
    # 二、主角与目标 —— 「最开始想要什么」必须是**单独一格**
    assert set(fields["protagonist"]["required"]) == {"who", "initialWant"}
    # 三、核心冲突 —— 外部 / 内部**分开写**（现状是一个 centralConflict 单字段）
    assert set(fields["conflict"]["required"]) == {"external", "internal"}
    # 四、世界与核心规则 —— 规则是**列表**，「可枚举」是产品负责人的原话形状
    assert fields["worldAndRules"]["fields"]["rules"]["type"] == "array"
    # 五、主要角色关系 —— 关系**如何变化**是独立字段
    rel = fields["keyRelationships"]["of"]
    assert set(rel["required"]) == {"between", "nature", "howItChanges"}
    assert (
        rel["fields"]["between"]["minItems"],
        rel["fields"]["between"]["maxItems"],
    ) == (2, 2)
    # 六、故事主线 —— **一个五段对象**，不是三个散字段
    assert set(fields["mainline"]["required"]) == {
        "setup",
        "development",
        "midpointTurn",
        "climax",
        "ending",
    }
    # 七、核心秘密 / 揭示顺序
    assert set(fields["secretsAndReveals"]["of"]["required"]) == {
        "truth",
        "revealAround",
    }
    # 八、主题与最终变化
    assert set(fields["themeAndChange"]["required"]) == {"theme", "protagonistBecomes"}


def test_the_four_off_list_fields_were_not_silently_deleted(srv) -> None:
    """TASK-089 §2.2 逐条：留下的仍然可读，合并的旧字段仍然被接受。"""
    skill = srv._load_skill_catalog().skills["story-development"]
    fields = skill.output_schema["fields"]
    # episodeCount：它就是「目标集数 24」，分集规划要与它互相校验
    assert fields["episodeCount"]["type"] == "number"
    # durationNote：分集规划的 duration 从它派生
    assert fields["durationNote"]["type"] == "string"
    # genreTone：Prompt 编译在用（promptc.js 的「大纲题材基调」）
    assert fields["genreTone"]["type"] == "string"
    # premise：合并进 storyCore，但**保留旧字段读取**（加法迁移）
    assert fields["premise"]["type"] == "string"
    assert "premise" not in skill.output_schema["required"]
    # …以及大纲页在用的其余旧字段，一个都没删
    for legacy in (
        "logline",
        "world",
        "centralConflict",
        "storyArc",
        "climax",
        "ending",
    ):
        assert legacy in fields, f"{legacy} 正在被读，不得静默删除"


def test_a_legacy_shaped_outline_is_still_accepted_by_the_parser(srv) -> None:
    """`_parse_story_outline` 同时是**手工提交**的 sanitiser：磁盘上已有的四版大纲、
    以及创作者粘贴的旧格式大纲，都必须继续能用。"""
    legacy = '{"premise":"p","logline":"l","centralConflict":"c"}'
    assert srv._parse_story_outline(legacy)["premise"] == "p"
    assert srv._parse_story_outline(_ANSWER)["storyCore"].startswith("被世界抹除")
    # 但完全没有「这个故事讲什么」的答案仍然被拒
    with pytest.raises(ValueError):
        srv._parse_story_outline('{"genreTone":"古装"}')


# --- 两模式 ------------------------------------------------------------------ #


def test_the_mode_is_decided_in_one_place(srv) -> None:
    assert srv._skill_id_for("story-develop", {"idea": "i"}) == "story-development"
    assert (
        srv._skill_id_for("story-develop", {"idea": "i", "instruction": "偏权谋"})
        == "story-development"
    ), "没有当前大纲时，带方向指令仍然是写一版新的"
    assert (
        srv._skill_id_for("story-develop", {"idea": "i", "current": _EIGHT})
        == "story-development"
    ), "没有修改要求就没有要改的东西"
    assert (
        srv._skill_id_for(
            "story-develop",
            {"idea": "i", "current": _EIGHT, "instruction": "让许渡早一点露出真实目的"},
        )
        == "story-reviser"
    )


def test_a_revision_carries_the_outline_as_declared_context(srv, monkeypatch) -> None:
    seen = _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(
        app,
        {
            "idea": "一句创意",
            "current": _EIGHT,
            "instruction": "让许渡早一点露出真实目的",
        },
    )
    assert status == 200, body
    prompt = seen[0]
    assert "Story Reviser" in prompt
    assert "保留未被要求改动的部分" in prompt or "原样抄回来" in prompt
    assert "源律不禁止尝试，只禁止成功" in prompt, "修订失去了它要修订的大纲"
    assert '<数据 键="outline">' in prompt
    assert '<数据 键="revisionRequest">' in prompt
    # …而修改要求**只出现一次**（reviser 模式下它是声明输入，不再另外围一遍）
    assert prompt.count("让许渡早一点露出真实目的") == 1

    run = srv.runs().get(body["run_id"])
    assert run["params"]["skillId"] == "story-reviser"


def test_a_writer_mode_steer_still_reaches_the_prompt(srv, monkeypatch) -> None:
    """第一次发展故事时没有大纲可改，方向指令仍然必须到达模型。"""
    seen = _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(app, {"idea": "一句创意", "instruction": "偏权谋、女性主角"})
    assert status == 200, body
    assert "偏权谋、女性主角" in seen[0]
    assert "### 修改要求" in seen[0], "writer 模式下它仍然走围栏"


def test_both_packages_answer_the_same_contract(srv) -> None:
    catalog = srv._load_skill_catalog()
    writer = catalog.skills["story-development"]
    reviser = catalog.skills["story-reviser"]
    assert reviser.output_schema == writer.output_schema
    assert reviser.inputs == ("outline", "revisionRequest")
    assert "brief" in reviser.optional_inputs


def test_the_legacy_response_key_is_unchanged(srv, monkeypatch) -> None:
    """契约 §5.9c：调用方看到的键不变。"""
    _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(app, {"idea": "一句创意"})
    assert status == 200
    assert body["outline"]["storyCore"].startswith("被世界抹除")
    assert body["outline"]["mainline"]["midpointTurn"] == "她发现校准官也被抹除过"
