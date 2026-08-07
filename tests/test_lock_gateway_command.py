"""Draft-plan lock Gateway command tests (ADR-0047 / TASK-047).

STRICTLY OFFLINE: no network, no Provider, no payment — ``lock-draft-plan``
only publishes versioned planning documents / records and compiles packets.

Every path stages a project to an approved ``production_lock`` over shot plan
v1 (the staging pattern from tests/test_paid_gateway_command.py), then locks a
canvas draft through the command. Covers: draft param validation blockers
(count / title / description / duration / first-frame shape+size), planning
contract blockers (shot count, total duration), approval-chain blockers,
catalog quote blockers, overwrite refusal, target binding via
``ShotPlanTargetResolver``, the full high-risk Gateway path (preflight ->
confirm -> submit -> COMPLETED receipt + versioned files + re-approval +
first-frame packets), preflight digest stability, confirmation enforcement,
command_id idempotency and conflict, concurrent-lock staleness, optional
brief/story versioning, and the default-registry posture (never registered by
default).
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.app.gateway_commands import build_wfm1_registry
from ai_video_workflow.app.lock_gateway import (
    LOCK_DRAFT_PLAN,
    ShotPlanTargetResolver,
    register_lock_draft_command,
)
from ai_video_workflow.approval import load_approval, transition_stage
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.gateway import (
    BlockedCommandError,
    CommandEnvelope,
    CommandGateway,
    CommandIdConflictError,
    CommandRegistry,
    ConfirmationRequiredError,
    ConfirmationStaleError,
    ReceiptStatus,
    TargetBindingError,
    UnregisteredCommandError,
)
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.planning import (
    load_packet,
    load_shot_plan,
    publish_brief,
    publish_prompt,
    publish_shot_plan,
    publish_story,
)

AT = "2026-08-07T00:00:00+00:00"
T0 = datetime(2026, 8, 7, tzinfo=timezone.utc)
FRAME = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="


def _clock() -> datetime:
    return T0


# --- staging (mirrors tests/test_paid_gateway_command.py) ---------------------


def _catalog_raw() -> dict:
    return {
        "schema_version": 1,
        "catalog_id": "wfm1-test",
        "version": 1,
        "providers": {
            "prov": {
                "display_name": "P",
                "capabilities": ["image_to_video", "text_to_video"],
                "credential_env_vars": [],
                "models": {
                    "m1": {
                        "billing_mode": "per_clip",
                        "currency": "USD",
                        "clip_prices": [
                            {
                                "resolution": "512p",
                                "duration_seconds": 6,
                                "amount_minor_units": 10,
                            },
                            {
                                "resolution": "512p",
                                "duration_seconds": 10,
                                "amount_minor_units": 15,
                            },
                        ],
                        "per_second_minor_units": {},
                    }
                },
            }
        },
    }


def _config_dict(digest: str) -> dict:
    return {
        "schema_version": 2,
        "default_provider": "prov",
        "fallback_provider": None,
        "shot_overrides": {},
        "budgets_jpy": {
            "episode_soft": 1200,
            "episode_hard": 1500,
            "monthly_hard": 5000,
            "per_shot": 400,
        },
        "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
        "catalog_id": "wfm1-test",
        "catalog_version": 1,
        "catalog_digest": digest,
    }


def _plan_v1() -> dict:
    return {
        "schema_version": 1,
        "version": 1,
        "shots": [
            {
                "shot_id": f"shot-{i}",
                "sequence": i,
                "prompt_ref": {"prompt_id": "p-main", "version": 1},
                "duration_seconds": 10,
                "resolution": "512p",
                "capability": "text_to_video",
                "model_id": "m1",
                "width": 512,
                "height": 512,
                "frame_rate": 24.0,
                "reuse_assets": [],
                "first_frame_image": None,
            }
            for i in range(1, 7)
        ],
    }


def _setup_project(
    tmp_path: Path, *, approve: bool = True, approve_production: bool = True
) -> tuple[Path, Path]:
    """Stage a project with an approved shot plan v1 (no packets compiled)."""
    account = tmp_path
    project = account / "project-a"
    project.mkdir()
    catalog_dir = account / "catalog"
    catalog_dir.mkdir()
    raw = _catalog_raw()
    (catalog_dir / "wfm1-test.json").write_text(json.dumps(raw), encoding="utf-8")
    (project / "config").mkdir()
    (project / "config" / "wfm1.json").write_text(
        json.dumps(_config_dict(compute_catalog_digest(raw))), encoding="utf-8"
    )
    write_model_json(
        project / "project.json",
        Project(project_id="proj-a", name="T", created_at=T0),
    )
    publish_prompt(
        project,
        {
            "schema_version": 1,
            "prompt_id": "p-main",
            "version": 1,
            "text": "a cinematic shot v1",
            "previous_version": None,
            "change_reason": None,
            "reference_assets": [],
        },
    )
    publish_brief(
        project,
        {
            "schema_version": 1,
            "version": 1,
            "logline": "one act of kindness, one irreversible cost",
            "primary_load": "人性光辉",
            "secondary_load": None,
            "synopsis": "a stranger pays a debt no one asked her to pay",
        },
    )
    publish_story(
        project,
        {
            "schema_version": 1,
            "version": 1,
            "beats": [
                {"beat_id": "open", "description": "fast open"},
                {"beat_id": "turn", "description": "irreversible choice"},
                {"beat_id": "after", "description": "quiet afterglow"},
            ],
            "screenplay_md": None,
        },
    )
    publish_shot_plan(project, _plan_v1())
    if approve:
        targets = {
            "concept_lock": "planning/brief_v1.json",
            "screenplay_lock": "planning/story_v1.json",
            "av_design_lock": "planning/prompts/p-main/v1.json",
        }
        if approve_production:
            targets["production_lock"] = "planning/shot_plan_v1.json"
        for stage, target in targets.items():
            transition_stage(project, stage, "review", at=AT, by="o")
            transition_stage(
                project, stage, "approve", at=AT, by="o", targets=(target,)
            )
    return project, catalog_dir


# --- envelope helpers ----------------------------------------------------------


def _draft_shot(**overrides) -> dict:
    shot = {
        "title": "开场",
        "description": "a calm sunrise over the sea",
        "duration_seconds": 10,
        "first_frame_image": None,
    }
    shot.update(overrides)
    return shot


def _params(**overrides) -> dict:
    params = {
        "plan_version": 1,
        "shots": [_draft_shot() for _ in range(6)],
    }
    params.update(overrides)
    return params


def _plan_digest(root: Path, version: int = 1) -> str:
    path = root / "planning" / f"shot_plan_v{version}.json"
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _target(root: Path, version: int = 1, digest: str | None = None) -> dict:
    return {
        "ref": f"planning/shot_plan_v{version}.json",
        "version": version,
        "content_digest": digest or _plan_digest(root, version),
    }


def _env(
    root: Path,
    *,
    command_id: str = "cmd-1",
    actor: str = "user",
    params=None,
    target=None,
) -> CommandEnvelope:
    return CommandEnvelope(
        command_id=command_id,
        name=LOCK_DRAFT_PLAN,
        actor=actor,
        params=_params() if params is None else params,
        occurred_at=T0,
        target=_target(root) if target is None else target,
    )


def _registry(catalog_dir: Path) -> CommandRegistry:
    registry = CommandRegistry()
    register_lock_draft_command(
        registry, catalog_dir=catalog_dir, account_root=None, clock=_clock
    )
    return registry


def _gateway(root: Path, catalog_dir: Path) -> CommandGateway:
    return CommandGateway(
        root,
        registry=_registry(catalog_dir),
        target_resolver=ShotPlanTargetResolver(),
        clock=_clock,
    )


def _preview(root: Path, catalog_dir: Path, envelope: CommandEnvelope):
    return _registry(catalog_dir).get(LOCK_DRAFT_PLAN).preview(root, envelope)


def _locked_receipt(root: Path, catalog_dir: Path, envelope: CommandEnvelope):
    gateway = _gateway(root, catalog_dir)
    preflight = gateway.preflight(envelope)
    assert preflight.preview.blockers == ()
    return gateway.submit(envelope, confirmation=preflight.preflight_digest)


# --- 1. draft param validation blockers ----------------------------------------


def test_preview_blocks_missing_params(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    envelope = _env(root, params={"plan_version": 1})
    preview = _preview(root, catalog_dir, envelope)
    assert any("missing param 'shots'" in b for b in preview.blockers)


def test_preview_blocks_bad_shot_entries(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    shots = [
        _draft_shot(title="x" * 81),
        _draft_shot(description="y" * 501),
        _draft_shot(duration_seconds=7),
        _draft_shot(first_frame_image="https://example.com/a.png"),
        _draft_shot(extra="nope", **{}),
        _draft_shot(),
    ]
    preview = _preview(root, catalog_dir, _env(root, params=_params(shots=shots)))
    blockers = "\n".join(preview.blockers)
    assert "shots[1].title: over 80 chars" in blockers
    assert "shots[2].description: over 500 chars" in blockers
    assert "shots[3].duration_seconds" in blockers
    assert "shots[4].first_frame_image: expected an image data URL" in blockers
    assert "shots[5]: unknown keys ['extra']" in blockers


def test_preview_blocks_oversize_first_frame(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    huge = "data:image/png;base64," + "A" * (8 * 1024 * 1024)
    shots = [_draft_shot(first_frame_image=huge)] + [_draft_shot() for _ in range(5)]
    preview = _preview(root, catalog_dir, _env(root, params=_params(shots=shots)))
    assert any("data URL too large" in b for b in preview.blockers)


def test_preview_blocks_too_many_shots(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    shots = [_draft_shot() for _ in range(21)]
    preview = _preview(root, catalog_dir, _env(root, params=_params(shots=shots)))
    assert any("at most 20 draft shots" in b for b in preview.blockers)


def test_preview_blocks_planning_contract(tmp_path: Path) -> None:
    # 3 shots passes the command envelope but violates the planning contract
    # (6-10 shots) — surfaced through the real parser, fail-closed.
    root, catalog_dir = _setup_project(tmp_path)
    shots = [_draft_shot() for _ in range(3)]
    preview = _preview(root, catalog_dir, _env(root, params=_params(shots=shots)))
    assert any("expected 6-10 shots" in b for b in preview.blockers)


def test_preview_blocks_total_duration(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    shots = [_draft_shot(duration_seconds=10) for _ in range(10)]  # 100s > 75s
    preview = _preview(root, catalog_dir, _env(root, params=_params(shots=shots)))
    assert any("total duration" in b for b in preview.blockers)


def test_preview_blocks_non_user_actor(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    preview = _preview(root, catalog_dir, _env(root, actor="ai"))
    assert any("actor must be 'user'" in b for b in preview.blockers)


def test_preview_blocks_missing_identity(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    (root / "project.json").unlink()
    preview = _preview(root, catalog_dir, _env(root))
    assert any("no project identity" in b for b in preview.blockers)


def test_preview_blocks_target_not_binding_plan(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    target = {
        "ref": "records/shots/shot-1.json",
        "version": 1,
        "content_digest": "a" * 64,
    }
    preview = _preview(root, catalog_dir, _env(root, target=target))
    assert any("target must bind the current shot plan" in b for b in preview.blockers)


def test_preview_blocks_stale_plan_version(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    params = _params(plan_version=2)
    target = {
        "ref": "planning/shot_plan_v2.json",
        "version": 2,
        "content_digest": "a" * 64,
    }
    preview = _preview(root, catalog_dir, _env(root, params=params, target=target))
    assert any("the current shot plan is v1" in b for b in preview.blockers)


def test_preview_blocks_unapproved_prerequisites(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path, approve=False)
    preview = _preview(root, catalog_dir, _env(root))
    assert any("NotApproved" in b for b in preview.blockers)


def test_preview_blocks_unpriceable_shot(tmp_path: Path) -> None:
    # remove the 6s clip price -> a 6s draft shot cannot be quoted/compiled.
    account = tmp_path
    root, catalog_dir = _setup_project(tmp_path)
    raw = _catalog_raw()
    raw["providers"]["prov"]["models"]["m1"]["clip_prices"] = [
        {"resolution": "512p", "duration_seconds": 10, "amount_minor_units": 15}
    ]
    (catalog_dir / "wfm1-test.json").write_text(json.dumps(raw), encoding="utf-8")
    (root / "config" / "wfm1.json").write_text(
        json.dumps(_config_dict(compute_catalog_digest(raw))), encoding="utf-8"
    )
    shots = [_draft_shot(duration_seconds=6) for _ in range(8)]
    preview = _preview(root, catalog_dir, _env(root, params=_params(shots=shots)))
    assert any("not producible under the locked catalog" in b for b in preview.blockers)
    assert account == tmp_path


def test_preview_blocks_existing_lock_files(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    shots_dir = root / "records" / "shots"
    shots_dir.mkdir(parents=True)
    (shots_dir / "shot-p2-1.json").write_text("{}", encoding="utf-8")
    preview = _preview(root, catalog_dir, _env(root))
    assert any("refusing to overwrite existing files" in b for b in preview.blockers)
    assert any("records/shots/shot-p2-1.json" in b for b in preview.blockers)


# --- 2. clean preview -----------------------------------------------------------


def test_preview_clean_draft(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    shots = [_draft_shot() for _ in range(5)] + [_draft_shot(first_frame_image=FRAME)]
    preview = _preview(root, catalog_dir, _env(root, params=_params(shots=shots)))
    assert preview.blockers == ()
    assert preview.estimated_cost is None  # locking never spends
    inputs = dict(preview.inputs)
    assert inputs["new_plan_version"] == 2
    assert inputs["publishes_brief"] is False
    rows = inputs["shots"]
    assert [r["shot_id"] for r in rows] == [f"shot-p2-{i}" for i in range(1, 7)]
    assert all(r["packet_version"] == 1 for r in rows)
    assert rows[0]["first_frame_sha256"] is None
    assert (
        rows[5]["first_frame_sha256"]
        == hashlib.sha256(FRAME.encode("utf-8")).hexdigest()
    )
    # the confirmation binds the full text the user reviewed
    assert rows[0]["title"] == "开场"
    assert rows[0]["description"] == "a calm sunrise over the sea"


def test_preflight_digest_is_stable(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    gateway = _gateway(root, catalog_dir)
    first = gateway.preflight(_env(root))
    second = gateway.preflight(_env(root))
    assert first.preflight_digest == second.preflight_digest
    assert first.is_high_risk is True


# --- 3. full gateway path -------------------------------------------------------


def test_lock_publishes_versioned_plan_and_packets(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    shots = [_draft_shot() for _ in range(5)] + [
        _draft_shot(title="终幕", description="full sunrise", first_frame_image=FRAME)
    ]
    envelope = _env(root, params=_params(shots=shots))
    receipt = _locked_receipt(root, catalog_dir, envelope)
    assert receipt.status is ReceiptStatus.COMPLETED
    outcome = receipt.outcome
    assert outcome["plan_version"] == 2
    assert outcome["production_lock"] == "re-approved"
    assert [s["shot_id"] for s in outcome["shots"]] == [
        f"shot-p2-{i}" for i in range(1, 7)
    ]
    assert all(s["packet_version"] == 1 for s in outcome["shots"])

    # versioned publishes — v1 untouched, v2 new
    plan_v1 = load_shot_plan(root, 1)
    assert plan_v1.shots[0].shot_id == "shot-1"
    plan_v2 = load_shot_plan(root, 2)
    assert [s.shot_id for s in plan_v2.shots] == [f"shot-p2-{i}" for i in range(1, 7)]
    # generation baseline inherited from the superseded plan
    assert plan_v2.shots[0].resolution == "512p"
    assert plan_v2.shots[0].model_id == "m1"
    assert plan_v2.shots[5].first_frame_image == FRAME
    assert plan_v2.shots[5].capability == "image_to_video"
    assert plan_v2.shots[0].capability == "text_to_video"

    # immutable records for the locked shots
    record = json.loads(
        (root / "records" / "shots" / "shot-p2-6.json").read_text(encoding="utf-8")
    )
    assert record["description"] == "终幕"
    assert record["prompt"] == "full sunrise"
    assert record["scene_id"] == "scene-p2"
    assert (root / "records" / "scenes" / "scene-p2.json").is_file()

    # production_lock re-approved onto the NEW plan file
    marker = load_approval(root, "production_lock")
    assert marker.status == "approved"
    assert [t.ref for t in marker.approved_targets] == ["planning/shot_plan_v2.json"]

    # packets exist, carry the draft prompt + first frame
    packet = load_packet(root, "shot-p2-6", 1)
    assert packet.prompt_text == "full sunrise"
    assert packet.first_frame_image == FRAME
    assert packet.capability == "image_to_video"
    packet_plain = load_packet(root, "shot-p2-1", 1)
    assert packet_plain.first_frame_image is None


def test_lock_requires_confirmation(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    gateway = _gateway(root, catalog_dir)
    with pytest.raises(ConfirmationRequiredError):
        gateway.submit(_env(root))
    with pytest.raises(ConfirmationStaleError):
        gateway.submit(_env(root), confirmation="not-the-digest")
    # a refused submit wrote nothing
    assert not (root / "planning" / "shot_plan_v2.json").exists()


def test_lock_target_digest_drift_fails_closed(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    gateway = _gateway(root, catalog_dir)
    envelope = _env(root, target=_target(root, digest="b" * 64))
    with pytest.raises(TargetBindingError):
        gateway.preflight(envelope)


def test_lock_command_id_idempotent_and_conflicting(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    envelope = _env(root)
    receipt = _locked_receipt(root, catalog_dir, envelope)
    gateway = _gateway(root, catalog_dir)
    # same command_id + same request -> the SAME receipt, no re-execution
    again = gateway.submit(_env(root))
    assert again.status is ReceiptStatus.COMPLETED
    assert again.request_digest == receipt.request_digest
    assert not (root / "planning" / "shot_plan_v3.json").exists()
    # same command_id + different request -> fail-closed conflict
    other = _params(shots=[_draft_shot(title="改") for _ in range(6)])
    with pytest.raises(CommandIdConflictError):
        gateway.submit(_env(root, params=other))


def test_concurrent_lock_goes_stale(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    gateway = _gateway(root, catalog_dir)
    preflight = gateway.preflight(_env(root))
    # another session locks first: plan v2 appears
    _locked_receipt(root, catalog_dir, _env(root, command_id="cmd-other"))
    # this session's confirmed submit is refused (stale plan_version blocker)
    with pytest.raises(BlockedCommandError):
        gateway.submit(
            _env(root, command_id="cmd-late"),
            confirmation=preflight.preflight_digest,
        )


def test_lock_reapproves_from_rejected_production_lock(tmp_path: Path) -> None:
    # rejected -> revise -> approve is the legal walk the lock performs
    root, catalog_dir = _setup_project(tmp_path)
    transition_stage(root, "production_lock", "reject", at=AT, by="o", reason="redo")
    receipt = _locked_receipt(root, catalog_dir, _env(root))
    assert receipt.status is ReceiptStatus.COMPLETED
    marker = load_approval(root, "production_lock")
    assert marker.status == "approved"
    assert [t.ref for t in marker.approved_targets] == ["planning/shot_plan_v2.json"]


def test_lock_reapproves_from_review_needed_production_lock(tmp_path: Path) -> None:
    # review_needed approves directly (no reject/revise detour)
    root, catalog_dir = _setup_project(tmp_path, approve_production=False)
    transition_stage(root, "production_lock", "review", at=AT, by="o")
    receipt = _locked_receipt(root, catalog_dir, _env(root))
    assert receipt.status is ReceiptStatus.COMPLETED
    marker = load_approval(root, "production_lock")
    assert marker.status == "approved"
    assert [t.ref for t in marker.approved_targets] == ["planning/shot_plan_v2.json"]


def test_lock_reapproves_from_unapproved_production_lock(tmp_path: Path) -> None:
    # prerequisites approved but production_lock never approved: the lock is
    # itself the approving human Gate (preview -> confirmation).
    root, catalog_dir = _setup_project(tmp_path, approve_production=False)
    receipt = _locked_receipt(root, catalog_dir, _env(root))
    assert receipt.status is ReceiptStatus.COMPLETED
    marker = load_approval(root, "production_lock")
    assert marker.status == "approved"
    assert [t.ref for t in marker.approved_targets] == ["planning/shot_plan_v2.json"]


def test_lock_publishes_optional_brief_and_story(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    params = _params(
        brief={
            "logline": "a new logline from the canvas",
            "primary_load": "唯美",
            "secondary_load": None,
            "synopsis": "a new synopsis",
        },
        story={
            "beats": [{"beat_id": "b1", "description": "one beat"}],
            "screenplay_md": None,
        },
    )
    receipt = _locked_receipt(root, catalog_dir, _env(root, params=params))
    assert receipt.status is ReceiptStatus.COMPLETED
    brief = json.loads(
        (root / "planning" / "brief_v2.json").read_text(encoding="utf-8")
    )
    assert brief["version"] == 2
    assert brief["logline"] == "a new logline from the canvas"
    story = json.loads(
        (root / "planning" / "story_v2.json").read_text(encoding="utf-8")
    )
    assert story["beats"] == [{"beat_id": "b1", "description": "one beat"}]


def test_second_lock_supersedes_the_first(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    _locked_receipt(root, catalog_dir, _env(root))
    shots = [_draft_shot(title="第二轮") for _ in range(6)]
    envelope = _env(
        root,
        command_id="cmd-2",
        params=_params(plan_version=2, shots=shots),
        target=_target(root, version=2),
    )
    receipt = _locked_receipt(root, catalog_dir, envelope)
    assert receipt.outcome["plan_version"] == 3
    assert [s["shot_id"] for s in receipt.outcome["shots"]] == [
        f"shot-p3-{i}" for i in range(1, 7)
    ]
    marker = load_approval(root, "production_lock")
    assert [t.ref for t in marker.approved_targets] == ["planning/shot_plan_v3.json"]
    # nothing from the first lock was deleted
    assert (root / "planning" / "shot_plan_v2.json").is_file()
    assert (root / "planning" / "packets" / "shot-p2-1_v1.json").is_file()


# --- 4. target resolver ---------------------------------------------------------


def test_resolver_binds_only_the_canonical_plan_ref(tmp_path: Path) -> None:
    root, _ = _setup_project(tmp_path)
    resolver = ShotPlanTargetResolver()
    good = resolver.resolve_target(root, ref="planning/shot_plan_v1.json", version=1)
    assert good.exists and good.content_digest == _plan_digest(root, 1)
    assert not resolver.resolve_target(
        root, ref="planning/shot_plan_v1.json", version=2
    ).exists
    assert not resolver.resolve_target(
        root, ref="planning/shot_plan_v2.json", version=2
    ).exists
    assert not resolver.resolve_target(
        root, ref="records/shots/shot-1.json", version=1
    ).exists
    assert not resolver.resolve_target(
        root, ref="../planning/shot_plan_v1.json", version=1
    ).exists


# --- 5. registration posture ----------------------------------------------------


def test_default_registry_never_contains_lock_command() -> None:
    registry = build_wfm1_registry()
    assert LOCK_DRAFT_PLAN not in registry.names()
    with pytest.raises(UnregisteredCommandError):
        registry.get(LOCK_DRAFT_PLAN)


def test_registering_twice_is_refused(tmp_path: Path) -> None:
    registry = _registry(tmp_path)
    with pytest.raises(Exception, match="already registered"):
        register_lock_draft_command(registry, catalog_dir=tmp_path, clock=_clock)
