"""motv Production Bible — checkpoint M7.

STRICTLY OFFLINE, no spend. Guards the wiring contract that lives in
DOM-bound closures (bibledoc transitions / resolvers / v6→v7 migration / v7
validation behavior is covered by the frontend suite, ``tests/bible.test.mjs``):

- the bible rides in the SAME ``production`` document (single write path) and
  no workflow node imports or owns it;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def test_bible_is_persisted_via_production_not_nodes() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # the bible rides in the SAME production document (single write path)
    assert "production: proddoc.serialize(productionDoc)" in app
    assert "bibledoc." in app
    for node in (
        "script.js",
        "scriptgen.js",
        "assets.js",
        "video.js",
        "audio.js",
        "edit.js",
    ):
        node_src = (_SRC / "workflow" / "nodes" / node).read_text("utf-8")
        assert "bibledoc" not in node_src


def test_core_contracts_untouched_by_m7() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("characterId", "locationId", "bibledoc", "resolveCharacter"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
