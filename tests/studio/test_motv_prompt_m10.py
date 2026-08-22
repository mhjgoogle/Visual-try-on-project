"""motv Prompt 编译器 + 手动生成入口 — checkpoint M10.

STRICTLY OFFLINE, no spend. Runs the frontend units (prompt compilation from
state-resolved bible refs, honest gap reporting, entry-panel rendering) via
``node --test`` and guards the wiring contract:

- the compiler is PURE (no fetch/DOM/clock) and never invents absent facets;
- entries are manual-first (ChatGPT/Gemini copy+open, import) with the API
  entry an HONEST future note — no new provider architecture;
- an import through the prompt flow records a REAL Generation (promptSnapshot
  = the copied text, provider = the entry) via the existing M5 registry; a
  plain import stays an ordinary upload;
- media lands through the SAME upload endpoint + mediaref write path as the
  workflow nodes (identical slug namespace) — no duplicate media state;
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
def test_frontend_prompt_units_via_node() -> None:
    """M10 prompt 编译 / 入口面板 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/promptc.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_compiler_is_pure() -> None:
    src = (_SRC / "workflow" / "promptc.js").read_text("utf-8")
    for fn in ("compileImagePrompt", "compileVideoPrompt"):
        assert f"export function {fn}" in src
    # call/reference forms only — the purity NOTE in the header comment
    # legitimately mentions these words
    for forbidden in ("fetch(", "document.", "window.", "Date.now", "localStorage"):
        assert forbidden not in src, f"compiler must stay pure ({forbidden})"


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


def test_api_entry_is_an_honest_future_note() -> None:
    # TASK-051 moved the generation entry out of the storyboard's centre column
    # into the AI Director (ui/genentry.js); the honesty rule is unchanged.
    ge = (_SRC / "ui" / "genentry.js").read_text("utf-8")
    assert "API 自动生成" in ge
    assert "未来" in ge
    # no fake API button — the unwired provider renders as a chip/note, and the
    # only wired actions are copy-and-open plus import
    assert "data-gp-api" not in ge
    assert 'data-gp-prov="api"' not in ge
    for wired in ("data-gp-go", "data-gp-import"):
        assert wired in ge


def test_core_contracts_untouched_by_m10() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("compileImagePrompt", "compileVideoPrompt", "importShotMedia"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
