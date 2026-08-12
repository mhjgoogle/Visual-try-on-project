"""motv Production upstream workspace — TASK-057 / ADR-0054.

STRICTLY OFFLINE, no spend. Runs the frontend units (Creative Brief version
semantics, first-class Relationships, World Setting, Episode beats, the
upstream dependency mechanism, character tiers, the v9→v10 migration and v10
validation, plus the upstream view models) via ``node --test`` and guards the
wiring contract:

- Production's职责 stops at 创意 → 故事大纲 → 作品设定 → 分集规划; the downstream
  production stages are NOT in the project rail (ADR-0054 决策 1);
- Autosave != Version: only an explicit user act creates a Revision or bumps a
  canon revision number (决策 2 / 决策 6);
- Canonical domain only: the Creative Brief lives in the EXISTING story
  document, Relationships/World live in the production document, and no UI
  module keeps a second copy of a Character, a Relationship or an Outline;
- an upstream revision NEVER auto-rewrites an Episode; the Impact Review
  separates the deterministic dependency change from the AI semantic judgement,
  and the latter is honestly reported as unavailable (决策 6);
- AI output stays a Proposal — the AI-proposed-character route is not simulated
  (决策 7 / §10);
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — these tests assert about what the code
    DOES, and a module header that merely explains a boundary must not read as
    a violation of it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_upstream_units_via_node() -> None:
    """TASK-057 上游域 / v9→v10 迁移 / v10 校验 / 视图模型 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/upstream.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_production_rail_is_upstream_only() -> None:
    """左栏一级导航是「作品开发」；画面/视频/音频/剪辑 不在其中。"""
    shell = _read("ui", "shell.js")
    nav = shell[
        shell.index("export const NAV = [") : shell.index("export const EPISODE_NAV")
    ]
    for key in (
        '"brief"',
        '"story"',
        '"characters"',
        '"relationships"',
        '"world"',
        '"episodes"',
    ):
        assert key in nav, f"upstream rail is missing {key}"
    for key in ('"frames"', '"video"', '"audio"', '"edit"', '"shots"'):
        assert key not in nav, f"downstream stage {key} must not be in the project rail"
    # ADR-0061 决策 1 renamed this space 故事开发 (「把故事写出来」) and extended it to
    # end at 本集剧本 — media production moved out to the 剧集制作 space entirely.
    assert '"故事开发"' in nav
    assert '"script"' in nav, "story development ends at the episode script"
    # The episode's production stages are the 剧集制作 space's centre tabs
    # (ADR-0061 决策 2) rather than a sub-tree nested under an episode row.
    episode_nav = shell[
        shell.index("export const EPISODE_NAV") : shell.index("export const ASSET_NAV")
    ]
    for key in ('"shots"', '"frames"', '"video"', '"audio"', '"edit"'):
        assert key in episode_nav
    # 剧本 is NOT here: story development ends at the episode script, and 剧集制作
    # begins FROM it. Both spaces claiming it is exactly the overlap ADR-0061 removed.
    assert '"script"' not in episode_nav, "本集剧本 belongs to 故事开发, not 剧集制作"
    # the unified workbench leads, and the provenance VIEW is part of this space
    assert '"workbench"' in episode_nav
    assert '"provenance"' in episode_nav
    # …and no second flow model on any creator path
    assert '"canvas"' not in episode_nav


def test_creative_brief_lives_in_the_existing_story_document() -> None:
    """Creative Brief 复用故事域，不新建第二套版本系统。"""
    story = _read("workflow", "storydoc.js")
    for fn in (
        "editBriefDraft",
        "commitBrief",
        "briefIsDirty",
        "activeBrief",
        "restoreBriefDraft",
    ):
        assert f"export function {fn}" in story
    # there is no separate brief document module competing with storydoc
    assert not (_SRC / "workflow" / "briefdoc.js").exists()
    # the core idea has ONE home: the brief's own fields never include it
    fields = story[story.index("export const BRIEF_FIELDS") :]
    fields = fields[: fields.index("\n")]
    for forbidden in ("idea", "coreIdea"):
        assert f'"{forbidden}"' not in fields


