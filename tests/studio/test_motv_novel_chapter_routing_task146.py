"""TASK-146 / REQ-009 判据 1–4：小说与剧集是两种形态，选错了不是排序不佳。

「写这一章」和「写这一集」用的是同一批名词，`selectWhen` 分不开；而「接着往下写」
两边都命中不了。所以形态由 `internalRouting.form` 做**硬排除**，在打分之前。

这份测试盯的是四件会静默出错的事：

1. **小说项目里写出来的是小说**（判据 2）。resolver 选中 `novel-chapter-writer`，
   而不是产出可拍剧本的 `script-writer`。
2. **剧集项目一个字节都没变**（判据 4）。同样的话仍然落到 `script-writer`。
3. **剧集侧一个字节都没变**（判据 5 订正后的版本）。显式报 `episode` 时，连命中
   小说家关键词的说法也不会选中它。**没报形态时它会参与竞争** —— 那是加一个包的
   固有后果，不可能避免；它被两道 fail-closed 兜住，本文件把这个事实测出来写下来。
4. **排除干净了就说清楚，不静默降级**。形态把候选排空时返回拒绝，而不是退回去
   挑一个不适用的能力跑。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"

#: 模块名**必须唯一**，不能叫 `skillpkg`：`tests/contract/test_motv_skillpkg_task075.py`
#: 用那个名字注册它自己的那一份，两边同跑时后加载的会把前一份从 `sys.modules` 里
#: 顶掉，而 `@dataclass` 解析字符串注解时要按 `cls.__module__` 回查自己那一份 ——
#: 顶掉之后它拿到的是另一个模块对象。实测代价：单跑两边都绿，
#: `pytest tests/studio tests/contract` 一起跑 37 项红。
_SPEC = importlib.util.spec_from_file_location(
    "skillpkg_task146", _REPO / "mockups" / "motv-workspace" / "skillpkg.py"
)
skillpkg = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = skillpkg
_SPEC.loader.exec_module(skillpkg)

_ROUTING = {
    "intent": "chapter-writing",
    "kind": "generative",
    "scope": "project",
    "priority": 80,
    "selectWhen": ["这一章"],
}

#: 写正文要的材料都齐了 —— 这份测试判的是**选谁**，不是缺什么。
_READY = {
    "brief",
    "outline",
    "characters",
    "relationships",
    "world",
    "episodePlan",
}


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_novel_146", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog(srv):
    return srv._load_skill_catalog()


class _CatalogWithout:
    """真实目录**减去**一个包 —— 「加这个包之前」的那一份。

    「与今天一致」只能对着一个真的没有这个包的目录证。拿两份都含新包的配置互相比，
    比的是两个新配置，不是新旧（codex 轮 2 的 BLOCKING 3 / NOT_EVIDENCED）。
    """

    def __init__(self, catalog, skill_id: str) -> None:
        self._rows = [s for s in catalog.available() if s.skill_id != skill_id]
        assert len(self._rows) == len(list(catalog.available())) - 1, (
            f"{skill_id} 不在目录里 —— 这个基线什么都没减掉"
        )

    def available(self):
        return self._rows


def _resolve(srv, catalog, *, goal, form, scope="project"):
    return srv._conv_resolve(
        catalog,
        "episode-production",
        goal=goal,
        scope=scope,
        ready=_READY,
        shot_id="",
        form=form,
    )


# --- 1. 小说项目里写出来的是小说 --------------------------------------------- #


@pytest.mark.parametrize(
    "goal",
    [
        "写这一章",
        "接着写",
        "把这一章的正文写出来",
        "继续写小说",
    ],
)
def test_a_novel_project_gets_the_novelist(srv, catalog, goal) -> None:
    plan, refusal = _resolve(srv, catalog, goal=goal, form="novel")
    assert refusal is None, refusal
    assert plan["skillId"] == "novel-chapter-writer", plan["reason"]
    assert plan["reason"].strip(), "为什么选它必须说得出来（ADR-0091 决策 5）"


def test_a_novel_project_never_gets_the_screenwriter(srv, catalog) -> None:
    """连他说「剧本」都不行 —— 在写小说的项目里产出一份可拍剧本，不是排序不佳，
    是把另一种东西写进了他的正文位。"""
    plan, refusal = _resolve(
        srv, catalog, goal="写这一集的剧本", form="novel", scope="episode"
    )
    assert refusal is None, refusal
    assert plan["skillId"] != "script-writer"


# --- 2. 剧集项目一个字节都没变 ------------------------------------------------ #


def test_an_episode_project_still_gets_the_screenwriter(srv, catalog) -> None:
    plan, refusal = _resolve(
        srv, catalog, goal="写这一集的剧本", form="episode", scope="episode"
    )
    assert refusal is None, refusal
    assert plan["skillId"] == "script-writer"


def test_the_novelist_is_excluded_from_an_episode_project(srv, catalog) -> None:
    plan, refusal = _resolve(
        srv, catalog, goal="接着写", form="episode", scope="episode"
    )
    assert refusal is None, refusal
    assert plan["skillId"] != "novel-chapter-writer"


# --- 3. 没报形态 = 不限 ------------------------------------------------------- #


@pytest.mark.parametrize(
    "goal",
    [
        # 剧集侧原有的说法
        "写这一集的剧本",
        "把这一集拆成分镜",
        "这一集的声音该怎么做",
        # **新包的关键词**（轮 1 BLOCKING 3：只测不命中新包的句子，等于没测）
        "这一章",
        "接着写",
        "正文",
        "小说",
    ],
)
def test_an_episode_project_is_untouched_by_the_new_package(srv, catalog, goal) -> None:
    """显式报剧集时，**一个字节都没变** —— 包括那些会命中小说家关键词的说法。

    这是判据 5 订正后真正要守的不变量。原判据要求「没报 form 时也与今天一致」，
    那不可能成立：往 `episode-production` 里加一个包，它必然出现在无形态约束时的
    候选里。剧集侧不受影响是**能成立**的那一条，也是唯一有产品意义的那一条。
    """
    plan, refusal = _resolve(srv, catalog, goal=goal, form="episode", scope="episode")
    assert refusal is None, refusal
    assert plan["skillId"] != "novel-chapter-writer", (
        f"「{goal}」在剧集项目里选中了小说家：{plan['reason']}"
    )
    # **与加这个包之前逐句对照**（轮 2：只断言「不是小说家」证不出「与以前一样」
    # —— 换掉的可能是别的某个包）。基线 = 把新包从目录里摘掉之后的同一次解析。
    baseline, r0 = srv._conv_resolve(
        _CatalogWithout(catalog, "novel-chapter-writer"),
        "episode-production",
        goal=goal,
        scope="episode",
        ready=_READY,
        shot_id="",
        form="episode",
    )
    assert r0 is None, r0
    assert plan["skillId"] == baseline["skillId"], (
        f"「{goal}」的选择被新包改掉了：{baseline['skillId']} → {plan['skillId']}"
    )


def test_an_unset_form_can_pick_the_novelist_and_that_is_safe(srv, catalog) -> None:
    """没选形态的项目里，「接着写」**确实**会选中小说家 —— 记录这个事实，
    并说明为什么它写不坏东西。

    两道闸兜着，都在前端侧测（`novelchapter.test.mjs`）：
    1. `chapterPlan` 是小说家的必填输入，没有章号就没有它 → 运行前 `missingInputs`
       就拒了，`action` 是 `ask`，不是 `run`；
    2. 即便跑到应用那一步，`applyBodyProposal` 也会因为 `form` 为空而拒绝，
       并让他先去「正文创作」选形态。

    所以这条不是缺陷，是一个被两道 fail-closed 兜住的选择。测它是为了让这个事实
    **被写下来**，而不是等下一个人重新发现。
    """
    plan, refusal = _resolve(srv, catalog, goal="接着写", form="")
    assert refusal is None, refusal
    assert plan["skillId"] == "novel-chapter-writer"
    # 材料不齐时它必须是「我知道你要什么，但你还缺这些」，不是直接开跑。
    empty, _ = srv._conv_resolve(
        catalog,
        "episode-production",
        goal="接着写",
        scope="project",
        ready=set(),
        shot_id="",
        form="",
    )
    assert empty["action"] == "ask"
    # 缺的那一项要**说得出他该做什么**，不只是一个名词：他看到「缺 本章任务」
    # 并不知道去哪儿补（codex 轮 2 对验收 2 的 NOT_EVIDENCED）。
    said = "；".join(empty["missing"])
    assert "本章任务" in said, empty["missing"]
    assert "正文创作" in said and "打开" in said, (
        f"缺输入的提示没告诉他去打开那一章：{empty['missing']}"
    )


# --- 4. 排空了就说清楚 -------------------------------------------------------- #


class _FakeSkill:
    """够 `_conv_candidates` 读的最小一个包。

    真实目录**排不空** —— `episode-production` 之下绝大多数包不声明 `form`，
    因此两种形态都留着。所以这一条只能用构造的目录来证：拿真目录跑，它会在
    「碰巧还有别的候选」上通过，等于没测到那个分支。
    """

    def __init__(self, skill_id: str, form: str) -> None:
        self.skill_id = skill_id
        self.version = 1
        self.title = skill_id
        self.work = "creative"
        self.inputs = ()
        self.routing = {
            "userCapability": ["episode-production"],
            "internalRouting": {
                "intent": "scene-writing",
                "kind": "generative",
                "scope": "project",
                "form": form,
                "priority": 50,
                "selectWhen": ["写"],
            },
        }


class _FakeCatalog:
    def __init__(self, *skills) -> None:
        self._skills = skills

    def available(self):
        return self._skills


def test_an_empty_form_filter_refuses_instead_of_downgrading(srv) -> None:
    """把候选排空时必须拒绝。**不许**回退到未过滤的名单里挑一个 —— 那正是
    「静默降级成别的能力」，ADR-0091 决策 2 明令禁止的那件事。"""
    only_episode = _FakeCatalog(_FakeSkill("fake-episode-only", "episode"))
    plan, refusal = srv._conv_resolve(
        only_episode,
        "episode-production",
        goal="写这一章",
        scope="project",
        ready=_READY,
        shot_id="",
        form="novel",
    )
    assert plan is None
    assert refusal and "小说" in refusal


def test_an_unconstrained_package_survives_every_form(srv) -> None:
    """不声明 `form` 的包两种形态都留着 —— 这是绝大多数包的情况，也是这个字段
    可以是**可选**的全部理由。"""
    both = _FakeCatalog(_FakeSkill("fake-any-form", ""))
    for form in ("novel", "episode", ""):
        plan, refusal = srv._conv_resolve(
            both,
            "episode-production",
            goal="写点什么",
            scope="project",
            ready=_READY,
            shot_id="",
            form=form,
        )
        assert refusal is None, refusal
        assert plan["skillId"] == "fake-any-form"


# --- 5. 前端报上来的形态怎么被读 ---------------------------------------------- #


@pytest.mark.parametrize(
    "context,expected",
    [
        ({"form": "novel"}, "novel"),
        ({"form": "  episode  "}, "episode"),
        ({}, ""),
        ({"form": None}, ""),
        ({"form": 7}, ""),
        (None, ""),
        ({"form": "x" * 99}, "x" * 16),
    ],
)
def test_form_is_read_defensively(srv, context, expected) -> None:
    """它来自网络，所以每一种不是字符串的形状都得落回「不限」，而不是抛出来把
    整轮对话作废。"""
    assert srv._conv_form(context) == expected


# --- 6. manifest 里的 form 是可选的，但写错就拒 ------------------------------- #


def test_form_is_optional_and_means_unconstrained() -> None:
    """绝大多数包不声明它 —— 它们与形态无关，而且**必须**保持与形态无关：
    要求每个包都表态会让这个字段变成一道人人都得答的新题。"""
    out = skillpkg._check_internal_routing(dict(_ROUTING), shot_scoped=False)
    assert out["form"] == ""


@pytest.mark.parametrize("form", ["novel", "episode"])
def test_a_declared_form_survives_loading(form) -> None:
    out = skillpkg._check_internal_routing(
        {**_ROUTING, "form": form}, shot_scoped=False
    )
    assert out["form"] == form


def test_the_new_package_never_reaches_the_frontend_prompt(srv, catalog) -> None:
    """验收 6 / REQ-007 判据 6：前端 Agent 看得见的仍然只有那三个。

    加一个能力包**必须**是一次纯粹的服务端变更。这条直接看喂给模型的那段文字：
    新包的 id、标题、触发词一个都不许出现在里面 —— 出现一个，模型下一轮就会去点名
    它，而那正是 ADR-0091 收敛掉的路由争抢。
    """
    caps = srv._conv_capabilities(catalog, srv._user_capabilities())
    assert {c["id"] for c in caps} == {
        "story-development",
        "episode-production",
        "story-review",
    }
    text = srv._conv_capability_text(caps)
    # 内部包的**身份** —— id、内部意图、包标题、角色名 —— 一个都不许出现。
    for leak in (
        "novel-chapter-writer",
        "chapter-writing",
        "script-writer",
        "Novel Chapter Writer",
        "小说家",
    ):
        assert leak not in text, f"内部能力「{leak}」漏进了前端提示词"
    # **不测 `selectWhen` 关键词**：「这一章」既是小说家的触发词，也是用户能力
    # `episode-production` 的示例说法（「写这一章」正是他会说的话）。两者重合，
    # 断言它不出现只会误伤文案，证不了「内部能力没泄漏」——那由上面的身份检查负责。


def test_the_two_writers_read_and_write_different_things() -> None:
    """判据 2 能被确定性验证的那一半：**结构**上两条路不会串。

    小说家要「本章任务」而编剧要「本集规划」，产出一个叫 `chapter` 一个叫
    `script` —— 所以一份剧本提案掉不进小说的应用路径，反之亦然（前端侧
    `novelchapter.test.mjs` 测了应用路径那一端）。

    「写出来的**内容**真的是散文」由 prompt 与 `reviewCriteria` 约束，
    自动化测不了，只能在真实项目上走查 —— 这一点如实记在 TASK-146 上，
    不假装这份测试证明了它。
    """
    builtin = _REPO / "product-skills" / "builtin"
    novel = json.loads(
        (builtin / "novel-chapter-writer" / "manifest.json").read_bytes()
    )
    script = json.loads((builtin / "script-writer" / "manifest.json").read_bytes())
    assert "chapterPlan" in novel["inputs"]
    assert "chapterPlan" not in script["inputs"] + script["optionalInputs"]
    assert "episodePlan" in script["inputs"]
    assert "episodePlan" not in novel["inputs"] + novel["optionalInputs"]

    novel_out = json.loads(
        (builtin / "novel-chapter-writer" / "output.schema.json").read_bytes()
    )
    script_out = json.loads(
        (builtin / "script-writer" / "output.schema.json").read_bytes()
    )
    assert novel_out["required"] == ["chapter"]
    assert script_out["required"] == ["script"]

    prompt = (builtin / "novel-chapter-writer" / "prompt.md").read_text("utf-8")
    assert "不是剧本" in prompt or "不要写" in prompt
    # 它必须被告知写**第几章** —— 否则它拿着整份大纲写它自己挑的那一章
    # （轮 1 的 BLOCKING 4）。
    assert "本章任务" in prompt and "no" in prompt


def test_the_chapter_task_reaches_the_compiled_prompt() -> None:
    """章号真的进到**最终喂给模型的那份提示词**里。

    轮 2 的 NON_BLOCKING 问的正是这个：漂移快照的 `context` 是一份冻结的固定上下文，
    里面没有 `chapterPlan`，所以快照里的小说家提示词也没有 —— 那证明不了运行时也
    没有。这条用一份**带 `chapterPlan` 的** context 走同一个编译器，把「模型收得到
    第几章」变成可复核的事实。
    """
    catalog = skillpkg.load_catalog([("builtin", _REPO / "product-skills" / "builtin")])
    labels = skillpkg.load_input_labels(_REPO / "product-skills" / "skill-inputs.json")
    skill = catalog.skills["novel-chapter-writer"]
    prompt = skillpkg.compile_prompt(
        skill,
        {
            "outline": "海底城市浮出水面",
            "chapterPlan": {
                "no": 7,
                "title": "",
                "wordsSoFar": 0,
                "planRows": [{"Scene": "下潜准备", "冲突": "氧气不够两个人用"}],
                "outlineExcerpts": ["§2 考古队决定下潜"],
            },
        },
        labels,
    )
    assert "本章任务" in prompt, "输入的人类标签没进提示词"
    # 章号本身 —— 断言的是**它以数据的形状出现**，不是「某处出现过一个 7」。
    # 一个 `"7" in prompt` 会被提示词里任何一个 7 满足，那正是「断言写法而不是
    # 断言性质」的反面教材（TASK-087 §7 推论 1）。
    assert '"no": 7' in prompt, "章号没进提示词 —— 模型不知道它在写第几章"
    assert '<数据 键="chapterPlan">' in prompt, "本章任务没被围栏包起来"
    assert "下潜准备" in prompt, "这一章的结构规划行没进提示词"
    assert "考古队决定下潜" in prompt, "这一章引用的大纲没进提示词"


@pytest.mark.parametrize("form", ["Novel", "小说", "", "both", 1, True, [], None])
def test_a_bad_form_is_refused_not_ignored(form) -> None:
    """fail-closed：一个拼错的 `"Novel"` 若被当成「没声明」，这个包就会在两种形态
    里都被选中 —— 静默地扩大了适用面，而这正是加载器该当场挡住的那类失败。

    `None` 也在内：JSON 里显式写 `null` 不是「没写」，是写错了值。
    """
    with pytest.raises(skillpkg.SkillPackageError):
        skillpkg._check_internal_routing({**_ROUTING, "form": form}, shot_scoped=False)
