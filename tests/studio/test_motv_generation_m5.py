"""motv Project Generation Registry + Asset storage lifecycle — checkpoint M5.

STRICTLY OFFLINE, no spend. Guards the wiring contract that lives in
DOM-bound closures (genlib provenance / v4→v5 backfill / storage-lifecycle
behavior is covered by the frontend suite, ``tests/generation.test.mjs``):

- generation targets bind to the canonical creativeShotId, never the slot;
- the Core contract is untouched (all of this is mockup/client-side).

The two guards that read ``app.js``（入口编排层）—— Generation provenance 是
**项目级**持久化登记表（顶层 ``generations``），以及「系统里恰有七条会记录
Generation 的产出路径」—— 已随 TASK-102 批次 E 移到
``tests/contract/test_frontend_write_path_invariants.py``。
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


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