def test_autosave_never_creates_a_version() -> None:
    """自动保存只写 Working Draft；正式版本只能由用户显式创建。"""
    app = _read("app.js")
    brief_block = app[app.index("editBrief: (fields)") : app.index("setActiveOutline:")]
    # the autosave path persists but never commits
    assert "storydoc.editBriefDraft" in brief_block
    assert "commitBrief" in brief_block
    edit_line = next(
        ln for ln in brief_block.splitlines() if "editBrief: (fields)" in ln
    )
    assert "commitBrief" not in edit_line, "editing the brief must not create a version"

    # the canon revision counters move ONLY through the explicit confirm op
    canon = _code("workflow", "canondoc.js")
    assert "export function confirmCanon" in canon
    for mutator in ("updateWorld", "updateRelationship", "addRelationship"):
        block = canon[canon.index(f"export function {mutator}") :]
        block = block[: block.index("\n}")]
        assert "canon[" not in block, f"{mutator} must not bump a revision number"


def test_relationship_is_first_class_and_references_characters_by_id() -> None:
    """关系是独立对象，只按 characterId 引用角色，绝不复制角色档案。"""
    canon = _code("workflow", "canondoc.js")
    assert "export const RELATIONSHIP_FIELDS" in canon
    for facet in (
        "coreConflict",
        "tension",
        "power",
        "history",
        "secrets",
        "arc",
        "forbidden",
    ):
        assert f'"{facet}"' in canon
    add = canon[
        canon.index("export function addRelationship") : canon.index(
            "export function removeRelationship"
        )
    ]
    # exactly two DISTINCT existing characters, one definition per pair
    assert "aId === bId" in add
    assert "relationshipBetween" in add
    assert "characterIds" in add
    # a relationship stores ids, never a profile copy
    assert "profile: c.profile" not in canon
    assert "appearance" not in canon


def test_world_setting_does_not_duplicate_the_location_domain() -> None:
    """世界观是上游 Canon，不是第二份地点数据库。"""
    canon = _code("workflow", "canondoc.js")
    assert "export const WORLD_FIELDS" in canon
    # World never touches location entities or scene location refs
    for forbidden in ("locationId", "locationRef", "addLocation", "bibledoc"):
        assert forbidden not in canon, (
            f"World Setting must not reach into the Location domain ({forbidden})"
        )
    worldws = _read("ui", "worldws.js")
    assert "不是第二份地点数据库" in worldws


def test_relationship_beat_is_episode_level_only() -> None:
    """Relationship Beat 只记录该集实际发生，不修改 Project-level 定义。"""
    canon = _code("workflow", "canondoc.js")
    block = canon[canon.index("export function setEpisodeRelationshipBeat") :]
    block = block[: block.index("export function stampEpisodeUpstream")]
    # it writes the EPISODE's beat list and nothing else
    assert "ep.beats.relationship" in block
    assert ".profile" not in block, (
        "an episode beat must not write the relationship definition"
    )


def test_upstream_revision_never_rewrites_an_episode() -> None:
    """上游创建新 Revision 不自动改写任何 Episode。"""
    canon = _code("workflow", "canondoc.js")
    confirm = canon[
        canon.index("export function confirmCanon") : canon.index(
            "export function upstreamVersions"
        )
    ]
    for forbidden in ("episodes", "beats", "basedOn", "title"):
        assert forbidden not in confirm, (
            f"confirming a canon revision must not touch {forbidden}"
        )
    # the stamp is explicit, and impact is a pure diff
    assert "export function stampEpisodeUpstream" in canon
    assert "export function episodeImpact" in canon
    impact = canon[canon.index("export function episodeImpact") :]
    assert "ep.beats" not in impact
    assert "renameEpisode" not in impact


