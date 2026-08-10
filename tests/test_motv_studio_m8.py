"""motv Production studio UI reconstruction — checkpoint M8.

STRICTLY OFFLINE, no spend. Runs the frontend units (storyboard/shot-detail
models, AI Director model, creative-facet passthrough, bible breakdown
parse/match/merge semantics, derived appearances) via ``node --test`` and
guards the wiring contract:

- the studio is a VIEW: no new persisted top-level field, no duplicate media
  state — media writes stay on mediaref/the M3 registry, shot edits append
  immutable scriptgen draft versions, provenance stays on the M5 registry;
- the bible breakdown endpoint follows the ADR-0042 agent posture (local
  ``claude -p``, fail-closed strict parse, writes nothing server-side) and
  everything it returns is a PROPOSAL — application is an explicit user act;
- episode appearances are DERIVED from scene references, never stored;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _server_module():
    spec = importlib.util.spec_from_file_location(
        "motv_server_m8", _MOCKUP_DIR / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_studio_units_via_node() -> None:
    """M8 studio 模型 / 拆解提案域 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/studio.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_studio_adds_no_new_persisted_field() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    serializer = app[
        app.index("function serializeGraph") : app.index("function attachAssetViews")
    ]
    # exactly the domain field set (M9: scriptDoc → per-episode scripts +
    # story) — the studio persists NOTHING of its own
    for field in (
        "story:",
        "scripts,",
        "assets:",
        "generations:",
        "production:",
        "nodes:",
        "edges:",
        "pan:",
    ):
        assert field in serializer
    assert "bibleProposals" not in serializer  # proposals are transient review state
    assert "selectedShot" not in serializer


def test_media_actions_reuse_the_single_write_paths() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # variant switching goes through the SAME mediaref primitive as the node
    # version picker, against the M3 registry maps — no duplicate media state
    assert "mediaref.setCurrent({ uploads: map }" in app
    sb = (_SRC / "ui" / "storyboard.js").read_text("utf-8")
    for forbidden in ("addVersion(", "history.push", "localStorage"):
        assert forbidden not in sb, (
            f"storyboard must not write media state ({forbidden})"
        )


def test_shot_edits_append_immutable_draft_versions() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # ctx.shots.saveEdit pushes a NEW version and re-points cur — same
    # discipline as the node's ✎ editor; creative facets ride additively
    assert "node.versions.push({" in app
    assert 'origin: "edited"' in app
    editor = (_SRC / "ui" / "shoteditor.js").read_text("utf-8")
    for facet in ("action", "cameraMotion", "dialogue"):
        assert facet in editor


def test_breakdown_endpoint_is_fail_closed_and_write_free() -> None:
    server = _server_module()
    # strict parse: junk raises, well-formed passes
    with pytest.raises(ValueError):
        server._parse_bible_breakdown("no json here")
    with pytest.raises(ValueError):
        server._parse_bible_breakdown('{"characters": [{"noname": 1}]}')
    with pytest.raises(ValueError):
        server._parse_bible_breakdown('{"characters": [], "locations": []}')
    raw = '前言 {"characters": [{"name": "李昭"}], "locations": [{"name": "殿"}]} 后记'
    out = server._parse_bible_breakdown(raw)
    assert [c["name"] for c in out["characters"]] == ["李昭"]
    src = (_MOCKUP_DIR / "server.py").read_text("utf-8")
    handler = src[
        src.index("def _agent_bible_breakdown") : src.index("def _agent_script_draft")
    ]
    # the endpoint writes nothing server-side and embeds the script as data
    assert "_data_embed" in handler
    assert "open(" not in handler and ".write(" not in handler


def test_appearances_are_derived_not_stored() -> None:
    bd = (_SRC / "workflow" / "breakdown.js").read_text("utf-8")
    assert "export function derivedAppearances" in bd
    # nothing writes an appearance/episode list onto bible entities
    bible = (_SRC / "workflow" / "bibledoc.js").read_text("utf-8")
    for forbidden in ("appearances", "episodeIds", "appearsIn"):
        assert forbidden not in bible, (
            f"appearance lists must stay derived ({forbidden})"
        )


def test_proposals_apply_through_existing_bible_ops_only() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    block = app[app.index("breakdown: {") : app.index("// Shot-draft controller")]
    # every application composes existing bibledoc ops — no direct doc surgery
    for op in (
        "bibledoc.addCharacter",
        "bibledoc.updateCharacterProfile",
        "bibledoc.addLocation",
    ):
        assert op in block
    assert "productionDoc.characters.push" not in block
    assert "productionDoc.locations.push" not in block


def test_core_contracts_untouched_by_m8() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    for needle in (
        "storyboardModel",
        "directorModel",
        "parseBreakdown",
        "bible-breakdown",
    ):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
