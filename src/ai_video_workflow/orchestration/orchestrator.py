"""Public provider orchestrator facade and end-to-end integration.

`ProviderOrchestrator` is the stateless public entry point (§4.2). It
holds a `VideoProvider` and a pure `_OrchestrationPlanner`, builds a
`_FileOrchestrationExecutor` per call from the context project root,
and wires the approved end-to-end behavior: §6.1 input validation,
§7.2 operation identity / NO_OP, §17.2 lifecycle admission (including
REDRIVE / REPAIR / E-unknown / E-recovery), the §11.5/§12 durable
call ordering (INTENT → MAY_HAVE_STARTED landed before the Provider
call; never auto-resubmit), and the resume assessment over all
durable phases. It owns no persistent state, never reads the clock,
never touches the filesystem directly, and calls the Provider at most
once per entry.
"""

from __future__ import annotations

from datetime import datetime

from ai_video_workflow.manifest import ManifestStatus
from ai_video_workflow.orchestration._models import (
    ABSENT,
    _ExecutablePlan,
    _PendingApply,
    _PendingProviderCall,
    _StableStateSnapshot,
)
from ai_video_workflow.orchestration.canonical import _make_snapshot_wrapper
from ai_video_workflow.orchestration.errors import (
    ConflictingProviderResultError,
    IdempotencyConflictError,
    InvalidOrchestrationInputError,
    InvalidOrchestrationStateError,
    InvalidRecoveryRecordError,
    MissingRecoveryRecordError,
    PartialCommitConflictError,
    UnknownProviderSideEffectError,
)
from ai_video_workflow.orchestration.executor import (
    _FileOrchestrationExecutor,
)
from ai_video_workflow.orchestration.models import (
    OrchestrationAction,
    OrchestrationContext,
    OrchestrationOutcome,
    OrchestrationPlan,
    OrchestrationRecord,
    OutcomeKind,
    RecordPhase,
    RecoveryDisposition,
    ResumeAssessment,
)
from ai_video_workflow.orchestration.planning import (
    _NoOpDecision,
    _OrchestrationPlanner,
)
from ai_video_workflow.orchestration.recovery import (
    _classify_orchestration_traces,
    _restore_provider_result,
)
from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.models import (
    ArtifactReference,
    ProviderResult,
    ProviderStatus,
)
from ai_video_workflow.serialization import model_to_json
from ai_video_workflow.validation import validate_stable_id

_TERMINAL_STATUSES = frozenset(
    {
        ProviderStatus.SUCCEEDED,
        ProviderStatus.FAILED,
        ProviderStatus.CANCELLED,
    }
)

_POLLABLE_STATUSES = frozenset(
    {
        ProviderStatus.WAITING_FOR_USER,
        ProviderStatus.PROCESSING,
        ProviderStatus.ARTIFACT_AVAILABLE,
    }
)

_COLLECTABLE_STATUSES = frozenset(
    {ProviderStatus.WAITING_FOR_USER, ProviderStatus.ARTIFACT_AVAILABLE}
)

_CALL_PHASES = frozenset(
    {
        RecordPhase.PROVIDER_CALL_INTENT,
        RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
        RecordPhase.PROVIDER_RESULT_UNKNOWN,
    }
)


