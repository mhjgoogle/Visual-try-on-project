"""Paid generation coordination chain (TASK-014 / TASK-016).

Runs the pre-flight coordination for one paid generation attempt, in a
fixed order, *around* the pluggable provider — without touching the M1
orchestrator:

  1. approval digest gate      (blocked -> 0 provider calls)
  2. provider/model/capability resolution
  3. catalog quote
  4. budget pre-flight check    (denied -> 0 provider calls, no fallback)
  5. reservation (pre-flight hold, idempotent)
  6. provider submit / poll / collect
  7. authoritative cost booking (QCD ``provider_cost_recorded``) + commit

Fallback: a *technical* failure (network/timeout/auth/vendor) before the
job is charged releases the hold and retries the configured fallback
provider under a **new** operation id, re-running approval, quote,
budget, and reservation from scratch. A **budget** denial never falls
back. An **ambiguous** failure after submit (unknown charge state) marks
the reservation ``needs_reconciliation`` and stops — never an automatic
re-pay.

Crash safety: a reservation left ``held`` from a prior crashed attempt is
never re-submitted; it is flagged for reconciliation.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Protocol

from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.app.cost_boundary import to_authoritative_cost
from ai_video_workflow.approval.errors import NotApprovedError
from ai_video_workflow.approval.gate import require_stage_approved
from ai_video_workflow.budget.account import (
    account_outstanding_holds,
    read_account_month_spent,
)
from ai_video_workflow.budget.estimate import estimate_generation_cost
from ai_video_workflow.budget.guard import evaluate_pre_flight
from ai_video_workflow.budget.ledger import month_key_jst, read_ledger
from ai_video_workflow.budget.lock import account_budget_lock
from ai_video_workflow.budget.reservation import (
    COMMITTED,
    HELD,
    NEEDS_RECONCILIATION,
    commit_reservation,
    hold_reservation,
    load_reservation,
    mark_needs_reconciliation,
    outstanding_holds,
    release_reservation,
    shot_consecutive_failures,
)
from ai_video_workflow.config.catalog import ProviderCatalog
from ai_video_workflow.config.project_config import ProjectConfig
from ai_video_workflow.config.selection import resolve_provider_selection
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.models import Project, Shot
from ai_video_workflow.providers.cloud_errors import (
    CloudProviderError,
    ProviderAuthError,
    ProviderNoChargeFailureError,
    ProviderNotDispatchedError,
    ProviderVendorError,
)
from ai_video_workflow.providers.errors import ProviderError
from ai_video_workflow.providers.models import ProviderRequest, ProviderStatus
from ai_video_workflow.providers.registry import ProviderRegistry
from ai_video_workflow.qcd.events import build_provider_cost_recorded_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.security.paths import resolve_within_root

_MAX_POLLS = 120

# Submit-phase errors that PROVE no remote job was created (safe to release
# and fall back). Everything else during submit is ambiguous.
_SAFE_NO_CHARGE_SUBMIT = (ProviderAuthError, ProviderNotDispatchedError)

# Outcome kinds
SUCCESS = "success"
SUCCESS_MEDIA_PENDING = "success_media_pending"
ALREADY_COMMITTED = "already_committed"
APPROVAL_BLOCKED = "approval_blocked"
BUDGET_DENIED = "budget_denied"
TECHNICAL_FAILURE = "technical_failure"
NEEDS_RECONCILIATION_OUTCOME = "needs_reconciliation"
PROVIDER_UNAVAILABLE = "provider_unavailable"
SPEC_INVALID = "spec_invalid"


class CoordinatorError(AiVideoWorkflowError):
    """Raised when a paid request cannot be bound to a consistent spec."""


@dataclass(frozen=True, slots=True)
class GenerationSpec:
    """One immutable spec both the quote and the provider payload derive from.

    Built once from the request + shot and validated for internal
    consistency, so a catalog quote can never be priced on parameters that
    differ from what the provider is actually asked to generate.
    """

    model_id: str
    capability: str
    resolution: str
    duration_seconds: int
    width: int
    height: int
    frame_rate: float
    prompt: str


class MediaFetcher(Protocol):
    """Fetches an external artifact reference to a local destination."""

    def fetch(self, reference: str, dest: Path) -> None: ...


@dataclass(frozen=True, slots=True)
class PaidRequest:
    """Inputs for one paid generation attempt."""

    task_id: str
    shot_id: str
    operation_id: str
    stage: str
    capability: str
    model_id: str
    resolution: str
    duration_seconds: int


@dataclass(frozen=True, slots=True)
class PaidOutcome:
    """The result of a paid coordination attempt."""

    kind: str
    provider_id: str | None = None
    operation_id: str | None = None
    cost_minor_units: int | None = None
    currency: str | None = None
    reason: str | None = None
    stop_scope: str | None = None
    fell_back: bool = False


class _TechnicalFailure(Exception):
    """Internal: a technical failure eligible for fallback (no charge yet)."""


class _AmbiguousResult(Exception):
    """Internal: an unknown charge state; needs manual reconciliation."""


class PaidGenerationCoordinator:
    """Coordinates one paid generation attempt around a pluggable provider."""

    def __init__(
        self,
        *,
        project_root: Path,
        config: ProjectConfig,
        catalog: ProviderCatalog,
        registry: ProviderRegistry,
        project: Project,
        fetcher: MediaFetcher,
        clock: Callable[[], datetime],
        account_root: Path | None = None,
    ) -> None:
        self._project_root = project_root
        self._config = config
        self._catalog = catalog
        self._registry = registry
        self._project = project
        self._fetcher = fetcher
        self._clock = clock
        self._account_root = account_root or project_root.parent

    def submit_paid(self, shot: Shot, request: PaidRequest) -> PaidOutcome:
        """Run the coordination chain, with one fallback on technical failure."""
        selection = resolve_provider_selection(
            self._config,
            self._catalog,
            request.shot_id,
            capability=request.capability,
            model_id=request.model_id,
        )
        primary = self._attempt(
            shot, request, request.operation_id, selection.primary_provider_id
        )
        if (
            primary.kind == TECHNICAL_FAILURE
            and selection.fallback_provider_id is not None
        ):
            # The primary's failure is now a persisted (released) reservation,
            # so the fallback's guard recomputes the failure count from facts.
            fallback_request = replace(
                request,
                operation_id=f"{request.operation_id}:fallback",
            )
            fallback = self._attempt(
                shot,
                fallback_request,
                fallback_request.operation_id,
                selection.fallback_provider_id,
                fell_back=True,
            )
            return fallback
        return primary

    # --- one attempt ------------------------------------------------------

    def _attempt(
        self,
        shot: Shot,
        request: PaidRequest,
        operation_id: str,
        provider_id: str,
        *,
        fell_back: bool = False,
    ) -> PaidOutcome:
        # 1. approval digest gate (re-checked every attempt)
        try:
            require_stage_approved(self._project_root, request.stage)
        except NotApprovedError as exc:
            return PaidOutcome(
                kind=APPROVAL_BLOCKED, reason=str(exc), fell_back=fell_back
            )

        # 2/5-pre. Build the provider and the immutable spec BEFORE any hold,
        # so a missing provider or an inconsistent quote-vs-payload spec can
        # never leave a held reservation behind (and never calls a provider).
        try:
            provider = self._build_provider(provider_id)
        except ProviderError as exc:
            return PaidOutcome(
                kind=PROVIDER_UNAVAILABLE,
                provider_id=provider_id,
                operation_id=operation_id,
                reason=str(exc),
                fell_back=fell_back,
            )
        try:
            spec = _build_spec(shot, request)
        except CoordinatorError as exc:
            return PaidOutcome(
                kind=SPEC_INVALID,
                provider_id=provider_id,
                operation_id=operation_id,
                reason=str(exc),
                fell_back=fell_back,
            )

        # 3-5. quote + budget + reservation, all under one account-level lock
        # so two different operations cannot both pass check-then-reserve.
        with account_budget_lock(self._account_root):
            existing = load_reservation(
                self._project_root, request.task_id, operation_id
            )
            if existing is not None:
                # same-operation concurrency / crash resume stays idempotent
                return self._resume_existing(existing, provider_id, fell_back)

            estimate = estimate_generation_cost(
                self._catalog,
                self._config.fx,
                provider_id,
                spec.model_id,
                resolution=spec.resolution,
                duration_seconds=spec.duration_seconds,
            )
            decision = self._check_budget(request, estimate.jpy)
            if not decision.allowed:
                return PaidOutcome(
                    kind=BUDGET_DENIED,
                    provider_id=provider_id,
                    operation_id=operation_id,
                    reason=decision.reason,
                    stop_scope=decision.stop_scope,
                    fell_back=fell_back,
                )
            now = self._clock()
            hold_reservation(
                self._project_root,
                project_id=self._project.project_id,
                task_id=request.task_id,
                operation_id=operation_id,
                shot_id=request.shot_id,
                provider_id=provider_id,
                model_id=spec.model_id,
                estimate_jpy=estimate.jpy,
                created_at=now.isoformat(),
            )

        # 6. provider submit / poll / collect (outside the lock)
        provider_request = self._build_request(spec, request, provider_id)
        try:
            final = _drive_provider(provider, provider_request, now)
        except _TechnicalFailure as exc:
            release_reservation(
                self._project_root,
                request.task_id,
                operation_id,
                resolved_at=self._clock().isoformat(),
                note=f"technical failure: {exc}",
            )
            return PaidOutcome(
                kind=TECHNICAL_FAILURE,
                provider_id=provider_id,
                operation_id=operation_id,
                reason=str(exc),
                fell_back=fell_back,
            )
        except _AmbiguousResult as exc:
            mark_needs_reconciliation(
                self._project_root,
                request.task_id,
                operation_id,
                note=f"unknown charge state: {exc}",
            )
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                provider_id=provider_id,
                operation_id=operation_id,
                reason=str(exc),
                fell_back=fell_back,
            )

        # 7. book authoritative cost + commit, then fetch media
        return self._settle(request, operation_id, provider_id, final, fell_back)

    def _resume_existing(self, existing, provider_id, fell_back) -> PaidOutcome:
        if existing.status == COMMITTED:
            # already charged and booked: never re-submit / re-pay
            return PaidOutcome(
                kind=ALREADY_COMMITTED,
                provider_id=existing.provider_id,
                operation_id=existing.operation_id,
                fell_back=fell_back,
            )
        if existing.status == HELD:
            # a prior attempt held then crashed before settling: unknown charge
            mark_needs_reconciliation(
                self._project_root,
                existing.task_id,
                existing.operation_id,
                note="held reservation resumed; charge state unknown",
            )
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                provider_id=existing.provider_id,
                operation_id=existing.operation_id,
                reason="prior attempt did not settle; manual reconciliation",
                fell_back=fell_back,
            )
        if existing.status == NEEDS_RECONCILIATION:
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                provider_id=existing.provider_id,
                operation_id=existing.operation_id,
                reason="reservation awaiting manual reconciliation",
                fell_back=fell_back,
            )
        # RELEASED: a prior clean failure for this exact operation
        return PaidOutcome(
            kind=TECHNICAL_FAILURE,
            provider_id=existing.provider_id,
            operation_id=existing.operation_id,
            reason="operation previously failed and was released",
            fell_back=fell_back,
        )

    def _settle(
        self, request, operation_id, provider_id, final, fell_back
    ) -> PaidOutcome:
        if final.cost_observation is None:
            mark_needs_reconciliation(
                self._project_root,
                request.task_id,
                operation_id,
                note="provider succeeded without a cost observation",
            )
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                provider_id=provider_id,
                operation_id=operation_id,
                reason="no cost observation to book",
                fell_back=fell_back,
            )

        auth = to_authoritative_cost(final.cost_observation)
        now = self._clock()
        # authoritative cost fact (idempotent by event_id) then commit
        append_event(
            self._project_root,
            build_provider_cost_recorded_event(
                project_id=self._project.project_id,
                shot_id=request.shot_id,
                task_id=request.task_id,
                provider_id=provider_id,
                model_id=request.model_id,
                operation_id=operation_id,
                cost_minor_units=auth.cost_minor_units,
                currency=auth.currency,
                billing_source=auth.billing_source,
                occurred_at=now,
                observed_amount=auth.observed_amount,
                observed_unit=auth.observed_unit,
            ),
        )
        commit_reservation(
            self._project_root,
            request.task_id,
            operation_id,
            resolved_at=now.isoformat(),
        )

        # media fetch is retryable and has no money impact
        kind = SUCCESS
        dest = resolve_within_root(self._project_root, staging_ref_for(request.task_id))
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._fetcher.fetch(final.artifact.reference, dest)
        except Exception:  # noqa: BLE001 - cost is settled; media is retryable
            kind = SUCCESS_MEDIA_PENDING

        return PaidOutcome(
            kind=kind,
            provider_id=provider_id,
            operation_id=operation_id,
            cost_minor_units=auth.cost_minor_units,
            currency=auth.currency,
            fell_back=fell_back,
        )

    def _check_budget(self, request: PaidRequest, estimate_jpy: int):
        # Called inside the account budget lock. Episode/shot are project
        # scope; monthly is account scope (all projects' committed + all
        # projects' outstanding holds). Failure count is derived from
        # persisted reservations, never trusted from the request.
        ledger = read_ledger(self._project_root, self._config.fx)
        holds = outstanding_holds(self._project_root)
        month = month_key_jst(self._clock())
        account_month = read_account_month_spent(self._account_root, month).total_jpy
        account_holds = account_outstanding_holds(self._account_root)
        failures = shot_consecutive_failures(self._project_root, request.shot_id)
        return evaluate_pre_flight(
            budgets=self._config.budgets_jpy,
            month_spent_jpy=account_month + account_holds,
            episode_spent_jpy=ledger.project_total_jpy + holds.total_jpy,
            shot_spent_jpy=ledger.shot_spent(request.shot_id)
            + holds.shot_held(request.shot_id),
            estimate_jpy=estimate_jpy,
            shot_consecutive_failures=failures,
        )

    def _build_provider(self, provider_id: str):
        entry = self._catalog.providers.get(provider_id)
        if entry is None:
            raise ProviderError(
                f"provider {provider_id!r} is not in the locked catalog"
            )
        return self._registry.build(provider_id, entry)

    def _build_request(
        self, spec: GenerationSpec, request: PaidRequest, provider_id: str
    ) -> ProviderRequest:
        # Payload derives from the same spec the quote used; the priced
        # resolution is passed through so the vendor generates what was
        # priced.
        return ProviderRequest(
            provider_id=provider_id,
            task_id=request.task_id,
            shot_id=request.shot_id,
            prompt=spec.prompt,
            duration_seconds=float(spec.duration_seconds),
            width=spec.width,
            height=spec.height,
            frame_rate=spec.frame_rate,
            staging_ref=staging_ref_for(request.task_id),
            provider_parameters={
                "resolution": spec.resolution,
                "capability": spec.capability,
            },
        )


def _build_spec(shot: Shot, request: PaidRequest) -> GenerationSpec:
    """Bind the quote and the payload to one validated spec.

    The duration used for pricing must equal the shot's duration, so a
    CLI-supplied quote parameter can never diverge from what the provider
    is asked to generate.
    """
    if not isinstance(request.duration_seconds, int) or request.duration_seconds < 1:
        raise CoordinatorError("duration_seconds: expected a positive int")
    if not request.resolution:
        raise CoordinatorError("resolution: required")
    if not request.model_id or not request.capability:
        raise CoordinatorError("model_id and capability are required")
    if float(request.duration_seconds) != float(shot.duration_seconds):
        raise CoordinatorError(
            f"duration mismatch: request {request.duration_seconds}s != "
            f"shot {shot.duration_seconds}s (quote would diverge from payload)"
        )
    return GenerationSpec(
        model_id=request.model_id,
        capability=request.capability,
        resolution=request.resolution,
        duration_seconds=request.duration_seconds,
        width=shot.width,
        height=shot.height,
        frame_rate=shot.frame_rate,
        prompt=shot.prompt,
    )


def _drive_provider(provider, request: ProviderRequest, now: datetime):
    """Drive prepare/submit/poll/collect; classify failures by *charge state*.

    The classification is conservative about money: a failure is only
    'technical' (release + fallback) when it PROVES no remote job/charge;
    otherwise it is 'ambiguous' (needs_reconciliation, no fallback, no
    auto-retry).
    """
    # prepare is local / pre-dispatch: no job exists yet.
    try:
        prepared = provider.prepare(request, observed_at=now)
    except CloudProviderError as exc:
        raise _TechnicalFailure(str(exc)) from exc

    # submit: only provably-not-dispatched errors are safe no-charge; a
    # timeout / response error / generic network error may have been received.
    try:
        current = provider.submit(request, prepared, observed_at=now)
    except _SAFE_NO_CHARGE_SUBMIT as exc:
        raise _TechnicalFailure(str(exc)) from exc
    except CloudProviderError as exc:
        raise _AmbiguousResult(str(exc)) from exc

    # post-submit: the job may be charged. Only a provider that DECLARES no
    # charge (ProviderNoChargeFailureError) may release + fall back.
    try:
        for _ in range(_MAX_POLLS):
            status = current.status
            if status is ProviderStatus.ARTIFACT_AVAILABLE:
                return provider.collect(
                    request,
                    current,
                    artifact=current.artifact,
                    observed_at=now,
                    completed_at=now,
                )
            if status is ProviderStatus.SUCCEEDED:
                return current
            if status is ProviderStatus.FAILED:
                # a status result cannot prove no charge -> ambiguous
                raise _AmbiguousResult(current.error_summary or "provider failed")
            if status is ProviderStatus.CANCELLED:
                raise _AmbiguousResult("provider cancelled")
            current = provider.poll(request, current, observed_at=now)
    except ProviderNoChargeFailureError as exc:
        # provider definitively asserts no charge -> safe to release + fall back
        raise _TechnicalFailure(str(exc)) from exc
    except ProviderVendorError as exc:
        # generic vendor failure: charge unknown -> ambiguous
        raise _AmbiguousResult(str(exc)) from exc
    except CloudProviderError as exc:
        # network / timeout / response after submit: unknown charge -> ambiguous
        raise _AmbiguousResult(str(exc)) from exc
    raise _AmbiguousResult("provider did not reach a terminal state")