def test_impact_review_does_not_fake_an_ai_verdict() -> None:
    """Impact Review 区分确定性依赖变化与 AI 语义判断；后者显示为未接入。"""
    canon = _read("workflow", "canondoc.js")
    assert "semantic: { available: false" in canon
    ws = _read("ui", "epplanws.js")
    assert "确定性依赖变化" in ws
    assert "AI 语义影响判断" in ws
    assert "dir-unavail" in ws  # rendered as unavailable, not as a verdict


def test_ai_character_proposal_is_not_simulated() -> None:
    """AI 新增角色只能是 Proposal；本批没有真实通道，因此不模拟。"""
    biblews = _read("ui", "biblews.js")
    assert "尚未接入" in biblews
    assert "未经确认不写入 Canon" in biblews
    # the domain supports the decision (formal / bit / promote) without any AI
    bible = _read("workflow", "bibledoc.js")
    assert "export function setCharacterTier" in bible
    assert "export const CHARACTER_TIERS" in bible


def test_promotion_preserves_identity_and_references() -> None:
    """提升为正式角色只翻转 tier，不动身份与任何引用。"""
    bible = _code("workflow", "bibledoc.js")
    block = bible[bible.index("export function setCharacterTier") :]
    block = block[: block.index("\n}")]
    assert "c.tier = tier" in block
    for forbidden in ("characterId =", "referenceAssetIds =", "states =", "filter("):
        assert forbidden not in block, f"promotion must not rewrite {forbidden}"


def test_canonical_domain_only_no_second_copies() -> None:
    """UI 不保存第二份 Character / Relationship / Outline / Canon。"""
    for name in ("briefws.js", "relws.js", "worldws.js", "epplanws.js"):
        src = _read("ui", name)
        # every write goes through a ctx controller; no module-level mutable store
        assert "let " not in src.split("export function")[0], (
            f"{name} must not hold module state"
        )
        for forbidden in ("localStorage", "sessionStorage"):
            assert forbidden not in src, (
                f"{name} must not persist its own copy ({forbidden})"
            )
    # the canon controller is the single write path from the UI
    app = _read("app.js")
    canon_ctl = app[app.index("  canon: {") : app.index("  agentShotsDraft:")]
    for op in (
        "addRelationship",
        "updateRelationship",
        "updateWorld",
        "confirm:",
        "stamp:",
        "impact:",
    ):
        assert op in canon_ctl


def test_schema_v10_migration_is_additive_and_scoped() -> None:
    """v9→v10 纯追加；不顺手做无关的 asset URL 迁移。

    这里**不锁定当前版本号**：v10 是 Production 上游 canon 的迁移步，后续迁移
    （asset URL / project-relative path 等）按约定使用 v11+，把当前号写死会让
    合法的后续迁移误报失败。要守住的是 v10 这一步存在、已注册、且只做上游追加。
    """
    schema = _read("services", "canvasschema.js")
    match = re.search(r"CANVAS_SCHEMA_VERSION = (\d+)", schema)
    assert match is not None
    assert int(match.group(1)) >= 10, "v10 (TASK-057) must not be renumbered away"
    assert "function migrateV9ToV10" in schema
    assert "9: migrateV9ToV10" in schema
    code = _code("services", "canvasschema.js")
    # bound the slice by the NEXT migration function, not by MIGRATIONS: a later
    # v10→v11 step legitimately sits between them and is not ours to police
    body = code[code.index("function migrateV9ToV10") :]
    end = body.find("\nfunction migrate", 1)
    mig = body[: end if end != -1 else body.index("export const MIGRATIONS")]
    # it adds the new canon and nothing else — media/assets are untouched
    for forbidden in ("assets", "generations", "timelines", "url", "uploads"):
        assert forbidden not in mig, f"the v10 migration must not touch {forbidden}"
    # and it mints NO brief revision the creator never confirmed
    assert "versions: []" in mig
    assert "active: 0" in mig


