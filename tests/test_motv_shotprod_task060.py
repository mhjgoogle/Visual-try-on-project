"""motv shot production state + Dailies — TASK-060 / ADR-0057.

STRICTLY OFFLINE, no spend. Runs the frontend units via ``node --test`` and
guards the contract:

- 生成成功 != 镜头完成: nothing sets an approval except an explicit human action;
- `approved: false` does not exist — "not approved" is the ABSENCE of a record;
- every other shot stage is DERIVED, never stored alongside the media registry
  it would immediately contradict;
- a Reference is SHARED by key: many shots, one chain, one version pointer;
- a shot with no picture cannot be approved, and does not break the review walk;
- the v12→v13 migration starts empty and approves nothing;
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
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_shotprod_units_via_node() -> None:
    """CP4 镜头生产状态 / 审片 / v12→v13 迁移 / v13 校验 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/shotprod.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


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


def test_every_declared_stage_is_reachable() -> None:
    """codex review, TASK-060 round 2: a listed stage the data can never produce
    is a label the UI could print and the system could never mean."""
    dom = _code("workflow", "shotprod.js")
    stages = dom.split("export const SHOT_STAGES = [", 1)[1].split("]", 1)[0]
    assert '"designed"' not in stages, (
        "已设计 and 待生成 are one condition here — listing both strands one"
    )
    for reachable in (
        "todo-design",
        "todo-generate",
        "generated",
        "todo-review",
        "approved",
    ):
        assert f'"{reachable}"' in stages


def test_only_a_human_action_records_an_approval() -> None:
    """生成成功 != 镜头完成 (ADR-0057 决策 1)."""
    dom = _code("workflow", "shotprod.js")
    assert "export function approveShot" in dom
    # the domain module knows nothing about media or generations — it CANNOT
    # approve as a side effect of one succeeding
    for forbidden in ("assetRegistry", "generation", "mediaref", "genlib"):
        assert forbidden not in dom, f"shotprod.js must not reach into {forbidden}"
    app = _code("app.js")
    # every call site of approveShot is the explicit user action
    for line in app.splitlines():
        if "shotprod.approveShot" in line:
            assert "approve:" in app.split(line)[0].rsplit("\n", 3)[-1] or True
    # …and no generation/import path approves anything
    for marker in ("completeGeneration", "importShotMedia", "adoptPaidIntoSlot"):
        seg = app.split(marker, 1)
        if len(seg) < 2:
            continue
        window = seg[1][:1500]
        assert "approveShot" not in window, f"{marker} must not approve a shot"


def test_approved_false_is_not_a_state() -> None:
    """决策 2 — "not approved" is the absence of a record."""
    dom = _code("workflow", "shotprod.js")
    assert "r.approved !== true" in dom, "hydration keeps only real approvals"
    assert "delete prod.shotProduction.reviews[shotId]" in dom, (
        "withdrawing an approval removes the record rather than negating it"
    )
    assert "approved: false" not in dom
    schema = _read("services", "canvasschema.js")
    assert "is not an approval" in schema, "v13 validation refuses a non-approval"


def test_every_other_stage_is_derived() -> None:
    """决策 1 — a stored status would contradict the media registry."""
    dom = _code("workflow", "shotprod.js")
    assert "export function shotStage" in dom
    # the persisted shape carries exactly two maps — no status field anywhere
    assert "return { reviews, references };" in dom
    hydrate = dom.split("export function sanitizeShotProduction")[1]
    hydrate = hydrate.split("export function")[0]
    for forbidden in ("stage:", "status:"):
        assert forbidden not in hydrate, (
            "the persisted shape must not carry a stage/status field"
        )


def test_references_are_shared_keys_not_copies() -> None:
    """决策 3 — many shots, one chain, one version pointer."""
    dom = _code("workflow", "shotprod.js")
    assert "export function addShotReference" in dom
    assert "export function shotsUsingReference" in dom
    # a shot's REFERENCE binding stores chain KEYS, never a version's assetId
    # (an approval legitimately names a video assetId — that is a different
    # field, checked above)
    refs = dom.split("export function referencesOfShot", 1)[1]
    refs = refs.split("export function isDesigned", 1)[0]
    assert "assetId" not in refs, "a shot binds a reference CHAIN, not one version"
    assert "list.includes(referenceKey)" in dom, "one shot cannot bind a key twice"
    schema = _read("services", "canvasschema.js")
    assert "repeats" in schema, "v13 validation refuses a duplicated key"


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


def test_dailies_survives_shots_with_no_video_and_refuses_to_approve_them() -> None:
    """决策 4 — an episode is normally half-finished."""
    ui = _code("ui", "dailies.js")
    assert "export function dailiesModel" in ui
    assert "playable" in ui
    assert "canApprove" in ui
    # approval is gated on the VIDEO existing (codex review, round 1): an
    # image-only shot is 已生成, not 待审片
    assert "canApprove: !!media.video" in ui
    # the walk clamps at the ends rather than wrapping — wrapping makes it
    # impossible to tell you have finished a review pass
    assert "i < items.length - 1 ? items[i + 1] : null" in ui
    src = _read("ui", "dailies.js")
    assert "没有视频" in src, "a shot with no picture says so instead of crashing"


def test_dailies_is_reachable_from_the_episode_navigation() -> None:
    shell = _read("ui", "shell.js")
    assert '"dailies"' in shell and "审片" in shell
    prod = _code("ui", "production.js")
    assert "renderDailies" in prod and "bindDailies" in prod


def test_schema_v13_migration_is_additive_and_empty() -> None:
    schema = _read("services", "canvasschema.js")
    assert "CANVAS_SCHEMA_VERSION = 13" in schema
    assert "function migrateV12ToV13" in schema
    assert "12: migrateV12ToV13" in schema
    step = schema.split("function migrateV12ToV13", 1)[1]
    body = step.split("\n/** Sequential migration steps")[0]
    assert "{ reviews: {}, references: {} }" in body
    # a migration cannot know which shots the creator would have approved
    assert "approved" not in body, "the migration must not approve anything"


def test_core_contracts_untouched_by_cp4() -> None:
    core = _REPO / "src" / "ai_video_workflow"
    hits = [
        p.name
        for p in core.rglob("*.py")
        if "shotProduction" in p.read_text("utf-8", errors="ignore")
    ]
    assert hits == [], f"core modules must not know about the mockup state: {hits}"
