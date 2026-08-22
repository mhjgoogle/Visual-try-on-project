"""motv Project Generation Registry + Asset storage lifecycle — checkpoint M5.

STRICTLY OFFLINE, no spend. Guards the wiring contract that lives in
DOM-bound closures (genlib provenance / v4→v5 backfill / storage-lifecycle
behavior is covered by the frontend suite, ``tests/generation.test.mjs``):

- Generation provenance is a PROJECT-level durable registry (top-level
  ``generations``), NOT owned by workflow nodes or by the Asset registry;
- generation targets bind to the canonical creativeShotId, never the slot;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


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
    # app.js PLUS the controllers extracted from it (TASK-073 §1.8). The invariant is
    # 「系统里有七条会记录 Generation 的产出路径」, not 「app.js 这个文件里有七处」 —
    # anchoring it to one file makes every extraction fail this guard for the wrong
    # reason (the ffmpeg render moved to controllers/timelinectl.js).
    app = (_SRC / "app.js").read_text("utf-8") + "".join(
        f.read_text("utf-8") for f in sorted((_SRC / "controllers").glob("*.js"))
    )
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


def test_core_contracts_untouched_by_m5() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("generationId", "createGenerationRegistry", "storageState"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
