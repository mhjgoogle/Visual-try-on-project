"""motv Project Generation Registry + Asset storage lifecycle — checkpoint M5.

STRICTLY OFFLINE, no spend. Runs the frontend units (genlib provenance,
deterministic v4→v5 backfill, storage lifecycle, v5 validation) via
``node --test`` and guards the wiring contract:

- Generation provenance is a PROJECT-level durable registry (top-level
  ``generations``), NOT owned by workflow nodes or by the Asset registry;
- generationId is minted, never derived from assetId / slot / hash;
- generation targets bind to the canonical creativeShotId, never the slot;
- Generation metadata is independent of media-bytes lifecycle (an Asset's
  storageState can change without touching Generation history);
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_generation_units_via_node() -> None:
    """M5 生成溯源 / v4→v5 回填 / 存储生命周期 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/generation.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_generation_registry_is_a_dedicated_project_module() -> None:
    gen = (_SRC / "workflow" / "genlib.js").read_text("utf-8")
    # the durable provenance API lives in its own project-domain module
    for fn in (
        "startGeneration",
        "completeGeneration",
        "failGeneration",
        "createGenerationRegistry",
    ):
        assert f"export function {fn}" in gen
    # generationId is MINTED, never derived from assetId / slot / hash
    assert 'mintId("gen")' in gen


def test_generations_are_project_level_persisted_not_node_owned() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # top-level, parallel to assets, serialized + hydrated from the canvas save
    assert "generations: generationRegistry" in app
    assert "genlib.createGenerationRegistry" in app
    # a Workflow node never becomes the durable owner: nodes call ctx.* helpers,
    # they do not import or hold the registry themselves
    for node in ("assets.js", "audio.js"):
        src = (_SRC / "workflow" / "nodes" / node).read_text("utf-8")
        assert "createGenerationRegistry" not in src
        assert "genlib" not in src


def test_ai_paths_record_generations_with_frozen_snapshot() -> None:
    assets = (_SRC / "workflow" / "nodes" / "assets.js").read_text("utf-8")
    audio = (_SRC / "workflow" / "nodes" / "audio.js").read_text("utf-8")
    app = (_SRC / "app.js").read_text("utf-8")
    # image + audio launch a generation and complete/fail it
    for src in (assets, audio):
        assert "ctx.startGeneration" in src
        assert "ctx.completeGeneration" in src
        assert "ctx.failGeneration" in src
    # video: BOTH the single and the batch paid paths start a generation and
    # complete it on adopt (link the produced video Asset); M10 adds the
    # manual-entry import path (promptSnapshot from the copied prompt); M11
    # adds audio entry-import + local TTS + the ffmpeg render provenance
    # 7 since TASK-064 Phase 3: a Shot Mix is a DERIVED audio asset produced from
    # real inputs, so it records a real Generation like every other producer —
    # that is what puts it on the provenance graph with its sources.
    assert app.count("ctx.startGeneration") == 7
    assert app.count("ctx.completeGeneration") >= 6
    assert "promptSnapshot" in assets and "promptSnapshot" in audio
    # an AMBIGUOUS submit exception must NOT mark the video generation failed
    # (the remote may have billed it) — only a DEFINITIVE non-success response
    # does. So app.js fails a generation in exactly one place: the else-branch.
    assert app.count("ctx.failGeneration") == 1


def test_generation_target_is_creativeShotId_never_slot() -> None:
    assets = (_SRC / "workflow" / "nodes" / "assets.js").read_text("utf-8")
    audio = (_SRC / "workflow" / "nodes" / "audio.js").read_text("utf-8")
    # image/audio target the draft shot's canonical identity, not its slot
    assert "targetId: s.shotId" in assets
    assert "targetId: s.shotId" in audio
    # neither binds the generation target to a slot
    assert "targetId: s.slot" not in assets
    assert "targetId: s.slot" not in audio


def test_schema_has_v5_generation_registry_and_storage_state() -> None:
    schema = (_SRC / "services" / "canvasschema.js").read_text("utf-8")
    # the schema version has moved past 5 (M6+); M5's guarantee is the v4→v5
    # step and its invariants staying in the chain, not the current pin
    assert "function migrateV4ToV5" in schema
    assert "4: migrateV4ToV5" in schema
    # v5 validation guards the generation registry + the storage lifecycle field
    assert "missing its generations registry" in schema
    assert "duplicate generationId" in schema
    assert "invalid storageState" in schema


def test_core_contracts_untouched_by_m5() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    for needle in ("generationId", "createGenerationRegistry", "storageState"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
