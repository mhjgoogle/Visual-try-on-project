"""motv Asset Registration Foundation — TASK-058 / ADR-0055.

STRICTLY OFFLINE, no spend. Guards the wiring contract (the frontend units —
declaration vocabulary, domain checking, the v10→v11 migration, v11 validation,
canonical References, explicit reclassification — live in
``tests/assetreg.test.mjs``, run by the frontend gate/CI):

- 上传 ≠ 保存文件: EVERY media write path declares at the write, and the single
  media write path fills honest defaults so an undeclared write yields an
  UNCLASSIFIED asset rather than an orphan or an invalid document;
- semantics never come from a path or a filename (ADR-0055 决策 2);
- `reusable` is only ever an explicit creator mark — never inferred from usage;
- a new project's folder shape (project.json / studio/ / media/) exists from
  creation, with NO physical classification subfolders (决策 5);
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
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
    # …and every path that SPENDS BYTES pre-checks its declaration first, so a
    # refused declaration can never leave an unregistered file behind. The four
    # import controllers each check; `ctx.uploadMedia` is the raw transport and
    # its one caller (nodes/shared.js) checks before calling it.
    #
    # SCANNED ACROSS app.js AND src/controllers/*.js, because TASK-073 §1.8 is
    # moving these controllers out of app.js one at a time (`assetctl.js` took
    # two of the four with it). Counting only app.js would let this guard drop
    # to a passing-but-empty state exactly when the code it protects moves —
    # the same failure §5.12 records for the generation-snapshot guard. The
    # NUMBER must never be lowered to match a move: it is 「四条上传路径各自
    # 预检」, not 「app.js 里还剩几处」.
    controllers = sorted((_SRC / "controllers").glob("*.js"))
    app_and_controllers = "\n".join(
        [_code("app.js")] + [_code("controllers", p.name) for p in controllers]
    )
    assert app_and_controllers.count("assetreg.checkDeclaration(") >= 4, (
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


def test_core_contracts_untouched_by_cp2() -> None:
    """The whole checkpoint is client-side; no core pipeline file changes."""
    core = _REPO / "src" / "ai_video_workflow"
    hits = [
        p.name
        for p in core.rglob("*.py")
        if "assetreg" in p.read_text("utf-8", errors="ignore")
    ]
    assert hits == [], f"core modules must not know about the mockup registry: {hits}"
