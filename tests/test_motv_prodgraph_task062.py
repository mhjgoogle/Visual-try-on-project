"""motv 生产图身份合同 — TASK-062 / ADR-0059.

STRICTLY OFFLINE, no spend. Runs the frontend units via ``node --test`` and
guards the contracts a UI-level test could not see:

- 每一层由真实 ID 串起来，而不是由「时间接近」猜出来；
- Skill Run 记录它读的 context（id，不是那句人写的摘要）；
- Proposal 有身份，Generation 记录它从哪个提案发起；
- 旧记录一律 null 并显示「未记录」——迁移不回填、不推断；
- 溯源图仍然是 derived read model，拓扑一行都不持久化；
- canonical story 不被复制进读模型 / 资产 / 技能记录。
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — a rule can never be 'satisfied' by a
    comment that merely describes it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_prodgraph_units_via_node() -> None:
    """生产图身份合同 / 统一读模型 / v13→v14 迁移 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/prodgraph.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_the_schema_carries_the_three_identity_fields() -> None:
    """context / proposalId / origin 是本合同的全部持久化面。"""
    schema = _code("services", "canvasschema.js")
    m = re.search(r"CANVAS_SCHEMA_VERSION = (\d+)", schema)
    assert m and int(m.group(1)) >= 14, "the identity contract lands at v14"
    assert "13: migrateV13ToV14" in schema
    # the migration is ADDITIVE and writes null — never a back-filled guess
    body = schema.split("function migrateV13ToV14", 1)[1].split("\n}", 1)[0]
    assert "r.context = null" in body
    assert "r.proposal.proposalId = null" in body
    assert "g.origin = null" in body
    for guess in ("activeEpisode", "episodes[0]", "createdAt", "find("):
        assert guess not in body, f"{guess} would infer linkage the document never had"


def test_the_validator_accepts_null_and_refuses_a_malformed_link() -> None:
    """null 是合法的（表示未记录）；但存在的 context/origin 必须是 id 对象——
    畸形的那一份会被当作真实溯源画到图上。"""
    schema = _code("services", "canvasschema.js")
    assert "has a non-object context" in schema
    assert "has an invalid context." in schema
    assert "has a non-object origin" in schema
    assert "has an invalid origin." in schema


def test_a_run_records_ids_not_only_a_sentence() -> None:
    """字符串摘要不能被追溯：「这次运行读的是哪一集」必须能被回答。"""
    run = _code("workflow", "skillrun.js")
    assert "context: contextOf(entry.context)" in run
    assert "function contextOf(raw)" in run
    # an object of three nulls would claim the context was recorded and empty
    assert "c.episodeId || c.sceneId || c.shotId ? c : null" in run
    # the human summary is KEPT — it is what a person reads
    assert "inputSummary: strOrNull(entry.inputSummary)" in run


def test_a_proposal_gets_an_id_when_it_exists_and_keeps_it() -> None:
    run = _code("workflow", "skillrun.js")
    prop = run.split("export function proposeRun", 1)[1].split("export function", 1)[0]
    assert 'mintId("proposal")' in prop
    # MINTED, never read out of the payload: `proposal` is model output, and an
    # answer carrying its own id would put an identity under content's control
    # (codex review 轮 6)
    assert "if (isObj(r.proposal)) r.proposal.proposalId = mintId(" in prop
    assert "export function proposalIdOf" in run


