"""motv canvas identity/provenance — checkpoint M2 (v1→v2 migration).

STRICTLY OFFLINE, no spend. Source-level guards on the flows that live inside
DOM-bound closures (the migration/identity behavior itself is covered by the
frontend suite, ``tests/identity.test.mjs``, run by the frontend gate/CI).

Covers the M2 guarantees:

- the AI-draft flow captures the Script version id at call time and never
  fabricates a based-on relation; the manual-edit flow records its base draft
  version (source guards on scriptgen.js);
- Core ``src/ai_video_workflow/`` remains untouched by this checkpoint.

The lock-draft-plan payload guard (``shotId`` must NOT leak into Gateway
commands) reads ``app.js`` and moved to
``tests/contract/test_frontend_write_path_invariants.py`` (TASK-102 批次 E).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"


def test_draft_flows_record_provenance_at_the_real_push_sites() -> None:
    src = (_MOCKUP_DIR / "src" / "workflow" / "nodes" / "scriptgen.js").read_text(
        "utf-8"
    )
    # AI draft: source id captured when the script text is read, before the call
    assert "ctx.getScriptSourceId" in src
    assert "assignShotIdentity(shots)" in src
    # a regeneration is NOT a revision of the previous draft — no fabricated link
    assert "basedOnDraftId: null" in src
    # manual edit: records the base draft version it provably opened from
    assert "basedOnDraftId: typeof curV.id" in src
    assert 'origin: "edited"' in src


def test_core_contracts_untouched_by_m2() -> None:
    """M2 是 mockup 域检查点：核心合同目录不得出现 creator 身份字段。"""
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    assert core_files_containing("sourceScriptVersionId", core) == []
