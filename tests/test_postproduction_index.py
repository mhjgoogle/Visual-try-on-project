"""Tests for the WFM2 S5–S7 post-production artifact index (TASK-036)."""

from __future__ import annotations

import hashlib
import json

import pytest

from ai_video_workflow.postproduction import catalog, index
from ai_video_workflow.postproduction.errors import (
    PostProductionError,
    PostProductionNotFoundError,
    PostProductionValidationError,
)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _publish(project_root, *, step_id, kind, ref, stage, inputs=(), **kw):
    art = index.build_artifact(
        stage=stage,
        step_id=step_id,
        kind=kind,
        ref=ref,
        version=1,
        input_refs=inputs,
        **kw,
    )
    index.publish_artifact(project_root, art)
    return art


def _assembly(project_root, ref="timeline") -> index.PostProductionArtifact:
    return _publish(
        project_root, step_id="S5-T01", kind="assembly_timeline", ref=ref, stage="s5"
    )


# --- catalog -----------------------------------------------------------------


def test_catalog_covers_s5_s7() -> None:
    assert {s.stage for s in catalog.steps()} == {"s5", "s6", "s7"}
    assert catalog.step("S6-T03").fact_domain == catalog.FD_QC_TECHNICAL
    gates = {s.step_id for s in catalog.human_gate_steps()}
    assert {"S5-T06", "S6-T01", "S6-T06", "S7-T05"} <= gates


def test_qc_domains_are_distinct() -> None:
    domains = {
        catalog.step(s).fact_domain for s in ("S6-T01", "S6-T02", "S6-T03", "S6-T04")
    }
    assert len(domains) == 4  # narrative/continuity/technical/rights are separate


# --- identity / lineage ------------------------------------------------------


def test_publish_load_roundtrip_and_digest(tmp_path) -> None:
    art = _assembly(tmp_path)
    loaded = index.load_artifact(tmp_path, "s5", "timeline", 1)
    assert loaded.content_digest == art.content_digest
    assert loaded.fact_domain == "post_media"
    assert loaded.status == "produced"


def test_tampered_index_fails_closed(tmp_path) -> None:
    _assembly(tmp_path)
    path = tmp_path / index.index_relpath("s5", "timeline", 1)
    raw = json.loads(path.read_text())
    raw["kind"] = "rough_cut"  # identity change without recomputing digest
    path.write_text(json.dumps(raw))
    with pytest.raises(PostProductionValidationError):
        index.load_artifact(tmp_path, "s5", "timeline", 1)


def test_linear_versioning_requires_parent(tmp_path) -> None:
    _assembly(tmp_path)
    # v2 must parent v1 with a change reason
    with pytest.raises(PostProductionError):
        index.build_artifact(
            stage="s5",
            step_id="S5-T01",
            kind="assembly_timeline",
            ref="timeline",
            version=2,
        )
    v2 = index.build_artifact(
        stage="s5",
        step_id="S5-T01",
        kind="assembly_timeline",
        ref="timeline",
        version=2,
        parent_version=1,
        change_reason="re-cut opening",
    )
    index.publish_artifact(tmp_path, v2)
    assert index.latest_version(tmp_path, "s5", "timeline") == 2


def test_republish_same_version_refused(tmp_path) -> None:
    # the linear-chain guard fires first (v1 exists -> next must be v2); the
    # create-only file publish is defense-in-depth beneath it.
    _assembly(tmp_path)
    with pytest.raises(PostProductionValidationError):
        _assembly(tmp_path)  # same ref v1 again


def test_fact_domain_must_match_catalog(tmp_path) -> None:
    with pytest.raises(PostProductionValidationError):
        index.build_artifact(
            stage="s5",
            step_id="S5-T01",
            kind="assembly_timeline",
            ref="t",
            version=1,
            fact_domain="qc_technical",
        )


def test_bad_catalog_triple_rejected(tmp_path) -> None:
    with pytest.raises(PostProductionValidationError):
        index.build_artifact(
            stage="s6", step_id="S5-T01", kind="assembly_timeline", ref="t", version=1
        )


# --- input lineage + completeness --------------------------------------------


def test_produced_binds_required_pp_input(tmp_path) -> None:
    a = _assembly(tmp_path)
    # S5-T02 rough_cut REQUIRES S5-T01 assembly_timeline as an input
    ref = a.as_input_ref()
    _publish(
        tmp_path,
        step_id="S5-T02",
        kind="rough_cut",
        ref="rough",
        stage="s5",
        inputs=(ref.to_dict(),),
    )
    assert index.load_latest(tmp_path, "s5", "rough").kind == "rough_cut"


def test_missing_required_pp_input_rejected(tmp_path) -> None:
    _assembly(tmp_path)
    with pytest.raises(PostProductionValidationError):
        _publish(tmp_path, step_id="S5-T02", kind="rough_cut", ref="rough", stage="s5")


