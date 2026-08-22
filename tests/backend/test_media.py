"""Tests for the WFM2 multimedia contract layer (TASK-035 / ADR-0038).

Covers the capability-declaring media Provider registry (fail-closed), the media
asset identity/lineage index (immutable linear versions, digest + media-file
binding, cross-domain input refs resolved), generation batch + selection (all
candidates retained, unselected never deleted), formal asset promotion, and
unified cost reusing the existing budget/QCD chain. No network, no real paid API,
no spend (offline stub only). VideoProvider is untouched.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.budget.ledger import build_ledger
from ai_video_workflow.config.project_config import FxConfig
from ai_video_workflow.media import (
    build_asset,
    default_media_registry,
    generate_batch,
    load_asset,
    load_latest,
    promote_selection,
    publish_asset,
    record_selection,
)
from ai_video_workflow.media.errors import (
    MediaError,
    MediaNotFoundError,
    MediaProviderError,
    MediaValidationError,
)
from ai_video_workflow.media.provider import (
    LocalStubMediaProvider,
    MediaProviderRegistry,
    MediaRequest,
    MediaStatus,
)
from ai_video_workflow.qcd.log import read_events

T0 = datetime(2026, 8, 4, 9, 0, 0, tzinfo=timezone.utc)
_FX = FxConfig(base_currency="JPY", rates={})


def _clock():
    return T0


def _stage(root: Path, relpath: str, content: bytes):
    path = root / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return relpath, hashlib.sha256(content).hexdigest(), len(content)


def _import_asset(root, *, media_kind="reference", ref="ref-a", content=b"img", **over):
    relpath, sha, size = _stage(root, f"media/objects/{ref}.bin", content)
    return build_asset(
        media_kind=media_kind,
        ref=ref,
        version=1,
        producer={"source": "manual", "note": "imported"},
        media_path=relpath,
        media_sha256=sha,
        size_bytes=size,
        **over,
    )


# --- provider registry: fail-closed ------------------------------------------


def test_stub_is_deterministic_and_offline():
    prov = LocalStubMediaProvider()
    req = MediaRequest(
        "local-stub", "op-1", "text_to_image", "generated_image", "a cat", "m1", {}, []
    )
    a = prov.generate(req, observed_at=T0)
    b = prov.generate(req, observed_at=T0)
    assert a.status is MediaStatus.SUCCEEDED
    assert a.content == b.content  # deterministic
    assert a.cost_observation is None  # zero cost


def test_registry_unknown_provider_fails_closed():
    reg = default_media_registry()
    with pytest.raises(MediaProviderError):
        reg.build("no-such-provider")


def test_registry_unknown_capability_fails_closed():
    reg = default_media_registry()
    with pytest.raises(MediaProviderError):
        reg.resolve("local-stub", "video_to_video")  # not a media capability


def test_registry_undeclared_capability_fails_closed():
    class _Narrow(LocalStubMediaProvider):
        def declared_capabilities(self):
            return frozenset({"text_to_image"})

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _Narrow())
    reg.resolve("local-stub", "text_to_image")  # declared -> ok
    with pytest.raises(MediaProviderError):
        reg.resolve("local-stub", "text_to_audio")  # not declared


def test_request_rejects_unknown_capability_and_kind():
    with pytest.raises(MediaValidationError):
        MediaRequest("p", "op", "bogus", "generated_image", "x", "m", {}, [])
    with pytest.raises(MediaValidationError):
        MediaRequest("p", "op", "text_to_image", "bogus_kind", "x", "m", {}, [])


# --- asset identity + lineage ------------------------------------------------


def test_asset_publish_load_roundtrip(tmp_path):
    asset = _import_asset(tmp_path)
    publish_asset(tmp_path, asset)
    loaded = load_latest(tmp_path, "reference", "ref-a")
    assert loaded.content_digest == asset.content_digest
    assert loaded.producer["source"] == "manual"


def test_asset_immutable_linear_versions(tmp_path):
    publish_asset(tmp_path, _import_asset(tmp_path))
    # a v2 must parent v1; a stray v3 or missing parent is refused
    with pytest.raises(MediaError):
        build_asset(
            media_kind="reference",
            ref="ref-a",
            version=2,
            producer={"source": "manual", "note": ""},
            media_path="x",
            media_sha256="a" * 64,
            size_bytes=1,
        )  # v2 without parent


def test_asset_tamper_fails_closed(tmp_path):
    publish_asset(tmp_path, _import_asset(tmp_path))
    path = tmp_path / "media" / "assets" / "reference" / "ref-a_v1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["size_bytes"] = 999  # identity changed, digest not
    path.write_text(json.dumps(raw))
    with pytest.raises(MediaValidationError):
        load_asset(tmp_path, "reference", "ref-a", 1)


def test_asset_media_file_binding(tmp_path):
    asset = _import_asset(tmp_path, content=b"original")
    publish_asset(tmp_path, asset)
    # editing the bound media without a new version fails closed on load
    (tmp_path / asset.media_path).write_bytes(b"tampered-bytes")
    with pytest.raises(MediaValidationError):
        load_latest(tmp_path, "reference", "ref-a")


def test_asset_missing_media_file_refused(tmp_path):
    relpath, sha, size = _stage(tmp_path, "media/objects/ghost.bin", b"x")
    (tmp_path / relpath).unlink()  # remove before publish
    asset = build_asset(
        media_kind="reference",
        ref="ghost",
        version=1,
        producer={"source": "manual", "note": ""},
        media_path=relpath,
        media_sha256=sha,
        size_bytes=size,
    )
    with pytest.raises(MediaValidationError):
        publish_asset(tmp_path, asset)


def test_asset_input_ref_media_domain_resolves(tmp_path):
    up = _import_asset(tmp_path, media_kind="reference", ref="up", content=b"up")
    publish_asset(tmp_path, up)
    down = _import_asset(
        tmp_path,
        media_kind="keyframe",
        ref="down",
        content=b"down",
        input_refs=[up.as_input_ref().to_dict()],
    )
    publish_asset(tmp_path, down)  # resolves + digest-matches
    # a forged upstream digest is refused
    forged = _import_asset(
        tmp_path,
        media_kind="master",
        ref="forge",
        content=b"forge",
        input_refs=[
            {
                "domain": "media",
                "container": "reference",
                "ref": "up",
                "version": 1,
                "content_digest": "b" * 64,
            }
        ],
    )
    with pytest.raises(MediaValidationError):
        publish_asset(tmp_path, forged)


def test_asset_input_ref_creative_domain_resolves(tmp_path):
    from ai_video_workflow.creative import build_artifact as c_build
    from ai_video_workflow.creative import publish_artifact as c_publish

    idea = c_build(stage="l0", step_id="L0-01", kind="idea_card", ref="idea", version=1)
    c_publish(tmp_path, idea)
    asset = _import_asset(
        tmp_path,
        media_kind="reference",
        ref="from-idea",
        content=b"x",
        input_refs=[
            {
                "domain": "creative",
                "container": "l0",
                "ref": "idea",
                "version": 1,
                "content_digest": idea.content_digest,
            }
        ],
    )
    publish_asset(tmp_path, asset)  # cross-domain resolve OK
    # a dangling creative ref is refused
    bad = _import_asset(
        tmp_path,
        media_kind="master",
        ref="bad",
        content=b"y",
        input_refs=[
            {
                "domain": "creative",
                "container": "l0",
                "ref": "nope",
                "version": 1,
                "content_digest": "a" * 64,
            }
        ],
    )
    with pytest.raises(MediaValidationError):
        publish_asset(tmp_path, bad)


# --- generation batch + selection --------------------------------------------


def test_generate_batch_retains_all_candidates(tmp_path):
    reg = default_media_registry()
    batch = generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1", "c2", "c3"],
        clock=_clock,
    )
    assert [c.candidate_id for c in batch.candidates] == ["c1", "c2", "c3"]
    assert len({c.media_sha256 for c in batch.candidates}) == 3  # distinct
    staged = sorted(
        p.name for p in (tmp_path / "staging" / "media" / "batch-1").iterdir()
    )
    assert staged == ["c1.png", "c2.png", "c3.png"]


def test_generate_batch_rejects_traversal_ids(tmp_path):
    reg = default_media_registry()
    with pytest.raises(MediaValidationError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="../../escape",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1"],
            clock=_clock,
        )
    with pytest.raises(MediaValidationError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["../c1"],
            clock=_clock,
        )
    # nothing was staged before validation rejected the crafted ids
    assert not (tmp_path / "staging").exists()


def test_generated_asset_carries_batch_input_lineage(tmp_path):
    # an upstream media asset drives generation; the promoted asset must keep it
    up = _import_asset(tmp_path, media_kind="reference", ref="up", content=b"up")
    publish_asset(tmp_path, up)
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="image_to_image",
        media_kind="generated_image",
        prompt="restyle",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
        input_refs=[up.as_input_ref().to_dict()],
    )
    record_selection(
        tmp_path, selection_id="sel-1", batch_id="batch-1", selected_candidate_id="c1"
    )
    asset = promote_selection(tmp_path, ref="styled", version=1, selection_id="sel-1")
    assert any(r.ref == "up" and r.domain == "media" for r in asset.input_refs)


def test_generate_batch_fails_closed_on_bad_capability(tmp_path):
    reg = default_media_registry()
    with pytest.raises(MediaError):  # unknown capability rejected up front
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op",
            batch_id="b",
            capability="video_to_video",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1"],
            clock=_clock,
        )


def test_selection_and_promotion_retain_unselected(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1", "c2"],
        clock=_clock,
    )
    record_selection(
        tmp_path, selection_id="sel-1", batch_id="batch-1", selected_candidate_id="c2"
    )
    asset = promote_selection(tmp_path, ref="cat", version=1, selection_id="sel-1")
    assert asset.batch_id == "batch-1"
    assert asset.producer["source"] == "generation"
    # both staged candidates remain (unselected never deleted)
    assert (tmp_path / "staging" / "media" / "batch-1" / "c1.png").is_file()
    assert (tmp_path / "staging" / "media" / "batch-1" / "c2.png").is_file()
    assert (
        load_latest(tmp_path, "generated_image", "cat").content_digest
        == asset.content_digest
    )


def test_selection_rejects_unknown_candidate(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    with pytest.raises(MediaNotFoundError):
        record_selection(
            tmp_path,
            selection_id="sel-x",
            batch_id="batch-1",
            selected_candidate_id="nope",
        )


def test_selection_actor_forced_user(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    with pytest.raises(MediaValidationError):
        record_selection(
            tmp_path,
            selection_id="s",
            batch_id="batch-1",
            selected_candidate_id="c1",
            actor="agent",
        )


# --- unified cost (reuses the existing chain) --------------------------------


def _hold(tmp_path, task_id="task-1", operation_id="op-1"):
    from ai_video_workflow.budget.reservation import hold_reservation

    hold_reservation(
        tmp_path,
        project_id="proj-1",
        task_id=task_id,
        operation_id=operation_id,
        shot_id="shot-1",
        provider_id="cloud-x",
        model_id="m1",
        estimate_jpy=500,
        created_at=T0.isoformat(),
    )


def test_media_cost_rolls_into_existing_ledger(tmp_path):
    from ai_video_workflow.media import book_media_cost

    _hold(tmp_path)  # budget-gated reservation exists first
    book_media_cost(
        tmp_path,
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-1",
        provider_id="cloud-x",
        model_id="m1",
        operation_id="op-1",
        cost_minor_units=500,
        currency="JPY",
        occurred_at=T0,
    )
    assert build_ledger(read_events(tmp_path), _FX).project_total_jpy == 500


def test_media_cost_requires_reservation(tmp_path):
    from ai_video_workflow.media import book_media_cost

    # no reservation -> refuse to book uncontrolled spend
    with pytest.raises(MediaValidationError):
        book_media_cost(
            tmp_path,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            provider_id="cloud-x",
            model_id="m1",
            operation_id="op-1",
            cost_minor_units=500,
            currency="JPY",
            occurred_at=T0,
        )
    assert read_events(tmp_path) == ()  # nothing booked


def test_media_cost_booked_exactly_once(tmp_path):
    from ai_video_workflow.media import book_media_cost

    _hold(tmp_path)
    for _ in range(2):  # replay
        book_media_cost(
            tmp_path,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            provider_id="cloud-x",
            model_id="m1",
            operation_id="op-1",
            cost_minor_units=500,
            currency="JPY",
            occurred_at=T0,
        )
    assert build_ledger(read_events(tmp_path), _FX).project_total_jpy == 500  # once


# --- CLI ---------------------------------------------------------------------


def _run(root, *args):
    return cli.main(["--project-root", str(root), *args])


def test_cli_media_generate_select_promote(tmp_path, capsys):
    spec = {
        "provider_id": "local-stub",
        "operation_id": "op-1",
        "batch_id": "batch-1",
        "capability": "text_to_image",
        "media_kind": "generated_image",
        "prompt": "a cat",
        "model_id": "m1",
        "candidate_ids": ["c1", "c2"],
    }
    (tmp_path / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    assert _run(tmp_path, "media-generate", "--from", str(tmp_path / "spec.json")) == 0
    assert (
        _run(
            tmp_path,
            "media-select",
            "--batch-id",
            "batch-1",
            "--candidate-id",
            "c1",
            "--selection-id",
            "sel-1",
        )
        == 0
    )
    assert (
        _run(
            tmp_path,
            "media-promote",
            "--selection-id",
            "sel-1",
            "--ref",
            "cat",
            "--version",
            "1",
        )
        == 0
    )
    assert (tmp_path / "media" / "assets" / "generated_image" / "cat_v1.json").is_file()


def test_cli_media_generate_rejects_bad_spec(tmp_path):
    (tmp_path / "bad.json").write_text(
        json.dumps({"provider_id": "x"}), encoding="utf-8"
    )
    assert _run(tmp_path, "media-generate", "--from", str(tmp_path / "bad.json")) == 1


def test_cli_media_generate_rejects_string_candidate_ids(tmp_path):
    # a bare string must not explode into a char list of candidates
    spec = {
        "provider_id": "local-stub",
        "operation_id": "op-1",
        "batch_id": "batch-1",
        "capability": "text_to_image",
        "media_kind": "generated_image",
        "prompt": "a cat",
        "model_id": "m1",
        "candidate_ids": "abc",
    }
    (tmp_path / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    assert _run(tmp_path, "media-generate", "--from", str(tmp_path / "spec.json")) == 1


def test_generate_batch_rejects_duplicate_candidate_ids(tmp_path):
    reg = default_media_registry()
    with pytest.raises(MediaValidationError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1", "c1"],
            clock=_clock,
        )
    assert not (tmp_path / "staging").exists()  # nothing staged before rejection


def test_generate_batch_rejects_malformed_parameters(tmp_path):
    reg = default_media_registry()
    with pytest.raises(MediaValidationError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1"],
            clock=_clock,
            parameters="not-an-object",
        )


def test_load_selection_rejects_tampered_actor(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    record_selection(
        tmp_path, selection_id="sel-1", batch_id="batch-1", selected_candidate_id="c1"
    )
    path = tmp_path / "media" / "selections" / "sel-1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["actor"] = "agent"  # forge non-user provenance
    path.write_text(json.dumps(raw))
    from ai_video_workflow.media import load_selection

    with pytest.raises(MediaValidationError):
        load_selection(tmp_path, "sel-1")


def test_cli_media_promote_supports_revision(tmp_path):
    spec = {
        "provider_id": "local-stub",
        "operation_id": "op-1",
        "batch_id": "batch-1",
        "capability": "text_to_image",
        "media_kind": "generated_image",
        "prompt": "a cat",
        "model_id": "m1",
        "candidate_ids": ["c1", "c2"],
    }
    (tmp_path / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    assert _run(tmp_path, "media-generate", "--from", str(tmp_path / "spec.json")) == 0
    _run(
        tmp_path,
        "media-select",
        "--batch-id",
        "batch-1",
        "--candidate-id",
        "c1",
        "--selection-id",
        "sel-1",
    )
    _run(
        tmp_path,
        "media-promote",
        "--selection-id",
        "sel-1",
        "--ref",
        "cat",
        "--version",
        "1",
    )
    # a v2 revision with parent + reason succeeds via the CLI
    _run(
        tmp_path,
        "media-select",
        "--batch-id",
        "batch-1",
        "--candidate-id",
        "c2",
        "--selection-id",
        "sel-2",
    )
    rc = _run(
        tmp_path,
        "media-promote",
        "--selection-id",
        "sel-2",
        "--ref",
        "cat",
        "--version",
        "2",
        "--parent-version",
        "1",
        "--change-reason",
        "reselect",
    )
    assert rc == 0
    assert (tmp_path / "media" / "assets" / "generated_image" / "cat_v2.json").is_file()


def test_request_rejects_incompatible_capability_kind():
    # an audio capability cannot produce an image kind (and vice versa)
    with pytest.raises(MediaValidationError):
        MediaRequest("p", "op", "text_to_audio", "generated_image", "x", "m", {}, [])
    with pytest.raises(MediaValidationError):
        MediaRequest("p", "op", "text_to_image", "audio_generation", "x", "m", {}, [])


def test_generate_batch_rejects_incompatible_kind(tmp_path):
    reg = default_media_registry()
    with pytest.raises(MediaValidationError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="b",
            capability="text_to_audio",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1"],
            clock=_clock,
        )
    assert not (tmp_path / "staging").exists()


def test_promoted_asset_records_selection_identity(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1", "c2"],
        clock=_clock,
    )
    record_selection(
        tmp_path, selection_id="sel-2", batch_id="batch-1", selected_candidate_id="c2"
    )
    asset = promote_selection(tmp_path, ref="cat", version=1, selection_id="sel-2")
    assert asset.producer["selection_id"] == "sel-2"
    assert asset.producer["candidate_id"] == "c2"


def test_load_batch_rejects_id_mismatch(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    path = tmp_path / "media" / "batches" / "batch-1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["batch_id"] = "batch-9"  # tamper provenance
    path.write_text(json.dumps(raw))
    from ai_video_workflow.media import load_batch

    with pytest.raises(MediaValidationError):
        load_batch(tmp_path, "batch-1")


def test_build_batch_rejects_incompatible_capability_kind():
    from ai_video_workflow.media.batch import build_batch

    cand = [
        {
            "candidate_id": "c1",
            "staging_path": "staging/media/x.wav",
            "media_sha256": "a" * 64,
            "size_bytes": 1,
        }
    ]
    with pytest.raises(MediaValidationError):
        build_batch(
            batch_id="b",
            operation_id="op",
            provider_id="p",
            model_id="m",
            capability="text_to_audio",
            media_kind="generated_image",
            prompt="x",
            candidates=cand,
        )


def test_publish_rejects_forged_generation_provenance(tmp_path):
    reg = default_media_registry()
    batch = generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1", "c2"],
        clock=_clock,
    )
    record_selection(
        tmp_path, selection_id="sel-1", batch_id="batch-1", selected_candidate_id="c1"
    )
    c1 = batch.candidate("c1")
    # forge: claim the selection authorized c2 while binding c1's media
    forged = build_asset(
        media_kind="generated_image",
        ref="cat",
        version=1,
        producer={
            "source": "generation",
            "operation_id": "op-1",
            "provider_id": "local-stub",
            "model_id": "m1",
            "parameters": {},
            "selection_id": "sel-1",
            "candidate_id": "c2",
        },
        media_path=c1.staging_path,
        media_sha256=c1.media_sha256,
        size_bytes=c1.size_bytes,
        batch_id="batch-1",
    )
    with pytest.raises(MediaValidationError):
        publish_asset(tmp_path, forged)


def test_generate_batch_cleans_up_staging_on_failure(tmp_path):
    from ai_video_workflow.media.provider import MediaProviderRegistry, MediaResult

    class _FailSecond(LocalStubMediaProvider):
        def __init__(self):
            self._n = 0

        def generate(self, request, *, observed_at):
            self._n += 1
            if self._n >= 2:
                return MediaResult(
                    self.provider_id, request.operation_id, MediaStatus.FAILED
                )
            return super().generate(request, observed_at=observed_at)

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _FailSecond())
    with pytest.raises(MediaProviderError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1", "c2"],
            clock=_clock,
        )
    # the first candidate's staged file was cleaned up (no orphan)
    media_dir = tmp_path / "staging" / "media"
    # no staged media file remains anywhere under staging/media (empty batch dir ok)
    assert not media_dir.exists() or not list(media_dir.rglob("*.png"))


def test_failed_batch_cleanup_isolated_from_other_batches(tmp_path):
    from ai_video_workflow.media.provider import MediaProviderRegistry, MediaResult

    # a batch is published; both candidate files are staged and retained
    generate_batch(
        tmp_path,
        registry=default_media_registry(),
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1", "c2"],
        clock=_clock,
    )
    c1_file = tmp_path / "staging" / "media" / "batch-1" / "c1.png"
    assert c1_file.is_file()

    class _FailSecond(LocalStubMediaProvider):
        def __init__(self):
            self._n = 0

        def generate(self, request, *, observed_at):
            self._n += 1
            if self._n >= 2:
                return MediaResult(
                    self.provider_id, request.operation_id, MediaStatus.FAILED
                )
            return super().generate(request, observed_at=observed_at)

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _FailSecond())
    # a DIFFERENT batch (same operation/candidate ids, different content is fine)
    # fails partway; its cleanup must not touch batch-1's retained media
    with pytest.raises(MediaProviderError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="batch-1b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="a cat",
            model_id="m1",
            candidate_ids=["c1", "c2"],
            clock=_clock,
        )
    # batch-1's retained candidate is untouched; batch-1b left no orphan
    assert c1_file.is_file()
    assert not list((tmp_path / "staging" / "media" / "batch-1b").glob("*.png"))


def test_same_ids_different_batches_do_not_collide(tmp_path):
    # reusing operation/candidate ids with DIFFERENT content in a new batch must
    # not collide (staging is keyed by the unique batch_id)
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-2",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a dog",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    assert (tmp_path / "staging" / "media" / "batch-1" / "c1.png").is_file()
    assert (tmp_path / "staging" / "media" / "batch-2" / "c1.png").is_file()


def test_stub_emits_valid_png_and_wav():
    prov = LocalStubMediaProvider()
    img = prov.generate(
        MediaRequest(
            "local-stub", "op", "text_to_image", "generated_image", "x", "m", {}, []
        ),
        observed_at=T0,
    )
    assert img.content[:8] == b"\x89PNG\r\n\x1a\n"  # valid PNG signature
    aud = prov.generate(
        MediaRequest(
            "local-stub", "op", "text_to_audio", "audio_generation", "x", "m", {}, []
        ),
        observed_at=T0,
    )
    assert aud.content[:4] == b"RIFF" and aud.content[8:12] == b"WAVE"  # valid WAV


def test_external_ref_result_fetched_via_fetcher(tmp_path):
    from ai_video_workflow.media.provider import (
        MediaProviderRegistry,
        MediaResult,
    )

    class _External(LocalStubMediaProvider):
        def generate(self, request, *, observed_at):
            cid = request.parameters["candidate_id"]
            return MediaResult(
                self.provider_id,
                request.operation_id,
                MediaStatus.SUCCEEDED,
                content=None,
                external_ref=f"https://example/{cid}",
            )

    class _FakeFetcher:
        def fetch(self, reference, dest):
            dest.write_bytes(b"fetched:" + reference.encode())

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _External())
    batch = generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="x",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
        fetcher=_FakeFetcher(),
    )
    staged = tmp_path / "staging" / "media" / "batch-1" / "c1.png"
    assert staged.read_bytes() == b"fetched:https://example/c1"
    assert batch.candidates[0].media_sha256


def test_external_ref_without_fetcher_fails_closed(tmp_path):
    from ai_video_workflow.media.provider import (
        MediaProviderRegistry,
        MediaResult,
    )

    class _External(LocalStubMediaProvider):
        def generate(self, request, *, observed_at):
            return MediaResult(
                self.provider_id,
                request.operation_id,
                MediaStatus.SUCCEEDED,
                content=None,
                external_ref="https://example/x",
            )

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _External())
    with pytest.raises(MediaProviderError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1"],
            clock=_clock,
        )


def test_batch_rejects_noncanonical_candidate_path():
    from ai_video_workflow.media.batch import build_batch

    bad = [
        {
            "candidate_id": "c1",
            "staging_path": "media/objects/evil.png",
            "media_sha256": "a" * 64,
            "size_bytes": 1,
        }
    ]
    with pytest.raises(MediaValidationError):
        build_batch(
            batch_id="batch-1",
            operation_id="op",
            provider_id="p",
            model_id="m",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            candidates=bad,
        )


def test_load_batch_verifies_candidate_files(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    # tamper the staged candidate file -> load_batch fails closed
    (tmp_path / "staging" / "media" / "batch-1" / "c1.png").write_bytes(b"evil")
    from ai_video_workflow.media import load_batch

    with pytest.raises(MediaValidationError):
        load_batch(tmp_path, "batch-1")


def test_generate_batch_rejects_result_identity_mismatch(tmp_path):
    from ai_video_workflow.media.provider import MediaProviderRegistry, MediaResult

    class _Wrong(LocalStubMediaProvider):
        def generate(self, request, *, observed_at):
            r = super().generate(request, observed_at=observed_at)
            return MediaResult(r.provider_id, "WRONG-OP", r.status, content=r.content)

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _Wrong())
    with pytest.raises(MediaProviderError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1"],
            clock=_clock,
        )


def test_publish_rejects_forged_parameters(tmp_path):
    reg = default_media_registry()
    batch = generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
        parameters={"style": "noir"},
    )
    record_selection(
        tmp_path, selection_id="sel-1", batch_id="batch-1", selected_candidate_id="c1"
    )
    c1 = batch.candidate("c1")
    forged = build_asset(
        media_kind="generated_image",
        ref="cat",
        version=1,
        producer={
            "source": "generation",
            "operation_id": "op-1",
            "provider_id": "local-stub",
            "model_id": "m1",
            "parameters": {"style": "bright"},  # falsified
            "selection_id": "sel-1",
            "candidate_id": "c1",
        },
        media_path=c1.staging_path,
        media_sha256=c1.media_sha256,
        size_bytes=c1.size_bytes,
        batch_id="batch-1",
    )
    with pytest.raises(MediaValidationError):
        publish_asset(tmp_path, forged)


def test_publish_rejects_dropped_batch_input_ref(tmp_path):
    up = _import_asset(tmp_path, media_kind="reference", ref="up", content=b"up")
    publish_asset(tmp_path, up)
    reg = default_media_registry()
    batch = generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="image_to_image",
        media_kind="generated_image",
        prompt="restyle",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
        input_refs=[up.as_input_ref().to_dict()],
    )
    record_selection(
        tmp_path, selection_id="sel-1", batch_id="batch-1", selected_candidate_id="c1"
    )
    c1 = batch.candidate("c1")
    forged = build_asset(
        media_kind="generated_image",
        ref="styled",
        version=1,
        producer={
            "source": "generation",
            "operation_id": "op-1",
            "provider_id": "local-stub",
            "model_id": "m1",
            "parameters": {},
            "selection_id": "sel-1",
            "candidate_id": "c1",
        },
        media_path=c1.staging_path,
        media_sha256=c1.media_sha256,
        size_bytes=c1.size_bytes,
        batch_id="batch-1",
        input_refs=[],  # dropped the batch's declared upstream lineage
    )
    with pytest.raises(MediaValidationError):
        publish_asset(tmp_path, forged)


def test_generate_batch_is_idempotent_on_rerun(tmp_path):
    reg = default_media_registry()
    kw = dict(
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1", "c2"],
        clock=_clock,
    )
    a = generate_batch(tmp_path, **kw)
    b = generate_batch(tmp_path, **kw)  # rerun after "interruption"
    assert a.to_dict() == b.to_dict()  # same batch, no OverwriteRefused


def test_generate_batch_rerun_with_different_request_conflicts(tmp_path):
    reg = default_media_registry()
    base = dict(
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        clock=_clock,
    )
    generate_batch(tmp_path, candidate_ids=["c1"], **base)
    with pytest.raises(MediaValidationError):
        generate_batch(tmp_path, candidate_ids=["c1", "c2"], **base)  # different


def test_book_media_cost_rejects_attribute_mismatch(tmp_path):
    from ai_video_workflow.media import book_media_cost

    _hold(tmp_path)  # reserved for provider cloud-x / shot-1
    with pytest.raises(MediaValidationError):
        book_media_cost(
            tmp_path,
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            provider_id="other-provider",
            model_id="m1",
            operation_id="op-1",
            cost_minor_units=500,
            currency="JPY",
            occurred_at=T0,
        )


def test_external_fetch_writes_trusted_download_receipt(tmp_path):
    from ai_video_workflow.media.provider import MediaProviderRegistry, MediaResult

    class _External(LocalStubMediaProvider):
        def generate(self, request, *, observed_at):
            return MediaResult(
                self.provider_id,
                request.operation_id,
                MediaStatus.SUCCEEDED,
                content=None,
                external_ref="https://example/x",
            )

    class _FakeFetcher:
        def fetch(self, reference, dest):
            dest.write_bytes(b"fetched-bytes")

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _External())
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="x",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
        fetcher=_FakeFetcher(),
    )
    receipt = tmp_path / "staging" / "media" / "batch-1" / "c1.png.fetched.json"
    assert receipt.is_file()
    assert (
        json.loads(receipt.read_text(encoding="utf-8"))["sha256"]
        == hashlib.sha256(b"fetched-bytes").hexdigest()
    )


def test_generate_batch_rerun_with_different_prompt_conflicts(tmp_path):
    reg = default_media_registry()
    base = dict(
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    generate_batch(tmp_path, prompt="a cat", **base)
    with pytest.raises(MediaValidationError):  # same ids, changed prompt -> conflict
        generate_batch(tmp_path, prompt="a dog", **base)


def test_load_batch_rejects_tampered_provenance(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    path = tmp_path / "media" / "batches" / "batch-1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["prompt"] = "a forged prompt"  # candidate file hashes still valid
    path.write_text(json.dumps(raw))
    from ai_video_workflow.media import load_batch

    with pytest.raises(MediaValidationError):
        load_batch(tmp_path, "batch-1")


def test_load_selection_rejects_tampered_record(tmp_path):
    reg = default_media_registry()
    generate_batch(
        tmp_path,
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    record_selection(
        tmp_path, selection_id="sel-1", batch_id="batch-1", selected_candidate_id="c1"
    )
    path = tmp_path / "media" / "selections" / "sel-1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["rationale"] = "forged"  # digest no longer matches
    path.write_text(json.dumps(raw))
    from ai_video_workflow.media import load_selection

    with pytest.raises(MediaValidationError):
        load_selection(tmp_path, "sel-1")


def test_external_ref_rejects_non_http_scheme(tmp_path):
    from ai_video_workflow.media.provider import MediaProviderRegistry, MediaResult

    class _Ext(LocalStubMediaProvider):
        def generate(self, request, *, observed_at):
            return MediaResult(
                self.provider_id,
                request.operation_id,
                MediaStatus.SUCCEEDED,
                content=None,
                external_ref="file:///etc/passwd",
            )

    class _Fetcher:
        def fetch(self, reference, dest):  # pragma: no cover - must never run
            dest.write_bytes(b"x")

    reg = MediaProviderRegistry()
    reg.register("local-stub", lambda: _Ext())
    with pytest.raises(MediaProviderError):
        generate_batch(
            tmp_path,
            registry=reg,
            provider_id="local-stub",
            operation_id="op-1",
            batch_id="b",
            capability="text_to_image",
            media_kind="generated_image",
            prompt="x",
            model_id="m",
            candidate_ids=["c1"],
            clock=_clock,
            fetcher=_Fetcher(),
        )


def test_concurrent_publish_returns_winner_without_rollback(tmp_path):
    # simulate the race: the batch record already exists at publish time (a
    # concurrent winner), so publish hits OverwriteRefused; our call must return
    # the winner and NOT delete the shared staged candidate files.
    reg = default_media_registry()
    kw = dict(
        registry=reg,
        provider_id="local-stub",
        operation_id="op-1",
        batch_id="batch-1",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="a cat",
        model_id="m1",
        candidate_ids=["c1"],
        clock=_clock,
    )
    generate_batch(tmp_path, **kw)  # the "winner" publishes first
    staged = tmp_path / "staging" / "media" / "batch-1" / "c1.png"
    assert staged.is_file()
    result = generate_batch(tmp_path, **kw)  # idempotent re-entry returns winner
    assert result.batch_id == "batch-1"
    assert staged.is_file()  # shared candidate file was never rolled back
