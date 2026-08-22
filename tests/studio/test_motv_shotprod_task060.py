"""motv shot production state + Dailies — TASK-060 / ADR-0057.

STRICTLY OFFLINE, no spend. Guards the contract halves the frontend suite
cannot see (the module-level behavior lives in ``tests/shotprod.test.mjs`` and
runs via the frontend suite + gate + CI):

- 生成成功 != 镜头完成: nothing sets an approval except an explicit human action —
  the sole call site lives in ``app.js``, which no ``.test.mjs`` can import;
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
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


def test_the_no_video_guard_lives_in_the_DOMAIN_not_only_the_ui() -> None:
    """codex review, TASK-060 round 2: a UI-only check leaves every other caller
    of the declared sole write path free to approve a shot with nothing to
    watch."""
    app = _code("app.js")
    approve = app.split("approve: (shotId, note)", 1)[1].split("unapprove:", 1)[0]
    assert "ctx.shot.mediaOf(shot)" in approve
    assert "media.videoAssetId" in approve
    assert "return false" in approve
    # …and the approval is bound to THAT EXACT VIDEO (codex review, round 3):
    # switching the variant or adding a newer take must not let unreviewed
    # footage inherit a 已通过 it never earned
    dom = _code("workflow", "shotprod.js")
    assert "export function isApprovedFor" in dom
    assert "isApprovedFor(prod, shotId, m.videoAssetId)" in dom
    assert "r.assetId === videoAssetId" in dom
    # …while the record itself is never erased
    assert "export function hasStaleApproval" in dom


def test_only_a_human_action_records_an_approval() -> None:
    """生成成功 != 镜头完成 (ADR-0057 决策 1)."""
    dom = _code("workflow", "shotprod.js")
    assert "export function approveShot" in dom
    # the domain module knows nothing about media or generations — it CANNOT
    # approve as a side effect of one succeeding
    for forbidden in ("assetRegistry", "generation", "mediaref", "genlib"):
        assert forbidden not in dom, f"shotprod.js must not reach into {forbidden}"
    app = _code("app.js")
    # EVERY call site of approveShot lives inside the explicit user action, and
    # there is exactly one. (This assertion previously ended in `or True`, which
    # made it unconditionally pass — the only automated defence for 决策 1 never
    # actually ran. Found by the TASK-057 session's codex review; see TASK-060
    # §5A.)
    call_lines = [ln for ln in app.splitlines() if "shotprod.approveShot" in ln]
    assert len(call_lines) == 1, (
        f"approveShot must have exactly ONE call site, found {len(call_lines)}"
    )
    lines = app.splitlines()
    idx = next(i for i, ln in enumerate(lines) if "shotprod.approveShot" in ln)
    # walk back to the enclosing controller method (a 4-space-indented `key:`)
    controller = None
    for ln in reversed(lines[:idx]):
        m = re.match(r"^ {4}(\w+):", ln)
        if m:
            controller = m.group(1)
            break
    assert controller == "approve", (
        f"approveShot is called from `{controller}`, not the explicit approve action"
    )
    # …and no generation/import path approves anything
    for marker in ("completeGeneration", "importShotMedia", "adoptPaidIntoSlot"):
        seg = app.split(marker, 1)
        if len(seg) < 2:
            continue
        window = seg[1][:1500]
        assert "approveShot" not in window, f"{marker} must not approve a shot"


def test_a_deleted_reference_leaves_no_phantom() -> None:
    """决策 5."""
    dom = _code("workflow", "shotprod.js")
    assert "export function pruneShotReferences" in dom
    app = _code("app.js")
    # exposing the primitive is not enough — the DELETE path must call it
    # (codex review, round 1), or a deleted reference leaves phantom chips
    delete_path = app.split("permanentDelete:", 1)[1].split("\n  },", 1)[0]
    assert "pruneShotReferences" in delete_path, (
        "permanent delete must prune the shot bindings of a removed reference"
    )


def test_core_contracts_untouched_by_cp4() -> None:
    core = _REPO / "src" / "ai_video_workflow"
    hits = [
        p.name
        for p in core.rglob("*.py")
        if "shotProduction" in p.read_text("utf-8", errors="ignore")
    ]
    assert hits == [], f"core modules must not know about the mockup state: {hits}"


def test_approving_a_shot_records_a_layer_1_decision_that_names_the_take() -> None:
    """TASK-072 §1.5 / 系统合同 §6.4：通过 = 一条层 1 ReviewDecision，不只是旧标记。"""
    app = _code("app.js")
    approve = app.split("approve: (shotId, note)", 1)[1].split("unapprove:", 1)[0]
    # the Decision is built BEFORE the legacy marker: writing the marker while failing
    # to record the decision leaves the two disagreeing, with the weaker one winning
    assert approve.index("review.decision(") < approve.index("shotprod.approveShot(")
    assert 'layer: "shot"' in approve
    assert 'verdict: "passed"' in approve
    assert 'by: "user"' in approve
    # WHICH take — a decision with no version can never go stale (§6.4)
    assert "basedOnVersion: media.videoVersion" in approve
    # a MONOTONIC id, not `Date.now()`: approve → unapprove → approve inside one
    # millisecond minted the same decisionId twice, and a duplicate primary key makes
    # an append-only log ambiguous
    assert 'review.newDecisionId("shot", shotId)' in approve
    # narrowly: no id may be minted from the clock. A blanket ban on `Date.now()`
    # over the whole slice would also fail a legitimate `decidedAt` timestamp later
    assert "decisionId: `dec-" not in approve
    # …and if that version cannot be read, the approval is REFUSED rather than
    # recorded without saying what it approved
    assert "if (!dec.ok)" in approve
    assert "return false" in approve.split("if (!dec.ok)", 1)[1][:200]

    # withdrawal APPENDS a needs_rework decision judged against the SAME version —
    # the approval happened, on a take that existed (G5 只追加)
    undo = app.split("unapprove: (shotId) => {", 1)[1]
    undo = undo.split("references: (shotId)", 1)[0]
    # the undo site mints its id the same way — pinned separately, or a regression
    # that reverted only this half would pass every suite
    assert 'review.newDecisionId("shot", shotId)' in undo
    assert "decisionId: `dec-" not in undo
    assert 'verdict: "needs_rework"' in undo
    assert "prev.basedOnVersion" in undo
    # only APPENDED to — a withdrawn approval that vanished would make the history
    # claim the creator never approved it
    assert "decisions: [...reviewsDoc.decisions, undo.value]" in undo
    assert "reviewsDoc.decisions.filter" not in undo

    # the version the decision is bound to comes from the media registry, not invented
    media_of = app.split("mediaOf: (shot) =>", 1)[1].split("_slotOf:", 1)[0]
    want = "videoVersion: vid && Number.isInteger(vid.version) ? vid.version : null"
    assert want in media_of
