"""motv Project Asset Registry — checkpoint M3 (v2→v3 migration).

STRICTLY OFFLINE, no spend. Source-level guards on the ownership boundaries
that live inside DOM-bound closures (the registry/migration behavior itself
is covered by the frontend suite, ``tests/assets.test.mjs``):

- ONE authoritative durable media owner: the serializer persists the project
  registry and no node-local media fields; the edit node appends finals via
  the registry, not node state;
- ``mediaref.addVersion`` remains the single media write path (no other
  module rewrites version history);
- Core ``src/ai_video_workflow/`` remains untouched by creator asset identity.
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


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


def _strip_browser_history_api(text: str) -> str:
    """Remove the BROWSER History API before the needles run (TASK-081).

    `window.history.pushState` / `replaceState` are hash routing — they have
    nothing to do with a media version history — but the needle `history.push`
    is a TEXT APPROXIMATION and matches `history.pushState` by substring. The
    RULE is unchanged: only `mediaref.addVersion` may rewrite a version chain.
    What is sharpened is the approximation, so it stops reporting the address
    bar as a parallel media write path.

    Deliberately narrow: only these two exact API names are removed, so an
    actual `history.push(...)` anywhere — including in the same file — is still
    caught.
    """
    return text.replace("history.pushState", "").replace("history.replaceState", "")


def test_single_media_write_path_is_mediaref() -> None:
    """版本历史只能经 mediaref.addVersion 改写 — 不允许并行写路径。"""
    hits = []
    for p in _SRC.rglob("*.js"):
        if p.name == "mediaref.js":
            continue
        text = _strip_browser_history_api(p.read_text("utf-8"))
        if p.name == "artifactversion.js":
            # READ-ONLY DERIVED VIEW (TASK-072 §1.7). It maps `versions/active/locked`
            # into the six states and writes NOTHING — which is what makes introducing
            # this vocabulary unable to corrupt what it derives. The needles below are
            # a TEXT APPROXIMATION of "parallel write path"; `history.filter(isObj)`
            # here guards against a null element in a legacy document, not a rewrite.
            #
            # The exemption is ASSERTED, not assumed: if a real writer ever appears in
            # this module these lines fail, so the waiver cannot quietly cover one.
            for writer in ("history.push", "history.sort", ".current =", "history ="):
                assert writer not in text, f"artifactversion.js now writes: {writer}"
            continue
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
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    assert core_files_containing("assetId", core) == []
