"""TASK-119 / ADR-0091：路由元数据的包格式，以及跨包的冲突校验。

两层，看得见它们的人不一样 —— 这份测试守的就是那条界线：

    userCapability    前端对话 Agent 看得见的三个用户能力之一。它进提示词。
    internalRouting   只有服务端 resolver 看得见。**它永远不进提示词。**

以及一条更早的纪律：**fail-closed**（ADR-0067 决策 7）。一份写错的路由元数据必须让
**整个包不可用并说出原因**，而不是「路由字段被忽略、能力照常出现在目录里」——
后者在屏幕上与「作者根本没写路由」一模一样，而作者相信自己写了。
"""

from __future__ import annotations

import json
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP))

import skillpkg  # noqa: E402 - path injected above

_BUILTIN = _REPO / "product-skills" / "builtin"
_INPUTS = _REPO / "product-skills" / "skill-inputs.json"
_CAPS = _REPO / "product-skills" / "user-capabilities.json"


@pytest.fixture(scope="module")
def catalog():
    return skillpkg.load_catalog(
        [("builtin", _BUILTIN)],
        shot_scoped_inputs=skillpkg.load_shot_scoped_inputs(_INPUTS),
    )


def _package(tmp_path: Path, skill_id: str = "story-development") -> Path:
    root = tmp_path / "skills"
    root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(_BUILTIN / skill_id, root / skill_id)
    return root / skill_id


def _routing(package: Path, routing) -> None:
    path = package / "manifest.json"
    data = json.loads(path.read_bytes().decode("utf-8"))
    if routing is None:
        data.pop("routing", None)
    else:
        data["routing"] = routing
    path.write_bytes(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))


def _load(package: Path):
    return skillpkg.load_package(
        package, "project", skillpkg.load_shot_scoped_inputs(_INPUTS)
    )


_GOOD = {
    "userCapability": ["story-development"],
    "internalRouting": {
        "intent": "story-structure",
        "kind": "generative",
        "scope": "project",
        "priority": 50,
        "selectWhen": ["故事"],
    },
}


# --- 1. 没有 routing 是合法的；写了就必须写全 --------------------------------- #


def test_a_package_without_routing_simply_does_not_route(tmp_path) -> None:
    """「不参与自然语言路由」和「写了但写错了」是两件不同的事。

    前者是绝大多数包的正常状态（页面里的专业按钮照常调它）；后者让整个包不可用。
    """
    package = _package(tmp_path)
    _routing(package, None)
    skill = _load(package)
    assert skill.routing is None
    assert skill.public()["routing"] is None


@pytest.mark.parametrize("drop", ["userCapability", "internalRouting"])
def test_a_half_written_routing_fails_the_package(tmp_path, drop) -> None:
    package = _package(tmp_path)
    _routing(package, {k: v for k, v in _GOOD.items() if k != drop})
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        _load(package)
    assert drop in str(exc.value)


@pytest.mark.parametrize(
    "drop",
    ["intent", "kind", "scope", "priority", "selectWhen"],
)
def test_internal_routing_has_no_silent_defaults(tmp_path, drop) -> None:
    """能省的字段就是有一个看不见的默认值 —— 而默认值决定的是「谁被选中」。"""
    package = _package(tmp_path)
    internal = {k: v for k, v in _GOOD["internalRouting"].items() if k != drop}
    _routing(package, {**_GOOD, "internalRouting": internal})
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        _load(package)
    assert drop in str(exc.value)


def test_an_unknown_routing_field_is_refused_not_ignored(tmp_path) -> None:
    """拼错一个字段名被忽略掉，表现是「路由没生效」，而没有任何地方说过它没生效。"""
    package = _package(tmp_path)
    _routing(package, {**_GOOD, "triggers": ["帮我搭建世界观"]})
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        _load(package)
    assert "triggers" in str(exc.value)


# --- 2. 封闭词汇表 ------------------------------------------------------------- #


@pytest.mark.parametrize(
    "bad,fragment",
    [
        ({"userCapability": "story-development"}, "userCapability"),  # 不是数组
        ({"userCapability": []}, "userCapability"),
        ({"userCapability": ["make-a-movie"]}, "userCapability"),
        ({"userCapability": ["story-review", "story-review"]}, "重复"),
    ],
)
def test_the_user_capability_vocabulary_is_closed(tmp_path, bad, fragment) -> None:
    """自由字符串无法被校验，于是拼错一个字母的包会安静地永远不被路由到。"""
    package = _package(tmp_path)
    _routing(package, {**_GOOD, **bad})
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        _load(package)
    assert fragment in str(exc.value)