def test_forged_input_digest_rejected(tmp_path) -> None:
    a = _assembly(tmp_path)
    bad = a.as_input_ref().to_dict()
    bad["content_digest"] = "0" * 64
    with pytest.raises(PostProductionValidationError):
        _publish(
            tmp_path,
            step_id="S5-T02",
            kind="rough_cut",
            ref="rough",
            stage="s5",
            inputs=(bad,),
        )


def test_external_input_is_declared_only(tmp_path) -> None:
    # an external (QCD/evaluation) fact is referenced by digest, not resolved
    a = _assembly(tmp_path)
    ref = a.as_input_ref().to_dict()
    ext = {
        "surface": "external",
        "container": "qcd",
        "ref": "provider_cost_recorded",
        "version": 1,
        "content_digest": "a" * 64,
    }
    _publish(
        tmp_path,
        step_id="S5-T02",
        kind="rough_cut",
        ref="rough",
        stage="s5",
        inputs=(ref, ext),
    )
    loaded = index.load_latest(tmp_path, "s5", "rough")
    assert any(i.surface == "external" for i in loaded.input_refs)


# --- status semantics (missing != zero, P7) ----------------------------------


def test_not_applicable_only_for_conditional(tmp_path) -> None:
    # S7-T05 knowledge_promotion is conditional -> not_applicable is valid
    _publish(
        tmp_path,
        step_id="S7-T05",
        kind="knowledge_promotion",
        ref="kp",
        stage="s7",
        status="not_applicable",
        status_reason="no reusable knowledge this run",
    )
    loaded = index.load_latest(tmp_path, "s7", "kp")
    assert loaded.status == "not_applicable"
    # a REQUIRED step may not be not_applicable
    with pytest.raises(PostProductionValidationError):
        index.build_artifact(
            stage="s5",
            step_id="S5-T01",
            kind="assembly_timeline",
            ref="t",
            version=1,
            status="not_applicable",
            status_reason="x",
        )


def test_unavailable_only_for_optional_data(tmp_path) -> None:
    # S7-T03 performance_snapshot is optional-data -> unavailable is valid
    _publish(
        tmp_path,
        step_id="S7-T03",
        kind="performance_snapshot",
        ref="perf",
        stage="s7",
        status="unavailable",
        status_reason="platform analytics window not yet open",
    )
    assert index.load_latest(tmp_path, "s7", "perf").status == "unavailable"
    with pytest.raises(PostProductionValidationError):
        index.build_artifact(
            stage="s7",
            step_id="S7-T01",
            kind="postmortem",
            ref="pm",
            version=1,
            status="unavailable",
            status_reason="x",
        )


def test_non_produced_requires_reason_and_no_body(tmp_path) -> None:
    with pytest.raises(PostProductionValidationError):
        index.build_artifact(
            stage="s7",
            step_id="S7-T05",
            kind="knowledge_promotion",
            ref="kp",
            version=1,
            status="not_applicable",
        )
    with pytest.raises(PostProductionValidationError):
        index.build_artifact(
            stage="s7",
            step_id="S7-T03",
            kind="performance_snapshot",
            ref="perf",
            version=1,
            status="unavailable",
            status_reason="x",
            body_ref="reports/x.json",
            body_digest="a" * 64,
        )


def test_not_applicable_waives_input_completeness(tmp_path) -> None:
    # S7-T05 requires S7-T04, but a not_applicable outcome produced nothing
    _publish(
        tmp_path,
        step_id="S7-T05",
        kind="knowledge_promotion",
        ref="kp",
        stage="s7",
        status="not_applicable",
        status_reason="nothing worth promoting",
    )
    assert index.load_latest(tmp_path, "s7", "kp").status == "not_applicable"


# --- body binding ------------------------------------------------------------


def test_body_ref_digest_binding(tmp_path) -> None:
    # S5-T01 has no required post-production inputs, so it's a clean body carrier
    body = tmp_path / "reports" / "timeline.md"
    body.parent.mkdir(parents=True, exist_ok=True)
    body.write_text("assembly timeline body")
    digest = _sha(body.read_bytes())
    _publish(
        tmp_path,
        step_id="S5-T01",
        kind="assembly_timeline",
        ref="timeline",
        stage="s5",
        body_ref="reports/timeline.md",
        body_digest=digest,
    )
    # editing the body after publish is caught on load
    body.write_text("tampered")
    with pytest.raises(PostProductionValidationError):
        index.load_latest(tmp_path, "s5", "timeline")


def test_version_may_not_change_identity(tmp_path) -> None:
    # v1 is assembly_timeline; a v2 that repurposes the same ref to rough_cut is
    # rejected — a ref's step/kind/fact_domain is immutable across versions.
    _assembly(tmp_path)
    drift = index.build_artifact(
        stage="s5",
        step_id="S5-T02",
        kind="rough_cut",
        ref="timeline",
        version=2,
        parent_version=1,
        change_reason="oops repurpose",
    )
    with pytest.raises(PostProductionValidationError):
        index.publish_artifact(tmp_path, drift)


