"""Paid video generation Gateway command tests (ADR-0041 / TASK-041).

STRICTLY OFFLINE: no real network, no MiniMax, no payment. The paid command
is exercised through the Command Gateway with a FAKE provider (registered in
a fresh ProviderRegistry) and a FAKE media fetcher, so ``submit_paid`` runs
its full coordination chain against fakes only.

The command is PACKET-ONLY: every path stages a project all the way to a fresh
``production_lock`` with a compiled task packet (the staging pattern from
tests/test_planning.py), then drives generation from that verified packet.

Covers: preview fail-closed blockers (params / stage / actor / identity /
target-shot binding / unauthorized paid provider), a clean preview quote, the
full high-risk Gateway path (preflight -> confirm -> submit -> COMPLETED
receipt + booked cost fact), command_id idempotency and conflict, high-risk
confirmation enforcement, version-binding drift, target-shot cross binding,
MiniMax-only paid scope, and the authorization gate (the default no-spend
registry never contains this command).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.app.gateway_commands import build_wfm1_registry
from ai_video_workflow.app.paid_gateway import (
    ENABLE_PAID_COMMANDS_ENV,
    SUBMIT_VIDEO_GENERATION,
    PaidCommandNotAuthorizedError,
    register_paid_video_command,
)
from ai_video_workflow.approval import transition_stage
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.config.catalog_lock import load_locked_catalog
from ai_video_workflow.config.project_config import load_project_config
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.gateway import (
    BlockedCommandError,
    CommandEnvelope,
    CommandGateway,
    CommandIdConflictError,
    CommandRegistry,
    ConfirmationRequiredError,
    ConfirmationStaleError,
    ReceiptStatus,
    ResolvedTarget,
    TargetBindingError,
    UnregisteredCommandError,
    read_receipts,
)
from ai_video_workflow.models import (
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
)
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.planning import (
    compile_task_packets,
    publish_brief,
    publish_prompt,
    publish_shot_plan,
    publish_story,
)
from ai_video_workflow.profile import add_reuse_ref, parse_pack, publish_pack_version
from ai_video_workflow.providers.registry import ProviderRegistry
from ai_video_workflow.qcd.events import QcdEventType
from ai_video_workflow.qcd.log import read_events
from tests.paid_fakes import FakeFetcher, FakeProvider

AT = "2026-08-02T00:00:00+00:00"
T0 = datetime(2026, 8, 2, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64


def _clock() -> datetime:
    return T0


@pytest.fixture(autouse=True)
def _enable_paid_commands(monkeypatch):
    # Deployment opt-in required to REGISTER the paid command; set for every
    # test so the happy paths register (still with fake providers). Real
    # transport stays gated by AI_VIDEO_WORKFLOW_REAL_MINIMAX, which is UNSET.
    monkeypatch.setenv(ENABLE_PAID_COMMANDS_ENV, "1")


# --- planning fixtures (mirrors tests/test_planning.py) ----------------------


def _provider_entry() -> dict:
    return {
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
                        "duration_seconds": 10,
                        "amount_minor_units": 10,
                    }
                ],
                "per_second_minor_units": {},
            }
        },
    }


def _catalog_raw(provider_id: str, *, extra_providers: tuple[str, ...] = ()) -> dict:
    providers = {provider_id: _provider_entry()}
    for extra in extra_providers:
        providers[extra] = _provider_entry()
    return {
        "schema_version": 1,
        "catalog_id": "wfm1-test",
        "version": 1,
        "providers": providers,
    }


def _config_dict(
    provider_id: str,
    digest: str,
    *,
    fallback_provider: str | None = None,
    budgets: dict | None = None,
) -> dict:
    return {
        "schema_version": 2,
        "default_provider": provider_id,
        "fallback_provider": fallback_provider,
        "shot_overrides": {},
        "budgets_jpy": budgets
        or {
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


def _prompt() -> dict:
    return {
        "schema_version": 1,
        "prompt_id": "p-main",
        "version": 1,
        "text": "a cinematic shot v1",
        "previous_version": None,
        "change_reason": None,
        "reference_assets": ["character-mia"],
    }


def _plan_dict(n_shots: int = 6, seconds_each: int = 10) -> dict:
    return {
        "schema_version": 1,
        "version": 1,
        "shots": [
            {
                "shot_id": f"shot-{i}",
                "sequence": i,
                "prompt_ref": {"prompt_id": "p-main", "version": 1},
                "duration_seconds": seconds_each,
                "resolution": "512p",
                "capability": "text_to_video",
                "model_id": "m1",
                "width": 512,
                "height": 512,
                "frame_rate": 24.0,
                "reuse_assets": ["character-mia"],
                "first_frame_image": None,
            }
            for i in range(1, n_shots + 1)
        ],
    }


def _pack_dict() -> dict:
    return {
        "schema_version": 1,
        "asset_id": "character-mia",
        "version": 1,
        "kind": "character",
        "content": {"name": "Mia", "look": "grey coat"},
    }


def _write_records(project: Path) -> None:
    write_model_json(
        project / "project.json",
        Project(project_id="proj-a", name="T", created_at=T0),
    )
    (project / "records" / "scenes").mkdir(parents=True)
    (project / "records" / "shots").mkdir(parents=True)
    write_model_json(
        project / "records" / "scenes" / "scene-1.json",
        Scene(
            scene_id="scene-1",
            project_id="proj-a",
            sequence=1,
            title="S",
            description="d",
            created_at=T0,
        ),
    )
    write_model_json(
        project / "records" / "shots" / "shot-1.json",
        Shot(
            shot_id="shot-1",
            scene_id="scene-1",
            sequence=1,
            description="d",
            prompt="a shot",
            duration_seconds=10.0,
            width=512,
            height=512,
            frame_rate=24.0,
            created_at=T0,
        ),
    )


def _setup_packet_project(
    tmp_path: Path,
    *,
    provider_id: str = "minimax",
    approve: bool = True,
    fallback_provider: str | None = None,
    budgets: dict | None = None,
) -> tuple[Path, Path]:
    """Stage a project to production_lock with a compiled shot-1 packet."""
    account = tmp_path
    project = account / "project-a"
    project.mkdir()

    catalog_dir = account / "catalog"
    catalog_dir.mkdir()
    extra = (fallback_provider,) if fallback_provider is not None else ()
    raw = _catalog_raw(provider_id, extra_providers=extra)
    (catalog_dir / "wfm1-test.json").write_text(json.dumps(raw), encoding="utf-8")
    digest = compute_catalog_digest(raw)
    (project / "config").mkdir()
    (project / "config" / "wfm1.json").write_text(
        json.dumps(
            _config_dict(
                provider_id,
                digest,
                fallback_provider=fallback_provider,
                budgets=budgets,
            )
        ),
        encoding="utf-8",
    )

    publish_pack_version(account, parse_pack(_pack_dict()))
    add_reuse_ref(project, account, "character-mia", 1)
    publish_prompt(project, _prompt())
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
    publish_shot_plan(project, _plan_dict())
    if approve:
        targets = {
            "concept_lock": "planning/brief_v1.json",
            "screenplay_lock": "planning/story_v1.json",
            "av_design_lock": "planning/prompts/p-main/v1.json",
            "production_lock": "planning/shot_plan_v1.json",
        }
        for stage, target in targets.items():
            transition_stage(project, stage, "review", at=AT, by="o")
            transition_stage(
                project, stage, "approve", at=AT, by="o", targets=(target,)
            )
        config = load_project_config(project)
        catalog = load_locked_catalog(config, catalog_dir)
        compile_task_packets(project, account, catalog, config)

    _write_records(project)
    return project, catalog_dir


# --- gateway wiring helpers --------------------------------------------------


class _FakeResolver:
    """Resolves the command target to a controlled authoritative digest."""

    def __init__(self, targets: dict | None = None) -> None:
        self._targets = (
            targets
            if targets is not None
            else {("shot-1", 1): _DIGEST, ("shot-2", 1): _DIGEST}
        )

    def resolve_target(self, project_root, *, ref, version) -> ResolvedTarget:
        digest = self._targets.get((ref, version))
        if digest is None:
            return ResolvedTarget(exists=False, content_digest=None)
        return ResolvedTarget(exists=True, content_digest=digest)


def _provider_registry_factory(provider: FakeProvider):
    def _factory() -> ProviderRegistry:
        registry = ProviderRegistry()
        registry.register(provider.provider_id, lambda entry: provider)
        return registry

    return _factory


def _register_paid(
    registry: CommandRegistry,
    catalog_dir: Path,
    *,
    provider_id: str = "minimax",
) -> None:
    register_paid_video_command(
        registry,
        provider_registry=_provider_registry_factory(
            FakeProvider(provider_id=provider_id)
        ),
        fetcher=FakeFetcher,
        catalog_dir=catalog_dir,
        authorized=True,  # tests explicitly opt into the paid command
        account_root=None,  # -> project_root.parent (the account root)
        clock=_clock,
    )


def _target(ref: str = "shot-1", version: int = 1, digest: str = _DIGEST) -> dict:
    return {"ref": ref, "version": version, "content_digest": digest}


def _params(**overrides) -> dict:
    params = {
        "task_id": "task-shot-1-1",  # canonical bootstrap id for shot-1
        "shot_id": "shot-1",
        "operation_id": "op-1",
        "packet_version": 1,
    }
    params.update(overrides)
    return params


def _env(
    *, command_id: str = "cmd-1", actor: str = "user", params=None, target=None
) -> CommandEnvelope:
    return CommandEnvelope(
        command_id=command_id,
        name=SUBMIT_VIDEO_GENERATION,
        actor=actor,
        params=_params() if params is None else params,
        occurred_at=T0,
        target=_target() if target is None else target,
    )


def _gateway(
    root: Path,
    catalog_dir: Path,
    *,
    resolver=None,
    provider_id: str = "minimax",
) -> CommandGateway:
    registry = CommandRegistry()
    _register_paid(registry, catalog_dir, provider_id=provider_id)
    return CommandGateway(
        root,
        registry=registry,
        target_resolver=resolver or _FakeResolver(),
        clock=_clock,
    )


def _preview(
    root: Path,
    catalog_dir: Path,
    envelope: CommandEnvelope,
    *,
    provider_id: str = "minimax",
):
    registry = CommandRegistry()
    _register_paid(registry, catalog_dir, provider_id=provider_id)
    return registry.get(SUBMIT_VIDEO_GENERATION).preview(root, envelope)


def _apply(
    root: Path,
    catalog_dir: Path,
    envelope: CommandEnvelope,
    *,
    provider_id: str = "minimax",
):
    registry = CommandRegistry()
    _register_paid(registry, catalog_dir, provider_id=provider_id)
    return registry.get(SUBMIT_VIDEO_GENERATION).apply(root, envelope)


# --- 1. preview fail-closed blockers -----------------------------------------


def test_preview_blocks_missing_params(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    params = _params()
    del params["packet_version"]
    preview = _preview(root, catalog_dir, _env(params=params))
    assert any("missing param 'packet_version'" in b for b in preview.blockers)


def test_preview_blocks_unapproved_production_lock(tmp_path: Path) -> None:
    # no approval chain -> require_stage_ready(production_lock) fails closed.
    root, catalog_dir = _setup_packet_project(tmp_path, approve=False)
    preview = _preview(root, catalog_dir, _env())
    assert preview.estimated_cost is None
    assert any("NotApproved" in b for b in preview.blockers)


def test_preview_blocks_non_user_actor(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    preview = _preview(root, catalog_dir, _env(actor="ai"))
    assert any("actor must be 'user'" in b for b in preview.blockers)


def test_preview_blocks_missing_project_identity(tmp_path: Path) -> None:
    _root, catalog_dir = _setup_packet_project(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()
    preview = _preview(empty, catalog_dir, _env())
    assert any("no project identity" in b for b in preview.blockers)


def test_preview_blocks_target_not_binding_shot(tmp_path: Path) -> None:
    # target names shot-2 but params.shot_id is shot-1 -> fail-closed.
    root, catalog_dir = _setup_packet_project(tmp_path)
    preview = _preview(root, catalog_dir, _env(target=_target(ref="shot-2")))
    assert any("target must bind the same shot" in b for b in preview.blockers)


def test_preview_blocks_unauthorized_paid_provider(tmp_path: Path) -> None:
    # resolved provider is 'sora', default authorization is MiniMax only.
    root, catalog_dir = _setup_packet_project(tmp_path, provider_id="sora")
    preview = _preview(root, catalog_dir, _env(), provider_id="sora")
    assert any("not authorized for paid video" in b for b in preview.blockers)


# --- 2. preview happy --------------------------------------------------------


def test_preview_clean_reports_estimate_and_inputs(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    preview = _preview(root, catalog_dir, _env())
    assert preview.blockers == ()
    assert preview.estimated_cost is not None
    assert preview.estimated_cost["jpy"] == 16  # 10 USD-minor * 160 / 100
    assert preview.estimated_cost["original_amount_minor_units"] == 10
    assert preview.estimated_cost["original_currency"] == "USD"
    assert preview.inputs["model"] == "m1"
    assert preview.inputs["resolution"] == "512p"
    assert preview.inputs["duration"] == 10


# --- 3. full Gateway path ----------------------------------------------------


def test_full_gateway_path_runs_coordinator(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    envelope = _env()

    preflight = gw.preflight(envelope)
    assert preflight.is_high_risk is True
    assert isinstance(preflight.preflight_digest, str)
    assert len(preflight.preflight_digest) == 64

    receipt = gw.submit(envelope, confirmation=preflight.preflight_digest)
    assert receipt.status is ReceiptStatus.COMPLETED
    assert receipt.outcome["kind"] == "success"
    assert receipt.outcome["provider_id"] == "minimax"

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost_events) == 1  # the coordinator actually ran and booked cost


# --- 4. idempotency + conflict -----------------------------------------------


def test_same_command_id_and_request_is_idempotent(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    envelope = _env()
    confirmation = gw.preflight(envelope).preflight_digest

    first = gw.submit(envelope, confirmation=confirmation)
    second = gw.submit(envelope, confirmation=confirmation)

    assert second.request_digest == first.request_digest
    assert second.occurred_at == first.occurred_at  # same persisted receipt
    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost_events) == 1  # not re-executed / not double-paid


def test_same_command_id_different_request_conflicts(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    envelope = _env()
    gw.submit(envelope, confirmation=gw.preflight(envelope).preflight_digest)

    drifted = _env(params=_params(packet_version=2))
    with pytest.raises(CommandIdConflictError):
        gw.submit(drifted, confirmation="0" * 64)


# --- 5. high-risk confirmation -----------------------------------------------


def test_high_risk_requires_confirmation(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    with pytest.raises(ConfirmationRequiredError):
        gw.submit(_env(command_id="cmd-noconf"))


def test_high_risk_rejects_stale_confirmation(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    with pytest.raises(ConfirmationStaleError):
        gw.submit(_env(command_id="cmd-stale"), confirmation=_DIGEST2)


# --- 6. version binding (fail-closed) ----------------------------------------


def test_drifted_target_is_refused(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    # resolver reports a DIFFERENT authoritative digest than the envelope binds.
    resolver = _FakeResolver(targets={("shot-1", 1): _DIGEST2})
    gw = _gateway(root, catalog_dir, resolver=resolver)
    with pytest.raises(TargetBindingError):
        gw.submit(_env(command_id="cmd-drift"), confirmation=_DIGEST)


def test_target_bound_to_other_shot_is_refused(tmp_path: Path) -> None:
    # a valid, resolvable target for shot-2 must never drive shot-1 generation.
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    mismatch = _env(command_id="cmd-mismatch", target=_target(ref="shot-2"))

    with pytest.raises(BlockedCommandError):
        gw.submit(mismatch, confirmation=gw.preflight(mismatch).preflight_digest)

    # defense in depth: apply itself refuses even if reached directly.
    with pytest.raises(AiVideoWorkflowError):
        _apply(root, catalog_dir, mismatch)

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []  # coordinator never ran


# --- 6b. task <-> shot provenance binding ------------------------------------


def test_foreign_task_id_is_refused(tmp_path: Path) -> None:
    # 'task-shot-2-1' is shot-2's canonical id; submitting it for shot-1's
    # approved packet is a cross-shot provenance violation.
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    foreign = _env(command_id="cmd-foreign", params=_params(task_id="task-shot-2-1"))

    with pytest.raises(BlockedCommandError):
        gw.submit(foreign, confirmation=gw.preflight(foreign).preflight_digest)

    # defense in depth: apply itself refuses even if reached directly.
    with pytest.raises(AiVideoWorkflowError):
        _apply(root, catalog_dir, foreign)

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []  # coordinator never ran


def test_noncanonical_task_suffix_is_refused(tmp_path: Path) -> None:
    # Prefix-only validation would admit an arbitrary suffix like
    # 'task-shot-1-attacker'; the suffix must be the canonical positive-integer
    # redo counter, so a non-numeric fresh id is refused (no unrecorded task id
    # can slip past the per-task reservation guard).
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    bad = _env(command_id="cmd-bad", params=_params(task_id="task-shot-1-attacker"))

    with pytest.raises(BlockedCommandError):
        gw.submit(bad, confirmation=gw.preflight(bad).preflight_digest)
    with pytest.raises(AiVideoWorkflowError):
        _apply(root, catalog_dir, bad)

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []  # coordinator never ran


def _write_generation_task(root: Path, task_id: str, shot_id: str) -> None:
    # A recorded core fact, as app/bootstrap.py create_redo_task would persist.
    (root / "records" / "generation-tasks").mkdir(parents=True, exist_ok=True)
    write_model_json(
        root / "records" / "generation-tasks" / f"{task_id}.json",
        GenerationTask(
            task_id=task_id,
            shot_id=shot_id,
            status=GenerationTaskStatus.PENDING,
            created_at=T0,
            updated_at=T0,
        ),
    )


def test_canonical_but_unrecorded_redo_id_is_refused(tmp_path: Path) -> None:
    # 'task-shot-1-2' LOOKS canonical but no GenerationTask record exists for
    # it (no create_redo_task ran) -> the UI cannot mint fresh task ids.
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)
    minted = _env(command_id="cmd-minted", params=_params(task_id="task-shot-1-2"))

    with pytest.raises(BlockedCommandError):
        gw.submit(minted, confirmation=gw.preflight(minted).preflight_digest)

    # defense in depth: apply itself refuses even if reached directly.
    with pytest.raises(AiVideoWorkflowError):
        _apply(root, catalog_dir, minted)

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []  # coordinator never ran


def test_recorded_redo_task_id_passes_binding(tmp_path: Path) -> None:
    # once the core has persisted the GenerationTask record for shot-1 (as
    # create_redo_task does), the same id passes the task<->shot binding.
    root, catalog_dir = _setup_packet_project(tmp_path)
    _write_generation_task(root, "task-shot-1-2", "shot-1")

    recorded = _env(command_id="cmd-recorded", params=_params(task_id="task-shot-1-2"))
    preview = _preview(root, catalog_dir, recorded)
    assert not any("task_id" in b for b in preview.blockers)
    assert preview.blockers == ()  # no other guard trips in this fixture


# --- 7. MiniMax-only paid scope ----------------------------------------------


def test_unauthorized_provider_refused_end_to_end(tmp_path: Path) -> None:
    # a project whose resolved provider is not MiniMax cannot incur spend.
    root, catalog_dir = _setup_packet_project(tmp_path, provider_id="sora")
    gw = _gateway(root, catalog_dir, provider_id="sora")
    envelope = _env()

    with pytest.raises(BlockedCommandError):
        gw.submit(envelope, confirmation=gw.preflight(envelope).preflight_digest)

    # defense in depth: apply itself refuses the unauthorized provider.
    with pytest.raises(AiVideoWorkflowError):
        _apply(root, catalog_dir, envelope, provider_id="sora")

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []  # coordinator never ran


def test_unauthorized_fallback_provider_refused(tmp_path: Path) -> None:
    # primary 'minimax' is authorized, but the coordinator can fall back to
    # 'sora' after a technical failure -> an unauthorized fallback could spend.
    root, catalog_dir = _setup_packet_project(
        tmp_path, provider_id="minimax", fallback_provider="sora"
    )
    gw = _gateway(root, catalog_dir)  # authorized == ("minimax",)
    envelope = _env()

    preview = _preview(root, catalog_dir, envelope)
    assert any("fallback provider 'sora'" in b for b in preview.blockers)

    with pytest.raises(BlockedCommandError):
        gw.submit(envelope, confirmation=gw.preflight(envelope).preflight_digest)

    # defense in depth: apply itself refuses the unauthorized fallback.
    with pytest.raises(AiVideoWorkflowError):
        _apply(root, catalog_dir, envelope)

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []  # coordinator never ran


# --- 7c. fail-closed budget admission (ADR-0033 P7) --------------------------


def test_over_budget_request_refused_before_wal(tmp_path: Path) -> None:
    # per-shot cap below the 16 JPY quote -> the read-only budget preflight
    # denies at preview, so the Gateway refuses before any confirmation/WAL.
    tiny_budgets = {
        "episode_soft": 1200,
        "episode_hard": 1500,
        "monthly_hard": 5000,
        "per_shot": 10,  # 0 spent + 16 estimate > 10 -> shot-scope deny
    }
    root, catalog_dir = _setup_packet_project(tmp_path, budgets=tiny_budgets)
    gw = _gateway(root, catalog_dir)
    envelope = _env()

    preview = _preview(root, catalog_dir, envelope)
    assert preview.estimated_cost is not None  # quote still reported
    assert preview.estimated_cost["jpy"] == 16
    assert any("budget denied" in b for b in preview.blockers)

    with pytest.raises(BlockedCommandError):
        gw.submit(envelope, confirmation=gw.preflight(envelope).preflight_digest)

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []  # coordinator never ran
    assert read_receipts(root) == ()  # no ATTEMPTING/receipt was written


# --- 7b. task-level operation guard (no re-pay via fresh ids) ----------------


def test_task_with_existing_reservation_is_refused(tmp_path: Path) -> None:
    # After a first successful paid run, the task carries a persisted
    # reservation; a fresh command_id + operation_id for the SAME task must
    # not re-pay it (mirrors the coordinator's task-level operation guard).
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = _gateway(root, catalog_dir)

    first = _env(command_id="cmd-first")
    receipt = gw.submit(first, confirmation=gw.preflight(first).preflight_digest)
    assert receipt.status is ReceiptStatus.COMPLETED

    # a double-pay attempt: new command id + new operation id, same task/packet
    replay = _env(command_id="cmd-replay", params=_params(operation_id="op-2"))
    with pytest.raises(BlockedCommandError):
        gw.submit(replay, confirmation=gw.preflight(replay).preflight_digest)

    # defense in depth: apply itself refuses even if reached directly.
    with pytest.raises(AiVideoWorkflowError):
        _apply(root, catalog_dir, replay)

    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost_events) == 1  # the task was booked exactly once


# --- 8. authorization gate ---------------------------------------------------


def test_registration_without_authorization_is_refused(tmp_path: Path) -> None:
    _root, catalog_dir = _setup_packet_project(tmp_path)
    registry = CommandRegistry()
    with pytest.raises(PaidCommandNotAuthorizedError):
        register_paid_video_command(
            registry,
            provider_registry=_provider_registry_factory(
                FakeProvider(provider_id="minimax")
            ),
            fetcher=FakeFetcher,
            catalog_dir=catalog_dir,
            # authorized defaults to False -> fail-closed, nothing registered
        )
    assert SUBMIT_VIDEO_GENERATION not in registry.names()


def test_registration_without_env_flag_is_refused(tmp_path: Path, monkeypatch) -> None:
    # in-code authorized=True is not enough: the deployment opt-in must be set.
    monkeypatch.delenv(ENABLE_PAID_COMMANDS_ENV, raising=False)
    _root, catalog_dir = _setup_packet_project(tmp_path)
    registry = CommandRegistry()
    with pytest.raises(PaidCommandNotAuthorizedError):
        register_paid_video_command(
            registry,
            provider_registry=_provider_registry_factory(
                FakeProvider(provider_id="minimax")
            ),
            fetcher=FakeFetcher,
            catalog_dir=catalog_dir,
            authorized=True,  # authorized in code, but env flag is unset
        )
    assert SUBMIT_VIDEO_GENERATION not in registry.names()


def test_default_registry_excludes_paid_command() -> None:
    assert SUBMIT_VIDEO_GENERATION not in build_wfm1_registry().names()


def test_unregistered_paid_command_is_refused(tmp_path: Path) -> None:
    root, catalog_dir = _setup_packet_project(tmp_path)
    gw = CommandGateway(
        root,
        registry=build_wfm1_registry(),  # default no-spend registry
        target_resolver=_FakeResolver(),
        clock=_clock,
    )
    with pytest.raises(UnregisteredCommandError):
        gw.preflight(_env())


# --- 9. shot-record target resolver -------------------------------------------


def test_shot_record_resolver_binds_real_record_bytes(tmp_path: Path) -> None:
    # End-to-end with the REAL resolver: the target digest is the sha256 of the
    # authoritative shot record file, so the exact previewed bytes are bound.
    import hashlib

    from ai_video_workflow.app.paid_gateway import ShotRecordTargetResolver

    root, catalog_dir = _setup_packet_project(tmp_path)
    record = root / "records" / "shots" / "shot-1.json"
    digest = hashlib.sha256(record.read_bytes()).hexdigest()
    resolver = ShotRecordTargetResolver()

    resolved = resolver.resolve_target(root, ref="shot-1", version=1)
    assert resolved.exists and resolved.content_digest == digest
    # record-path form of the ref binds identically
    path_form = resolver.resolve_target(
        root, ref="records/shots/shot-1.json", version=1
    )
    assert path_form.exists and path_form.content_digest == digest

    registry = CommandRegistry()
    _register_paid(registry, catalog_dir)
    gw = CommandGateway(
        root,
        registry=registry,
        target_resolver=resolver,
        clock=_clock,
    )
    env = _env(target=_target(digest=digest))
    receipt = gw.submit(env, confirmation=gw.preflight(env).preflight_digest)
    assert receipt.status is ReceiptStatus.COMPLETED

    # a drifted record (any byte change) fails closed at the gateway
    record.write_text(record.read_text() + "\n", encoding="utf-8")
    stale = _env(command_id="cmd-stale", params=_params(operation_id="op-9"))
    stale = CommandEnvelope(
        command_id=stale.command_id,
        name=stale.name,
        actor=stale.actor,
        params=stale.params,
        occurred_at=stale.occurred_at,
        target=_target(digest=digest),  # digest of the OLD bytes
    )
    with pytest.raises(TargetBindingError):
        gw.preflight(stale)


def test_shot_record_resolver_fails_closed(tmp_path: Path) -> None:
    from ai_video_workflow.app.paid_gateway import ShotRecordTargetResolver

    root, _ = _setup_packet_project(tmp_path)
    resolver = ShotRecordTargetResolver()
    # non-1 version, missing record, traversal, empty ref -> absent
    assert not resolver.resolve_target(root, ref="shot-1", version=2).exists
    assert not resolver.resolve_target(root, ref="shot-9", version=1).exists
    assert not resolver.resolve_target(root, ref="../shot-1", version=1).exists
    assert not resolver.resolve_target(root, ref="", version=1).exists