class ProviderOrchestrator:
    """Stateless public orchestration service over one VideoProvider."""

    __slots__ = ("_provider", "_executor", "_planner")

    def __init__(self, provider: VideoProvider) -> None:
        if not isinstance(provider, VideoProvider):
            raise InvalidOrchestrationInputError(
                f"provider: expected a VideoProvider, got {type(provider).__name__}"
            )
        self._provider = provider
        self._executor: _FileOrchestrationExecutor | None = None
        self._planner = _OrchestrationPlanner()

    # --- public action entry points (§4.2) ---

    def prepare(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
    ) -> OrchestrationOutcome:
        return self._run(
            context,
            action=OrchestrationAction.PREPARE,
            operation_id=operation_id,
            observed_at=observed_at,
        )

    def submit(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
    ) -> OrchestrationOutcome:
        return self._run(
            context,
            action=OrchestrationAction.SUBMIT,
            operation_id=operation_id,
            observed_at=observed_at,
        )

    def poll(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
    ) -> OrchestrationOutcome:
        return self._run(
            context,
            action=OrchestrationAction.POLL,
            operation_id=operation_id,
            observed_at=observed_at,
        )

    def report_artifact(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        artifact: ArtifactReference,
        observed_at: datetime,
    ) -> OrchestrationOutcome:
        if type(artifact) is not ArtifactReference:
            raise InvalidOrchestrationInputError(
                "artifact: report_artifact requires an ArtifactReference"
            )
        return self._run(
            context,
            action=OrchestrationAction.REPORT_ARTIFACT,
            operation_id=operation_id,
            observed_at=observed_at,
            artifact_input=artifact,
        )

    def collect(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
        artifact: ArtifactReference | None = None,
        completed_at: datetime | None = None,
    ) -> OrchestrationOutcome:
        if artifact is not None and type(artifact) is not ArtifactReference:
            raise InvalidOrchestrationInputError(
                "artifact: expected an ArtifactReference or None"
            )
        return self._run(
            context,
            action=OrchestrationAction.COLLECT,
            operation_id=operation_id,
            observed_at=observed_at,
            artifact_input=artifact,
            completed_at_input=completed_at,
        )

    def replay_result(
        self,
        context: OrchestrationContext,
        result: ProviderResult,
        *,
        operation_id: str,
    ) -> OrchestrationOutcome:
        if type(result) is not ProviderResult:
            raise InvalidOrchestrationInputError(
                "result: replay_result requires a ProviderResult"
            )
        return self._run(
            context,
            action=OrchestrationAction.REPLAY_RESULT,
            operation_id=operation_id,
            observed_at=result.observed_at,
            completed_at_input=result.completed_at,
            caller_result=result,
        )

    def resume(self, context: OrchestrationContext) -> ResumeAssessment:
        """Assess one task's resumable state; controlled auto-repair only.

        Fixed ordering: (1) static context validation; (2) caller
        snapshot-vs-disk staleness — raises, and takes priority over a
        malformed record; (3) strict durable-record parse; (4) request
        consistency; (5) task/shot/provider identity; (6) stable-bearing
        committed-state S1; (7) phase-specific classification. It never
        calls the Provider and never resubmits; only an interrupted
        APPLYING is auto-repaired to STABLE (§17.2 REPAIR / §14 P3-P8),
        and a malformed/manual record is never repaired.
        """
        self._require_context(context)
        executor = self._new_executor(context)
        # (2) snapshot-vs-disk is checked BEFORE the strict record parse so a
        # stale/drifted caller context is rejected (raise) with priority over
        # a malformed record. read_business_state omits the record parse; a
        # transient filesystem / missing-required error propagates unchanged.
        business = executor.read_business_state(context.task.task_id)
        self._require_snapshot_matches_disk(context, business)
        # (3) strict record parse. A malformed / corrupt durable record
        # (§14 E1/S0) with a current context is a manual-reconciliation state,
        # marked RECOVERY_REQUIRED (never the clean-∅ None), MANUAL — not
        # CONFLICT (CONFLICT is reserved for external drift P9/S1/R3).
        try:
            observation = executor.read_project_state(context.task.task_id)
        except InvalidRecoveryRecordError:
            return self._manual_assessment(
                context,
                phase=RecordPhase.RECOVERY_REQUIRED,
                disposition=RecoveryDisposition.MANUAL_RECONCILIATION,
            )
        record = observation.record
        stable = None if record is None else record.stable
        # (4) request drift and (5) identity mismatch on a stable-bearing
        # record are invalid context (raise), not assessments.
        if stable is not None:
            self._planner.check_request_consistency(context.request, stable)
            self._require_resume_identity(context, observation, stable)
        if record is None:
            if _classify_orchestration_traces(
                task=observation.task,
                manifest=observation.manifest,
                instruction_exists=observation.instruction_text is not None,
            ):
                # record lost but orchestration traces exist (§13.5 / R1): a
                # manual-reconciliation state marked RECOVERY_REQUIRED; no
                # record is created, traces are not cleared, never collapsed
                # to the clean-∅ None.
                return self._manual_assessment(
                    context,
                    phase=RecordPhase.RECOVERY_REQUIRED,
                    disposition=RecoveryDisposition.MANUAL_RECONCILIATION,
                )
            return self._empty_assessment(context)
        phase = record.phase
        # APPLYING is judged by the fingerprint-authoritative recovery, not the
        # strict before-state S1 (an apply legitimately advances files); a file
        # that is neither before nor after is §14 P9 -> CONFLICT.
        if phase is RecordPhase.APPLYING:
            return self._resume_applying(context, executor)
        # (6) No stable-bearing phase bypasses S1 — STABLE, INTENT,
        # MAY_HAVE_STARTED, RESULT_UNKNOWN, and an already-landed
        # RECOVERY_REQUIRED all run the §13.2 S1 verifier first (only when a
        # committed stable snapshot is present). External committed-file drift
        # is a CONFLICT (report only; the record phase is preserved per §6.2
        # invariant 3; no durable mutation) and takes precedence over the
        # phase's clean disposition.
        if record.stable is not None and not executor.committed_state_matches(
            record.stable, observation
        ):
            return self._s1_conflict_assessment(context, phase, record.stable)
        # (7) clean committed state: phase-specific classification.
        # An already-landed RECOVERY_REQUIRED that still matches its committed
        # baseline is the uniform MANUAL_RECONCILIATION (§14 does not re-derive
        # the original cause); a drifted one was already returned as CONFLICT.
        if phase is RecordPhase.RECOVERY_REQUIRED:
            return self._manual_assessment(
                context,
                phase=RecordPhase.RECOVERY_REQUIRED,
                disposition=RecoveryDisposition.MANUAL_RECONCILIATION,
                last_completed_action=(
                    None
                    if record.stable is None
                    else record.stable.last_completed_action
                ),
            )
        if phase is RecordPhase.STABLE:
            return self._stable_assessment(
                context, record.stable, RecoveryDisposition.NONE
            )
        if phase is RecordPhase.PROVIDER_CALL_INTENT:
            return ResumeAssessment(
                task_id=context.task.task_id,
                shot_id=context.task.shot_id,
                provider_id=context.request.provider_id,
                phase=phase,
                last_completed_action=record.stable.last_completed_action,
                legal_actions=(record.pending.action,),
                preferred_next_action=record.pending.action,
                is_terminal=False,
                requires_manual_reconciliation=False,
                disposition=RecoveryDisposition.SAFE_AUTO_RETRY,
            )
        # PROVIDER_CALL_MAY_HAVE_STARTED / PROVIDER_RESULT_UNKNOWN
        return self._manual_assessment(
            context,
            phase=phase,
            disposition=RecoveryDisposition.MANUAL_RECONCILIATION,
            last_completed_action=record.stable.last_completed_action,
        )

    # --- core action pipeline ---

    def _run(
        self,
        context: OrchestrationContext,
        *,
        action: OrchestrationAction,
        operation_id: str,
        observed_at: datetime,
        artifact_input: ArtifactReference | None = None,
        completed_at_input: datetime | None = None,
        caller_result: ProviderResult | None = None,
        _repaired: bool = False,
    ) -> OrchestrationOutcome:
        self._require_context(context)
        validate_stable_id(operation_id, field_name="operation_id")
        executor = self._new_executor(context)
        observation = executor.read_project_state(context.task.task_id)
        self._require_snapshot_matches_disk(context, observation)
        record = observation.record

        # --- durable-phase routing (§17.2 rows 9-13) ---
        if record is not None and record.phase is not RecordPhase.STABLE:
            if record.phase in _CALL_PHASES:
                return self._route_call_phase(
                    context,
                    executor,
                    record,
                    action=action,
                    operation_id=operation_id,
                    observed_at=observed_at,
                    artifact_input=artifact_input,
                    completed_at_input=completed_at_input,
                )
            if record.phase is RecordPhase.APPLYING:
                if _repaired:
                    raise InvalidOrchestrationStateError(
                        "recovery: applying record did not resolve to stable"
                    )
                executor.recover(context.task.task_id)
                return self._run(
                    context,
                    action=action,
                    operation_id=operation_id,
                    observed_at=observed_at,
                    artifact_input=artifact_input,
                    completed_at_input=completed_at_input,
                    caller_result=caller_result,
                    _repaired=True,
                )
            # RECOVERY_REQUIRED -> executor.recover raises the mapped error
            executor.recover(context.task.task_id)
            raise InvalidOrchestrationStateError(
                "recovery: record requires manual reconciliation"
            )

        stable = None if record is None else record.stable
        if record is None and _classify_orchestration_traces(
            task=observation.task,
            manifest=observation.manifest,
            instruction_exists=observation.instruction_text is not None,
        ):
            raise MissingRecoveryRecordError(
                "recovery: the orchestration record is missing but "
                "orchestration traces exist"
            )

        # Fixed stable-bearing order (§1): (4) request + identity, (5) the
        # single executor-owned §13.2 S1 committed-state verifier, (6)
        # instruction carry-over — in that order. S1 precedes the instruction
        # carry-over so an instruction-bytes drift is a
        # PartialCommitConflictError (not an InvalidOrchestrationInputError),
        # and precedes routing / replay / any Provider call or WAL write. It
        # runs only when a committed stable baseline exists.
        request_fingerprint = self._planner.check_request_consistency(
            context.request, stable
        )
        self._require_identity_preconditions(context, observation, stable)
        if stable is not None:
            executor.verify_committed_state(stable, observation)
        self._require_instruction_preconditions(context, observation, stable)
        status = None if stable is None else _provider_status(stable)

        # §7.2 committed-operation replay precedes admission so a
        # response-loss retry of the last committed provider-calling
        # operation is a NO_OP (not an E-state) regardless of the current
        # committed status. replay_result identity is judged by the planner.
        if action is not OrchestrationAction.REPLAY_RESULT and stable is not None:
            replay = self._precall_operation_replay(
                stable,
                action=action,
                operation_id=operation_id,
                observed_at=observed_at,
                artifact_input=artifact_input,
                completed_at_input=completed_at_input,
                request_fingerprint=request_fingerprint,
            )
            if replay is not None:
                return self._noop_outcome(context, stable, replay, provider_result=None)

        route = _route(status, action)
        if route == "e_state":
            raise InvalidOrchestrationStateError(
                f"action: {action.value} is not admissible in state "
                f"{'empty' if status is None else status.value}"
            )
        if route == "noop_repeated_prepare":
            return self._noop_outcome(
                context, stable, "repeated_prepare", provider_result=None
            )
        if route == "noop_already_collected":
            return self._collect_terminal_noop(context, stable, artifact_input)
        if route == "replay":
            return self._apply_via_plan(
                context,
                executor,
                stable,
                observation,
                action=action,
                operation_id=operation_id,
                observed_at=observed_at,
                artifact_input=artifact_input,
                completed_at_input=completed_at_input,
                result=caller_result,
                request_fingerprint=request_fingerprint,
                provider_called=False,
            )
        if route == "call_intent":
            return self._call_intent(
                context,
                executor,
                stable,
                observation,
                action=action,
                operation_id=operation_id,
                observed_at=observed_at,
                artifact_input=artifact_input,
                completed_at_input=completed_at_input,
                request_fingerprint=request_fingerprint,
            )
        return self._call_direct(
            context,
            executor,
            stable,
            observation,
            action=action,
            operation_id=operation_id,
            observed_at=observed_at,
            artifact_input=artifact_input,
            completed_at_input=completed_at_input,
            request_fingerprint=request_fingerprint,
        )

    # --- direct path (prepare / poll / report_artifact): no pre-call WAL ---

    def _call_direct(
        self,
        context,
        executor,
        stable,
        observation,
        *,
        action,
        operation_id,
        observed_at,
        artifact_input,
        completed_at_input,
        request_fingerprint,
    ) -> OrchestrationOutcome:
        # a terminal manifest cannot be updated (§17.5); reject before the call
        _require_updatable_manifest(observation)
        result = self._invoke_provider(
            context, stable, action, observed_at, artifact_input, completed_at_input
        )
        return self._apply_via_plan(
            context,
            executor,
            stable,
            observation,
            action=action,
            operation_id=operation_id,
            observed_at=observed_at,
            artifact_input=artifact_input,
            completed_at_input=completed_at_input,
            result=result,
            request_fingerprint=request_fingerprint,
            provider_called=True,
        )

    # --- pre-call WAL path (submit / collect): INTENT -> MAY_HAVE_STARTED ---

    def _call_intent(
        self,
        context,
        executor,
        stable,
        observation,
        *,
        action,
        operation_id,
        observed_at,
        artifact_input,
        completed_at_input,
        request_fingerprint,
    ) -> OrchestrationOutcome:
        # a terminal manifest cannot be updated (§17.5); reject before the
        # pre-call WAL writes and the Provider call
        _require_updatable_manifest(observation)
        task_id = context.task.task_id
        intent = self._build_call(
            action,
            operation_id,
            context.request,
            request_fingerprint,
            stable,
            observed_at,
            artifact_input,
            completed_at_input,
            RecordPhase.PROVIDER_CALL_INTENT,
        )
        executor.write_pending_call_intent(task_id, stable, intent)
        started = self._build_call(
            action,
            operation_id,
            context.request,
            request_fingerprint,
            stable,
            observed_at,
            artifact_input,
            completed_at_input,
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
        )
        executor.write_pending_call_intent(task_id, stable, started)
        try:
            result = self._invoke_provider(
                context,
                stable,
                action,
                observed_at,
                artifact_input,
                completed_at_input,
            )
        except Exception as exc:
            unknown = self._build_call(
                action,
                operation_id,
                context.request,
                request_fingerprint,
                stable,
                observed_at,
                artifact_input,
                completed_at_input,
                RecordPhase.PROVIDER_RESULT_UNKNOWN,
            )
            executor.write_pending_call_intent(task_id, stable, unknown)
            raise UnknownProviderSideEffectError(
                f"{action.value}: the provider call outcome is unknown; "
                "automatic recovery must not resubmit"
            ) from exc
        return self._apply_via_plan(
            context,
            executor,
            stable,
            observation,
            action=action,
            operation_id=operation_id,
            observed_at=observed_at,
            artifact_input=artifact_input,
            completed_at_input=completed_at_input,
            result=result,
            request_fingerprint=request_fingerprint,
            provider_called=True,
        )

    # --- second planning + apply, shared by direct / intent / replay ---

    def _apply_via_plan(
        self,
        context,
        executor,
        stable,
        observation,
        *,
        action,
        operation_id,
        observed_at,
        artifact_input,
        completed_at_input,
        result,
        request_fingerprint,
        provider_called,
    ) -> OrchestrationOutcome:
        plan = self._planner.plan(
            action=action,
            operation_id=operation_id,
            request=context.request,
            task=observation.task,
            manifest=observation.manifest,
            stable=stable,
            result=result,
            observed_at=observed_at,
            artifact_input=artifact_input,
            completed_at_input=completed_at_input,
            task_before_fingerprint=observation.task_fingerprint,
            manifest_before_fingerprint=observation.manifest_fingerprint,
            instruction_before_fingerprint=observation.instruction_fingerprint,
            instruction_before_text=observation.instruction_text,
        )
        if isinstance(plan, _NoOpDecision):
            return self._noop_outcome(
                context,
                stable,
                plan.reason,
                provider_result=result,
            )
        executor.write_apply_intent(context.task.task_id, stable, plan)
        executor.commit_apply(plan)
        return self._applied_outcome(context, plan, result)

    # --- durable call-phase routing (§17.2 rows 9-11) ---

    def _route_call_phase(
        self,
        context,
        executor,
        record,
        *,
        action,
        operation_id,
        observed_at,
        artifact_input,
        completed_at_input,
    ) -> OrchestrationOutcome:
        # Every provider-call phase carries a committed stable snapshot, so
        # the fixed stable-bearing order (§1) applies here too: a fresh
        # snapshot-vs-disk (2), request + identity (4), and the single §13.2
        # S1 committed-state verifier (5) all run BEFORE any phase-specific
        # routing — including the MAY_HAVE_STARTED / RESULT_UNKNOWN
        # unknown-side-effect error and the INTENT redrive. A committed drift
        # is therefore a PartialCommitConflictError with zero Provider calls,
        # never masked by the unknown-side-effect error.
        stable = record.stable
        observation = executor.read_project_state(context.task.task_id)
        self._require_snapshot_matches_disk(context, observation)
        request_fingerprint = self._planner.check_request_consistency(
            context.request, stable
        )
        self._require_identity_preconditions(context, observation, stable)
        executor.verify_committed_state(stable, observation)

        if record.phase in (
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
            RecordPhase.PROVIDER_RESULT_UNKNOWN,
        ):
            raise UnknownProviderSideEffectError(
                "recovery: a provider call may have started; automatic "
                "recovery must not resubmit"
            )
        # PROVIDER_CALL_INTENT: REDRIVE only for the same action + identity
        pending = record.pending
        if action is not pending.action:
            raise InvalidOrchestrationStateError(
                f"action: {action.value} is illegal while a "
                f"{pending.action.value} call intent is pending"
            )
        _snapshot, action_input_fingerprint = self._planner.action_input_fingerprint(
            observed_at=observed_at,
            artifact=artifact_input,
            completed_at=completed_at_input,
            result_fingerprint=None,
        )
        if (
            operation_id != pending.operation_id
            or request_fingerprint != pending.request_fingerprint
            or action_input_fingerprint != pending.action_input_fingerprint
        ):
            raise IdempotencyConflictError(
                "operation: a different identity cannot redrive the pending call intent"
            )
        # step 6 instruction carry-over before the redriven Provider call
        self._require_instruction_preconditions(context, observation, stable)
        return self._call_intent(
            context,
            executor,
            stable,
            observation,
            action=action,
            operation_id=operation_id,
            observed_at=observed_at,
            artifact_input=artifact_input,
            completed_at_input=completed_at_input,
            request_fingerprint=request_fingerprint,
        )

    # --- provider invocation (at most one call per entry) ---

    def _invoke_provider(
        self,
        context,
        stable,
        action,
        observed_at,
        artifact_input,
        completed_at_input,
    ) -> ProviderResult:
        request = context.request
        if action is OrchestrationAction.PREPARE:
            return self._provider.prepare(request, observed_at=observed_at)
        current = _restore_provider_result(stable.last_result_snapshot)
        if action is OrchestrationAction.SUBMIT:
            return self._provider.submit(request, current, observed_at=observed_at)
        if action is OrchestrationAction.POLL:
            return self._provider.poll(request, current, observed_at=observed_at)
        if action is OrchestrationAction.REPORT_ARTIFACT:
            return self._provider.poll(
                request,
                current,
                observed_at=observed_at,
                reported_artifact=artifact_input,
            )
        if action is OrchestrationAction.COLLECT:
            return self._provider.collect(
                request,
                current,
                artifact=artifact_input,
                observed_at=observed_at,
                completed_at=completed_at_input,
            )
        raise InvalidOrchestrationStateError(
            f"action: {action.value} does not invoke the provider"
        )

    # --- pre-call operation identity (§7.2) ---

    def _precall_operation_replay(
        self,
        stable,
        *,
        action,
        operation_id,
        observed_at,
        artifact_input,
        completed_at_input,
        request_fingerprint,
    ) -> str | None:
        if stable is None:
            return None
        _snapshot, action_input_fingerprint = self._planner.action_input_fingerprint(
            observed_at=observed_at,
            artifact=artifact_input,
            completed_at=completed_at_input,
            result_fingerprint=None,
        )
        operation = stable.last_committed_operation
        if operation_id != operation["operation_id"]:
            return None
        if (
            action.value == operation["action"]
            and request_fingerprint == operation["request_fingerprint"]
            and action_input_fingerprint == operation["action_input_fingerprint"]
        ):
            return "committed_operation_replay"
        raise IdempotencyConflictError(
            "operation_id: reused with a different action or inputs"
        )

    def _collect_terminal_noop(
        self, context, stable, artifact_input
    ) -> OrchestrationOutcome:
        if artifact_input is not None:
            authoritative = (
                None
                if stable.authoritative_artifact is None
                else dict(stable.authoritative_artifact["payload"])
            )
            if artifact_input.to_json_dict() != authoritative:
                raise ConflictingProviderResultError(
                    "artifact: conflicts with the authoritative collected handoff"
                )
        return self._noop_outcome(
            context, stable, "already_collected", provider_result=None
        )

    # --- durable pending-call construction ---

    def _build_call(
        self,
        action,
        operation_id,
        request,
        request_fingerprint,
        stable,
        observed_at,
        artifact_input,
        completed_at_input,
        call_phase,
    ) -> _PendingProviderCall:
        request_wrapper = _make_snapshot_wrapper(
            "provider_request", request.to_json_dict()
        )
        action_input_snapshot, action_input_fingerprint = (
            self._planner.action_input_fingerprint(
                observed_at=observed_at,
                artifact=artifact_input,
                completed_at=completed_at_input,
                result_fingerprint=None,
            )
        )
        artifact_wrapper = (
            None
            if artifact_input is None
            else _make_snapshot_wrapper(
                "artifact_reference", artifact_input.to_json_dict()
            )
        )
        return _PendingProviderCall(
            operation_id=operation_id,
            action=action,
            baseline_version=stable.version,
            request_snapshot=request_wrapper,
            request_fingerprint=request_fingerprint,
            action_input_snapshot=action_input_snapshot,
            action_input_fingerprint=action_input_fingerprint,
            original_observed_at=observed_at,
            original_completed_at=completed_at_input,
            artifact_input=artifact_wrapper,
            call_phase=call_phase,
            call_may_have_started=(call_phase is not RecordPhase.PROVIDER_CALL_INTENT),
            started_at=observed_at,
            recovery_policy=RecoveryDisposition.MANUAL_RECONCILIATION,
        )

    # --- outcome / assessment construction ---

    def _applied_outcome(
        self, context, plan: _ExecutablePlan, result: ProviderResult
    ) -> OrchestrationOutcome:
        pending = plan.pending_apply
        artifact_handoff = (
            result.artifact
            if plan.action is OrchestrationAction.COLLECT
            and result.status is ProviderStatus.SUCCEEDED
            else None
        )
        public_plan = OrchestrationPlan(
            plan_id=plan.plan_id,
            operation_id=plan.operation_id,
            action=plan.action,
            task_id=plan.task_id,
            shot_id=plan.shot_id,
            provider_id=plan.provider_id,
            baseline_version=plan.baseline_version,
            request_fingerprint=pending.request_fingerprint,
            result_fingerprint=pending.result_fingerprint,
            before_fingerprints=dict(pending.before_fingerprints),
            after_fingerprints={
                "task": pending.task_after_fingerprint,
                "manifest": pending.manifest_after_fingerprint,
                "instruction": pending.instruction_after_fingerprint,
            },
            task_after_snapshot=dict(pending.task_after_snapshot),
            manifest_after_snapshot=dict(pending.manifest_after_snapshot),
            instruction_fingerprint=pending.instruction_after_fingerprint,
            legal_actions=pending.post_commit_legal_actions,
            preferred_next_action=pending.post_commit_preferred_next_action,
            artifact_handoff=artifact_handoff,
        )
        record = OrchestrationRecord(
            exists=True,
            phase=RecordPhase.STABLE,
            task_id=context.task.task_id,
            shot_id=context.task.shot_id,
            provider_id=context.task.provider_id,
            stable_version=plan.baseline_version + 1,
            last_completed_action=plan.action,
            provider_status=result.status,
            pending_operation_id=None,
            pending_action=None,
            pending_plan_id=None,
        )
        return OrchestrationOutcome(
            kind=OutcomeKind.APPLIED,
            plan=public_plan,
            no_op_reason=None,
            record=record,
            legal_actions=pending.post_commit_legal_actions,
            preferred_next_action=pending.post_commit_preferred_next_action,
            provider_result=result,
            artifact_handoff=artifact_handoff,
        )

    def _noop_outcome(
        self,
        context,
        stable: _StableStateSnapshot | None,
        reason: str,
        *,
        provider_result: ProviderResult | None,
    ) -> OrchestrationOutcome:
        legal, preferred = self._planner.legal_actions_for(stable)
        phase = None if stable is None else RecordPhase.STABLE
        record = self._record_from_stable(context, phase, stable, None)
        return OrchestrationOutcome(
            kind=OutcomeKind.NO_OP,
            plan=None,
            no_op_reason=reason,
            record=record,
            legal_actions=legal,
            preferred_next_action=preferred,
            provider_result=provider_result,
            artifact_handoff=None,
        )

    def _record_from_stable(
        self,
        context,
        phase: RecordPhase | None,
        stable: _StableStateSnapshot | None,
        pending,
    ) -> OrchestrationRecord:
        if phase is None:
            return OrchestrationRecord(
                exists=False,
                phase=None,
                task_id=context.task.task_id,
                shot_id=context.task.shot_id,
                provider_id=context.task.provider_id,
                stable_version=None,
                last_completed_action=None,
                provider_status=None,
                pending_operation_id=None,
                pending_action=None,
                pending_plan_id=None,
            )
        stable_version = None if stable is None else stable.version
        last_completed = None if stable is None else stable.last_completed_action
        provider_status = None if stable is None else _provider_status(stable)
        pending_operation_id = None
        pending_action = None
        pending_plan_id = None
        if pending is not None:
            pending_operation_id = pending.operation_id
            pending_action = pending.action
            if isinstance(pending, _PendingApply):
                pending_plan_id = pending.plan_id
        return OrchestrationRecord(
            exists=True,
            phase=phase,
            task_id=context.task.task_id,
            shot_id=context.task.shot_id,
            provider_id=context.task.provider_id,
            stable_version=stable_version,
            last_completed_action=last_completed,
            provider_status=provider_status,
            pending_operation_id=pending_operation_id,
            pending_action=pending_action,
            pending_plan_id=pending_plan_id,
        )

    def _empty_assessment(self, context) -> ResumeAssessment:
        return ResumeAssessment(
            task_id=context.task.task_id,
            shot_id=context.task.shot_id,
            provider_id=context.request.provider_id,
            phase=None,
            last_completed_action=None,
            legal_actions=(OrchestrationAction.PREPARE,),
            preferred_next_action=OrchestrationAction.PREPARE,
            is_terminal=False,
            requires_manual_reconciliation=False,
            disposition=RecoveryDisposition.NONE,
        )

    def _stable_assessment(self, context, stable, disposition) -> ResumeAssessment:
        legal, preferred = self._planner.legal_actions_for(stable)
        status = _provider_status(stable)
        return ResumeAssessment(
            task_id=context.task.task_id,
            shot_id=context.task.shot_id,
            provider_id=context.request.provider_id,
            phase=RecordPhase.STABLE,
            last_completed_action=stable.last_completed_action,
            legal_actions=legal,
            preferred_next_action=preferred,
            is_terminal=status in _TERMINAL_STATUSES,
            requires_manual_reconciliation=False,
            disposition=disposition,
        )

    def _manual_assessment(
        self,
        context,
        *,
        phase: RecordPhase | None,
        disposition: RecoveryDisposition,
        last_completed_action=None,
    ) -> ResumeAssessment:
        return ResumeAssessment(
            task_id=context.task.task_id,
            shot_id=context.task.shot_id,
            provider_id=context.request.provider_id,
            phase=phase,
            last_completed_action=last_completed_action,
            legal_actions=(),
            preferred_next_action=None,
            is_terminal=False,
            requires_manual_reconciliation=True,
            disposition=disposition,
        )

    def _resume_applying(self, context, executor) -> ResumeAssessment:
        try:
            executor.recover(context.task.task_id)
        except PartialCommitConflictError:
            # §14 P9: a state file is neither before nor after; recovery has
            # landed a durable RECOVERY_REQUIRED. Report the conflict cause.
            return self._manual_assessment(
                context,
                phase=RecordPhase.RECOVERY_REQUIRED,
                disposition=RecoveryDisposition.CONFLICT,
            )
        except InvalidRecoveryRecordError:
            # §14 E1/S0 surfaced during recovery: manual reconciliation, not
            # an external-drift conflict.
            return self._manual_assessment(
                context,
                phase=RecordPhase.RECOVERY_REQUIRED,
                disposition=RecoveryDisposition.MANUAL_RECONCILIATION,
            )
        # Any other failure (e.g. a transient PersistenceExecutionError that
        # did not durably change the record, or an unexpected error) is not
        # folded into a false conflict assessment — it propagates.
        reread = executor.read_project_state(context.task.task_id)
        if reread.record is not None and reread.record.phase is RecordPhase.STABLE:
            return self._stable_assessment(
                context, reread.record.stable, RecoveryDisposition.SAFE_AUTO_RETRY
            )
        return self._manual_assessment(
            context,
            phase=RecordPhase.RECOVERY_REQUIRED,
            disposition=RecoveryDisposition.MANUAL_RECONCILIATION,
        )

    # --- context validation ---

    def _require_context(self, context) -> None:
        if type(context) is not OrchestrationContext:
            raise InvalidOrchestrationInputError(
                "context: expected an OrchestrationContext, "
                f"got {type(context).__name__}"
            )
        request = context.request
        task = context.task
        manifest = context.manifest
        if task.task_id != request.task_id or task.shot_id != request.shot_id:
            raise InvalidOrchestrationInputError(
                "context: task identity must match the request identity"
            )
        if manifest.step_name != f"generation:{task.task_id}":
            raise InvalidOrchestrationInputError(
                "manifest.step_name: must equal generation:<task_id>"
            )
        if self._provider.provider_id != request.provider_id:
            raise InvalidOrchestrationInputError(
                "request.provider_id: must match the provider identity"
            )

    def _require_snapshot_matches_disk(self, context, observation) -> None:
        from ai_video_workflow.orchestration.canonical import _sha256_hex

        task_bytes_fp = _sha256_hex(model_to_json(context.task).encode("utf-8"))
        if task_bytes_fp != observation.task_fingerprint:
            raise InvalidOrchestrationInputError(
                "context.task: does not match the on-disk task file (§9)"
            )
        manifest_bytes_fp = _sha256_hex(model_to_json(context.manifest).encode("utf-8"))
        if manifest_bytes_fp != observation.manifest_fingerprint:
            raise InvalidOrchestrationInputError(
                "context.manifest: does not match the on-disk manifest file (§9)"
            )

    def _require_identity_preconditions(self, context, observation, stable) -> None:
        """§7.1 identity alignment — step 4, BEFORE the §13.2 S1 verifier.

        Verifies the four-way identity alignment (task/request/stable
        provider_id and stable task/shot alignment) only. For the first
        prepare (no committed stable) the sole identity precondition is
        that ``task.provider_id`` is still None. Runs before S1 so a genuine
        identity mismatch is reported as InvalidOrchestrationInputError,
        while a committed-file drift is reported by S1 (§13.2) afterwards.
        """
        task = observation.task
        request = context.request
        if stable is None:
            if task.provider_id is not None:
                raise InvalidOrchestrationInputError(
                    "task.provider_id: must be None before the first prepare"
                )
            return
        if task.provider_id != request.provider_id:
            raise InvalidOrchestrationInputError(
                "task.provider_id: must equal request.provider_id"
            )
        if (
            stable.task_id != task.task_id
            or stable.shot_id != task.shot_id
            or stable.provider_id != request.provider_id
        ):
            raise InvalidOrchestrationInputError(
                "stable: task_id, shot_id, and provider_id must match the "
                "request and task identity"
            )

    def _require_instruction_preconditions(self, context, observation, stable) -> None:
        """§6 instruction carry-over — step 6, AFTER the §13.2 S1 verifier.

        For the first prepare (no committed stable) the instruction file
        must be absent. For a subsequent action the disk instruction
        fingerprint must equal the committed carry-over fingerprint; the
        S1 verifier already enforces exactly this for a committed baseline,
        so an instruction-bytes drift surfaces as a
        PartialCommitConflictError (not an InvalidOrchestrationInputError).
        This check remains as defense in depth and to reject an instruction
        that appears with no committed baseline.
        """
        if stable is None:
            if observation.instruction_fingerprint != ABSENT:
                raise InvalidOrchestrationInputError(
                    "instruction: the first prepare requires a missing instruction file"
                )
            return
        if (
            observation.instruction_fingerprint
            != stable.committed_instruction_fingerprint
        ):
            raise InvalidOrchestrationInputError(
                "instruction: the before fingerprint must equal the committed "
                "instruction fingerprint (carry-over)"
            )

    def _require_resume_identity(self, context, observation, stable) -> None:
        """§7.1 four-way identity for resume (raise on invalid context).

        Unlike the action path, an instruction/committed-file drift is not
        raised here; it is reported as a §14 S1 CONFLICT assessment (a
        resume returns an assessment for recoverable states, §15).
        """
        task = observation.task
        request = context.request
        if task.provider_id != request.provider_id:
            raise InvalidOrchestrationInputError(
                "task.provider_id: must equal request.provider_id"
            )
        if (
            stable.task_id != task.task_id
            or stable.shot_id != task.shot_id
            or stable.provider_id != request.provider_id
        ):
            raise InvalidOrchestrationInputError(
                "stable: task_id, shot_id, and provider_id must match the "
                "request and task identity"
            )

    def _s1_conflict_assessment(
        self, context, phase: RecordPhase, stable: _StableStateSnapshot
    ) -> ResumeAssessment:
        """§14 S1 external-drift CONFLICT assessment (report only).

        The committed task/manifest/instruction files drifted from the
        stable baseline. The record phase is preserved (§6.2 invariant 3);
        no durable mutation and no Provider call occur.
        """
        return ResumeAssessment(
            task_id=context.task.task_id,
            shot_id=context.task.shot_id,
            provider_id=context.request.provider_id,
            phase=phase,
            last_completed_action=stable.last_completed_action,
            legal_actions=(),
            preferred_next_action=None,
            is_terminal=False,
            requires_manual_reconciliation=True,
            disposition=RecoveryDisposition.CONFLICT,
        )

    def _new_executor(self, context) -> _FileOrchestrationExecutor:
        return _FileOrchestrationExecutor(context.project_root)