def test_load_detects_tampered_upstream_with_recomputed_digest(tmp_path) -> None:
    a = _assembly(tmp_path)
    _publish(
        tmp_path,
        step_id="S5-T02",
        kind="rough_cut",
        ref="rough",
        stage="s5",
        inputs=(a.as_input_ref().to_dict(),),
    )
    # rewrite the upstream A as a DIFFERENT-but-self-consistent artifact (its own
    # digest recomputed), simulating post-publication tampering of the upstream.
    tampered = index.build_artifact(
        stage="s5",
        step_id="S5-T01",
        kind="assembly_timeline",
        ref="timeline",
        version=1,
        checklist=({"item": "note", "verdict": "ok", "note": "injected"},),
    )
    apath = tmp_path / index.index_relpath("s5", "timeline", 1)
    apath.write_text(json.dumps(tampered.to_dict()))
    # A still loads on its own (its digest is internally consistent)...
    assert index.load_artifact(tmp_path, "s5", "timeline", 1).content_digest != (
        a.content_digest
    )
    # ...but loading the DEPENDENT rough_cut re-resolves A and detects the drift
    with pytest.raises(PostProductionValidationError):
        index.load_artifact(tmp_path, "s5", "rough", 1)


def _publish_media_master(project_root, ref="mixdown"):
    from ai_video_workflow.media import assets as media_assets

    media = project_root / "media" / "imported" / "master" / f"{ref}.bin"
    media.parent.mkdir(parents=True, exist_ok=True)
    media.write_bytes(b"master-media-bytes-" + ref.encode())
    asset = media_assets.build_asset(
        media_kind="master",
        ref=ref,
        version=1,
        producer={"source": "external", "note": "mix master"},
        media_path=f"media/imported/master/{ref}.bin",
        media_sha256=_sha(media.read_bytes()),
        size_bytes=media.stat().st_size,
    )
    media_assets.publish_asset(project_root, asset)
    return asset


def _pp_chain_to_fine(project_root):
    a = _assembly(project_root)
    r = _publish(
        project_root,
        step_id="S5-T02",
        kind="rough_cut",
        ref="rough",
        stage="s5",
        inputs=(a.as_input_ref().to_dict(),),
    )
    f = _publish(
        project_root,
        step_id="S5-T03",
        kind="fine_cut",
        ref="fine",
        stage="s5",
        inputs=(r.as_input_ref().to_dict(),),
    )
    return f


def test_audio_mix_requires_media_provenance(tmp_path) -> None:
    fine = _pp_chain_to_fine(tmp_path)
    master = _publish_media_master(tmp_path)
    media_ref = {
        "surface": "media",
        "container": "master",
        "ref": "mixdown",
        "version": 1,
        "content_digest": master.content_digest,
    }
    # with the media source bound, S5-T04 publishes
    _publish(
        tmp_path,
        step_id="S5-T04",
        kind="audio_mix",
        ref="mix",
        stage="s5",
        inputs=(fine.as_input_ref().to_dict(), media_ref),
    )
    assert index.load_latest(tmp_path, "s5", "mix").kind == "audio_mix"


def test_audio_mix_without_media_provenance_rejected(tmp_path) -> None:
    fine = _pp_chain_to_fine(tmp_path)
    # binds the required post-production input but NOT the required media source
    with pytest.raises(PostProductionValidationError):
        _publish(
            tmp_path,
            step_id="S5-T04",
            kind="audio_mix",
            ref="mix",
            stage="s5",
            inputs=(fine.as_input_ref().to_dict(),),
        )


def test_directly_constructed_invalid_artifact_rejected_at_publish(tmp_path) -> None:
    # bypass build_artifact and hand publish an invalid (step/kind mismatch)
    # artifact — it must be rejected before anything is written, not published
    # immutably and then poison the ref by failing every load.
    bad = index.PostProductionArtifact(
        schema_version=index.POSTPRODUCTION_INDEX_SCHEMA_VERSION,
        stage="s5",
        step_id="S5-T01",
        fact_domain="post_media",
        kind="rough_cut",  # wrong kind for S5-T01 (assembly_timeline)
        ref="poison",
        version=1,
        status="produced",
        status_reason=None,
        input_refs=(),
        parent_version=None,
        change_reason=None,
        checklist=(),
        body_ref=None,
        body_digest=None,
    )
    with pytest.raises(PostProductionValidationError):
        index.publish_artifact(tmp_path, bad)
    assert index.latest_version(tmp_path, "s5", "poison") is None  # nothing written


def test_missing_artifact_raises_not_found(tmp_path) -> None:
    with pytest.raises(PostProductionNotFoundError):
        index.load_artifact(tmp_path, "s5", "ghost", 1)
