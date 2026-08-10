"""Tests for the WFM2 creative/audiovisual L0-S3 contract layer (TASK-034).

Covers the locked-artifact structured index (identity/version/lineage,
immutability, digest + body binding, tamper detection, catalog-triple validity,
full input-lineage binding), the L0-S3 step catalog (faithful to the semantic
I/O baseline, queryable when unrun, WFM1 stage ids unchanged), payload
continuity, the three-representative-shot pilot gate (per-shot content/visual/
cost, bound to the lock's probe), and per-lock stage-target validation. Also the
read-only/publish/validate CLI. No Provider, no approval, no media generation,
no network, no payment.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.creative import (
    build_artifact,
    catalog,
    latest_version,
    load_latest,
    payload,
    pilot,
    publish_artifact,
    stage_targets,
)
from ai_video_workflow.creative.errors import (
    CreativeError,
    CreativeNotFoundError,
    CreativeValidationError,
)
from ai_video_workflow.creative.index import load_artifact
from ai_video_workflow.errors import OverwriteRefusedError


def _pub(
    root: Path,
    stage: str,
    step_id: str,
    kind: str,
    *,
    ref: str | None = None,
    version: int = 1,
    inputs=(),
    checklist=(("ok", "pass", ""),),
    parent_version=None,
    change_reason=None,
):
    art = build_artifact(
        stage=stage,
        step_id=step_id,
        kind=kind,
        ref=ref or kind,
        version=version,
        input_refs=[i.as_input_ref().to_dict() for i in inputs],
        parent_version=parent_version,
        change_reason=change_reason,
        checklist=[{"item": i, "verdict": v, "note": n} for i, v, n in checklist],
    )
    publish_artifact(root, art)
    return art


def _probe_pass(shots=("character_closeup", "medium", "hardest")):
    """Passing content/visual/cost checklist rows for the given shot classes."""
    return tuple(
        (f"{shot}:{dim}", "pass", "")
        for shot in shots
        for dim in ("content", "visual", "cost")
    )


# --- dependency-chain builders (publish full catalog lineage in order) -------


def _seed_l0(root, *, probe=None, lock=True, lock_ref="concept_lock"):
    probe = probe if probe is not None else _probe_pass()
    idea = _pub(root, "l0", "L0-01", "idea_card")
    logline = _pub(root, "l0", "L0-02", "logline_set", inputs=[idea])
    decl = _pub(root, "l0", "L0-03", "load_declaration", inputs=[idea, logline])
    sform = _pub(root, "l0", "L0-04", "short_form_test", inputs=[logline, decl])
    feas = _pub(root, "l0", "L0-05", "feasibility_report", inputs=[sform, logline])
    prb = _pub(
        root,
        "l0",
        "L0-06",
        "concept_probe",
        inputs=[decl, sform, feas],
        checklist=probe,
    )
    out = {
        "idea": idea,
        "logline": logline,
        "decl": decl,
        "sform": sform,
        "feas": feas,
        "probe": prb,
    }
    if lock:
        out["lock"] = _pub(
            root,
            "l0",
            "L0-07",
            "concept_lock",
            ref=lock_ref,
            inputs=[logline, decl, sform, feas, prb],
        )
    return out


def _seed_s1(root, l0):
    bible = _pub(root, "s1", "S1-T01", "story_bible", inputs=[l0["lock"]])
    beat = _pub(root, "s1", "S1-T02", "beat_sheet", inputs=[l0["lock"], bible])
    arc = _pub(root, "s1", "S1-T03", "character_arc", inputs=[l0["lock"], bible, beat])
    scr = _pub(root, "s1", "S1-T04", "screenplay", inputs=[bible, beat, arc])
    review = _pub(
        root, "s1", "S1-T05", "load_review", inputs=[scr, l0["decl"], l0["lock"]]
    )
    qc = _pub(root, "s1", "S1-T06", "narrative_qc", inputs=[scr, bible, beat, arc])
    lock = _pub(root, "s1", "S1-T07", "screenplay_lock", inputs=[scr, review, qc])
    return {
        "bible": bible,
        "beat": beat,
        "arc": arc,
        "screenplay": scr,
        "review": review,
        "qc": qc,
        "lock": lock,
    }


def _seed_s2(root, l0, s1, *, probe=None):
    probe = probe if probe is not None else _probe_pass()
    fmt = _pub(root, "s2", "S2-T01", "format_lock", inputs=[s1["lock"]])
    vb = _pub(
        root,
        "s2",
        "S2-T02",
        "visual_bible",
        inputs=[l0["lock"], s1["lock"], l0["decl"], fmt],
    )
    reg = _pub(root, "s2", "S2-T03", "design_registry", inputs=[s1["lock"], vb])
    cine = _pub(
        root, "s2", "S2-T04", "cinematography_guide", inputs=[fmt, vb, reg, l0["decl"]]
    )
    audio = _pub(
        root, "s2", "S2-T05", "audio_bible", inputs=[s1["lock"], l0["decl"], fmt]
    )
    vprobe = _pub(
        root,
        "s2",
        "S2-T06",
        "visual_probe",
        inputs=[fmt, vb, reg, cine, audio],
        checklist=probe,
    )
    lock = _pub(
        root,
        "s2",
        "S2-T07",
        "av_design_lock",
        inputs=[fmt, vb, reg, cine, audio, vprobe],
    )
    return {
        "fmt": fmt,
        "vbible": vb,
        "registry": reg,
        "cine": cine,
        "audio": audio,
        "vprobe": vprobe,
        "lock": lock,
    }


def _seed_s3(root, l0, s1, s2, *, card_refs=("shot_card",)):
    shot_list = _pub(
        root, "s3", "S3-T01", "shot_list", inputs=[s1["lock"], s2["lock"], s2["fmt"]]
    )
    cards = [
        _pub(
            root,
            "s3",
            "S3-T02",
            "shot_card",
            ref=c,
            inputs=[shot_list, s1["lock"], s2["lock"]],
        )
        for c in card_refs
    ]
    route = _pub(
        root, "s3", "S3-T03", "production_route", inputs=[cards[0], l0["feas"]]
    )
    provider = _pub(root, "s3", "S3-T04", "provider_plan", inputs=[route])
    budget = _pub(root, "s3", "S3-T05", "shot_budget", inputs=[cards[0], provider])
    pre = _pub(
        root,
        "s3",
        "S3-T06",
        "preflight_report",
        inputs=[shot_list, cards[0], route, provider, budget],
    )
    lock = _pub(
        root,
        "s3",
        "S3-T07",
        "production_design_lock",
        inputs=[shot_list, cards[0], route, provider, budget, pre],
    )
    return {
        "shot_list": shot_list,
        "cards": cards,
        "route": route,
        "provider": provider,
        "budget": budget,
        "preflight": pre,
        "lock": lock,
    }


def _seed_all(root, *, card_refs=("shot_card",)):
    l0 = _seed_l0(root)
    s1 = _seed_s1(root, l0)
    s2 = _seed_s2(root, l0, s1)
    s3 = _seed_s3(root, l0, s1, s2, card_refs=card_refs)
    return l0, s1, s2, s3


# --- index: identity, immutability, lineage ----------------------------------


def test_publish_load_roundtrip_and_digest(tmp_path):
    art = _pub(tmp_path, "l0", "L0-01", "idea_card")
    loaded = load_latest(tmp_path, "l0", "idea_card")
    assert loaded.content_digest == art.content_digest
    assert loaded.ref == "idea_card"
    assert latest_version(tmp_path, "l0", "idea_card") == 1


def test_immutable_publish_refuses_overwrite(tmp_path):
    art = _pub(tmp_path, "l0", "L0-01", "idea_card")
    with pytest.raises((CreativeValidationError, OverwriteRefusedError)):
        publish_artifact(tmp_path, art)


def test_tampered_index_fails_closed(tmp_path):
    _pub(tmp_path, "l0", "L0-01", "idea_card")
    path = tmp_path / "creative" / "l0" / "idea_card_v1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["checklist"] = [{"item": "x", "verdict": "pass", "note": "tampered"}]
    path.write_text(json.dumps(raw))  # digest no longer matches
    with pytest.raises(CreativeValidationError):
        load_artifact(tmp_path, "l0", "idea_card", 1)


def test_new_version_requires_parent_and_reason(tmp_path):
    _pub(tmp_path, "l0", "L0-01", "idea_card")
    _pub(
        tmp_path,
        "l0",
        "L0-01",
        "idea_card",
        version=2,
        parent_version=1,
        change_reason="refine",
    )
    assert latest_version(tmp_path, "l0", "idea_card") == 2
    # parent set but reason missing is refused at construction
    with pytest.raises(CreativeError):
        build_artifact(
            stage="l0",
            step_id="L0-01",
            kind="idea_card",
            ref="idea_card",
            version=3,
            parent_version=2,
        )


def test_build_rejects_v2_without_parent(tmp_path):
    with pytest.raises(CreativeError):
        build_artifact(
            stage="l0", step_id="L0-01", kind="idea_card", ref="idea_card", version=2
        )


def test_publish_v2_refuses_absent_parent(tmp_path):
    art = build_artifact(
        stage="l0",
        step_id="L0-01",
        kind="idea_card",
        ref="idea_card",
        version=2,
        parent_version=1,
        change_reason="edit",
    )
    with pytest.raises(CreativeValidationError):
        publish_artifact(tmp_path, art)  # v1 was never published


def test_body_ref_is_digest_bound(tmp_path):
    body = tmp_path / "creative" / "l0" / "idea.md"
    body.parent.mkdir(parents=True)
    body.write_text("# idea", encoding="utf-8")
    digest = hashlib.sha256(body.read_bytes()).hexdigest()
    _pub_body = build_artifact(
        stage="l0",
        step_id="L0-01",
        kind="idea_card",
        ref="idea_card",
        version=1,
        body_ref="creative/l0/idea.md",
        body_digest=digest,
    )
    publish_artifact(tmp_path, _pub_body)
    body.write_text("# tampered", encoding="utf-8")
    v2 = build_artifact(
        stage="l0",
        step_id="L0-01",
        kind="idea_card",
        ref="idea_card",
        version=2,
        parent_version=1,
        change_reason="x",
        body_ref="creative/l0/idea.md",
        body_digest=digest,
    )
    with pytest.raises(CreativeValidationError):
        publish_artifact(tmp_path, v2)


def test_body_tamper_after_publish_fails_on_load(tmp_path):
    body = tmp_path / "creative" / "l0" / "idea.md"
    body.parent.mkdir(parents=True)
    body.write_text("# idea", encoding="utf-8")
    digest = hashlib.sha256(body.read_bytes()).hexdigest()
    art = build_artifact(
        stage="l0",
        step_id="L0-01",
        kind="idea_card",
        ref="idea_card",
        version=1,
        body_ref="creative/l0/idea.md",
        body_digest=digest,
    )
    publish_artifact(tmp_path, art)
    body.write_text("# edited after publish", encoding="utf-8")
    with pytest.raises(CreativeValidationError):
        load_latest(tmp_path, "l0", "idea_card")


def test_load_missing_is_not_found(tmp_path):
    with pytest.raises(CreativeNotFoundError):
        load_artifact(tmp_path, "l0", "idea_card", 1)


def test_input_ref_requires_stage(tmp_path):
    with pytest.raises(CreativeError):
        build_artifact(
            stage="l0",
            step_id="L0-02",
            kind="logline_set",
            ref="logline_set",
            version=1,
            input_refs=[{"ref": "idea_card", "version": 1, "content_digest": "a" * 64}],
        )


def test_publish_requires_catalog_inputs(tmp_path):
    # logline_set (L0-02) requires idea_card (L0-01); omitting it is refused
    _pub(tmp_path, "l0", "L0-01", "idea_card")
    art = build_artifact(
        stage="l0", step_id="L0-02", kind="logline_set", ref="logline_set", version=1
    )  # no input_refs
    with pytest.raises(CreativeValidationError):
        publish_artifact(tmp_path, art)


def test_publish_refuses_dangling_input_ref(tmp_path):
    art = build_artifact(
        stage="l0",
        step_id="L0-02",
        kind="logline_set",
        ref="logline_set",
        version=1,
        input_refs=[
            {
                "stage": "l0",
                "ref": "idea_card",
                "version": 1,
                "content_digest": "a" * 64,
            }
        ],
    )
    with pytest.raises(CreativeValidationError):
        publish_artifact(tmp_path, art)  # idea_card never published


def test_publish_refuses_digest_forged_input_ref(tmp_path):
    real = _pub(tmp_path, "l0", "L0-01", "idea_card")
    forged = build_artifact(
        stage="l0",
        step_id="L0-02",
        kind="logline_set",
        ref="logline_set",
        version=1,
        input_refs=[
            {
                "stage": real.stage,
                "ref": real.ref,
                "version": real.version,
                "content_digest": "b" * 64,
            }
        ],
    )
    with pytest.raises(CreativeValidationError):
        publish_artifact(tmp_path, forged)


def test_publish_refuses_corrupt_parent(tmp_path):
    _pub(tmp_path, "l0", "L0-01", "idea_card")
    path = tmp_path / "creative" / "l0" / "idea_card_v1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["checklist"] = [{"item": "x", "verdict": "pass", "note": "tampered"}]
    path.write_text(json.dumps(raw))
    v2 = build_artifact(
        stage="l0",
        step_id="L0-01",
        kind="idea_card",
        ref="idea_card",
        version=2,
        parent_version=1,
        change_reason="edit",
    )
    with pytest.raises(CreativeValidationError):
        publish_artifact(tmp_path, v2)


def test_build_rejects_invalid_catalog_triple(tmp_path):
    with pytest.raises(CreativeValidationError):
        build_artifact(
            stage="l0", step_id="L0-07", kind="idea_card", ref="x", version=1
        )
    with pytest.raises(CreativeValidationError):
        build_artifact(
            stage="l0", step_id="NOPE-99", kind="idea_card", ref="x", version=1
        )


def test_latest_version_does_not_collide_across_prefixed_refs(tmp_path):
    _pub(tmp_path, "l0", "L0-01", "idea_card", ref="foo")
    _pub(tmp_path, "l0", "L0-01", "idea_card", ref="foo_v1")
    assert latest_version(tmp_path, "l0", "foo") == 1
    assert latest_version(tmp_path, "l0", "foo_v1") == 1
    assert load_latest(tmp_path, "l0", "foo").ref == "foo"


# --- catalog: faithful to baseline, queryable unrun, ids unchanged -----------


def test_catalog_matches_baseline_step_ids():
    got = {r.step_id for r in catalog.steps()}
    expected = (
        {"Project-Init"}
        | {f"L0-0{i}" for i in range(1, 8)}
        | {f"S1-T0{i}" for i in range(1, 8)}
        | {f"S2-T0{i}" for i in range(1, 8)}
        | {f"S3-T0{i}" for i in range(1, 8)}
    )
    assert got == expected
    assert len(catalog.steps()) == 29


def test_catalog_is_queryable_before_any_run():
    assert len(catalog.steps("l0")) == 7
    assert [r.step_id for r in catalog.lock_steps()] == [
        "L0-07",
        "S1-T07",
        "S2-T07",
        "S3-T07",
    ]


def test_lock_steps_keep_wfm1_approval_stage_ids():
    stages = {r.step_id: r.approval_stage for r in catalog.lock_steps()}
    assert stages == {
        "L0-07": "concept_lock",
        "S1-T07": "screenplay_lock",
        "S2-T07": "av_design_lock",
        "S3-T07": "production_lock",
    }


def test_every_step_has_owner_and_completion():
    for r in catalog.steps():
        assert r.owner and r.completion and r.execution in ("required", "conditional")


# --- payload continuity ------------------------------------------------------


def test_validate_load_pair():
    payload.validate_load_pair("人性光辉", "唯美")
    payload.validate_load_pair("人性光辉", None)
    with pytest.raises(CreativeValidationError):
        payload.validate_load_pair("人性光辉", "人性光辉")
    with pytest.raises(CreativeValidationError):
        payload.validate_load_pair("unknown")


def test_payload_threads_ok_on_full_chain(tmp_path):
    _seed_all(tmp_path)
    # every load-declaration consumer is bound (structurally, via publish)
    assert payload.payload_threads(tmp_path) == ()


def test_payload_threads_reports_missing_carriers(tmp_path):
    _seed_l0(tmp_path)  # no S1/S2 carriers yet
    problems = payload.payload_threads(tmp_path)
    assert problems and any("has not been published" in p for p in problems)


# --- pilot gate --------------------------------------------------------------


def test_pilot_gate_requires_three_representative_classes(tmp_path):
    _seed_l0(tmp_path, probe=_probe_pass(("character_closeup", "medium")), lock=False)
    assert pilot.concept_probe_problems(tmp_path)[0].startswith("L0-06")


def test_pilot_gate_passes_on_full_evidence(tmp_path):
    _seed_l0(tmp_path, lock=False)
    assert pilot.concept_probe_problems(tmp_path) == ()


def test_pilot_gate_requires_all_three_dimensions(tmp_path):
    rows = tuple(r for r in _probe_pass() if r[0] != "hardest:cost")
    _seed_l0(tmp_path, probe=rows, lock=False)
    assert pilot.concept_probe_problems(tmp_path)


def test_pilot_gate_rejects_conflicting_evidence(tmp_path):
    rows = _probe_pass() + (("hardest:cost", "fail", "over budget"),)
    _seed_l0(tmp_path, probe=rows, lock=False)
    assert pilot.concept_probe_problems(tmp_path)


def test_pilot_gate_missing_probe_blocks(tmp_path):
    assert pilot.pilot_gate_problems(tmp_path)


def test_pilot_ignores_wrong_type_probe_at_ref(tmp_path):
    _pub(tmp_path, "l0", "L0-01", "idea_card", ref="concept_probe")
    problems = pilot.concept_probe_problems(tmp_path)
    assert problems and "not been published" in problems[0]


# --- stage targets -----------------------------------------------------------


def test_concept_lock_ready_when_chain_complete(tmp_path):
    _seed_l0(tmp_path, lock=True)
    assert stage_targets.validate_lock(tmp_path, "concept_lock") == ()
    stage_targets.require_lock_ready(tmp_path, "concept_lock")


def test_concept_lock_not_published_is_not_ready(tmp_path):
    _seed_l0(tmp_path, lock=False)  # inputs exist but no lock
    problems = stage_targets.validate_lock(tmp_path, "concept_lock")
    assert any("not been published" in p for p in problems)
    with pytest.raises(CreativeValidationError):
        stage_targets.require_lock_ready(tmp_path, "concept_lock")


def test_concept_lock_blocked_when_bound_probe_fails(tmp_path):
    # the lock binds a probe that does not clear the representative-shot checks
    _seed_l0(tmp_path, probe=_probe_pass(("character_closeup",)), lock=True)
    problems = stage_targets.validate_lock(tmp_path, "concept_lock")
    assert any("pilot probe" in p for p in problems)


def test_lock_resolved_at_custom_ref(tmp_path):
    _seed_l0(tmp_path, lock=True, lock_ref="episode_concept_lock")
    assert stage_targets.validate_lock(tmp_path, "concept_lock") == ()


def test_lock_ignores_wrong_type_artifact_at_canonical_ref(tmp_path):
    _pub(tmp_path, "l0", "L0-01", "idea_card", ref="concept_lock")
    problems = stage_targets.validate_lock(tmp_path, "concept_lock")
    assert any("not been published" in p for p in problems)


def test_screenplay_and_av_locks_ready_on_full_chain(tmp_path):
    _seed_all(tmp_path)
    assert stage_targets.validate_lock(tmp_path, "screenplay_lock") == ()
    assert stage_targets.validate_lock(tmp_path, "av_design_lock") == ()


def test_av_lock_blocked_when_visual_probe_fails(tmp_path):
    l0 = _seed_l0(tmp_path)
    s1 = _seed_s1(tmp_path, l0)
    _seed_s2(tmp_path, l0, s1, probe=_probe_pass(("character_closeup",)))
    problems = stage_targets.validate_lock(tmp_path, "av_design_lock")
    assert any("pilot probe" in p for p in problems)


def test_validate_unknown_lock_stage_errors(tmp_path):
    with pytest.raises(CreativeValidationError):
        stage_targets.validate_lock(tmp_path, "assets_ready")


def test_production_lock_ready_on_full_chain(tmp_path):
    _seed_all(tmp_path)
    assert stage_targets.validate_lock(tmp_path, "production_lock") == ()


def test_production_accepts_per_shot_cards(tmp_path):
    _seed_all(tmp_path, card_refs=("shot_card_shot-1", "shot_card_shot-2"))
    assert stage_targets.validate_lock(tmp_path, "production_lock") == ()


def test_production_requires_the_design_lock(tmp_path):
    # S3 design T01-T06 all present but the S3-T07 production_design_lock missing
    l0 = _seed_l0(tmp_path)
    s1 = _seed_s1(tmp_path, l0)
    s2 = _seed_s2(tmp_path, l0, s1)
    shot_list = _pub(
        tmp_path,
        "s3",
        "S3-T01",
        "shot_list",
        inputs=[s1["lock"], s2["lock"], s2["fmt"]],
    )
    card = _pub(
        tmp_path,
        "s3",
        "S3-T02",
        "shot_card",
        inputs=[shot_list, s1["lock"], s2["lock"]],
    )
    route = _pub(
        tmp_path, "s3", "S3-T03", "production_route", inputs=[card, l0["feas"]]
    )
    provider = _pub(tmp_path, "s3", "S3-T04", "provider_plan", inputs=[route])
    budget = _pub(tmp_path, "s3", "S3-T05", "shot_budget", inputs=[card, provider])
    _pub(
        tmp_path,
        "s3",
        "S3-T06",
        "preflight_report",
        inputs=[shot_list, card, route, provider, budget],
    )
    problems = stage_targets.validate_lock(tmp_path, "production_lock")
    assert any("production_design_lock" in p for p in problems)


def test_production_lock_reports_missing_s3_indexes(tmp_path):
    l0 = _seed_l0(tmp_path)
    s1 = _seed_s1(tmp_path, l0)
    _seed_s2(tmp_path, l0, s1)  # no S3 design indexes
    problems = stage_targets.validate_lock(tmp_path, "production_lock")
    assert len(problems) == 7  # S3-T01..T07 all missing
    assert all("not published" in p for p in problems)


# --- CLI ---------------------------------------------------------------------


def _run(root, *args):
    return cli.main(["--project-root", str(root), *args])


def test_cli_creative_plan(tmp_path, capsys):
    assert _run(tmp_path, "creative-plan", "--stage", "s2") == 0
    out = json.loads(capsys.readouterr().out)
    assert {r["step_id"] for r in out} == {f"S2-T0{i}" for i in range(1, 8)}


def test_cli_creative_plan_unknown_stage_fails_closed(tmp_path):
    assert _run(tmp_path, "creative-plan", "--stage", "s9") == 1


def test_cli_creative_publish_and_validate(tmp_path):
    spec = {
        "stage": "l0",
        "step_id": "L0-01",
        "kind": "idea_card",
        "ref": "idea_card",
        "version": 1,
        "checklist": [{"item": "x", "verdict": "pass", "note": ""}],
    }
    spec_file = tmp_path / "spec.json"
    spec_file.write_text(json.dumps(spec), encoding="utf-8")
    assert _run(tmp_path, "creative-publish", "--from", str(spec_file)) == 0
    assert (tmp_path / "creative" / "l0" / "idea_card_v1.json").is_file()
    # an incomplete concept lock validation exits non-zero (fail closed)
    assert _run(tmp_path, "creative-validate", "--stage-lock", "concept_lock") == 1


def test_cli_creative_publish_rejects_bad_spec(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"stage": "l0"}), encoding="utf-8")
    assert _run(tmp_path, "creative-publish", "--from", str(bad)) == 1
