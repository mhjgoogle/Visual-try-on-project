"""Tests for the WFM2 multimedia Workspace projection (WQ-19 / TASK-039)."""

from __future__ import annotations

import hashlib
import json

from ai_video_workflow.media import assets as media_assets
from ai_video_workflow.postproduction import index as pp
from ai_video_workflow.workspace import queries
from ai_video_workflow.workspace.envelope import Provenance

NOW = "2026-08-04T10:00:00+00:00"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _media(root, kind, ref, body=b"bytes"):
    rel = f"media/imported/{kind}/{ref}.bin"
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_bytes(body + ref.encode())
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


def _seed(root):
    _media(root, "keyframe", "kf1")
    _media(root, "voiceover", "vo1")
    _media(root, "subtitle", "sub1")
    _media(root, "master", "m1")
    art = pp.build_artifact(
        stage="s5", step_id="S5-T01", kind="assembly_timeline", ref="t", version=1
    )
    pp.publish_artifact(root, art)
    # a not_applicable S7 outcome (missing != zero) should be observable as such
    kp = pp.build_artifact(
        stage="s7",
        step_id="S7-T05",
        kind="knowledge_promotion",
        ref="kp",
        version=1,
        status="not_applicable",
        status_reason="nothing to promote",
    )
    pp.publish_artifact(root, kp)


def test_multimedia_projection_makes_media_observable(tmp_path) -> None:
    _seed(tmp_path)
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.query_id == "WQ-19"
    assert res.contract_version == "1.5"
    # every field is AUTHORITATIVE (derived from the digest-bound indices) — no
    # media type is an "unavailable" WFM1 placeholder anymore
    for item in res.items:
        for f in item.values():
            assert f.provenance is Provenance.AUTHORITATIVE
    kinds = {
        item["media_kind"].value
        for item in res.items
        if item["domain"].value == "media_asset"
    }
    assert {"keyframe", "voiceover", "subtitle", "master"} <= kinds
    # the not_applicable S7 fact is projected with its status intact (P7)
    kp = [
        item
        for item in res.items
        if item["domain"].value == "postproduction" and item["ref"].value == "kp"
    ]
    assert kp and kp[0]["status"].value == "not_applicable"
    assert res.scope["media_asset_count"] == 4
    assert not res.problems


def test_multimedia_projection_is_deterministic(tmp_path) -> None:
    _seed(tmp_path)
    a = queries.project_multimedia(tmp_path, NOW)
    b = queries.project_multimedia(tmp_path, NOW)
    assert queries._comparable(a) == queries._comparable(b)


def test_corrupt_postproduction_fails_closed(tmp_path) -> None:
    _seed(tmp_path)
    # tamper a post-production index so its self-digest no longer matches
    path = tmp_path / pp.index_relpath("s5", "t", 1)
    raw = json.loads(path.read_text())
    raw["kind"] = "rough_cut"
    path.write_text(json.dumps(raw))
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.readiness_failed
    assert any(p.category.value == "source_corrupt" for p in res.problems)


def test_corrupt_media_asset_fails_closed(tmp_path) -> None:
    _seed(tmp_path)
    # mutate a bound media file after registration -> digest mismatch on load
    (tmp_path / "media" / "imported" / "master" / "m1.bin").write_bytes(b"tampered")
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.readiness_failed
    assert any(p.category.value == "source_corrupt" for p in res.problems)


def test_empty_project_has_no_media_but_does_not_fail(tmp_path) -> None:
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.items == ()
    assert not res.problems
    assert res.scope["media_asset_count"] == 0
