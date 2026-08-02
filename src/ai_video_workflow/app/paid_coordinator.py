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

import json
import time
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
from ai_video_workflow.budget.estimate import CostEstimate, estimate_generation_cost
from ai_video_workflow.budget.guard import evaluate_pre_flight
from ai_video_workflow.budget.ledger import month_key_jst, read_ledger
from ai_video_workflow.budget.lock import account_budget_lock
from ai_video_workflow.budget.reservation import (
    COMMITTED,
    HELD,
    NEEDS_RECONCILIATION,
    commit_reservation,
    hold_reservation,
    list_reservations,
    load_reservation,
    mark_needs_reconciliation,
    outstanding_holds,
    record_external_task_ref,
    release_reservation,
    shot_consecutive_failures,
)
from ai_video_workflow.config.catalog import ProviderCatalog
from ai_video_workflow.config.project_config import ProjectConfig
from ai_video_workflow.config.selection import resolve_provider_selection
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.models import Project, Shot
from ai_video_workflow.providers.cloud_errors import (
    CloudProviderError,
    ProviderAuthError,
    ProviderNoChargeFailureError,
    ProviderNotDispatchedError,
    ProviderRequestRejectedError,
    ProviderVendorError,
)
from ai_video_workflow.providers.errors import (
    InvalidProviderRequestError,
    ProviderError,
)
from ai_video_workflow.providers.models import (
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)
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
REQUEST_REJECTED = "request_rejected"
OPERATION_CONFLICT = "operation_conflict"

_DEFAULT_POLL_INTERVAL_SECONDS = 10.0


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
    first_frame_image: str | None = None


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
    first_frame_image: str | None = None


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
    # True when the outcome merely REPLAYED a persisted reservation from an
    # earlier run instead of executing a fresh attempt. A replayed technical
    # failure must never trigger a fallback: the task may have settled
    # through other operations since, and a fallback would pay again.
    resumed: bool = False