def test_unknown_baseline_is_a_third_state_not_outdated() -> None:
    """basedOn = 0 是 unknown/未记录，不得被判为「上游已更新」。"""
    canon = _code("workflow", "canondoc.js")
    # the four states exist as real domain values, classified in ONE place
    assert "export const UPSTREAM_STATE" in canon
    assert "export function surfaceState" in canon
    for state in ("unknown", "current", "outdated", "diverged"):
        assert f'{state.upper()}: "{state}"' in canon
    body = canon[canon.index("export function surfaceState") :]
    body = body[: body.index("\n}")]
    # 0 → unknown, and it is decided BEFORE any ordering comparison
    assert "UPSTREAM_STATE.UNKNOWN" in body
    assert body.index("UNKNOWN") < body.index("OUTDATED"), (
        "an unrecorded baseline must be classified before the > comparison"
    )
    # the change COUNT excludes unknown by construction
    impact = canon[canon.index("export function episodeImpact") :]
    assert "count: outdated.length + diverged.length" in impact
    assert "unknown.length" not in impact.split("count:")[1].split("\n")[0]

    # the UI never prints a change count for an unrecorded baseline
    ws = _read("ui", "epplanws.js")
    assert "上游基线未记录" in ws
    assert "建立当前基线" in ws
    flag = ws[ws.index("const flag = im.count") :]
    flag = flag[: flag.index("return `<div")]
    assert "im.unknown.length" in flag
    assert "个上游变化" in flag.split("im.unknown.length")[0], (
        "the change count must belong to the im.count branch only"
    )
    assert "个上游变化" not in flag.split("im.unknown.length")[1]


def test_baseline_is_only_recorded_by_an_explicit_user_act() -> None:
    """迁移不猜；只有显式行为（建立基线 / 复核 / 确认规划新建集）才记录基线。"""
    schema = _code("services", "canvasschema.js")
    mig = schema[
        schema.index("function migrateV9ToV10") : schema.index(
            "export const MIGRATIONS"
        )
    ]
    # the migration writes an all-zero stamp and never reads a version to guess
    assert "brief: 0, outline: 0, characters: 0, relationships: 0, world: 0" in mig
    for forbidden in (
        "approved",
        "brief.active",
        "upstreamVersions",
        "canon.characters",
    ):
        assert forbidden not in mig, (
            f"the migration must not guess a baseline ({forbidden})"
        )

    app = _read("app.js")
    block = app[app.index("confirmPlan: (v) =>") : app.index("openEpisodeScript")]
    # only newly created + the adopted pristine episode get a baseline
    assert "baseline.push" in block
    assert "stampEpisodeUpstream" in block
    existing_branch = block[
        block.index("if (existing) {") : block.index("} else if (pristine")
    ]
    assert "baseline.push" not in existing_branch, (
        "a pre-existing episode must not be stamped by plan confirmation"
    )
    # pristineness now includes "no recorded beats"
    assert "beats" in block[: block.index("let adopted")]


def test_no_source_file_contains_a_nul_byte() -> None:
    """源码里不得出现字面 NUL。

    git 会把含 NUL 的文件判定为 binary：它的内容从此不出现在任何 diff 里，
    也就**永远不会进入 code review**（TASK-057 实际发生过两次：canondoc.js 的
    pairKey 与 upstream.test.mjs 的分隔符用例）。控制字符必须写成 ``\\u0000``
    转义，而不是字面字节。
    """
    roots = [
        _MOCKUP_DIR / "src",
        _MOCKUP_DIR / "tests",
        _MOCKUP_DIR / "fixtures",
        _MOCKUP_DIR / "styles",
    ]
    offenders = []
    for root in roots:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {
                ".js",
                ".mjs",
                ".css",
                ".html",
            }:
                continue
            if b"\x00" in path.read_bytes():
                offenders.append(str(path.relative_to(_MOCKUP_DIR)))
    assert not offenders, f"literal NUL byte (git treats these as binary): {offenders}"


def test_core_contracts_untouched_by_task057() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    for needle in (
        "canondoc",
        "relationshipId",
        "basedOn",
        "confirmCanon",
        "briefVersionId",
    ):
        hits = [
            p
            for p in core.rglob("*.py")
            if needle in p.read_text("utf-8", errors="ignore")
        ]
        assert not hits, f"{needle} leaked into Core: {hits}"
