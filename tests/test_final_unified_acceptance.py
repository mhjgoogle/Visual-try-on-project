"""Final unified product acceptance evidence (TASK-040).

The FINAL milestone gate for the two top-level requirements
(``ai_shortfilm_pipeline_workflow.md`` +
``ai_video_creation_workspace_requirements.md``).
Adds acceptance evidence only — no new product capability. Milestone PASS remains
the user's (final runbook §5); the implementing agent does NOT self-judge PASS.

It ties the whole closed loop — 目标 → 运行 → 观察 → 评价/Action → 复盘 → 学习/复用 —
across the REAL contract layers, fully offline and zero-spend, and asserts the
cross-cutting product invariants both requirements demand:

* multimedia (images/audio/subtitles) + formal S5–S7 post-production are OBSERVABLE
  as authoritative facts (not `unavailable`);
* the Workspace projection is DERIVED, deterministically rebuildable, and never a
  second source of truth; corruption fails closed;
* formal facts are REUSABLE across projects by digest-bound identity;
* automation NEVER replaces the user's creative judgement (human gates preserved);
* missing ≠ zero (P7) is preserved end to end.

The WFM1 sub-loop (observe→evaluate→act→learn through the real Gateway/query/HTTP
chain) is TASK-033's acceptance; the WFM2 S4–S7 sub-loop is TASK-037's. This suite
is the JOINT tie-off, and the traceability matrix maps every requirement row to its
owning evidence.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from ai_video_workflow import profile
from ai_video_workflow.automation import build_wfm3_registry, wfm3_capabilities
from ai_video_workflow.automation.errors import CapabilityNotRegisteredError
from ai_video_workflow.media import assets as media_assets
from ai_video_workflow.postproduction import catalog as pp_catalog
from ai_video_workflow.postproduction import index as pp
from ai_video_workflow.workspace import queries

NOW = "2026-08-04T11:00:00+00:00"
_EXAMPLE_PACK = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "reuse"
    / "character-mia"
    / "v1.json"
)


def _reuse_pack(version: int = 1, **content_overrides):
    raw = json.loads(_EXAMPLE_PACK.read_text(encoding="utf-8"))
    raw["version"] = version
    raw["content"] = {**raw["content"], **content_overrides}
    return profile.parse_pack(raw)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _media(root: Path, kind: str, ref: str) -> media_assets.MediaAsset:
    rel = f"media/imported/{kind}/{ref}.bin"
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_bytes(b"asset-" + ref.encode())
    asset = media_assets.build_asset(
        media_kind=kind,
        ref=ref,
        version=1,
        producer={"source": "external", "note": "n"},
        media_path=rel,
        media_sha256=_sha((root / rel).read_bytes()),
        size_bytes=(root / rel).stat().st_size,
    )
    media_assets.publish_asset(root, asset)
    return asset


def _run_a_project(root: Path) -> None:
    """目标 → 运行: publish a project's formal WFM2 facts."""
    _media(root, "keyframe", "kf")
    _media(root, "voiceover", "vo")
    _media(root, "subtitle", "sub")
    _media(root, "master", "final")
    pp.publish_artifact(
        root,
        pp.build_artifact(
            stage="s5", step_id="S5-T01", kind="assembly_timeline", ref="t", version=1
        ),
    )
    # a not_applicable S7 outcome — missing != zero must survive to the projection
    pp.publish_artifact(
        root,
        pp.build_artifact(
            stage="s7",
            step_id="S7-T05",
            kind="knowledge_promotion",
            ref="kp",
            version=1,
            status="not_applicable",
            status_reason="no reuse this run",
        ),
    )


def test_closed_loop_observe_is_authoritative_and_rebuildable(tmp_path) -> None:
    root = tmp_path / "proj"
    root.mkdir()
    _run_a_project(root)

    # 观察: the multimedia facts are observable + AUTHORITATIVE (not unavailable)
    view = queries.project_multimedia(root, NOW)
    kinds = {
        i["media_kind"].value for i in view.items if i["domain"].value == "media_asset"
    }
    assert {"keyframe", "voiceover", "subtitle", "master"} <= kinds
    assert all(
        f.provenance.value == "authoritative" for i in view.items for f in i.values()
    )
    assert not view.problems

    # projection is DERIVED + deterministically rebuildable (no second source)
    assert queries._comparable(view) == queries._comparable(
        queries.project_multimedia(root, NOW)
    )

    # missing != zero (P7) survives to the projection
    kp = [i for i in view.items if i.get("ref") and i["ref"].value == "kp"]
    assert kp and kp[0]["status"].value == "not_applicable"