def media_receipt_matches(receipt: Path, dest: Path) -> bool:
    """True iff ``dest`` matches the trusted download receipt.

    A receipt of any legal-JSON-but-wrong shape (array, string,
    missing/non-string sha256) is simply untrusted — never a crash.
    """
    try:
        recorded = json.loads(receipt.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(recorded, dict):
        return False
    sha = recorded.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        return False
    try:
        return sha == file_sha256(dest)
    except AiVideoWorkflowError:
        return False


class _TechnicalFailure(Exception):
    """Internal: a technical failure eligible for fallback (no charge yet)."""


class _AmbiguousResult(Exception):
    """Internal: an unknown charge state; needs manual reconciliation."""


class _RequestRejected(Exception):
    """Internal: the request was rejected pre-generation (no charge, no
    fallback) — e.g. invalid parameters or insufficient balance."""


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
        sleeper: Callable[[float], None] = time.sleep,
        poll_interval_seconds: float = _DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> None:
        self._project_root = project_root
        self._config = config
        self._catalog = catalog
        self._registry = registry
        self._project = project
        self._fetcher = fetcher
        self._clock = clock
        self._account_root = account_root or project_root.parent
        # Real async jobs never complete instantly; pace polling to avoid a
        # tight rate-limited loop. Tests inject a no-op sleeper.
        self._sleeper = sleeper
        self._poll_interval = poll_interval_seconds

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
            and not primary.resumed
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

    def resume_media(self, shot: Shot, task_id: str, operation_id: str) -> PaidOutcome:
        """Re-poll/collect an interrupted operation via its persisted task id.

        Rebuilt entirely from the persisted reservation record — the caller
        supplies only the ids and the shot. It never re-submits, never
        re-prices (booking uses the reservation's stored quote), and never
        re-pays. If the cost was already committed it just re-fetches the
        media; otherwise it books the stored cost (once) and commits.
        """
        reservation = load_reservation(self._project_root, task_id, operation_id)
        if reservation is None:
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                operation_id=operation_id,
                reason="no reservation to resume",
            )
        if reservation.external_task_ref is None:
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                provider_id=reservation.provider_id,
                operation_id=operation_id,
                reason="no external task id persisted; cannot resume safely",
            )
        if shot.shot_id != reservation.shot_id:
            return PaidOutcome(
                kind=SPEC_INVALID,
                provider_id=reservation.provider_id,
                operation_id=operation_id,
                reason=f"shot {shot.shot_id!r} does not match reservation "
                f"shot {reservation.shot_id!r}",
            )
        try:
            provider = self._build_provider(reservation.provider_id)
        except ProviderError as exc:
            return PaidOutcome(
                kind=PROVIDER_UNAVAILABLE,
                provider_id=reservation.provider_id,
                operation_id=operation_id,
                reason=str(exc),
            )

        now = self._clock()
        # A minimal request for poll/collect identity checks; poll uses the
        # external task id, not this request's payload.
        provider_request = ProviderRequest(
            provider_id=reservation.provider_id,
            task_id=task_id,
            shot_id=shot.shot_id,
            prompt=shot.prompt,
            duration_seconds=shot.duration_seconds,
            width=shot.width,
            height=shot.height,
            frame_rate=shot.frame_rate,
            staging_ref=staging_ref_for(task_id),
            provider_parameters={},
        )
        current = ProviderResult(
            provider_id=reservation.provider_id,
            task_id=task_id,
            shot_id=shot.shot_id,
            status=ProviderStatus.PROCESSING,
            observed_at=now,
            external_task_ref=reservation.external_task_ref,
        )
        already_committed = reservation.status == COMMITTED
        try:
            final = _poll_collect_phase(
                provider,
                provider_request,
                current,
                now,
                self._sleeper,
                self._poll_interval,
            )
        except _TechnicalFailure as exc:
            if already_committed:
                return self._media_pending(reservation, str(exc))
            return self._release_technical(
                reservation, operation_id, reservation.provider_id, exc, False
            )
        except _AmbiguousResult as exc:
            if already_committed:
                return self._media_pending(reservation, str(exc))
            return self._flag_ambiguous(
                reservation, operation_id, reservation.provider_id, exc, False
            )

        if already_committed:
            media_ok = self._fetch_to_staging(task_id, final.artifact.reference)
            return PaidOutcome(
                kind=SUCCESS if media_ok else SUCCESS_MEDIA_PENDING,
                provider_id=reservation.provider_id,
                operation_id=operation_id,
            )
        # Book from the reservation's stored quote — never a re-quote. If the
        # provider returns its own cost, that is used; the stored quote only
        # backs a fixed-price provider (and its absence -> needs_reconciliation
        # in _settle).
        estimate = None
        if (
            reservation.quote_minor_units is not None
            and reservation.quote_currency is not None
        ):
            estimate = CostEstimate(
                original_amount_minor_units=reservation.quote_minor_units,
                original_currency=reservation.quote_currency,
                jpy=reservation.estimate_jpy,
            )
        return self._settle(
            reservation,
            operation_id,
            reservation.provider_id,
            final,
            estimate,
            provider,
            fell_back=False,
        )

    def _media_pending(self, reservation, reason: str) -> PaidOutcome:
        return PaidOutcome(
            kind=SUCCESS_MEDIA_PENDING,
            provider_id=reservation.provider_id,
            operation_id=reservation.operation_id,
            reason=f"cost already committed; media unavailable: {reason}",
        )

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

            # Task-level operation guard: idempotency by (task, operation)
            # alone would let a NEW operation id re-pay for the same task.
            # A task with ANY persisted operation accepts no further
            # user-created operations — resume the same operation id,
            # reconcile it, or create a redo TASK. Only the coordinator's
            # own fallback attempt (after a proven-no-charge release in
            # this same run) may add its derived operation.
            if not fell_back:
                prior = [
                    r
                    for r in list_reservations(self._project_root)
                    if r.task_id == request.task_id
                ]
                if prior:
                    seen = ", ".join(f"{r.operation_id} ({r.status})" for r in prior)
                    return PaidOutcome(
                        kind=OPERATION_CONFLICT,
                        provider_id=provider_id,
                        operation_id=operation_id,
                        reason=(
                            f"task {request.task_id!r} already has paid "
                            f"operation(s): {seen}; a new operation could "
                            "pay twice. Resume with the SAME operation id "
                            "(or poll-media), resolve reconciliation, or "
                            "create a redo task"
                        ),
                        fell_back=fell_back,
                    )

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
                resolution=spec.resolution,
                duration_seconds=spec.duration_seconds,
                capability=spec.capability,
                quote_minor_units=estimate.original_amount_minor_units,
                quote_currency=estimate.original_currency,
            )

        # 6a. submit (outside the lock)
        provider_request = self._build_request(spec, request, provider_id)
        try:
            submitted = _submit_phase(provider, provider_request, now)
        except _TechnicalFailure as exc:
            return self._release_technical(
                request, operation_id, provider_id, exc, fell_back
            )
        except _RequestRejected as exc:
            return self._reject_request(
                request, operation_id, provider_id, exc, fell_back
            )
        except _AmbiguousResult as exc:
            return self._flag_ambiguous(
                request, operation_id, provider_id, exc, fell_back
            )

        # 6b. persist the external task id IMMEDIATELY, so a crash before the
        # media is collected never loses it (re-poll via `resume_media`).
        if submitted.external_task_ref is not None:
            record_external_task_ref(
                self._project_root,
                request.task_id,
                operation_id,
                submitted.external_task_ref,
            )

        # 6c. poll + collect (paced)
        try:
            final = _poll_collect_phase(
                provider,
                provider_request,
                submitted,
                now,
                self._sleeper,
                self._poll_interval,
            )
        except _TechnicalFailure as exc:
            return self._release_technical(
                request, operation_id, provider_id, exc, fell_back
            )
        except _AmbiguousResult as exc:
            return self._flag_ambiguous(
                request, operation_id, provider_id, exc, fell_back
            )

        # 7. book authoritative cost + commit, then fetch media
        return self._settle(
            request, operation_id, provider_id, final, estimate, provider, fell_back
        )

    def _reject_request(
        self, request, operation_id, provider_id, exc, fell_back
    ) -> PaidOutcome:
        # request rejected pre-generation: no charge, but do NOT fall back.
        release_reservation(
            self._project_root,
            request.task_id,
            operation_id,
            resolved_at=self._clock().isoformat(),
            note=f"request rejected: {exc}",
        )
        return PaidOutcome(
            kind=REQUEST_REJECTED,
            provider_id=provider_id,
            operation_id=operation_id,
            reason=str(exc),
            fell_back=fell_back,
        )

    def _release_technical(
        self, request, operation_id, provider_id, exc, fell_back
    ) -> PaidOutcome:
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

    def _flag_ambiguous(
        self, request, operation_id, provider_id, exc, fell_back
    ) -> PaidOutcome:
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

    def _resume_existing(self, existing, provider_id, fell_back) -> PaidOutcome:
        if existing.status == COMMITTED:
            # already charged and booked: never re-submit / re-pay
            return PaidOutcome(
                kind=ALREADY_COMMITTED,
                provider_id=existing.provider_id,
                operation_id=existing.operation_id,
                fell_back=fell_back,
                resumed=True,
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
                resumed=True,
            )
        if existing.status == NEEDS_RECONCILIATION:
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                provider_id=existing.provider_id,
                operation_id=existing.operation_id,
                reason="reservation awaiting manual reconciliation",
                fell_back=fell_back,
                resumed=True,
            )
        # RELEASED: a prior clean failure for this exact operation
        return PaidOutcome(
            kind=TECHNICAL_FAILURE,
            provider_id=existing.provider_id,
            operation_id=existing.operation_id,
            reason="operation previously failed and was released",
            fell_back=fell_back,
            resumed=True,
        )

    def _authoritative_cost(self, final, estimate, provider):
        """Return (cost_minor_units, currency, billing_source, obs_amt, obs_unit).

        Prefers the provider's reported cost (float boundary conversion);
        else, for a provider that bills at the fixed catalog price
        (ADR-0009), books the locked catalog price; else None (unbookable).
        """
        if final.cost_observation is not None:
            auth = to_authoritative_cost(final.cost_observation)
            return (
                auth.cost_minor_units,
                auth.currency,
                auth.billing_source,
                auth.observed_amount,
                auth.observed_unit,
            )
        if getattr(provider, "bills_at_catalog_price", False) and estimate is not None:
            return (
                estimate.original_amount_minor_units,
                estimate.original_currency,
                "catalog_fixed_price",
                None,
                None,
            )
        return None

    def _settle(
        self, request, operation_id, provider_id, final, estimate, provider, fell_back
    ) -> PaidOutcome:
        cost = self._authoritative_cost(final, estimate, provider)
        if cost is None:
            mark_needs_reconciliation(
                self._project_root,
                request.task_id,
                operation_id,
                note="provider succeeded but cost cannot be determined",
            )
            # the media is already paid for on the vendor side: recover it
            # (retryable, no money impact) even though booking needs a human.
            media_ok = self._fetch_to_staging(request.task_id, final.artifact.reference)
            return PaidOutcome(
                kind=NEEDS_RECONCILIATION_OUTCOME,
                provider_id=provider_id,
                operation_id=operation_id,
                reason="no cost to book"
                + ("; media fetched to staging" if media_ok else "; media pending"),
                fell_back=fell_back,
            )
        cost_minor, currency, billing_source, obs_amt, obs_unit = cost

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
                cost_minor_units=cost_minor,
                currency=currency,
                billing_source=billing_source,
                occurred_at=now,
                observed_amount=obs_amt,
                observed_unit=obs_unit,
            ),
        )
        commit_reservation(
            self._project_root,
            request.task_id,
            operation_id,
            resolved_at=now.isoformat(),
        )

        media_ok = self._fetch_to_staging(request.task_id, final.artifact.reference)
        return PaidOutcome(
            kind=SUCCESS if media_ok else SUCCESS_MEDIA_PENDING,
            provider_id=provider_id,
            operation_id=operation_id,
            cost_minor_units=cost_minor,
            currency=currency,
            fell_back=fell_back,
        )

    def _fetch_to_staging(self, task_id: str, reference: str) -> bool:
        """Fetch external media to staging; media is retryable, no money impact.

        Idempotent via a trusted download receipt: an existing staged file
        counts as success only when the receipt written after our own
        completed fetch still matches its digest. A pre-existing file
        without a matching receipt is neither trusted nor overwritten —
        the outcome stays ``success_media_pending`` for a human to resolve.
        """
        dest = resolve_within_root(self._project_root, staging_ref_for(task_id))
        receipt = resolve_within_root(
            self._project_root, staging_ref_for(task_id) + ".fetched.json"
        )
        if dest.is_file():
            return media_receipt_matches(receipt, dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._fetcher.fetch(reference, dest)
        except Exception:  # noqa: BLE001 - cost is settled; media is retryable
            return False
        try:
            receipt_payload = json.dumps({"sha256": file_sha256(dest)}, sort_keys=True)
            receipt.write_text(receipt_payload + "\n", encoding="utf-8")
        except (OSError, AiVideoWorkflowError):
            return False  # fetched but unverifiable -> media pending
        return True

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
                "model": spec.model_id,
                "first_frame_image": spec.first_frame_image,
                # best-effort idempotency key for the provider; the
                # authoritative guarantee is the reservation.
                "operation_id": request.operation_id,
            },
        )


