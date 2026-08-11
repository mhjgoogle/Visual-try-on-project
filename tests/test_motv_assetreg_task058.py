"""motv Asset Registration Foundation — TASK-058 / ADR-0055.

STRICTLY OFFLINE, no spend. Runs the frontend units (declaration vocabulary,
domain checking, the v10→v11 migration, v11 validation, canonical References,
explicit reclassification) via ``node --test`` and guards the wiring contract:

- 上传 ≠ 保存文件: EVERY media write path declares at the write, and the single
  media write path fills honest defaults so an undeclared write yields an
  UNCLASSIFIED asset rather than an orphan or an invalid document;
- semantics never come from a path or a filename (ADR-0055 决策 2);
- the declaration lives ON the Asset record — there is no second registry that
  could drift out of sync with the media it describes (决策 1);
- the migration back-fills only what the document already records, and invents
  no filename, display name, tag or reusable mark (决策 4);
- `reusable` is only ever an explicit creator mark — never inferred from usage;
- a new project's folder shape (project.json / studio/ / media/) exists from
  creation, with NO physical classification subfolders (决策 5);
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — these tests assert about what the code
    DOES, and a module header that explains a boundary must not read as a
    violation of it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_assetreg_units_via_node() -> None:
    """CP2 登记域 / v10→v11 迁移 / v11 校验 / 参考链 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/assetreg.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_declaration_vocabulary_is_closed_and_single_sourced() -> None:
    """The twelve semantic types exist in ONE place and everyone imports them."""
    reg = _read("workflow", "assetreg.js")
    for kind in (
        "character-reference",
        "location-reference",
        "prop-reference",
        "style-reference",
        "external-reference",
        "shot-image",
        "shot-video",
        "dialogue",
        "ambience",
        "sfx",
        "bgm",
        "final",
    ):
        assert f'"{kind}"' in reg, f"{kind} missing from the kind vocabulary"
    # the schema validator must not carry a SECOND copy of the vocabulary —
    # a forked list is how a valid document starts getting rejected (the same
    # defect codex found at v10 with the relationship pair key)
    schema = _read("services", "canvasschema.js")
    assert 'from "../workflow/assetreg.js"' in schema
    msg = "the validator must reuse the domain's list"
    assert "new Set(ASSET_KINDS)" in schema, msg
    assert "new Set(LINK_KEYS)" in schema
    # the validator body itself names no kind literal
    body = _code("services", "canvasschema.js")
    validator = body.split("export function validateCanvasDoc", 1)[1]
    # (`dialogue` / `ambience` / `sfx` / `bgm` are deliberately excluded — they
    # are ALSO timeline track names, a different namespace that legitimately
    # appears here.)
    kinds = ("character-reference", "location-reference", "shot-image", "shot-video")
    for kind in kinds:
        assert f'"{kind}"' not in validator, f"validateCanvasDoc re-declares {kind}"


def test_every_media_write_path_declares_at_the_write() -> None:
    """No page implements its own upload logic (ADR-0055 决策 1)."""
    # the single media write path fills declaration defaults, exactly as it
    # already fills assetId / storageState
    mediaref = _code("workflow", "mediaref.js")
    assert "ensureDeclaration" in mediaref
    assert "export function addVersion" in mediaref
    # every real import site DECLARES
    for mod in (
        ("app.js",),
        ("workflow", "nodes", "shared.js"),
        ("workflow", "nodes", "assets.js"),
        ("workflow", "nodes", "audio.js"),
    ):
        src = _code(*mod)
        if "addVersion(" not in src:
            continue
        assert "declare(" in src, f"{'/'.join(mod)} writes media without declaring it"
    # …and the app's upload paths CHECK the declaration before spending bytes,
    # so a refused declaration can never leave an unregistered file behind
    # …and every path that SPENDS BYTES pre-checks its declaration first, so a
    # refused declaration can never leave an unregistered file behind. app.js's
    # four import controllers each check; `ctx.uploadMedia` is the raw transport
    # and its one caller (nodes/shared.js) checks before calling it.
    app = _code("app.js")
    assert app.count("assetreg.checkDeclaration(") >= 4, (
        "an app-level import path uploads before checking its declaration"
    )
    node_upload = _code("workflow", "nodes", "shared.js")
    assert "checkDeclaration(" in node_upload
    before, _, after = node_upload.partition("ctx.uploadMedia(`")
    assert "checkDeclaration(" in before, (
        "nodes/shared.js must check the declaration BEFORE uploading"
    )