def test_origin_is_recorded_only_where_the_caller_named_it() -> None:
    """按「时间接近 + 同 context」推断出的血缘比没有血缘更糟：它看起来像记录。"""
    gen = _code("workflow", "genlib.js")
    assert "origin: originOf(entry.origin)" in gen
    assert "function originOf(raw)" in gen
    assert "if (!skillRunId || !proposalId) return null;" in gen
    # nothing in the generation registry searches for a nearby proposal
    for guess in ("skillRuns", "findRun", "nearest", "createdAt >"):
        assert guess not in gen, f"{guess} would infer an origin"

    app = _code("app.js")
    imp = app.split("importResult: async", 1)[1].split("\n    },", 1)[0]
    # ADR-0061 决策 3 added a SECOND way for the creator to name the run: pressing
    # 「用于生成」 on a proposal. Both branches are an explicit human statement —
    # what stays forbidden is INFERRING one, and `pendingOriginFor` refuses to:
    # it returns only what 「用于生成」 recorded, scoped to that run's own shot.
    assert "ctx.skills.originOf(fromSkillRunId)" in imp, (
        "a named run is still the primary origin"
    )
    assert "ctx.skills.pendingOriginFor(shotId)" in imp, (
        "the 「用于生成」 intent is the only other source of an origin"
    )
    # an import with NEITHER has no origin — the fallback chain must bottom out in
    # a lookup that can answer null, never in a search for a plausible proposal
    skills_block = app.split("pendingOriginFor:", 1)[1].split("\n    },", 1)[0]
    assert "if (!pendingOrigin) return null;" in skills_block, (
        "no explicit 「用于生成」 → no origin"
    )
    for guess in ("nearest", "createdAt >", "slice(-1)"):
        assert guess not in skills_block, f"{guess} would infer an origin"


def test_the_recorded_episode_is_the_one_the_prompt_actually_read() -> None:
    """codex review：`ctx.skills.context` 只从 ACTIVE 剧集组装输入，因此接受
    调用方传入的 episodeId 会记录一个 prompt 从未读过的上下文——一条长得和
    溯源一模一样的谎。场景/镜头可以缩小范围，但必须属于那一集。"""
    app = _code("app.js")
    scope = app.split("scopeOf: (skillId, scope = null)", 1)[1].split("\n    },", 1)[0]
    assert "const episodeId = ep ? ep.episodeId : null;" in scope
    assert "s.episodeId" not in scope, (
        "the caller must not be able to re-point the episode"
    )
    # a scene/shot from another episode is dropped, not recorded
    assert "const owns = (sceneId, shotId)" in scope
    # TASK-067: a shot-scoped run's scene is DERIVED from the shot rather than left
    # null — `shotContext` really does project the shot's own scene, so recording
    # null would under-report what the prompt read. The rule below is unchanged: a
    # scene/shot the episode does not own is still dropped by `narrow`.
    assert "narrow ? (wantScene || derivedScene) : null" in scope
    assert "narrow ? wantShot : null" in scope
    # …and the derived scene is LOOKED UP in that episode, never guessed
    assert (
        "(ep.scenes || []).find((sc) => (sc.shotIds || []).includes(wantShot))" in scope
    )
    # …and a LEVEL is recorded only when the skill actually reads that level:
    # a skill given only the outline never saw a shot (codex review 轮 10)
    assert (
        'const readsScene = keys.has("scenes") || skills.isShotScoped(skill);' in scope
    )
    # TASK-064 Phase 3: `shotAudio` is per-shot data too, so a Sound Designer run
    # given it can honestly be narrowed to one shot. TASK-067: a shot-scoped input
    # is per-shot BY DEFINITION. The RULE is unchanged — a level is recorded only
    # when the skill actually reads that level.
    assert (
        'const readsShot = keys.has("shots") || keys.has("shotAudio") '
        "|| skills.isShotScoped(skill);"
    ) in scope
    assert "readsScene && typeof s.sceneId" in scope
    assert "readsShot && typeof s.shotId" in scope


def test_scene_and_shot_are_validated_TOGETHER() -> None:
    """codex review 轮 2：分别验证会让「S01 的场景 + S02 的镜头」两项独立检查
    都通过，于是记录下一个并不存在的场景/镜头配对。"""
    app = _code("app.js")
    scope = app.split("scopeOf: (skillId, scope = null)", 1)[1].split("\n    },", 1)[0]
    owns = scope.split("const owns = (sceneId, shotId)", 1)[1].split("};", 1)[0]
    assert "const home = scene ||" in owns, "the shot must live in the scoped scene"
    assert "home.shotIds || []).includes(shotId)" in owns