def test_corruption_of_an_authoritative_fact_fails_closed(tmp_path) -> None:
    root = tmp_path / "proj"
    root.mkdir()
    _run_a_project(root)
    # tamper a post-production index -> the projection fails closed (not silent)
    path = root / pp.index_relpath("s5", "t", 1)
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["kind"] = "rough_cut"
    path.write_text(json.dumps(raw))
    view = queries.project_multimedia(root, NOW)
    assert view.readiness_failed


def test_formal_facts_are_reusable_across_projects(tmp_path) -> None:
    # Genuine cross-project reuse via the ADR-0011 account-level reuse pack:
    # two DISTINCT projects reference the SAME immutable published version, both
    # resolve to it, a later v2 does not change what they resolve, and in-place
    # tampering of the shared version fails closed for the referencing project.
    account = tmp_path
    pack = _reuse_pack(version=1)
    profile.publish_pack_version(account, pack)
    project_a = account / "project-a"
    project_a.mkdir()
    project_b = account / "project-b"
    project_b.mkdir()

    ref_a = profile.add_reuse_ref(project_a, account, pack.asset_id, 1)
    ref_b = profile.add_reuse_ref(project_b, account, pack.asset_id, 1)
    assert ref_a == ref_b  # both bind the same immutable, digest-pinned version

    # publishing v2 does NOT change what either project already resolves
    profile.publish_pack_version(account, _reuse_pack(version=2, look="red scarf"))
    for project in (project_a, project_b):
        (resolved,) = profile.resolve_reuse_refs(project, account)
        assert resolved.version == 1

    # in-place tampering of the shared version fails closed for the consumer
    pack_path = account / "reuse" / pack.asset_id / "v1.json"
    raw = json.loads(pack_path.read_text(encoding="utf-8"))
    raw["content"]["look"] = "tampered"
    pack_path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(profile.ReuseRefError):
        profile.resolve_reuse_refs(project_a, account)


def test_automation_never_replaces_user_creative_judgement(tmp_path) -> None:
    # No fixed automation duty is a human-gate step: creative judgement + final
    # approval stay with the user (both top-level requirements).
    assert all(not c.human_gate for c in wfm3_capabilities())
    # meanwhile the post-production contract PRESERVES the human final-judgement
    # gates (load review, QC conclusions, release, knowledge promotion).
    gated = {s.step_id for s in pp_catalog.human_gate_steps()}
    assert {"S5-T06", "S6-T06", "S7-T05"} <= gated
    # and the capability registry stays FAIL-CLOSED: a known duty resolves, an
    # unregistered capability is refused (unknown automation cannot bypass the
    # capability controls).
    registry = build_wfm3_registry()
    assert registry.get("package").capability_id == "package"
    with pytest.raises(CapabilityNotRegisteredError):
        registry.get("unregistered_capability")


def test_unique_writer_fact_domains_are_separated(tmp_path) -> None:
    # Every business fact has a single writer domain (no shared/second source).
    # The four QC conclusions are FOUR pairwise-DISTINCT domains (not aliased):
    qc_steps = ("S6-T01", "S6-T02", "S6-T03", "S6-T04")
    qc = [pp_catalog.step(s).fact_domain for s in qc_steps]
    assert len(set(qc)) == 4
    # the catalog's domains are EXACTLY the declared separated writer set — no
    # duplication, no aliasing, no undeclared/typo domain (so the separation
    # invariant is verified, not merely that some names occur):
    catalog_domains = {s.fact_domain for s in pp_catalog.steps()}
    assert catalog_domains <= pp_catalog.fact_domains()  # only declared domains
    assert catalog_domains == {
        pp_catalog.FD_POST_MEDIA,
        pp_catalog.FD_LOAD_REVIEW,
        pp_catalog.FD_QC_NARRATIVE,
        pp_catalog.FD_QC_CONTINUITY,
        pp_catalog.FD_QC_TECHNICAL,
        pp_catalog.FD_QC_RIGHTS,
        pp_catalog.FD_RELEASE,
        pp_catalog.FD_POSTMORTEM,
        pp_catalog.FD_SCORECARD,
        pp_catalog.FD_PERFORMANCE,
        pp_catalog.FD_REUSE,
        pp_catalog.FD_KNOWLEDGE,
    }
    # technical QC (a hard-check writer) is a DIFFERENT domain from the subjective
    # / approval / release writers — states are never crossed (P5):
    assert pp_catalog.FD_QC_TECHNICAL not in {
        pp_catalog.FD_LOAD_REVIEW,
        pp_catalog.FD_RELEASE,
        pp_catalog.FD_QC_NARRATIVE,
    }