def _require_updatable_manifest(observation) -> None:
    """Reject a terminal manifest before a Provider-calling apply (§17.5)."""
    if observation.manifest.status is not ManifestStatus.PENDING:
        raise InvalidOrchestrationStateError(
            "manifest.status: a terminal manifest cannot be updated"
        )


def _route(status: ProviderStatus | None, action: OrchestrationAction) -> str:
    """Return the §17.2 admission route for one (state, action) pair."""
    if status is None:
        if action is OrchestrationAction.PREPARE:
            return "call_direct"
        return "e_state"
    if action is OrchestrationAction.REPLAY_RESULT:
        return "replay"
    if action is OrchestrationAction.PREPARE:
        if status is ProviderStatus.NOT_SUBMITTED:
            return "noop_repeated_prepare"
        return "e_state"
    if action is OrchestrationAction.SUBMIT:
        if status is ProviderStatus.NOT_SUBMITTED:
            return "call_intent"
        return "e_state"
    if action in (OrchestrationAction.POLL, OrchestrationAction.REPORT_ARTIFACT):
        if status in _POLLABLE_STATUSES:
            return "call_direct"
        return "e_state"
    if action is OrchestrationAction.COLLECT:
        if status in _COLLECTABLE_STATUSES:
            return "call_intent"
        if status is ProviderStatus.SUCCEEDED:
            return "noop_already_collected"
        return "e_state"
    return "e_state"


def _provider_status(stable: _StableStateSnapshot) -> ProviderStatus:
    return ProviderStatus(stable.last_result_snapshot["payload"]["status"])
