"""Paid video generation Gateway command (ADR-0041 / TASK-041).

Registers the FIRST high-risk, real-spend Command Gateway command:
``submit-video-generation``. Its ``apply`` wraps the already-approved
application entry ``PaidGenerationCoordinator.submit_paid`` — it writes no
business files and never touches a Provider directly (ADR-0033 P1/P2). Its
``preview`` runs the read-only prerequisites (identity, actor, params,
target-shot binding, paid-provider authorization, catalog lock, packet /
production_lock freshness, budget quote) as fail-closed blockers and reports
the locked-catalog price as ``estimated_cost`` (ADR-0033 P4).

PACKET-ONLY: the command accepts exactly ``task_id / shot_id / operation_id /
packet_version`` and always derives the request from a re-verified task packet
(``production_lock`` + verified packet). It never accepts free-form
model/resolution/duration/stage — those would turn unapproved or stale
parameters into paid work (ADR-0041 "默认 packet 流；不接受自由参数改动已锁定方案").

This command is NOT in the default no-spend registry
(``build_wfm1_registry``): it is admitted ONLY through the explicit,
authorized-only ``register_paid_video_command`` builder, preserving the
ADR-0033 "no real write command by default" posture (ADR-0041 §Security 6).

Paid scope is VIDEO ONLY and MiniMax-only (``authorized_paid_providers``),
routed through the provider-neutral coordinator; real spend is gated
elsewhere by an explicit credential + flag (ADR-0006 / ADR-0009; image/audio
paid is out of scope per ADR-0038). Offline/fake transport is the test and
default posture — this module never forces a real call.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.app.bootstrap import initial_task_id
from ai_video_workflow.app.clock import utc_now
from ai_video_workflow.app.paid_coordinator import PaidGenerationCoordinator
from ai_video_workflow.approval import require_stage_ready
from ai_video_workflow.budget.account import (
    account_outstanding_holds,
    read_account_month_spent,
)
from ai_video_workflow.budget.estimate import estimate_generation_cost
from ai_video_workflow.budget.guard import evaluate_pre_flight
from ai_video_workflow.budget.ledger import month_key_jst, read_ledger
from ai_video_workflow.budget.reservation import (
    list_reservations,
    outstanding_holds,
    shot_consecutive_failures,
)
from ai_video_workflow.config.catalog_lock import load_locked_catalog
from ai_video_workflow.config.project_config import load_project_config
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.gateway.commands import (
    CommandEnvelope,
    CommandRegistry,
    CommandRisk,
    CommandSpec,
    Preview,
)
from ai_video_workflow.planning import (
    load_packet,
    packet_to_paid_request,
    verify_packet,
)
from ai_video_workflow.project_data import load_project_data, owning_project_id
from ai_video_workflow.providers.registry import ProviderRegistry
from ai_video_workflow.security import resolve_within_root

SUBMIT_VIDEO_GENERATION = "submit-video-generation"

# The paid providers this command is authorized to drive — a HARD-CODED module
# constant, deliberately NOT injectable at any call site. Paid scope is VIDEO
# only and MiniMax only (ADR-0006 / ADR-0009; image/audio paid excluded per
# ADR-0038); any other configured provider (primary or fallback) is refused
# fail-closed so it can never incur unauthorized spend. Widening this scope
# requires editing this module under a new Accepted ADR, never a call-site
# argument.
AUTHORIZED_PAID_PROVIDERS = ("minimax",)

# Read-only downstream facts shown before a high-risk confirmation.
_DOWNSTREAM = (
    "candidate VideoAsset",
    "QCD provider_cost_recorded",
    "reservation",
)

# The command is packet-only; these are the only params it accepts.
_REQUIRED = ("task_id", "shot_id", "operation_id", "packet_version")

# Deployment opt-in required to REGISTER the real-spend command, on top of the
# in-code ``authorized=True``. This gates registration only (not transport), so
# a code path that hard-codes ``authorized=True`` still cannot expose a
# spend-capable command in a deployment that did not set the flag.
ENABLE_PAID_COMMANDS_ENV = "AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS"


class PaidCommandNotAuthorizedError(AiVideoWorkflowError):
    """Raised when paid command registration is attempted without an explicit
    authorization signal.

    Real spend must be opted into: merely importing/calling the builder must
    not enable a spending command. Registration fails closed unless the caller
    passes ``authorized=True`` (the mockup paid-mode backend / tests do so
    explicitly); nothing is registered otherwise.
    """


@dataclass(frozen=True, slots=True)
class _PaidDeps:
    """Injected, provider-neutral dependencies for the paid command.

    ``provider_registry`` and ``fetcher`` are ZERO-ARG FACTORIES so tests
    inject fakes and real deployment injects ``default_registry`` /
    ``UrllibMediaFetcher`` — the command layer never binds a concrete
    Provider or transport.
    """

    provider_registry: Callable[[], ProviderRegistry]
    fetcher: Callable[[], object]
    catalog_dir: Path
    account_root: Path | None
    clock: Callable[[], datetime]


def register_paid_video_command(
    registry: CommandRegistry,
    *,
    provider_registry: Callable[[], ProviderRegistry],
    fetcher: Callable[[], object],
    catalog_dir: Path,
    authorized: bool = False,
    account_root: Path | None = None,
    clock: Callable[[], datetime] = utc_now,
) -> None:
    """Register the paid video generation command into an approved registry.

    Fail-closed on TWO independent signals (defense in depth): registration is
    REFUSED (``PaidCommandNotAuthorizedError``, nothing registered) unless BOTH
    the caller passes ``authorized=True`` AND the deployment sets the
    environment flag ``AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1``. The in-code
    flag alone is an unconstrained caller-supplied boolean, so an explicit
    deployment opt-in is also required — a code path that hard-codes
    ``authorized=True`` still cannot expose a spend-capable command in a
    deployment that never set the flag. The env flag gates REGISTRATION only,
    independent of whether the injected transport is real (tests still inject
    fakes). Callers wire this ONLY when paid usage is explicitly authorized, so
    ``build_wfm1_registry`` (the default no-spend registry) stays unchanged.
    The paid provider scope itself is the non-injectable module constant
    ``AUTHORIZED_PAID_PROVIDERS`` (MiniMax only, per ADR-0006 / ADR-0009 /
    ADR-0038) — no call-site argument can widen it.
    """
    if not authorized:
        raise PaidCommandNotAuthorizedError(
            "refusing to register the paid video generation command without "
            "explicit authorization; pass authorized=True only when paid "
            "spend is authorized"
        )
    if os.environ.get(ENABLE_PAID_COMMANDS_ENV) != "1":
        raise PaidCommandNotAuthorizedError(
            "refusing to register the paid video generation command without "
            f"the deployment opt-in {ENABLE_PAID_COMMANDS_ENV}=1 (set it only "
            "in a deployment authorized for paid spend)"
        )
    deps = _PaidDeps(
        provider_registry=provider_registry,
        fetcher=fetcher,
        catalog_dir=Path(catalog_dir),
        account_root=account_root,
        clock=clock,
    )

    def _preview_closure(project_root: Path, envelope: CommandEnvelope) -> Preview:
        return _preview(project_root, envelope, deps)

    def _apply_closure(project_root: Path, envelope: CommandEnvelope) -> dict:
        return _apply(project_root, envelope, deps)

    registry.register(
        CommandSpec(
            SUBMIT_VIDEO_GENERATION,
            CommandRisk.HIGH,
            _preview_closure,
            _apply_closure,
            requires_target=True,
        )
    )


# --- target <-> shot binding --------------------------------------------------


def _target_shot_id(target) -> str | None:
    """The shot id a command target identifies, or None if it names no shot.

    The command binds the exact shot version it generates for; the target
    ``ref`` is either the bare shot id or the shot record path
    (``records/shots/<shot_id>.json``). A ref that names no shot cannot be
    cross-checked and is treated as unbound (fail-closed at the caller).
    """
    if not isinstance(target, dict):
        return None
    ref = target.get("ref")
    if not isinstance(ref, str) or not ref:
        return None
    leaf = ref.rsplit("/", 1)[-1]
    if leaf.endswith(".json"):
        leaf = leaf[: -len(".json")]
    return leaf


def _target_binds_shot(envelope: CommandEnvelope, shot_id) -> bool:
    return shot_id is not None and _target_shot_id(envelope.target) == shot_id


# --- shared prerequisite resolution ------------------------------------------


def _discover_paths(project_root: Path, relative: str) -> tuple[Path, ...]:
    # A read-only, containment-checked discovery of one record directory (a
    # symlinked record dir cannot redirect reads outside the root).
    directory = resolve_within_root(project_root, relative)
    if not directory.is_dir():
        return ()
    return tuple(
        resolve_within_root(project_root, f"{relative}/{path.name}")
        for path in sorted(directory.glob("*.json"))
    )


def _provider_id_for(config, shot_id: str) -> str:
    # The primary provider the coordinator would price against and drive (shot
    # override then project default) — used for the read-only preview quote
    # and the paid-provider authorization check in both preview and apply.
    return config.shot_overrides.get(shot_id, config.default_provider)


def _require_task_bound_to_shot(data, task_id: str, shot_id: str) -> None:
    """Fail-closed unless ``task_id`` is a RECORDED core fact for ``shot_id``.

    ``task_id`` arrives from untrusted UI client params, so an approved packet
    for one shot must not be submittable under an arbitrary or freshly-minted
    task id (which would corrupt task<->shot provenance and downstream
    task-scoped records). Task ids are minted by the CORE, never by the UI:
    ``app/bootstrap.py`` ``bootstrap_generation_tasks``/``initial_task_id``
    mints ``task-{shot_id}-1`` and ``create_redo_task`` mints each subsequent
    ``task-{shot_id}-{n}`` as a persisted ``GenerationTask`` record (carrying
    both ``task_id`` and ``shot_id``, ``models.GenerationTask``). Accepted:

    - a task id matching an EXISTING GenerationTask record whose ``shot_id``
      is this shot; or
    - the canonical initial id (``initial_task_id(shot_id)``) when the shot
      has NO generation-task records yet (pre-bootstrap first attempt).

    Anything else — including a canonical-looking but unrecorded redo id —
    is refused: the next task id must be minted by the core redo mechanism
    (``create_redo_task``), matching the coordinator's own guidance to
    "create a redo task".
    """
    for task in data.generation_tasks:
        if task.task_id == task_id and task.shot_id != shot_id:
            raise AiVideoWorkflowError(
                f"task_id {task_id!r} is already recorded for shot "
                f"{task.shot_id!r}, not {shot_id!r}; refusing cross-shot task "
                "provenance"
            )
    shot_task_ids = {
        task.task_id for task in data.generation_tasks if task.shot_id == shot_id
    }
    if task_id in shot_task_ids:
        return
    if not shot_task_ids and task_id == initial_task_id(shot_id):
        return
    raise AiVideoWorkflowError(
        f"task_id {task_id!r} is not a recorded generation task for shot "
        f"{shot_id!r} (and is not the canonical initial id of a shot without "
        "task records); task ids are minted by the core — run create-redo-task "
        "to mint the next task id"
    )


def _resolved_request(project_root: Path, envelope: CommandEnvelope, deps: _PaidDeps):
    """Resolve (config, catalog, data, shot, request) or raise fail-closed.

    Mirrors the WFM1 packet flow in ``cli._paid_setup``: only a re-verified
    packet may reach the coordinator. Any unmet prerequisite (missing catalog
    lock, unresolved shot, unapproved/stale production_lock, drifted packet)
    raises BEFORE any coordinator state or Provider call exists.
    """
    params = envelope.params
    config = load_project_config(project_root)
    catalog = load_locked_catalog(config, deps.catalog_dir)
    data = load_project_data(
        resolve_within_root(project_root, "project.json"),
        character_paths=_discover_paths(project_root, "records/characters"),
        scene_paths=_discover_paths(project_root, "records/scenes"),
        shot_paths=_discover_paths(project_root, "records/shots"),
        generation_task_paths=_discover_paths(project_root, "records/generation-tasks"),
    )
    shot_id = params.get("shot_id")
    shot = next((s for s in data.shots if s.shot_id == shot_id), None)
    if shot is None:
        raise AiVideoWorkflowError(f"no shot record for {shot_id!r}")

    task_id = str(params["task_id"])
    _require_task_bound_to_shot(data, task_id, str(shot_id))

    # Task-level operation guard, mirrored from the coordinator's authoritative
    # guard (app/paid_coordinator.py:456-475 "Task-level operation guard"):
    # once a task has ANY persisted reservation, a NEW user operation is
    # refused so a fresh command_id/operation_id can never re-pay the same
    # task. Enforced here too so the refusal is visible and fail-closed at the
    # UI/command boundary (defense in depth; the coordinator still enforces it
    # under the account budget lock).
    if any(r.task_id == task_id for r in list_reservations(project_root)):
        raise AiVideoWorkflowError(
            f"task {task_id!r} already has a paid operation; create a redo "
            "task or resume the existing operation (refusing to re-pay the "
            "same task)"
        )

    account_root = deps.account_root or project_root.parent
    # The FULL production chain must be approved and fresh (any stale or
    # missing transitive prerequisite blocks before any coordinator state).
    require_stage_ready(project_root, "production_lock")
    packet = load_packet(project_root, shot_id, int(params["packet_version"]))
    # nothing in the stored packet is trusted: recompute and compare against
    # the approved authoritative inputs.
    verify_packet(project_root, account_root, catalog, config, packet)
    request = packet_to_paid_request(
        packet,
        task_id=params["task_id"],
        operation_id=params["operation_id"],
        stage="production_lock",
    )
    return config, catalog, data, shot, request


def _scope_reason(role: str, provider_id: str) -> str:
    return (
        f"paid {role} provider {provider_id!r} is not authorized for paid "
        f"video generation; only {list(AUTHORIZED_PAID_PROVIDERS)} may "
        "incur spend (ADR-0006 / ADR-0009; image/audio paid excluded per "
        "ADR-0038)"
    )


def _paid_scope_violation(config, shot_id: str) -> str | None:
    """Fail-closed reason if ANY provider the coordinator could bill is
    outside the authorized paid scope, else None.

    ``submit_paid`` bills the primary provider (shot override -> default) and,
    on a technical failure of the primary, falls back to
    ``config.fallback_provider`` (app/paid_coordinator.py ``submit_paid`` /
    ``resolve_provider_selection``). Both can incur spend, so BOTH must be in
    the hard-coded ``AUTHORIZED_PAID_PROVIDERS`` — checking only the primary
    would let an unauthorized fallback pay.
    """
    primary = _provider_id_for(config, shot_id)
    if primary not in AUTHORIZED_PAID_PROVIDERS:
        return _scope_reason("primary", primary)
    fallback = config.fallback_provider
    if fallback is not None and fallback not in AUTHORIZED_PAID_PROVIDERS:
        return _scope_reason("fallback", fallback)
    return None


def _budget_denied_reason(
    project_root: Path,
    account_root: Path,
    config,
    request,
    estimate_jpy: int,
    clock,
) -> str | None:
    """Read-only mirror of the coordinator's ``_check_budget`` fail-closed
    budget pre-flight (app/paid_coordinator.py ``_check_budget`` ->
    ``budget.guard.evaluate_pre_flight``), so an over-budget request is refused
    at preview BEFORE any confirmation / WAL receipt (ADR-0033 P7). Reuses the
    exact caps, outstanding holds, and consecutive-failure inputs; returns the
    denial reason, or None if the call may proceed.
    """
    ledger = read_ledger(project_root, config.fx)
    holds = outstanding_holds(project_root)
    month = month_key_jst(clock())
    account_month = read_account_month_spent(account_root, month).total_jpy
    account_holds = account_outstanding_holds(account_root)
    failures = shot_consecutive_failures(project_root, request.shot_id)
    decision = evaluate_pre_flight(
        budgets=config.budgets_jpy,
        month_spent_jpy=account_month + account_holds,
        episode_spent_jpy=ledger.project_total_jpy + holds.total_jpy,
        shot_spent_jpy=ledger.shot_spent(request.shot_id)
        + holds.shot_held(request.shot_id),
        estimate_jpy=estimate_jpy,
        shot_consecutive_failures=failures,
    )
    if decision.allowed:
        return None
    return f"budget denied ({decision.stop_scope}): {decision.reason}"


# --- preview (read-only) ------------------------------------------------------


def _preview(project_root: Path, envelope: CommandEnvelope, deps: _PaidDeps) -> Preview:
    params = envelope.params
    shot_id = params.get("shot_id")
    blockers: list[str] = [
        f"missing param {key!r}" for key in _REQUIRED if params.get(key) in (None, "")
    ]
    if owning_project_id(project_root) is None:
        blockers.append("no project identity (project.json missing)")
    if envelope.actor != "user":
        blockers.append("actor must be 'user' (paid generation provenance)")
    if not _target_binds_shot(envelope, shot_id):
        blockers.append(
            f"target must bind the same shot as shot_id={shot_id!r} "
            "(version binding fail-closed)"
        )

    inputs: dict = {key: params.get(key) for key in _REQUIRED}
    estimated_cost = None

    # Only touch the filesystem prerequisites once the cheap identity/param/
    # binding guards pass, so a malformed request fails closed without side
    # reads.
    if not blockers:
        try:
            config, catalog, _data, _shot, request = _resolved_request(
                project_root, envelope, deps
            )
        except Exception as exc:  # noqa: BLE001 - any unmet prereq is a blocker
            blockers.append(f"{type(exc).__name__}: {exc}")
        else:
            inputs.update(
                {
                    "model": request.model_id,
                    "resolution": request.resolution,
                    "duration": request.duration_seconds,
                    "capability": request.capability,
                    "stage": request.stage,
                }
            )
            provider_id = _provider_id_for(config, request.shot_id)
            scope_violation = _paid_scope_violation(config, request.shot_id)
            if scope_violation is not None:
                blockers.append(scope_violation)
            try:
                estimate = estimate_generation_cost(
                    catalog,
                    config.fx,
                    provider_id,
                    request.model_id,
                    resolution=request.resolution,
                    duration_seconds=request.duration_seconds,
                )
            except Exception as exc:  # noqa: BLE001 - pricing impossible -> blocker
                blockers.append(f"quote unavailable: {type(exc).__name__}: {exc}")
            else:
                estimated_cost = {
                    "jpy": estimate.jpy,
                    "original_amount_minor_units": estimate.original_amount_minor_units,
                    "original_currency": estimate.original_currency,
                }
                # Fail-closed budget admission (ADR-0033 P7): refuse an
                # over-budget request at preview, before any confirmation/WAL,
                # using the coordinator's exact read-only pre-flight.
                account_root = deps.account_root or project_root.parent
                denied = _budget_denied_reason(
                    project_root,
                    account_root,
                    config,
                    request,
                    estimate.jpy,
                    deps.clock,
                )
                if denied is not None:
                    blockers.append(denied)

    return Preview(
        inputs=inputs,
        estimated_cost=estimated_cost,
        downstream=_DOWNSTREAM,
        blockers=tuple(blockers),
    )


# --- apply (wraps the approved paid coordinator) ------------------------------


def _apply(project_root: Path, envelope: CommandEnvelope, deps: _PaidDeps) -> dict:
    shot_id = envelope.params.get("shot_id")
    # Version binding fail-closed: the confirmed target must name the same
    # shot the request generates for (a valid target for shot A can never
    # submit generation for shot B).
    if not _target_binds_shot(envelope, shot_id):
        raise AiVideoWorkflowError(
            f"target does not bind shot_id={shot_id!r}; refusing to generate "
            "for a shot the confirmed target did not authorize"
        )
    config, catalog, data, shot, request = _resolved_request(
        project_root, envelope, deps
    )
    scope_violation = _paid_scope_violation(config, request.shot_id)
    if scope_violation is not None:
        raise AiVideoWorkflowError(scope_violation)
    coordinator = PaidGenerationCoordinator(
        project_root=project_root,
        config=config,
        catalog=catalog,
        registry=deps.provider_registry(),
        project=data.project,
        fetcher=deps.fetcher(),
        clock=deps.clock,
        account_root=deps.account_root,
    )
    outcome = coordinator.submit_paid(shot, request)
    result = {
        "kind": outcome.kind,
        "provider_id": outcome.provider_id,
        "operation_id": outcome.operation_id,
        "cost_minor_units": outcome.cost_minor_units,
        "currency": outcome.currency,
        "reason": outcome.reason,
    }
    # Drop None-valued keys so the receipt outcome stays JSON-compatible
    # (the Gateway validates the outcome before persisting it).
    return {key: value for key, value in result.items() if value is not None}
