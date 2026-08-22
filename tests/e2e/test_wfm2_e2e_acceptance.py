"""WFM2 end-to-end acceptance evidence (TASK-037).

Milestone acceptance gate for "WFM2 formal audio-visual work". Adds acceptance
evidence only — no new product capability. It threads the WFM2-NEW layers (S4–S7)
end to end, fully offline and zero-spend, ON TOP OF a locked creative baseline:

  [creative baseline: L0–S3 locks are ADR-0037/TASK-034's milestone and are
   covered by that layer's own tests — tests/test_creative_*; here a real creative
   artifact is referenced to prove cross-surface creative→post-production lineage,
   not to re-cover the 34-step creative tree]
    → media assets + generation batch/selection (S4, ADR-0038/TASK-035)
    → TASK-008 audio-visual mux (S5-T04/T05: voice-over + subtitle onto the M1
      composition master, no TTS/paid API)
    → post-production / QC / release / archive index (S5–S7, ADR-0039/TASK-036)

It proves the WFM2 layers COMPOSE with digest-bound cross-surface lineage,
unique-writer fact-domain separation (P5), missing≠zero status semantics (P7), and
no orphaned provenance. Milestone sign-off remains the user's (see the runbook).
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.audio.registration import (
    register_subtitle_asset,
    register_voiceover_asset,
)
from ai_video_workflow.composition.av_profile import (
    SUBTITLE_MODE_SOFT,
    AudioTrackMix,
    AudioVisualProfile,
    SubtitleSpec,
)
from ai_video_workflow.composition.av_step import run_audiovisual_step
from ai_video_workflow.creative import index as creative_index
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.media import assets as media_assets
from ai_video_workflow.postproduction import catalog as pp_catalog
from ai_video_workflow.postproduction import index as pp
from ai_video_workflow.qcd.log import read_events
from tests.audio_fakes import FakeAudioVisualComposer, write_srt, write_wav
from tests.media_fakes import FakeMediaInspector

T0 = datetime(2026, 8, 4, 9, 0, 0, tzinfo=timezone.utc)
PROJECT = "wfm2-accept"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _publish_media_master(
    root: Path, ref: str, relpath: str
) -> media_assets.MediaAsset:
    media = root / relpath
    asset = media_assets.build_asset(
        media_kind="master",
        ref=ref,
        version=1,
        producer={"source": "external", "note": "wfm2 master"},
        media_path=relpath,
        media_sha256=_sha(media.read_bytes()),
        size_bytes=media.stat().st_size,
    )
    media_assets.publish_asset(root, asset)
    return asset


def _pp(root, *, step_id, kind, ref, stage, inputs=(), **kw):
    art = pp.build_artifact(
        stage=stage,
        step_id=step_id,
        kind=kind,
        ref=ref,
        version=1,
        input_refs=inputs,
        **kw,
    )
    pp.publish_artifact(root, art)
    return art


def test_wfm2_s4_to_s7_pipeline_on_creative_baseline(tmp_path) -> None:
    root = tmp_path / "project"
    root.mkdir()

    # --- creative baseline (L0–S3 is TASK-034's milestone / tests) ---------
    # Publish ONE real creative artifact to exercise the cross-surface
    # creative -> post-production lineage binding; the full L0–S3 lock tree is
    # covered by tests/test_creative_* (ADR-0037), not re-covered here.
    idea = creative_index.build_artifact(
        stage="l0", step_id="L0-01", kind="idea_card", ref="spark", version=1
    )
    creative_index.publish_artifact(root, idea)

    # --- S4: the M1 composition master (video-only) + TASK-008 AV mux -----
    (root / "outputs").mkdir(parents=True, exist_ok=True)
    (root / "outputs" / "final_v1.mp4").write_bytes(b"m1-video-master-bytes")
    write_wav(root / "audio" / "vo.wav", samples=8000)
    write_srt(root / "subs" / "en.srt", cues=2)
    register_voiceover_asset(root, ref="narration", media_relpath="audio/vo.wav")
    register_subtitle_asset(root, ref="en", media_relpath="subs/en.srt")

    profile = AudioVisualProfile(
        tracks=(AudioTrackMix(role="voiceover", ref="narration", version=1),),
        subtitles=SubtitleSpec(ref="en", version=1, mode=SUBTITLE_MODE_SOFT),
        original_audio_gain_db=-6.0,
    )
    av = run_audiovisual_step(
        project_root=root,
        project_id=PROJECT,
        base_video_relpath="outputs/final_v1.mp4",
        profile=profile,
        composer=FakeAudioVisualComposer(),
        inspector=FakeMediaInspector(
            result=MediaProbeResult("mp4", 8.0, 1280, 720, 24.0)
        ),
        observed_at=T0,
        base_has_audio=True,
    )
    # the S5 mux emitted the distinct audiovisual_completed fact (not composition)
    events = read_events(root)
    assert any(e.event_id == f"audiovisual_completed:{PROJECT}:v1" for e in events)

    # register the AV master as a formal media master asset (S5 master media)
    master_media = _publish_media_master(root, "final_av", av.output_path)

    # --- S5: post-production media chain (fact domain post_media) ---------
    assembly = _pp(
        root, step_id="S5-T01", kind="assembly_timeline", ref="timeline", stage="s5"
    )
    rough = _pp(
        root,
        step_id="S5-T02",
        kind="rough_cut",
        ref="rough",
        stage="s5",
        inputs=(assembly.as_input_ref().to_dict(),),
    )
    fine = _pp(
        root,
        step_id="S5-T03",
        kind="fine_cut",
        ref="fine",
        stage="s5",
        inputs=(rough.as_input_ref().to_dict(),),
    )
    media_ref = {
        "surface": "media",
        "container": "master",
        "ref": "final_av",
        "version": 1,
        "content_digest": master_media.content_digest,
    }
    mix = _pp(
        root,
        step_id="S5-T04",
        kind="audio_mix",
        ref="mix",
        stage="s5",
        inputs=(fine.as_input_ref().to_dict(), media_ref),
    )
    master = _pp(
        root,
        step_id="S5-T05",
        kind="master_candidate",
        ref="master",
        stage="s5",
        inputs=(fine.as_input_ref().to_dict(), mix.as_input_ref().to_dict(), media_ref),
    )
    load_review = _pp(
        root,
        step_id="S5-T06",
        kind="final_load_review",
        ref="loadrev",
        stage="s5",
        inputs=(master.as_input_ref().to_dict(),),
        checklist=({"item": "primary payload", "verdict": "pass", "note": "ok"},),
    )

    # --- S6: four independent QC fact domains + release -------------------
    lr = load_review.as_input_ref().to_dict()
    creative_ref = {
        "surface": "creative",
        "container": "l0",
        "ref": "spark",
        "version": 1,
        "content_digest": idea.content_digest,
    }
    narrative = _pp(
        root, step_id="S6-T01", kind="narrative_qc", ref="nqc", stage="s6", inputs=(lr,)
    )
    continuity = _pp(
        root,
        step_id="S6-T02",
        kind="continuity_qc",
        ref="cqc",
        stage="s6",
        inputs=(lr,),
    )
    technical = _pp(
        root, step_id="S6-T03", kind="technical_qc", ref="tqc", stage="s6", inputs=(lr,)
    )
    # rights QC binds the creative source AND the master media (cross-surface)
    rights = _pp(
        root,
        step_id="S6-T04",
        kind="rights_qc",
        ref="rqc",
        stage="s6",
        inputs=(lr, creative_ref, media_ref),
    )
    # the release package binds all four QC conclusions AND the precise master
    # media identity (matrix: "平台包引用精确母版 digest") — so the packaged
    # release carries an explicit immutable master lineage, not only QC refs.
    package = _pp(
        root,
        step_id="S6-T05",
        kind="release_package",
        ref="pkg",
        stage="s6",
        inputs=(
            *(
                a.as_input_ref().to_dict()
                for a in (narrative, continuity, technical, rights)
            ),
            media_ref,
        ),
    )
    assert any(i.surface == "media" for i in package.input_refs)
    result = _pp(
        root,
        step_id="S6-T06",
        kind="release_result",
        ref="rel",
        stage="s6",
        inputs=(package.as_input_ref().to_dict(),),
    )

    # the four QC facts are DISTINCT unique-writer domains (P5)
    qc_domains = {
        pp.load_latest(root, "s6", r).fact_domain for r in ("nqc", "cqc", "tqc", "rqc")
    }
    assert qc_domains == {
        pp_catalog.FD_QC_NARRATIVE,
        pp_catalog.FD_QC_CONTINUITY,
        pp_catalog.FD_QC_TECHNICAL,
        pp_catalog.FD_QC_RIGHTS,
    }

    # --- S7: post-mortem, scorecard, performance (unavailable), reuse,
    #         knowledge (not_applicable) — missing != zero (P7) ------------
    rel = result.as_input_ref().to_dict()
    ext_cost = {
        "surface": "external",
        "container": "qcd",
        "ref": "provider_cost_recorded",
        "version": 1,
        "content_digest": "b" * 64,
    }
    postmortem = _pp(
        root,
        step_id="S7-T01",
        kind="postmortem",
        ref="pm",
        stage="s7",
        inputs=(rel, ext_cost),
    )
    scorecard = _pp(
        root,
        step_id="S7-T02",
        kind="provider_scorecard",
        ref="score",
        stage="s7",
        inputs=(postmortem.as_input_ref().to_dict(),),
    )
    # audience performance is optional-data and legitimately NOT YET available
    perf = _pp(
        root,
        step_id="S7-T03",
        kind="performance_snapshot",
        ref="perf",
        stage="s7",
        status="unavailable",
        status_reason="platform analytics window opens 30 days post-release",
    )
    _pp(
        root,
        step_id="S7-T04",
        kind="reuse_candidate",
        ref="reuse",
        stage="s7",
        inputs=(
            postmortem.as_input_ref().to_dict(),
            scorecard.as_input_ref().to_dict(),
        ),
    )
    # nothing worth promoting this run: a conditional step recorded not_applicable
    knowledge = _pp(
        root,
        step_id="S7-T05",
        kind="knowledge_promotion",
        ref="kp",
        stage="s7",
        status="not_applicable",
        status_reason="no cross-project reuse this run",
    )

    # missing (unavailable/not_applicable) is DISTINCT from a produced zero
    assert perf.status == "unavailable" and perf.status_reason
    assert knowledge.status == "not_applicable" and knowledge.status_reason

    # --- lineage integrity: every produced artifact re-resolves on load,
    #     with no orphaned/forged cross-surface provenance ------------------
    for stage in ("s5", "s6", "s7"):
        for art in pp.latest_artifacts(root, stage):
            reloaded = pp.load_artifact(root, stage, art.ref, art.version)
            assert reloaded.content_digest == art.content_digest


def test_release_result_binds_full_qc_and_master_lineage(tmp_path) -> None:
    # A focused check that the S6 release package cannot exist without binding all
    # four QC conclusions (unique-writer completeness), guarding against a release
    # that skips a QC domain.
    root = tmp_path / "p"
    root.mkdir()
    # minimal chain to a load review
    a = _pp(root, step_id="S5-T01", kind="assembly_timeline", ref="t", stage="s5")
    r = _pp(
        root,
        step_id="S5-T02",
        kind="rough_cut",
        ref="r",
        stage="s5",
        inputs=(a.as_input_ref().to_dict(),),
    )
    f = _pp(
        root,
        step_id="S5-T03",
        kind="fine_cut",
        ref="f",
        stage="s5",
        inputs=(r.as_input_ref().to_dict(),),
    )
    (root / "m").write_bytes(b"master-bytes")
    m_media = media_assets.build_asset(
        media_kind="master",
        ref="mm",
        version=1,
        producer={"source": "external", "note": "m"},
        media_path="m",
        media_sha256=_sha((root / "m").read_bytes()),
        size_bytes=(root / "m").stat().st_size,
    )
    media_assets.publish_asset(root, m_media)
    media_ref = {
        "surface": "media",
        "container": "master",
        "ref": "mm",
        "version": 1,
        "content_digest": m_media.content_digest,
    }
    mix = _pp(
        root,
        step_id="S5-T04",
        kind="audio_mix",
        ref="mx",
        stage="s5",
        inputs=(f.as_input_ref().to_dict(), media_ref),
    )
    master = _pp(
        root,
        step_id="S5-T05",
        kind="master_candidate",
        ref="ma",
        stage="s5",
        inputs=(f.as_input_ref().to_dict(), mix.as_input_ref().to_dict(), media_ref),
    )
    lr = (
        _pp(
            root,
            step_id="S5-T06",
            kind="final_load_review",
            ref="lr",
            stage="s5",
            inputs=(master.as_input_ref().to_dict(),),
            checklist=({"item": "primary payload", "verdict": "pass", "note": "ok"},),
        )
        .as_input_ref()
        .to_dict()
    )
    n = _pp(
        root, step_id="S6-T01", kind="narrative_qc", ref="n", stage="s6", inputs=(lr,)
    )
    c = _pp(
        root, step_id="S6-T02", kind="continuity_qc", ref="c", stage="s6", inputs=(lr,)
    )
    t = _pp(
        root, step_id="S6-T03", kind="technical_qc", ref="t2", stage="s6", inputs=(lr,)
    )
    rq = _pp(
        root,
        step_id="S6-T04",
        kind="rights_qc",
        ref="rq",
        stage="s6",
        inputs=(lr, media_ref),
    )
    # a release package binding only three of four QC conclusions is rejected
    with pytest.raises(pp.PostProductionValidationError):
        _pp(
            root,
            step_id="S6-T05",
            kind="release_package",
            ref="pkg",
            stage="s6",
            inputs=tuple(
                x.as_input_ref().to_dict() for x in (n, c, t)
            ),  # missing rights
        )
    # binding all four QC conclusions AND the master media identity succeeds
    pkg = _pp(
        root,
        step_id="S6-T05",
        kind="release_package",
        ref="pkg",
        stage="s6",
        inputs=(
            *(x.as_input_ref().to_dict() for x in (n, c, t, rq)),
            media_ref,
        ),
    )
    assert pp.load_latest(root, "s6", "pkg").kind == "release_package"

    # the release RESULT cannot exist without binding the release package (its
    # sole required S6-T05 input) — a result may not skip the packaged lineage.
    with pytest.raises(pp.PostProductionValidationError):
        _pp(root, step_id="S6-T06", kind="release_result", ref="rel", stage="s6")
    result = _pp(
        root,
        step_id="S6-T06",
        kind="release_result",
        ref="rel",
        stage="s6",
        inputs=(pkg.as_input_ref().to_dict(),),
    )
    assert pp.load_latest(root, "s6", "rel").kind == "release_result"
    # and the result re-resolves its package lineage on load (fail-closed)
    assert result.input_refs[0].content_digest == pkg.content_digest
