"""motv Production 上游内容的持久化 — TASK-057 blocker 修复。

STRICTLY OFFLINE, no spend.

**这个 blocker 的实质**：Creative Brief / World / Relationship / Character /
Episode Beat 的输入框此前只在 ``change``（失焦）时写入 canonical 文档。用户在
Production 里打字、光标还停在框里就按浏览器刷新 —— 值从未离开 DOM，内容直接丢
失。可工作的参照是剧本输入框：它在 ``input`` 上就写域并 persist。

因此本文件守住两件事：

1. 每个上游输入框都在 **input** 上把值写进 canonical 域（→ 防抖 canvas save →
   ``studio/canvas.json``），而不是只在失焦时；
2. 这些创作内容**继续留在 canonical canvas/domain 里**，不被改造成 Asset ——
   上游工作区不得引用任何 asset 注册模块。

前端单测（真实 bind 函数 + DOM stub，断言「input → 域 → 序列化 → reload」）在
``mockups/motv-workspace/tests/persistupstream.test.mjs``。
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"

# every upstream workspace that owns creator text fields
_UPSTREAM_WS = ("briefws.js", "worldws.js", "relws.js", "epplanws.js")


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — these assertions are about behaviour."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_persistence_units_via_node() -> None:
    """上游输入 → canonical 域 → 序列化 → reload 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/persistupstream.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_every_upstream_field_autosaves_on_input_not_only_on_blur() -> None:
    """所有上游文本框必须经 fieldsync 在 input 上写域（这是 blocker 本身）。"""
    for name in _UPSTREAM_WS:
        code = _code("ui", name)
        assert "bindField" in code, f"{name}: fields must be bound through fieldsync"
        assert "restoreFieldFocus" in code, (
            f"{name}: must restore the caret after a re-render"
        )
        # the old blur-only shape must be gone from the field bindings
        for legacy in (
            "el.onchange = () => ctx.canon",
            "el.onchange = () => ctx.story",
        ):
            assert legacy not in code, f"{name}: still writes only on blur ({legacy})"

    # the Character / Location bible fields had the same defect
    ws = _code("ui", "workspaces.js")
    assert "bindField" in ws
    for legacy in (
        "el.onchange = () => ctx.bible.updateCharacterProfile",
        "el.onchange = () => ctx.bible.updateLocationProfile",
        "el.onchange = () => ctx.bible.setCharacterVoice",
    ):
        assert legacy not in ws, f"character fields still write only on blur ({legacy})"


def test_fieldsync_writes_on_input_and_never_drops_a_pending_write() -> None:
    """fieldsync 的契约：input 触发写入；切换字段/失焦不丢未提交的值。"""
    fs = _code("ui", "fieldsync.js")
    assert "el.oninput" in fs
    assert "export function flushFields" in fs
    assert "export function bindField" in fs
    assert "export function restoreFieldFocus" in fs
    # a queued write for another field is committed before the slot is reused
    schedule = fs[fs.index("const schedule =") : fs.index("el.oninput")]
    assert "flushFields" in schedule, (
        "a pending write for another field must be flushed"
    )
    # the value is captured at schedule time, never read back off a detached node
    assert "s.pending = { key:" in fs
    # blur commits immediately
    blur = fs[fs.index("el.onchange") :]
    assert "flushFields" in blur or "write(el.value)" in blur


def test_upstream_content_stays_canonical_domain_not_an_asset() -> None:
    """创作内容留在 canonical canvas/domain，不得被改造成 Asset。"""
    for name in (*_UPSTREAM_WS, "fieldsync.js"):
        code = _code("ui", name)
        for forbidden in ("assetreg", "assetlib", "registerAsset", "addVersion"):
            assert forbidden not in code, (
                f"{name}: creative text must not go through the asset "
                f"registry ({forbidden})"
            )
    # and the domain modules that own this content stay asset-free
    for mod in ("storydoc.js", "canondoc.js"):
        code = _code("workflow", mod)
        for forbidden in ("assetreg", "assetlib", "mediaref"):
            assert forbidden not in code, (
                f"{mod} must not depend on asset registration ({forbidden})"
            )


def test_the_persisted_document_carries_every_upstream_surface() -> None:
    """序列化的 canvas 文档必须包含全部上游创作内容。"""
    story = _code("workflow", "storydoc.js")
    serialize = story[story.index("export function serialize") :]
    serialize = serialize[: serialize.index("\n}")]
    for field in ("idea", "brief", "versions", "plans"):
        assert field in serialize, f"story.serialize must persist {field}"

    prod = _code("workflow", "proddoc.js")
    ser = prod[prod.index("export function serialize") :]
    ser = ser[: ser.index("\n}")]
    for field in (
        "episodes",
        "characters",
        "locations",
        "relationships",
        "world",
        "canon",
    ):
        assert field in ser, f"production.serialize must persist {field}"

    # persist.js must own these top-level fields (else they'd be treated as
    # unknown extras rather than saved state)
    persist = _code("services", "persist.js")
    owned = persist[persist.index("const OWNED_FIELDS") :]
    # the WHOLE declaration, not just its first line: TASK-064 added five fields
    # and wrapped the list across several lines, and a first-line-only slice then
    # reported every field below the break as unowned.
    owned = owned[: owned.index("];") + 2]
    for field in ("story", "production", "scripts"):
        assert f'"{field}"' in owned, f"persist must own the {field} field"
