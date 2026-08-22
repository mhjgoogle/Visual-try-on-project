"""motv Production Bible — checkpoint M7.

STRICTLY OFFLINE, no spend. Runs the frontend units (bibledoc transitions,
resolvers, v6→v7 migration, v7 validation) via ``node --test`` and guards the
wiring contract:

- Characters/Locations (with States) are project-level durable entities inside
  the ``production`` document — one stable identity each; a State overrides
  presentation facets but never mints a new identity;
- VOICE RULE: a Character has ONE base voice identity; a CharacterState may
  modify performance characteristics but can never carry its own voiceId —
  enforced in the domain AND by v7 validation;
- referenceAssetIds are REFERENCES into the M3 Asset Registry (never copies,
  legitimately outliving the media);
- Scenes reference characters/locations BY ID + optional state id — full
  profiles are never duplicated into Scene or Shot;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_bible_units_via_node() -> None:
    """M7 作品设定域 / v6→v7 迁移 / v7 校验 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/bible.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_bible_is_a_dedicated_domain_module() -> None:
    src = (_SRC / "workflow" / "bibledoc.js").read_text("utf-8")
    for fn in (
        "addCharacter",
        "addCharacterState",
        "setCharacterStateOverrides",
        "addLocation",
        "addLocationState",
        "resolveCharacter",
        "resolveLocation",
        "addSceneCharacter",
        "setSceneLocation",
    ):
        assert f"export function {fn}" in src
    # ids are MINTED, never derived
    for prefix in ("char", "cstate", "loc", "lstate"):
        assert f'mintId("{prefix}")' in src


def test_voice_rule_is_enforced_in_domain_and_schema() -> None:
    bible = (_SRC / "workflow" / "bibledoc.js").read_text("utf-8")
    schema = (_SRC / "services" / "canvasschema.js").read_text("utf-8")
    # domain: a state override never accepts a voiceId
    assert "voiceId is NEVER accepted on a state" in bible
    # resolver: the voice identity always comes from the base record
    assert "ALWAYS the base identity" in bible
    # schema: a persisted state override carrying voiceId is rejected
    assert "states must keep the base voice" in schema


def test_scene_references_bible_by_id_never_copies_profiles() -> None:
    src = (_SRC / "workflow" / "bibledoc.js").read_text("utf-8")
    # scene refs are {characterId, stateId} / {locationId, stateId} — the ops
    # never write profile/appearance content onto scenes
    assert "characterRefs.push({ characterId, stateId })" in src
    assert "s.locationRef = { locationId, stateId }" in src


def test_schema_has_v7_bible_validation() -> None:
    schema = (_SRC / "services" / "canvasschema.js").read_text("utf-8")
    # the schema version has moved past 7 (M9+); M7's guarantee is the v6→v7
    # step and its invariants staying in the chain, not the current pin
    assert "function migrateV6ToV7" in schema
    assert "6: migrateV6ToV7" in schema
    assert "duplicate characterId" in schema
    assert "duplicate locationId" in schema
    assert "duplicate stateId" in schema
    assert "references unknown character" in schema
    assert "references unknown location" in schema


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