def test_semantics_never_come_from_a_path_or_filename() -> None:
    """决策 2: the physical filename is identity/safety only, never meaning."""
    reg = _code("workflow", "assetreg.js")
    # the only name-based helper is isReferenceKey, and it is documented as a
    # READ-side grouping aid that does not decide semantics
    header = _read("workflow", "assetreg.js")
    assert "never infer meaning from a name" in header
    # the domain of a picked file comes from its MIME type, not its extension
    app = _read("app.js")
    assert "mediaDomainOfFile" in app
    assert "NOT from the file extension" in app
    # no kind is ever derived from a url / filename string
    assert '.endsWith(".png")' not in reg
    assert "originalFilename" in reg  # kept, but only as displayed provenance


def test_declaration_lives_on_the_asset_record_not_a_second_registry() -> None:
    """决策 1: one record, so an index cannot drift from its media."""
    reg = _code("workflow", "assetreg.js")
    # the registry structure is unchanged — no new top-level map is introduced
    assert "reg.index" not in reg
    assert "assetIndex" not in reg
    schema = _code("services", "canvasschema.js")
    assert "doc.assetDeclarations" not in schema
    # listAssets DERIVES the flat view from the same records every time
    assert "export function listAssets" in reg


def test_migration_backfills_only_recorded_facts() -> None:
    """决策 4: the v10→v11 step never invents a classification."""
    schema = _read("services", "canvasschema.js")
    assert "function migrateV10ToV11" in schema
    assert "10: migrateV10ToV11" in schema
    body = schema.split("function migrateV10ToV11", 1)[1].split(
        "\nexport const MIGRATIONS"
    )[0]
    # the honest defaults
    assert "rec.displayName = null" in body
    assert "rec.originalFilename = null" in body
    assert "rec.tags = []" in body
    assert "rec.reusable = false" in body
    # a record with no recorded fact stays unclassified AND flagged
    assert "stamp(r, null, null)" in body
    assert "rec.needsReview = !rec.kind" in body


def test_reusable_is_never_inferred_from_usage() -> None:
    """A creator marks 可复用; 'used many times' is not consent."""
    reg = _code("workflow", "assetreg.js")
    assert "rec.reusable = fields.reusable === true" in reg
    # nothing anywhere sets reusable from a usage count
    for mod in (("workflow", "assetreg.js"), ("workflow", "assetlib.js"), ("app.js")):
        parts = mod if isinstance(mod, tuple) else (mod,)
        src = _code(*parts)
        assert "reusable = true" not in src.replace("d.reusable === true", ""), (
            f"{'/'.join(parts)} sets reusable without an explicit mark"
        )


def test_unclassified_is_a_real_state_not_a_rejection() -> None:
    """An asset the studio cannot classify is still registered and visible."""
    reg = _read("workflow", "assetreg.js")
    assert "unclassified is honest" in reg or "kind: null" in reg
    schema = _read("services", "canvasschema.js")
    assert "`kind: null` is" in schema and "valid and expected" in schema


def test_project_folder_shape_is_created_without_physical_classification() -> None:
    """决策 5: studio/ + media/ exist from creation; no per-type subfolders."""
    server = (_MOCKUP_DIR / "server.py").read_text("utf-8")
    assert 'for sub in ("studio", "media"):' in server
    assert "(target / sub).mkdir(exist_ok=True)" in server
    # the Asset Registry is the classification source of truth — a physical one
    # could only ever disagree with it
    assert "Asset Registry is the classification source of truth" in server
    for forbidden in ("media/images", "media/characters", "media/references"):
        assert forbidden not in server


def test_schema_version_is_eleven_with_the_full_chain() -> None:
    schema = _read("services", "canvasschema.js")
    assert "CANVAS_SCHEMA_VERSION = 11" in schema
    compact = schema.replace(" ", "")
    for n in range(1, 11):
        assert f"{n}:migrateV{n}To" in compact, f"migration step {n} is missing"


def test_core_contracts_untouched_by_cp2() -> None:
    """The whole checkpoint is client-side; no core pipeline file changes."""
    core = _REPO / "src" / "ai_video_workflow"
    hits = [
        p.name
        for p in core.rglob("*.py")
        if "assetreg" in p.read_text("utf-8", errors="ignore")
    ]
    assert hits == [], f"core modules must not know about the mockup registry: {hits}"
