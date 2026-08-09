"""motv Production domain structure — checkpoint M6.

STRICTLY OFFLINE, no spend. Runs the frontend units (proddoc transitions,
episode read model, v5→v6 migration, v6 validation) via ``node --test`` and
guards the wiring contract:

- the Project → Episodes → Scenes → Shots structure is a PROJECT-level durable
  document (top-level ``production``), not workflow-node state;
- Scene references shots by the canonical creativeShotId ONLY — shot content
  stays on the scriptgen draft (legacy workflow untouched);
- Asset ownership (M3 registry) and Generation provenance (M5 registry) are
  NOT duplicated into the production structure;
- episodeId/sceneId are minted, never derived from title/index/position;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_production_domain_units_via_node() -> None:
    """M6 生产域结构 / v5→v6 迁移 / v6 校验 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/proddoc.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_production_structure_is_a_dedicated_domain_module() -> None:
    src = (_SRC / "workflow" / "proddoc.js").read_text("utf-8")
    for fn in (
        "createProduction",
        "serialize",
        "addEpisode",
        "addScene",
        "assignShot",
        "unassignShot",
        "episodeView",
    ):
        assert f"export function {fn}" in src
    # ids are MINTED, never derived from title / index / position
    assert 'mintId("ep")' in src
    assert 'mintId("scene")' in src


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


def test_scene_references_shots_and_never_duplicates_content() -> None:
    src = (_SRC / "workflow" / "proddoc.js").read_text("utf-8")
    # scenes hold shot REFERENCES (ids) only — no shot content / media / asset
    # fields exist in the domain document (a prose mention in the ownership
    # comment is fine; a field write like `description:` is not)
    assert "shotIds" in src
    for owned_elsewhere in (
        "description:",
        "duration_seconds",
        "first_frame",
        "url",
        "assetId",
        "history",
    ):
        assert owned_elsewhere not in src, (
            f"production doc must not own {owned_elsewhere}"
        )


def test_schema_is_v6_with_production_structure() -> None:
    schema = (_SRC / "services" / "canvasschema.js").read_text("utf-8")
    assert "CANVAS_SCHEMA_VERSION = 6" in schema
    assert "function migrateV5ToV6" in schema
    assert "5: migrateV5ToV6" in schema
    # v6 validation guards presence + id uniqueness + single-owner shot refs
    assert "missing its production structure" in schema
    assert "duplicate episodeId" in schema
    assert "duplicate sceneId" in schema
    assert "referenced by more than one scene" in schema


def test_persist_round_trip_owns_the_production_field() -> None:
    persist = (_SRC / "services" / "persist.js").read_text("utf-8")
    assert '"production"' in persist  # serializer-owned, not an unknown extra


def test_core_contracts_untouched_by_m6() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    for needle in ("episodeId", "sceneId", "createProduction", "proddoc"):
        hits = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["grep", "-rl", needle, str(core)],
            capture_output=True,
            text=True,
        )
        assert hits.stdout.strip() == "", f"{needle} leaked into Core"