# Same cap as the provider boundary (cloud_minimax), enforced here BEFORE a
# reservation is held so an oversized inline image can never leak a hold.
_MAX_FIRST_FRAME_DATA_URL_LEN = 8 * 1024 * 1024


def _validate_first_frame_image(value: str) -> str:
    # image-to-video first frame: public URL or inline image data URL only —
    # never a local path (which could leak a path or exfiltrate a local file).
    if value.startswith(("http://", "https://")):
        return value
    if value.startswith("data:image/"):
        if len(value) > _MAX_FIRST_FRAME_DATA_URL_LEN:
            raise CoordinatorError("first_frame_image: data URL too large")
        return value
    raise CoordinatorError(
        "first_frame_image: must be a public http(s) URL or an image data URL "
        "(local paths are not allowed)"
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
    first_frame_image = request.first_frame_image
    if first_frame_image is not None:
        first_frame_image = _validate_first_frame_image(first_frame_image)
    if request.capability == "image_to_video" and first_frame_image is None:
        raise CoordinatorError(
            "first_frame_image: required for the image_to_video capability"
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
        first_frame_image=first_frame_image,
    )


def _submit_phase(provider, request: ProviderRequest, now: datetime):
    """prepare + submit. Failures classified by whether a job was created.

    prepare is local (pre-dispatch); a submit error is only a safe
    'technical' failure when it PROVES no remote job — a timeout / response
    error / generic network error may have been received (ambiguous). A
    request rejected pre-generation (invalid params / no balance) is no
    charge but must not fall back.
    """
    try:
        prepared = provider.prepare(request, observed_at=now)
    except (ProviderRequestRejectedError, InvalidProviderRequestError) as exc:
        raise _RequestRejected(str(exc)) from exc
    except CloudProviderError as exc:
        raise _TechnicalFailure(str(exc)) from exc
    try:
        return provider.submit(request, prepared, observed_at=now)
    except (ProviderRequestRejectedError, InvalidProviderRequestError) as exc:
        # a provider-boundary request-validation error is raised client-side
        # before dispatch: no job, no charge — but the request is bad, so it
        # must not fall back (and must never leak a held reservation).
        raise _RequestRejected(str(exc)) from exc
    except _SAFE_NO_CHARGE_SUBMIT as exc:
        raise _TechnicalFailure(str(exc)) from exc
    except CloudProviderError as exc:
        raise _AmbiguousResult(str(exc)) from exc


def _poll_collect_phase(
    provider,
    request: ProviderRequest,
    current,
    now: datetime,
    sleeper: Callable[[float], None],
    interval_seconds: float,
):
    """poll + collect, paced by ``sleeper`` between polls.

    Post-submit the job may be charged. Only a provider that DECLARES no
    charge (ProviderNoChargeFailureError) may be released and fall back;
    every other failure/terminal status is ambiguous ->
    needs_reconciliation.
    """
    try:
        for index in range(_MAX_POLLS):
            # poll first so a job that is already done incurs no wait; sleep
            # only between successive polls of a still-running job.
            if index > 0:
                sleeper(interval_seconds)
            current = provider.poll(request, current, observed_at=now)
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
    except ProviderNoChargeFailureError as exc:
        raise _TechnicalFailure(str(exc)) from exc
    except ProviderVendorError as exc:
        raise _AmbiguousResult(str(exc)) from exc
    except CloudProviderError as exc:
        raise _AmbiguousResult(str(exc)) from exc
    raise _AmbiguousResult("provider did not reach a terminal state")
