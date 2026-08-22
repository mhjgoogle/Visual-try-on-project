"""motv Production domain structure — checkpoint M6.

STRICTLY OFFLINE, no spend. Guards the wiring contract that lives in
DOM-bound closures (proddoc transitions / episode read model / v5→v6
migration / v6 validation behavior is covered by the frontend suite,
``tests/proddoc.test.mjs``):

- the Project → Episodes → Scenes → Shots structure is a PROJECT-level durable
  document (top-level ``production``), not workflow-node state;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def test_production_is_project_level_persisted_not_node_owned() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # top-level, parallel to assets/generations, serialized + hydrated
    assert "production: proddoc.serialize(productionDoc)" in app
    assert "proddoc.createProduction" in app
    # no workflow node imports or owns the production document
    for node in (
        "script.js",
        "scriptgen.js",
        "assets.js",
        "video.js",
        "audio.js",
        "edit.js",
    ):
        node_src = (_SRC / "workflow" / "nodes" / node).read_text("utf-8")
        assert "proddoc" not in node_src


def test_core_contracts_untouched_by_m6() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("episodeId", "sceneId", "createProduction", "proddoc"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