@pytest.mark.parametrize(
    "over,fragment",
    [
        ({"intent": "做点什么"}, "intent"),
        ({"kind": "helpful"}, "kind"),
        ({"scope": "宇宙"}, "scope"),
        ({"priority": 0}, "priority"),
        ({"priority": 101}, "priority"),
        ({"priority": True}, "priority"),  # bool 在 Python 里是 int
        ({"priority": "高"}, "priority"),
        ({"selectWhen": []}, "selectWhen"),
        ({"selectWhen": ["故事", "故事"]}, "重复"),
        ({"selectWhen": ["  "]}, "selectWhen"),
        (
            {"selectWhen": ["帮我把这个想法发展成一个完整的、能拍的短剧故事大纲"]},
            "关键词",
        ),
        ({"selectWhen": list("一二三四五六七")}, "关键词"),
    ],
)
def test_internal_routing_values_are_bounded(tmp_path, over, fragment) -> None:
    package = _package(tmp_path)
    _routing(
        package, {**_GOOD, "internalRouting": {**_GOOD["internalRouting"], **over}}
    )
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        _load(package)
    assert fragment in str(exc.value)


def test_a_shot_scoped_capability_cannot_claim_a_wider_scope(tmp_path) -> None:
    """声明了镜头域输入的能力只能对着一个镜头运行 —— scope 说别的就是自相矛盾。"""
    package = _package(tmp_path, "shot-continuity-reviewer")
    _routing(
        package,
        {
            "userCapability": ["story-review"],
            "internalRouting": {
                "intent": "shot-continuity",
                "kind": "diagnostic",
                "scope": "project",
                "priority": 50,
                "selectWhen": ["这一镜"],
            },
        },
    )
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        _load(package)
    assert "shot" in str(exc.value)


# --- 3. 三个 facade 与代码里的封闭元组是同一份 --------------------------------- #


def test_the_capability_file_and_the_code_agree(catalog) -> None:
    caps = skillpkg.load_user_capabilities(_CAPS)
    assert tuple(c["id"] for c in caps) == skillpkg.USER_CAPABILITIES
    assert len(skillpkg.USER_CAPABILITIES) == 3, "收敛的那条线：三个，不多不少"
    for cap in caps:
        assert cap["title"].strip() and cap["purpose"].strip()
        assert cap["scopes"], "要说清它能在哪些层上工作"


