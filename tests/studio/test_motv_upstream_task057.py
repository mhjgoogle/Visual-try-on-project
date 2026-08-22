"""motv Production upstream workspace — TASK-057 / ADR-0054.

STRICTLY OFFLINE, no spend. The domain/view-model behavior tests live in
``mockups/motv-workspace/tests/upstream.test.mjs`` (run by the frontend suite +
gate + CI). This file keeps only the halves no ``.test.mjs`` can carry:

- Autosave != Version and the single canon write path — the controller wiring
  lives in ``app.js``, which nothing can import (决策 2 / 决策 6);
- baselines are recorded only by an explicit user act (the ``app.js`` half);
- no source file smuggles a literal NUL byte past code review;
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import re
from pathlib import Path

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — these tests assert about what the code
    DOES, and a module header that merely explains a boundary must not read as
    a violation of it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


def test_autosave_never_creates_a_version() -> None:
    """自动保存只写 Working Draft；正式版本只能由用户显式创建。"""
    app = _read("app.js")
    brief_block = app[app.index("editBrief: (fields)") : app.index("setActiveOutline:")]
    # the autosave path persists but never commits
    assert "storydoc.editBriefDraft" in brief_block
    assert "commitBrief" in brief_block
    edit_line = next(
        ln for ln in brief_block.splitlines() if "editBrief: (fields)" in ln
    )
    assert "commitBrief" not in edit_line, "editing the brief must not create a version"

    # the canon revision counters move ONLY through the explicit confirm op
    canon = _code("workflow", "canondoc.js")
    assert "export function confirmCanon" in canon
    for mutator in ("updateWorld", "updateRelationship", "addRelationship"):
        block = canon[canon.index(f"export function {mutator}") :]
        block = block[: block.index("\n}")]
        assert "canon[" not in block, f"{mutator} must not bump a revision number"


def test_canonical_domain_only_no_second_copies() -> None:
    """UI 不保存第二份 Character / Relationship / Outline / Canon。"""
    for name in ("briefws.js", "relws.js", "worldws.js", "epplanws.js"):
        src = _read("ui", name)
        # every write goes through a ctx controller; no module-level mutable store
        assert "let " not in src.split("export function")[0], (
            f"{name} must not hold module state"
        )
        for forbidden in ("localStorage", "sessionStorage"):
            assert forbidden not in src, (
                f"{name} must not persist its own copy ({forbidden})"
            )
    # the canon controller is the single write path from the UI
    app = _read("app.js")
    canon_ctl = app[app.index("  canon: {") : app.index("  agentShotsDraft:")]
    for op in (
        "addRelationship",
        "updateRelationship",
        "updateWorld",
        "confirm:",
        "stamp:",
        "impact:",
    ):
        assert op in canon_ctl


def test_baseline_is_only_recorded_by_an_explicit_user_act() -> None:
    """迁移不猜；只有显式行为（建立基线 / 复核 / 确认规划新建集）才记录基线。"""
    schema = _code("services", "canvasschema.js")
    mig = schema[
        schema.index("function migrateV9ToV10") : schema.index(
            "export const MIGRATIONS"
        )
    ]
    # the migration writes an all-zero stamp and never reads a version to guess
    assert "brief: 0, outline: 0, characters: 0, relationships: 0, world: 0" in mig
    for forbidden in (
        "approved",
        "brief.active",
        "upstreamVersions",
        "canon.characters",
    ):
        assert forbidden not in mig, (
            f"the migration must not guess a baseline ({forbidden})"
        )

    app = _read("app.js")
    block = app[app.index("confirmPlan: (v) =>") : app.index("openEpisodeScript")]
    # only newly created + the adopted pristine episode get a baseline
    assert "baseline.push" in block
    assert "stampEpisodeUpstream" in block
    existing_branch = block[
        block.index("if (existing) {") : block.index("} else if (pristine")
    ]
    assert "baseline.push" not in existing_branch, (
        "a pre-existing episode must not be stamped by plan confirmation"
    )
    # pristineness now includes "no recorded beats"
    assert "beats" in block[: block.index("let adopted")]


def test_no_source_file_contains_a_nul_byte() -> None:
    """源码里不得出现字面 NUL。

    git 会把含 NUL 的文件判定为 binary：它的内容从此不出现在任何 diff 里，
    也就**永远不会进入 code review**（TASK-057 实际发生过两次：canondoc.js 的
    pairKey 与 upstream.test.mjs 的分隔符用例）。控制字符必须写成 ``\\u0000``
    转义，而不是字面字节。
    """
    roots = [
        _MOCKUP_DIR / "src",
        _MOCKUP_DIR / "tests",
        _MOCKUP_DIR / "fixtures",
        _MOCKUP_DIR / "styles",
    ]
    offenders = []
    for root in roots:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {
                ".js",
                ".mjs",
                ".css",
                ".html",
            }:
                continue
            if b"\x00" in path.read_bytes():
                offenders.append(str(path.relative_to(_MOCKUP_DIR)))
    assert not offenders, f"literal NUL byte (git treats these as binary): {offenders}"


def test_core_contracts_untouched_by_task057() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in (
        "canondoc",
        "relationshipId",
        "basedOn",
        "confirmCanon",
        "briefVersionId",
    ):
        hits = [
            p
            for p in core.rglob("*.py")
            if needle in p.read_text("utf-8", errors="ignore")
        ]
        assert not hits, f"{needle} leaked into Core: {hits}"
