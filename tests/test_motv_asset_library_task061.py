"""motv 生产记忆库 / 本集制作 / 溯源创作主干 — TASK-061 / ADR-0058.

STRICTLY OFFLINE, no spend. Runs the frontend units via ``node --test`` and
guards the contracts that a UI-level test could not see:

- Usage is DERIVED and de-duplicated — never a stored second truth;
- the Asset Library is visual-first: path / assetId / storageState are not the
  primary surface;
- 临时上传 goes through the ONE registration path — no code path can leave
  orphan media behind;
- a route's unknown fields stay null; nothing invents a model or a seed;
- a shared Reference is ONE node in the provenance graph, bound by key;
- filtering the graph never rewrites an edge;
- the Core contract is untouched (all of this is mockup/client-side).
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
    """Source with comments stripped — so a rule can never be 'satisfied' by a
    comment that merely describes it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_cp5_cp6_cp7_units_via_node() -> None:
    """资产使用派生 / 本集制作 / 参考统筹 / 生成输入集合 / 溯源主干 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            "node",
            "--test",
            "tests/assetusage.test.mjs",
            "tests/episodeprod.test.mjs",
            "tests/wfspine.test.mjs",
        ],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_usage_is_derived_and_never_persisted() -> None:
    """「这个资产被哪里用了」不能给出过期答案：一旦存储，重新剪辑 / 切换版本 /
    解绑参考的瞬间就会漂移出第二份真相。"""
    usage = _code("workflow", "assetusage.js")
    # no writes at all: it only reads the canonical documents
    for forbidden in ("persist", "addVersion", "declare(", "= assetRegistry"):
        assert forbidden not in usage, f"{forbidden} would make usage a stored fact"
    # …and the serialized canvas never carries a usage field
    schema = _code("services", "canvasschema.js")
    assert "usage" not in schema

    # de-duplication is keyed on the PLACE, so one dependency is counted once
    assert "const seen = new Set()" in usage
    assert "if (seen.has(key)) return" in usage


def test_shot_usage_is_found_by_reference_KEY_not_by_assetId() -> None:
    """A Shot binds the CHAIN. Looking usage up by assetId would report a
    shared reference as unused the moment its chain moved to v2."""
    usage = _code("workflow", "assetusage.js")
    shot_block = usage.split('kind: "shot-reference"', 1)[0].rsplit("if (nonEmpty(", 1)[
        -1
    ]
    assert "referenceKey" in shot_block
    assert "list.includes(referenceKey)" in usage
    # the batch index passes the chain key through, else every card would lie
    assert "referenceKey: a.key || null" in usage


def test_the_library_is_visual_first_and_ids_are_not_the_main_surface() -> None:
    """path / assetId / storageState 退到 Inspector 的技术详情折叠区。"""
    lib = _code("ui", "assetlibws.js")
    card = lib.split("\nfunction card(a)", 1)[1].split("\nfunction ", 1)[0]
    # the id may be the CLICK TARGET, but it must never be rendered as text
    assert 'data-al-open="${esc(a.assetId)}"' in card
    for id_ish in ("a.storageState", "a.path", "a.url}", "a.key"):
        assert id_ish not in card, f"{id_ish} must not be on the card face"
    assert card.count("a.assetId") == 1, "assetId appears only as the click target"
    # the card shows real media, and says what the creator recognises it by
    assert "preview(a)" in card
    assert "a.name" in card
    # …while the technical facts live LAST, in a collapsed section
    tech = lib.split('class="al-tech"', 1)[1]
    assert (
        "<details" in lib.split('class="al-tech"', 1)[0][-200:]
        or "<details" in tech[:200]
    )
    for id_ish in ("assetId", "storageState"):
        assert id_ish in tech, f"{id_ish} is true and useful — it belongs here"


def test_temp_upload_still_registers_and_cannot_orphan_media() -> None:
    """临时上传不是绕过登记的捷径 (ADR-0058 决策 5)。"""
    app = _code("app.js")
    block = app.split("uploadReference: async (shotId, kind)", 1)[1].split(
        "importResult:", 1
    )[0]
    # ONE import path, then a binding — no direct upload call anywhere in it
    assert "ctx.assets.importReference" in block
    assert "ctx.shot.addReference" in block
    assert "query.uploadAssetImage" not in block, (
        "the picker must not upload on its own"
    )
    # the same is true of the Reference Plan's gap action
    plan = app.split("uploadFor: async (kind, subjectId)", 1)[1].split("\n  },", 1)[0]
    assert "ctx.assets.importReference" in plan
    assert "query.uploadAssetImage" not in plan


def test_the_reference_plan_never_copies_a_canonical_asset() -> None:
    """十个镜头共用一张参考图是一行带十个镜头，不是十份副本。"""
    plan = _code("ui", "refplan.js")
    # rows are keyed by the reference CHAIN
    assert "rows.set(key," in plan
    assert "rows.get(key).shotIds.push(shotId)" in plan
    # and it writes nothing
    for forbidden in ("declare(", "addVersion", "persist("):
        assert forbidden not in plan


def test_an_unknown_generation_field_stays_null() -> None:
    """手工外部生成不上报模型与 seed；填一个看起来合理的默认值就是编造溯源。"""
    gen = _code("workflow", "geninput.js")
    assert "model: strOrNull(rt.model)" in gen
    # a seed of 0 is a REAL seed and must survive the null-normalisation
    assert "rt.seed === undefined || rt.seed === null ? null : rt.seed" in gen
    # nothing defaults a provider/model string
    assert '"unknown"' not in gen
    assert 'model: ""' not in gen
    # the seed only reaches parameters when it is actually known
    assert "...(set.seed !== null ? { seed: set.seed } : {})" in gen


def test_the_manual_route_records_the_same_generation_shape() -> None:
    """手工路线第一次拥有与自动路线同等的溯源：它走同一个唯一写路径，
    并把输入集合冻结进 Generation 记录。"""
    app = _code("app.js")
    imp = app.split("importResult: async (shotId, kind, file, promptText)", 1)[1].split(
        "\n    },", 1
    )[0]
    assert "generationSeedFrom" in imp
    assert "ctx.media.importShotMedia" in imp, "the ONE media write path, not a new one"
    # importShotMedia consumes the seed when the caller assembled one
    media = app.split("importShotMedia: async", 1)[1].split("useAsFirstFrame:", 1)[0]
    assert "intent.seed" in media
    # …and the older prompt-only entry keeps working (no route was broken)
    assert "promptSnapshot: intent.prompt" in media


def test_the_provenance_spine_exists_and_is_authored_not_generated() -> None:
    """剧本 → 场景 → 镜头 是 canonical 文档，不是生成物。"""
    prov = _code("workflow", "provenance.js")
    for maker in ("script:", "scene:", "shot:"):
        assert maker in prov
    assert 'story.provenance = "authored"' in prov
    # an episode with no script gets NO node rather than an empty one
    assert "if (text) {" in prov
    # a shot the draft no longer holds is kept and flagged, never dropped
    assert "dangling: !s || s.dangling === true" in prov


def test_a_shared_reference_is_one_node_bound_by_key() -> None:
    """画十份副本会说出相反的事实，并掩盖切换链版本会同时移动全部镜头。"""
    prov = _code("workflow", "provenance.js")
    binds = prov.split("shotProduction.references", 1)[1].split("firstFrames", 1)[0]
    assert "currentOfChain" in binds, "the binding names the chain's CURRENT version"
    assert 'addEdge(sid, aid, "binds")' in binds
    # a binding whose reference is gone is REPORTED, not drawn to nothing
    assert 'kind: "danglingReference"' in binds


def test_filtering_never_rewrites_an_edge() -> None:
    """过滤不能破坏 lineage truth：隐藏的中间步骤留下断口，不是捷径。"""
    wf = _code("ui", "wfgraph.js")
    filt = wf.split("export function filterGraph", 1)[1].split("\n}", 1)[0]
    # edges are only ever FILTERED by surviving endpoints — never constructed
    assert "edges: scoped.edges.filter((e) => ids.has(e.from) && ids.has(e.to))" in filt
    assert "addEdge" not in filt
    assert "push({ from" not in filt
    # the spine survives only where something below it did
    assert "SPINE.has(from.type)" in filt


def test_cp5_cp7_is_client_side_only() -> None:
    """CP5–CP7 全部在 mockup 客户端：没有一行触碰 Python 流水线包。"""
    # the two derivation modules are deliberately dependency-FREE: pure
    # functions over documents, importable by anything, coupled to nothing
    for name in ("assetusage.js", "geninput.js"):
        assert "import " not in _code("workflow", name), name
    for parts in (
        ("ui", "episodews.js"),
        ("ui", "refplan.js"),
        ("ui", "assetlibws.js"),
    ):
        code = _code(*parts)
        # every import stays inside the mockup's own module tree
        for spec in re.findall(r'^import .*? from "([^"]+)"', code, re.MULTILINE):
            assert spec.startswith("."), (
                f"{parts[-1]} reaches outside the mockup: {spec}"
            )
        # and none of them talk to the backend directly — writes go through ctx
        assert "services/query.js" not in code, parts[-1]
