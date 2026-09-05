"""TASK-105 / ADR-0084：Flow 包是 Skill 包机制的第二个 kind。

这份测试盯的是三件事，按重要性排：

1. **fail-closed**（ADR-0084 决策 6）：引用了本机没有的能力 → 这份流程整份不可用，
   **并说出缺的是哪一个**。不静默跳过那一步 —— 少做一步的流程会安静地少做一件事，
   而少做的那件事在结果上看不出来。
2. **带结构不带内容**（决策 3 的硬边界里机器能执行的那一半）：seed 里出现媒体、
   登记表或 Run 记录 → 拒绝整个包。
3. **复用而不是重写**（决策 1）：围栏与散列走的必须是 `skillpkg` 那一份代码，
   否则「同一个机制」只是一句话。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP))

import flowpkg  # noqa: E402 - path injected above
import skillpkg  # noqa: E402 - same

_BUILTIN_FLOWS = _REPO / "product-flows" / "builtin"
_BUILTIN_SKILLS = _REPO / "product-skills" / "builtin"


@pytest.fixture(scope="module")
def skills():
    return skillpkg.load_catalog([("builtin", _BUILTIN_SKILLS)])


def _live_version(skill_id: str) -> int:
    """磁盘上这个能力**此刻**是第几版。

    DERIVED, NEVER HARD-CODED. 这些测试问的是「流程解析步骤的规则对不对」，而不是
    「story-development 现在是 v2」—— 把版本号写死，等于让每一次合法的升版（改
    prompt、改契约、改路由元数据）都把一批与它无关的测试撞红，而红的理由与它们
    要守的性质毫无关系。
    """
    return skillpkg.load_package(_BUILTIN_SKILLS / skill_id, "builtin").version


def _manifest(**over) -> dict:
    base = {
        "flowId": "demo",
        "flowVersion": 1,
        "kind": "flow",
        "title": "示例",
        "purpose": "测试用",
        "steps": [
            {
                "stepKey": "one",
                "skillId": "story-development",
                "skillVersion": _live_version("story-development"),
            }
        ],
    }
    base.update(over)
    return base


def _package(
    tmp_path: Path, *, manifest=None, seed=None, narrative="怎么走\n", name=None
):
    root = tmp_path / "flows"
    root.mkdir(parents=True, exist_ok=True)
    manifest = _manifest() if manifest is None else manifest
    directory = root / (name or manifest.get("flowId", "demo"))
    directory.mkdir()
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    (directory / "seed.json").write_text(
        json.dumps({} if seed is None else seed, ensure_ascii=False), encoding="utf-8"
    )
    (directory / "flow.md").write_text(narrative, encoding="utf-8")
    return root, directory


# --- 内置那一份是真的能用的 -------------------------------------------------- #


def test_the_builtin_flow_loads_against_the_real_skill_catalog(skills) -> None:
    """内置流程引用的每一个 `(skillId, skillVersion)` 都要真的在能力目录里。

    这条会在**任何一个被它引用的 Skill 升版本时**转红 —— 那正是要的：
    模板引用的是版本化的能力，能力动了而模板没跟上，就是模板过期了。
    """
    catalog = flowpkg.load_flow_catalog([("builtin", _BUILTIN_FLOWS)], skills=skills)
    assert not catalog.problems, [p.reason for p in catalog.problems]
    flow = catalog.get("episode-from-scratch")
    assert flow is not None
    assert [s.step_key for s in flow.steps] == [
        "story",
        "world",
        "episode-plan",
        "script",
        "breakdown",
        "base-assets",
        "storyboard",
    ]
    assert flowpkg.resolve_steps(flow, skills) == []


def test_created_from_carries_all_three_fields(skills) -> None:
    """`flowVersion` 回答「作者说这是第几版」，`flowDigest` 回答「那一版到底是
    什么」。只有后者能让一年后的溯源链闭合（ADR-0084 决策 5 = ADR-0067 决策 3）。"""
    flow = flowpkg.load_flow_catalog([("builtin", _BUILTIN_FLOWS)], skills=skills).get(
        "episode-from-scratch"
    )
    got = flow.created_from()
    assert set(got) == {"flowId", "flowVersion", "flowDigest"}
    assert got["flowDigest"].startswith("sha256:")
    assert got["flowDigest"] == flow.digest


# --- 决策 6：缺能力就整份不可用，并指名道姓 ------------------------------------ #


def test_a_missing_capability_makes_the_whole_flow_unavailable(tmp_path, skills):
    root, _ = _package(
        tmp_path,
        manifest=_manifest(
            steps=[
                {
                    "stepKey": "one",
                    "skillId": "story-development",
                    "skillVersion": _live_version("story-development"),
                },
                {"stepKey": "two", "skillId": "does-not-exist", "skillVersion": 1},
            ]
        ),
    )
    catalog = flowpkg.load_flow_catalog([("user", root)], skills=skills)

    assert catalog.get("demo") is None, "不得只跳过那一步，整份不可用"
    assert len(catalog.problems) == 1
    detail = catalog.problems[0].reason
    assert "does-not-exist" in detail, "要说出缺的是哪一个"
    assert "two" in detail, "还要说出是哪一步缺"


def test_a_capability_at_the_wrong_version_is_also_missing(tmp_path, skills):
    """能力还在但版本变了 —— 模板引用的就不是它当初引用的那个东西。"""
    root, _ = _package(
        tmp_path,
        manifest=_manifest(
            steps=[
                {"stepKey": "one", "skillId": "story-development", "skillVersion": 99}
            ]
        ),
    )
    catalog = flowpkg.load_flow_catalog([("user", root)], skills=skills)

    assert catalog.get("demo") is None
    assert "v99" in catalog.problems[0].reason
    live = _live_version("story-development")
    assert f"v{live}" in catalog.problems[0].reason, "要说出本机是哪一版"


def test_without_a_skill_catalog_only_the_package_itself_is_checked(tmp_path):
    """没装能力目录时（还没到那一步）只做包自身的校验，不假装解析过步骤。"""
    root, _ = _package(
        tmp_path,
        manifest=_manifest(
            steps=[{"stepKey": "one", "skillId": "does-not-exist", "skillVersion": 1}]
        ),
    )
    catalog = flowpkg.load_flow_catalog([("user", root)], skills=None)
    assert catalog.get("demo") is not None


# --- 决策 3：带结构不带内容 ---------------------------------------------------- #


@pytest.mark.parametrize(
    "key",
    ["assetRegistry", "generationRegistry", "skillRuns", "media", "timelines"],
)
def test_a_seed_carrying_content_is_refused(tmp_path, key):
    """把内容带进模板，新项目开局就是别人作品的一份副本；把媒体带进去，
    一份模板会有几个 GB。机器能拦住的这一半就拦住（ADR-0084 决策 3）。"""
    root, directory = _package(tmp_path, seed={key: []})
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "决策 3" in str(exc.value)


def test_an_ordinary_structural_seed_is_accepted(tmp_path):
    root, directory = _package(
        tmp_path, seed={"story": {"storyCore": ""}, "episodes": []}
    )
    flow = flowpkg.load_flow(directory, "user")
    assert flow.seed["episodes"] == []


# --- manifest 校验：一处不合法就整份拒绝 --------------------------------------- #


@pytest.mark.parametrize(
    "over,fragment",
    [
        ({"kind": "skill"}, "kind"),
        ({"flowVersion": 0}, "flowVersion"),
        ({"flowVersion": True}, "flowVersion"),
        ({"title": "  "}, "title"),
        ({"steps": []}, "steps"),
        ({"conventions": []}, "conventions"),
        ({"deprecated": "yes"}, "deprecated"),
    ],
)
def test_a_malformed_manifest_is_refused(tmp_path, over, fragment):
    _, directory = _package(tmp_path, manifest=_manifest(**over))
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert fragment in str(exc.value)


def test_an_unknown_manifest_field_is_refused_not_ignored(tmp_path):
    """一个拼错的 `covnentions` 被忽略掉，表现是「约定没生效」，
    而没有任何地方说过它没生效。"""
    _, directory = _package(tmp_path, manifest=_manifest(covnentions={}))
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "covnentions" in str(exc.value)


def test_a_duplicate_step_key_is_refused(tmp_path):
    _, directory = _package(
        tmp_path,
        manifest=_manifest(
            steps=[
                {
                    "stepKey": "one",
                    "skillId": "story-development",
                    "skillVersion": _live_version("story-development"),
                },
                {
                    "stepKey": "one",
                    "skillId": "script-writer",
                    "skillVersion": _live_version("script-writer"),
                },
            ]
        ),
    )
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "重复" in str(exc.value)


def test_the_flow_id_must_match_the_directory_name(tmp_path):
    """目录名就是这个包在磁盘上的地址；两者不一致 = 「这是哪个流程」有两个答案。"""
    _, directory = _package(tmp_path, name="elsewhere")
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "目录名" in str(exc.value)


def test_an_empty_narrative_is_refused(tmp_path):
    """`flow.md` 是三件套里**唯一写给人**的那一份，空着等于这个包只剩机器能用。"""
    _, directory = _package(tmp_path, narrative="   \n")
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "flow.md" in str(exc.value)


@pytest.mark.parametrize("missing", flowpkg.FLOW_FILES)
def test_a_package_missing_any_of_the_three_files_is_invalid(tmp_path, missing):
    """缺一个不是「能用一半的包」，是无效的包（ADR-0067 决策 7 逐字适用）。"""
    _, directory = _package(tmp_path)
    (directory / missing).unlink()
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert missing in str(exc.value)


# --- 决策 1：复用的是同一份代码，不是同一段文字 -------------------------------- #


def test_the_containment_fence_and_the_digest_are_skillpkgs_own(tmp_path, monkeypatch):
    """「复用 ADR-0067 的包机制」必须是可验证的，不能只是一句话。

    做法是把 `skillpkg` 的那两个函数换掉再看 flow 的行为变不变 —— 变了就说明
    flow 真的在用它们，而不是自己抄了一份（照抄的那份不会跟着改，也就不会跟着
    修：TASK-084 项 4 修的正是围栏，抄一份等于让 flow 永远停在修之前）。
    """
    _, directory = _package(tmp_path)

    calls = []
    real_read = skillpkg.read_package_files

    def spy_read(d, names, **kw):
        calls.append(tuple(names))
        return real_read(d, names, **kw)

    monkeypatch.setattr(flowpkg, "read_package_files", spy_read)
    monkeypatch.setattr(flowpkg, "compute_digest", lambda files: "sha256:stub")

    flow = flowpkg.load_flow(directory, "user")
    assert calls == [flowpkg.FLOW_FILES], "读文件走的是 skillpkg 那一份围栏"
    assert flow.digest == "sha256:stub", "散列走的是 skillpkg 那一份实现"


def test_a_file_linked_outside_the_package_is_refused(tmp_path):
    """围栏本身：`flow.md` 链到包外，读到的说明就来自别处，而包仍自称是这个来源。

    与 Skill 包同一条规则、同一份代码（TASK-084 项 4）。junction 在 Windows 上
    `is_symlink()` 答 False，所以判定用的是**解析后的包含关系**。
    """
    from tests.symlink_support import symlink_or_skip

    outside = tmp_path / "outside.md"
    outside.write_text("别处的内容\n", encoding="utf-8")
    _, directory = _package(tmp_path)
    (directory / "flow.md").unlink()
    symlink_or_skip(directory / "flow.md", outside)

    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "包目录之外" in str(exc.value)


# --- 三级来源：与 Skill 包同一套 ------------------------------------------------ #


def test_a_higher_source_overrides_wholesale(tmp_path, skills):
    """同 id 由更靠前的来源**整体**覆盖，不做字段级合并 —— 半个来自用户、
    半个来自内置的流程，没有人能预测它会做什么（ADR-0067 决策 2）。"""
    user_root = tmp_path / "user"
    builtin_root = tmp_path / "builtin"
    for root, title in ((user_root, "用户版"), (builtin_root, "内置版")):
        d = root / "demo"
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(
            json.dumps(_manifest(title=title), ensure_ascii=False), encoding="utf-8"
        )
        (d / "seed.json").write_text("{}", encoding="utf-8")
        (d / "flow.md").write_text("说明\n", encoding="utf-8")

    catalog = flowpkg.load_flow_catalog(
        [("user", user_root), ("builtin", builtin_root)], skills=skills
    )
    assert catalog.get("demo").title == "用户版"
    assert catalog.get("demo").source == "user"


def test_a_broken_package_becomes_a_problem_not_a_silent_absence(tmp_path, skills):
    root = tmp_path / "flows"
    (root / "demo").mkdir(parents=True)
    (root / "demo" / "manifest.json").write_text("{ not json", encoding="utf-8")
    (root / "demo" / "seed.json").write_text("{}", encoding="utf-8")
    (root / "demo" / "flow.md").write_text("说明\n", encoding="utf-8")

    catalog = flowpkg.load_flow_catalog([("user", root)], skills=skills)
    assert catalog.flows == {}
    assert len(catalog.problems) == 1
    assert "manifest.json" in catalog.problems[0].reason


# --- 审查轮 1 的四条 P1 ------------------------------------------------------- #


@pytest.mark.parametrize(
    "seed",
    [
        {"episodes": [{"scenes": [{"media": ["a.mp4"]}]}]},
        {"story": {"assetRegistry": {}}},
        {"a": {"b": {"c": {"skillRuns": []}}}},
        {"list": [{"timelines": {}}]},
    ],
)
def test_a_forbidden_key_at_any_depth_is_refused(tmp_path, seed):
    """只查顶层是不够的（codex 审查轮 1）：`{"episodes":[{"media":[…]}]}` 顶层
    完全干净，带的却正是这条边界要挡住的东西 —— 而 seed 天生是嵌套的
    （集 → 场 → 镜），顶层检查等于只挡住最不可能出现的那一层。"""
    _, directory = _package(tmp_path, seed=seed)
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "决策 3" in str(exc.value)


def test_the_error_says_where_the_forbidden_key_was(tmp_path):
    """嵌套之后「哪里」才有意义 —— 一句「seed 里有媒体」在五层结构里没法用。"""
    _, directory = _package(
        tmp_path, seed={"episodes": [{"scenes": [{"media": ["a.mp4"]}]}]}
    )
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "episodes[0].scenes[0]" in str(exc.value)


def _write_flow(root: Path, flow_id: str, *, title: str, broken=False):
    d = root / flow_id
    d.mkdir(parents=True)
    body = (
        "{ not json"
        if broken
        else json.dumps(_manifest(flowId=flow_id, title=title), ensure_ascii=False)
    )
    (d / "manifest.json").write_text(body, encoding="utf-8")
    (d / "seed.json").write_text("{}", encoding="utf-8")
    (d / "flow.md").write_text("说明\n", encoding="utf-8")
    return d


def test_a_broken_override_shadows_the_lower_source_rather_than_falling_back(
    tmp_path, skills
):
    """跨来源**不回退**（ADR-0067 决策 7 逐字适用于 flow）。

    创作者要的是自己那一份；坏了就该说坏了，而不是安静地跑内置那一份 ——
    屏幕上写着一个名字，跑的是另一个东西（codex 审查轮 1）。
    """
    user_root = tmp_path / "user"
    builtin_root = tmp_path / "builtin"
    _write_flow(user_root, "demo", title="我的", broken=True)
    _write_flow(builtin_root, "demo", title="内置")

    catalog = flowpkg.load_flow_catalog(
        [("user", user_root), ("builtin", builtin_root)], skills=skills
    )

    assert catalog.get("demo") is None, "不得回退到内置那一份"
    assert [p.source for p in catalog.problems] == ["user"]


def test_an_unreadable_source_shadows_every_id_below_it(tmp_path, skills, monkeypatch):
    """两种粒度：**一个包**坏了只遮蔽那一个 id；**整个来源根**读不出来则遮蔽
    每一个 id —— 因为我们不知道它本来会覆盖哪些。"""
    builtin_root = tmp_path / "builtin"
    _write_flow(builtin_root, "demo", title="内置")
    user_root = tmp_path / "user"
    user_root.mkdir()

    real_dirs = flowpkg._package_dirs

    def unreadable(directory, contain_within=None):
        if directory == user_root:
            return [], "权限不足"
        return real_dirs(directory, contain_within)

    monkeypatch.setattr(flowpkg, "_package_dirs", unreadable)
    catalog = flowpkg.load_flow_catalog(
        [("user", user_root), ("builtin", builtin_root)], skills=skills
    )

    assert catalog.flows == {}, "读不出来的来源遮蔽它下面的每一个 id"
    assert catalog.problems[0].source == "user"


def test_a_broken_package_in_one_source_does_not_shadow_other_ids(tmp_path, skills):
    """反方向：一个来源里的一个坏包，不得把**别的 id** 也带下水。"""
    user_root = tmp_path / "user"
    _write_flow(user_root, "broken", title="坏的", broken=True)
    _write_flow(user_root, "fine", title="好的")

    catalog = flowpkg.load_flow_catalog([("user", user_root)], skills=skills)

    assert list(catalog.flows) == ["fine"]
    assert [p.skill_id for p in catalog.problems] == ["broken"]


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize("where", ["manifest.json", "seed.json"])
def test_json_non_constants_are_refused_at_read_time(tmp_path, literal, where):
    """Python 的 `json.loads` **默认接受** NaN / Infinity，`json.dumps` 又原样
    吐回去 —— 于是一份写坏的模板会让 `/api/flows` 的响应体或 `studio/flow.json`
    变成浏览器解析不了的东西：一个包坏掉，整条路由或整个新项目跟着坏
    （codex 审查轮 3）。

    在**读入的那一刻**拒绝，而不是写出时补救：写出时才发现，坏值已经进过内存，
    而且那时已经说不清是哪一个包带来的。
    """
    _, directory = _package(tmp_path)
    if where == "manifest.json":
        body = json.dumps(_manifest(), ensure_ascii=False).replace(
            '"flowVersion": 1', f'"flowVersion": {literal}'
        )
    else:
        body = f'{{"scale": {literal}}}'
    (directory / where).write_text(body, encoding="utf-8")

    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert literal.lstrip("-") in str(exc.value)


def test_a_loaded_flow_round_trips_through_strict_json(tmp_path, skills):
    """自证：加载成功的流程，序列化出来必须是**严格合法**的 JSON。

    这是上面那条守卫真正要保护的性质 —— 拒绝 NaN 只是手段。
    """
    catalog = flowpkg.load_flow_catalog([("builtin", _BUILTIN_FLOWS)], skills=skills)
    flow = catalog.get("episode-from-scratch")
    payload = {
        "createdFrom": flow.created_from(),
        "conventions": dict(flow.conventions),
        "seed": dict(flow.seed),
    }
    text = json.dumps(payload, allow_nan=False)
    assert json.loads(text) == payload


# --- 审查轮 6：非有限数字与深嵌套，按**类**修 -------------------------------- #


@pytest.mark.parametrize("literal", ["1e400", "-1e400", "1E999"])
def test_exponent_overflow_is_refused_like_the_literals(tmp_path, literal):
    """轮 3 只挡住了 `NaN` / `Infinity` 三个**字面量**，而 `1e400` 是一个完全合法
    的 JSON 数字字面量 —— `json.loads` 把它算成 `inf`，`parse_constant` 根本不会
    被调用（codex 审查轮 6）。

    来源不同，后果一样：`json.dumps` 把 `Infinity` 原样吐出去，**一个包坏掉，
    整条 `/api/flows` 对所有客户端都坏掉**。所以挡的是「非有限」这个**性质**。
    """
    _, directory = _package(tmp_path, seed={"scale": None})
    (directory / "seed.json").write_text(f'{{"scale": {literal}}}', encoding="utf-8")
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "有限" in str(exc.value)


def test_a_non_finite_inside_conventions_is_refused_too(tmp_path):
    """`conventions` 与 `seed` 都会被原样吐进 `/api/flows` 和 `studio/flow.json`，
    所以两边走的是同一个入口、同一道检查。"""
    _, directory = _package(tmp_path)
    body = json.dumps(_manifest(), ensure_ascii=False).replace(
        '"purpose": "测试用"', '"purpose": "测试用", "conventions": {"x": 1e400}'
    )
    (directory / "manifest.json").write_text(body, encoding="utf-8")
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "有限" in str(exc.value)


def test_a_deeply_nested_package_is_a_problem_not_a_crash(tmp_path, skills):
    """`load_flow_catalog` 只接 `SkillPackageError`，所以一个 `RecursionError`
    会把**列表路由和「新建项目」一起打崩**，而不是变成一条隔离的 problem
    （codex 审查轮 6）。"""
    root = tmp_path / "flows"
    d = root / "deep"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(
        json.dumps(_manifest(flowId="deep"), ensure_ascii=False), encoding="utf-8"
    )
    (d / "flow.md").write_text("说明\n", encoding="utf-8")
    depth = 20_000
    (d / "seed.json").write_text(
        '{"a":' * depth + "null" + "}" * depth, encoding="utf-8"
    )

    # 不崩：整个目录照常加载，坏的那个变成一条 problem
    catalog = flowpkg.load_flow_catalog([("user", root)], skills=skills)

    assert catalog.flows == {}
    assert len(catalog.problems) == 1
    assert catalog.problems[0].skill_id == "deep"


def test_a_moderately_nested_package_is_also_refused_with_a_reason(tmp_path):
    """深度上限是**我们的**规则（模板是结构骨架），所以拒绝时要说出这一点。"""
    _, directory = _package(tmp_path)
    depth = 150
    (directory / "seed.json").write_text(
        '{"a":' * depth + "null" + "}" * depth, encoding="utf-8"
    )
    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "嵌套过深" in str(exc.value)


def test_an_ordinary_nesting_depth_is_still_fine(tmp_path):
    """反方向：真实模板的深度（集 → 场 → 镜 大约四层）不受影响。"""
    _, directory = _package(
        tmp_path,
        seed={"episodes": [{"scenes": [{"shots": [{"slug": "s1"}]}]}]},
    )
    flow = flowpkg.load_flow(directory, "user")
    assert flow.seed["episodes"][0]["scenes"][0]["shots"][0]["slug"] == "s1"


#: 一个反斜杠，运行时拼出来 —— **源码里不能出现转义序列本身**：Python 在编译
#: 这个文件时就会把它变成一个真的孤立代理项，于是文件自己 import 不进来。
#: （这个坑吃过两次，第一次把 flowpkg.py 写成了 0 字节。）
_BACKSLASH = chr(92)
_LONE_SURROGATE_ESCAPE = _BACKSLASH + "ud800"


@pytest.mark.parametrize("where", ["manifest.json", "seed.json"])
def test_a_lone_surrogate_is_refused_at_read_time(tmp_path, where):
    """孤立代理项：JSON 语法上合法、Python 收得下，但它**编码不出 UTF-8**。

    后果不是「输出不好看」，是**崩**：写 `studio/flow.json` 时 `.encode("utf-8")`
    抛 `UnicodeEncodeError`，那是 `ValueError` 不是 `OSError`，会绕过只接
    `OSError` 的回滚 —— 半个项目留在原地，之后每次重试都答「已存在」
    （codex 审查轮 10）。
    """
    _, directory = _package(tmp_path)
    if where == "manifest.json":
        body = json.dumps(_manifest(), ensure_ascii=False).replace(
            '"purpose": "测试用"',
            '"purpose": "测试用' + _LONE_SURROGATE_ESCAPE + '"',
        )
    else:
        body = '{"note": "' + _LONE_SURROGATE_ESCAPE + '"}'
    (directory / where).write_text(body, encoding="utf-8")

    with pytest.raises(skillpkg.SkillPackageError) as exc:
        flowpkg.load_flow(directory, "user")
    assert "UTF-8" in str(exc.value)


def test_every_loaded_flow_can_actually_be_written_out(skills):
    """自证：加载成功的流程，**一定**写得出去。

    这是上面那两族守卫（非有限数字、孤立代理项）真正要保护的性质 ——
    拒绝某种输入只是手段。
    """
    catalog = flowpkg.load_flow_catalog([("builtin", _BUILTIN_FLOWS)], skills=skills)
    assert catalog.flows, "前提：真的加载到了流程"
    for flow in catalog.flows.values():
        payload = {
            "createdFrom": flow.created_from(),
            "title": flow.title,
            "purpose": flow.purpose,
            "conventions": dict(flow.conventions),
            "seed": dict(flow.seed),
        }
        # 与 `_create_project` 写 `studio/flow.json` 时**同一串调用**
        blob = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        assert json.loads(blob.decode("utf-8")) == payload