def test_a_capability_file_that_disagrees_fails_closed(tmp_path) -> None:
    """两处各持一份名单必然漂移，而漂移的表现是「某一类请求安静地永远选不中」。"""
    bad = tmp_path / "caps.json"
    bad.write_text(
        json.dumps(
            {
                "capabilities": [
                    {
                        "id": "story-development",
                        "title": "开发故事",
                        "purpose": "x",
                        "scopes": ["project"],
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        skillpkg.load_user_capabilities(bad)
    assert "USER_CAPABILITIES" in str(exc.value)


# --- 4. 跨包冲突：不歧义、不指向不存在的能力 ----------------------------------- #


def test_every_capability_has_at_least_one_internal_candidate(catalog) -> None:
    """一个没有候选的 facade，选中它只会得到「识别到了、然后什么都没发生」。"""
    by_cap = defaultdict(list)
    for skill in catalog.available():
        if not skill.routing:
            continue
        for cap in skill.routing["userCapability"]:
            by_cap[cap].append(skill.skill_id)
    for cap in skillpkg.USER_CAPABILITIES:
        assert by_cap[cap], f"{cap} 之下一个内部能力都没有"


def test_no_two_candidates_in_one_capability_share_an_intent(catalog) -> None:
    """`intent` 是二级选择的等价类。同一个 facade 里出现两个同 intent 的候选，
    「选谁」就成了目录遍历顺序的函数 —— 那正是确定性要排除的东西。"""
    by_cap = defaultdict(list)
    for skill in catalog.available():
        if not skill.routing:
            continue
        for cap in skill.routing["userCapability"]:
            by_cap[cap].append(
                (skill.routing["internalRouting"]["intent"], skill.skill_id)
            )
    for cap, rows in by_cap.items():
        counts = Counter(intent for intent, _ in rows)
        dupes = {i: [s for x, s in rows if x == i] for i, n in counts.items() if n > 1}
        assert not dupes, f"{cap} 里有同 intent 的候选：{dupes}"


def test_no_two_candidates_tie_on_both_priority_and_keywords(catalog) -> None:
    """同优先级 + 关键词重叠 = 一句话同时点中两个而无从分辨。

    修订类与创作类**故意**共享名词（「剧本」既属于写也属于改），它们靠 resolver 的
    修改标记规则分开，不靠优先级 —— 所以这条只查同优先级的那些。
    """
    by_cap = defaultdict(list)
    for skill in catalog.available():
        if not skill.routing:
            continue
        internal = skill.routing["internalRouting"]
        for cap in skill.routing["userCapability"]:
            by_cap[cap].append(
                (internal["priority"], set(internal["selectWhen"]), skill.skill_id)
            )
    for cap, rows in by_cap.items():
        for i, (pri_a, words_a, id_a) in enumerate(rows):
            for pri_b, words_b, id_b in rows[i + 1 :]:
                if pri_a != pri_b:
                    continue
                assert not (words_a & words_b), (
                    f"{cap}：{id_a} 与 {id_b} 同优先级 {pri_a} 且关键词重叠 "
                    f"{words_a & words_b} —— 一句话点中两个时无从分辨"
                )


def test_a_facade_name_is_never_used_as_an_internal_skill_reference(catalog) -> None:
    """`story-development` 同时是一个 facade 名和一个内部能力名。

    那是**允许的**，因为两者活在不同字段里（`capability` / `skillId`），协议上不可能
    混淆。这条钉住的是那个前提：facade 名只出现在 `userCapability` 里，内部能力名
    只出现在 skillId 里，没有第三处把它们混在一起。
    """
    facades = set(skillpkg.USER_CAPABILITIES)
    collide = facades & set(catalog.skills)
    assert collide == {"story-development"}, (
        "如果又多了一个同名的，先确认协议里那两个字段仍然是分开的"
    )
    for skill in catalog.available():
        if not skill.routing:
            continue
        # 内部意图不得复用 facade 名 —— 那会让「这是哪一层的名字」失去唯一答案
        assert skill.routing["internalRouting"]["intent"] not in facades


def test_the_builtin_catalog_is_clean(catalog) -> None:
    """内置目录必须一条 problem 都没有 —— 装不上的包在这里就是缺陷。"""
    assert not catalog.problems, [(p.skill_id, p.reason) for p in catalog.problems]


def test_routing_reaches_the_browser_in_the_public_shape(catalog) -> None:
    """页面读不到文件系统，所以路由元数据只能从 `/api/skills` 到达它；
    页面**不得**自持第二份能力目录（决策 2）。"""
    payload = catalog.public()
    routed = [s for s in payload["skills"] if s["routing"]]
    assert routed, "至少要有能被路由到的能力"
    for entry in routed:
        assert set(entry["routing"]) == {"userCapability", "internalRouting"}
        assert entry["routing"]["userCapability"]


#: 本次新增的两个纯诊断能力。**只钉这两个**，理由写在下面那条测试里。
_NEW_DIAGNOSTIC = ("story-zoom", "audience-engagement-reviewer")


@pytest.mark.parametrize("skill_id", _NEW_DIAGNOSTIC)
def test_the_new_diagnostic_capabilities_cannot_write_back(catalog, skill_id) -> None:
    """诊断类只出结论与建议 —— 写回路径**结构上**不存在（不是「还没做」）。

    为什么只钉这两个，不钉所有 `kind: diagnostic`：`script-doctor` 在
    `APPLY_TARGETS` 里是 `can: true`（走 `scriptPlan`），而它的 output schema 只有
    `findings` / `strengths`，没有 `script` —— 也就是说那条写回路径拿不到东西可写。
    那是**本次之前就存在的**不一致，不在这张卡的范围内（AGENTS.md 第 17 条），
    已记为 Follow-up。在这里连它一起断言，等于让这张卡去修一个它没碰过的缺陷。
    """
    assert skill_id in catalog.skills
    assert catalog.skills[skill_id].routing["internalRouting"]["kind"] == "diagnostic"
    js = (_MOCKUP / "src" / "workflow" / "skillapply.js").read_text("utf-8")
    block = js.split(f'"{skill_id}":')
    assert len(block) > 1, f"{skill_id} 要在 APPLY_TARGETS 里显式说明它为什么不写回"
    assert "can: false" in block[1][:400], f"{skill_id} 是诊断类，不该有写回路径"