def test_the_read_model_reports_only_ids_that_RESOLVE() -> None:
    """codex review 轮 2/3：把请求的 id 原样抄进 context，会让导演引用一份它
    根本没有打开过的记录——剧集这一层同样如此。"""
    pg = _code("workflow", "prodgraph.js")
    assert "const episodeId = episode ? episode.episodeId : null;" in pg
    assert "const scene = wantScene ? allScenes.find" in pg
    assert "scene ? scene.shotIds.includes(wantShot) : ownedShotIds.has(wantShot)" in pg


def test_narrowing_actually_narrows_the_generations() -> None:
    """codex review 轮 2：场景范围返回整集镜头的生成、镜头范围扫进整集的无目标
    渲染，都会让一次针对某个场景的观察建立在别处的历史上。"""
    pg = _code("workflow", "prodgraph.js")
    assert "const scopeShotIds = shotId" in pg
    assert "new Set(homeScene.shotIds)" in pg
    assert "return !sceneId && !shotId && episodeOf(g) === episodeId;" in pg
    # …and the shots/QC/references the model reports narrow with it (轮 3)
    assert "const shots = [...scopeShotIds]" in pg
    assert "const scenes = homeScene ? [homeScene] : allScenes;" in pg


def test_the_director_reads_its_shot_from_the_model_it_cites() -> None:
    """codex review 轮 3：独立地从 sel 取 shotId，会让面板为一份并未产生上面
    那段文字的上下文作证——被模型判定为过期或跨集的选择仍会被印成依据。"""
    d = _code("ui", "director.js")
    head = d.split("export function directorModel", 1)[1].split("let primary", 1)[0]
    assert "production.context.shotId" in head, (
        "the shot must come from the model whose ids are shown as the evidence"
    )
    # the independent read is the fallback, not the source
    assert head.index("production.context.shotId") < head.index("sel.selectedShotId")


def test_the_validator_refuses_an_empty_context_or_runless_origin() -> None:
    """codex review 轮 2：全 null 的 context 会被图当作「已记录」，从而抹掉
    「未记录」这个状态；只有 proposalId 的 origin 无法被解析。"""
    schema = _code("services", "canvasschema.js")
    assert "has a context naming nothing" in schema
    assert "has a half origin" in schema


def test_an_origin_is_only_stamped_for_an_ACCEPTED_proposal() -> None:
    """codex review：等待中的运行还没有答案，被拒绝的提案没有发起任何东西，
    没有 id 的提案无法被指向。给它们盖章就是让生成声称一份记录不支持的来历。"""
    app = _code("app.js")
    origin = app.split("originOf: (skillRunId)", 1)[1].split("\n    },", 1)[0]
    assert 'r.status !== "accepted" || !proposalId' in origin
    assert "return null" in origin


def test_an_origin_missing_either_half_is_refused() -> None:
    """codex review 轮 2/3：origin 的含义是「从这份提案发起」。没有提案的运行
    什么也没发起；没有运行的提案名指一个答案，却没有任何记录说明谁被问过。
    任何一半单独存在都会被画成一条无法解析的链接。"""
    gen = _code("workflow", "genlib.js")
    fn = gen.split("function originOf(raw)", 1)[1].split("\n}", 1)[0]
    assert "if (!skillRunId || !proposalId) return null;" in fn


def test_the_graph_places_a_run_only_by_the_context_it_recorded() -> None:
    """没有记录 context 的旧运行不能被扫进当前剧集。"""
    prov = _code("workflow", "provenance.js")
    block = prov.split("for (const r of arr(skillRuns))", 1)[1].split(
        "for (const g of arr(generations))", 1
    )[0]
    assert "contextRecorded: !!c" in block
    # edges are drawn only from a context that both EXISTS and agrees with
    # itself (codex review 轮 7 moved the episode edge inside that guard)
    assert "if (c && !consistent) {" in block
    assert "} else if (c) {" in block
    assert "if (c.episodeId) addEdge(" in block
    for guess in ("activeEpisodeId", "episodes[0]"):
        assert guess not in block, (
            f"{guess} would attribute a run to an episode it never named"
        )
    # a dangling origin is REPORTED, not drawn to nothing
    assert 'kind: "danglingOrigin"' in prov
    # …and a context that contradicts itself (one episode named, a shot that
    # really lives in another) draws nothing at all (codex review 轮 7)
    assert 'kind: "inconsistentContext"' in prov
    assert "contextInconsistent: !!c && !consistent" in prov


