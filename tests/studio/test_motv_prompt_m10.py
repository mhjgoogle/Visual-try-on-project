"""motv Prompt 编译器 + 手动生成入口 — checkpoint M10.

STRICTLY OFFLINE, no spend. Guards the wiring contract that lives in
DOM-bound closures (prompt compilation from state-resolved bible refs, honest
gap reporting, entry-panel rendering are covered by the frontend suite,
``tests/promptc.test.mjs``):

- an import through the prompt flow records a REAL Generation (promptSnapshot
  = the copied text, provider = the entry) via the existing M5 registry; a
  plain import stays an ordinary upload;
- media lands through the SAME upload endpoint + mediaref write path as the
  workflow nodes (identical slug namespace) — no duplicate media state;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def test_import_reuses_single_write_paths_and_records_provenance() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    block = app[app.index("importShotMedia") : app.index("useAsFirstFrame")]
    # the SAME slug namespace as the workflow nodes' uploads
    assert "`assets-${slot}`" in block
    assert "`video-${slot}`" in block
    # media lands through mediaref (M3 registry) — never a parallel store
    assert "mediaref.addVersion" in block
    # provenance through the M5 registry helpers, prompt snapshot included
    assert "ctx.startGeneration" in block
    assert "promptSnapshot: intent.prompt" in block
    # demo mode fails honestly instead of pretending
    assert "演示模式无后端" in block


def test_core_contracts_untouched_by_m10() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("compileImagePrompt", "compileVideoPrompt", "importShotMedia"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
