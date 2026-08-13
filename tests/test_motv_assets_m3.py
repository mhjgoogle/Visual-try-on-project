"""motv Project Asset Registry — checkpoint M3 (v2→v3 migration).

STRICTLY OFFLINE, no spend. Wraps the frontend registry/migration units and
adds source-level guards on the ownership boundaries that live inside
DOM-bound closures.

Covers the M3 guarantees:

- deterministic, non-destructive v2→v3 migration (real fixtures included),
  media-domain keying (slot values are NOT globally unique across kinds),
  history/current preservation, conservative finals migration, reference-
  proven first-frame Asset reuse, provable-only shot association — via
  ``node --test tests/assets.test.mjs``;
- ONE authoritative durable media owner: the serializer persists the project
  registry and no node-local media fields; the edit node appends finals via
  the registry, not node state;
- ``mediaref.addVersion`` remains the single media write path (no other
  module rewrites version history);
- Core ``src/ai_video_workflow/`` remains untouched by creator asset identity.
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
def test_frontend_asset_registry_units_via_node() -> None:
    """迁移确定性/分域键/首帧同资产复用/溯源诚实/finals 保守迁移 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/assets.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_serializer_persists_registry_not_node_media() -> None:
    src = (_SRC / "app.js").read_text("utf-8")
    ser = src.split("function serializeGraph()")[1].split("function attachAssetViews")[
        0
    ]
    assert "assets: assetRegistry" in ser
    for field in ("n.uploads", "n.finals", "n.firstFrames"):
        assert field not in ser, f"serializeGraph still persists node-local {field}"
    # nodes re-attach the registry as views on restore AND on fresh creation
    assert src.count("attachAssetViews(nd)") >= 2


def test_single_media_write_path_is_mediaref() -> None:
    """版本历史只能经 mediaref.addVersion 改写 — 不允许并行写路径。"""
    hits = []
    for p in _SRC.rglob("*.js"):
        if p.name == "mediaref.js":
            continue
        text = p.read_text("utf-8")
        if p.name == "assetlib.js":
            # M11: removeAssetRecord is the ONE sanctioned non-mediaref
            # history writer (permanent-delete chain surgery, gated by the
            # blocking-reference scan). Everything else in assetlib.js must
            # still stay off the version-history write path.
            start = text.index("export function removeAssetRecord")
            end = text.index("export function", start + 1)
            text = text[:start] + text[end:]
        for needle in ("history.filter", "history.push", "history.sort", ".current ="):
            if needle in text:
                hits.append(f"{p.name}: {needle}")
    assert hits == [], f"parallel media write paths found: {hits}"


def test_edit_finals_go_through_the_registry() -> None:
    src = (_SRC / "workflow" / "nodes" / "edit.js").read_text("utf-8")
    assert "ctx.addFinal" in src
    assert "ctx.finalUrls" in src
    assert "node.finals" not in src  # the node no longer owns finals


def test_core_contracts_untouched_by_m3() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    assert core_files_containing("assetId", core) == []