def test_every_edge_connects_nodes_that_exist() -> None:
    """codex review 轮 4：`canon:<episodeId>` 这样的 id 随时可以拼出来，但它
    并不证明那个节点被创建过。没有 basedOn stamp 的剧集没有基线节点，指向它的
    边会画出一条文档从未记录的血缘。在 addEdge 这一层收口，任何将来新增的边
    都不可能再引入这一类。"""
    prov = _code("workflow", "provenance.js")
    fn = prov.split("const addEdge = (from, to, kind)", 1)[1].split("};", 1)[0]
    assert "if (!nodes.has(from) || !nodes.has(to)) return;" in fn


def test_the_unified_read_model_returns_the_context_it_read() -> None:
    """一个不能被追溯到上下文的判断是意见，不是观察（要求 1 + 9）。"""
    pg = _code("workflow", "prodgraph.js")
    assert "const context = { episodeId" in pg
    # all nine surfaces
    for surface in (
        "canon:",
        "story:",
        "episode:",
        "scenes,",
        "shots,",
        "referenceKeys,",
        "skillRuns:",
        "generations:",
        "qc,",
        "finals:",
    ):
        assert surface in pg, f"the model must read {surface}"
    # QC reports WHICH take was approved — ADR-0057 must not regress
    assert "approvedAssetId" in pg
    # and the Director actually reads through it
    d = _code("ui", "director.js")
    assert "contextIds: production ? production.context : null" in d
    prod_ui = _code("ui", "production.js")
    assert "production: ctx.prodgraph.model(" in prod_ui


def test_the_read_model_copies_no_canonical_story(monkeypatch=None) -> None:
    """要求 8：canonical story 不复制进读模型。它带 id、计数和少量已解析标签。"""
    pg = _code("workflow", "prodgraph.js")
    # the story surfaces as STANDING (which version is approved), never as text
    standing = pg.split("function storyStanding", 1)[1].split("\n}", 1)[0]
    for content in ("idea:", "content", "outline.", "text"):
        if content == "idea:":
            # a boolean "is there an idea at all" is standing, not content
            assert "idea: !!str(story.idea).trim()" in standing
            continue
        assert content not in standing, f"{content} would copy canon into the model"
    script = pg.split("function scriptStanding", 1)[1].split("\n}", 1)[0]
    assert "hasContent: !!str(text).trim()" in script, (
        "the script's standing, not its text"
    )
    assert (
        "return {\n    versions:" in script
        or "versions: arr(doc.versions).length" in script
    )


def test_the_graph_still_persists_no_topology() -> None:
    """要求 7：拓扑一行都不持久化。"""
    prov = _code("workflow", "provenance.js")
    for forbidden in ("persist(", "saveCanvas", "localStorage"):
        assert forbidden not in prov
    schema = _code("services", "canvasschema.js")
    for topology in ("provenanceGraph", "graphNodes", "graphEdges"):
        assert topology not in schema, f"{topology} would make the graph a stored fact"


def test_qc_approval_still_binds_a_take() -> None:
    """ADR-0057 不回归：通过绑定的是具体那一条 take。"""
    dom = _code("workflow", "shotprod.js")
    assert "export function isApprovedFor" in dom
    assert "r.assetId === videoAssetId" in dom
    pg = _code("workflow", "prodgraph.js")
    qc = pg.split("const qc = shots.map", 1)[1].split("\n  });", 1)[0]
    assert "approvedAssetId: isObj(r) ? str(r.assetId)" in qc, (
        "the model reports WHICH take was approved, not merely that one was"
    )
