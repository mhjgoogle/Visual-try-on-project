"""File-based orchestration executor: the exclusive state writer.

`_FileOrchestrationExecutor` is the only component that mutates the
four derived state files. It reads and strictly validates project
state, provides the before-fingerprints and instruction text that the
planner consumes (§9, §24.2 Step D carry-over), creates the approved
parent directories (§8.2), atomically lands each record-envelope
phase transition with transition-specific compare-and-set + identity +
equivalent-replay discipline (§11.4/§11.5), commits the first and
subsequent STABLE records (§13.0.2), and executes recovery for the
durable record — re-driving SAFE_AUTO_RETRY dispositions to STABLE,
verifying committed fingerprints on a clean STABLE (§13.2 S1), and
landing a durable RECOVERY_REQUIRED envelope before raising the mapped
error for every conflict/manual class (§14, §11.5 row 8). It NEVER
calls a Provider (the Provider-call ordering is the Step G facade),
never scans directories, and re-verifies per-component path
containment and state-target symlink safety at every read and write.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.manifest import StepManifest
from ai_video_workflow.models import GenerationTask
from ai_video_workflow.orchestration._models import (
    ABSENT,
    _build_envelope,
    _ExecutablePlan,
    _PendingApply,
    _PendingProviderCall,
    _StableStateSnapshot,
)
from ai_video_workflow.orchestration.canonical import (
    _fingerprint,
    _make_snapshot_wrapper,
    _sha256_hex,
    _thaw_mapping,
)
from ai_video_workflow.orchestration.errors import (
    BaselineMismatchError,
    InvalidRecoveryRecordError,
    MissingProjectStateError,
    MissingRecoveryRecordError,
    PartialCommitConflictError,
    PersistenceExecutionError,
)
from ai_video_workflow.orchestration.layout import _LayoutResolver, _StateLayout
from ai_video_workflow.orchestration.models import (
    OrchestrationAction,
    RecordPhase,
    RecoveryDisposition,
)
from ai_video_workflow.orchestration.recovery import (
    _classify_orchestration_traces,
    _classify_phase_recovery,
    _parse_record_envelope,
    _parse_stable_wrapper,
    _ParsedRecord,
    _restore_generation_task,
    _restore_step_manifest,
)
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.serialization import (
    model_from_json,
    model_to_dict,
    model_to_json,
)

_APPROVED_PARENT_DIRS = (
    ("records", "orchestration"),
    ("tasks", "instructions"),
    ("manifests",),
)

_CALL_PHASES = frozenset(
    {
        RecordPhase.PROVIDER_CALL_INTENT,
        RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
        RecordPhase.PROVIDER_RESULT_UNKNOWN,
    }
)

# Provider-call phases advance strictly forward by one step (§11.5 rows
# 1-3); an equal target is an idempotent replay, a lower target is an
# illegal regression.
_CALL_PHASE_ORDER = {
    RecordPhase.PROVIDER_CALL_INTENT: 0,
    RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED: 1,
    RecordPhase.PROVIDER_RESULT_UNKNOWN: 2,
}


@dataclass(frozen=True, slots=True)
class _ProjectStateObservation:
    """Observed, strictly validated on-disk state for one task."""

    task_id: str
    layout: _StateLayout
    task: GenerationTask
    manifest: StepManifest
    task_fingerprint: str
    manifest_fingerprint: str
    instruction_text: str | None
    instruction_fingerprint: str
    record: _ParsedRecord | None


@dataclass(frozen=True, slots=True)
class _ApplyOutcome:
    """Result of a committed apply: the new stable snapshot wrapper."""

    task_id: str
    stable_wrapper: dict[str, object]


@dataclass(frozen=True, slots=True)
class _RecoveryOutcome:
    """Result of a recovery classification and re-drive."""

    task_id: str
    disposition: RecoveryDisposition
    committed: bool
    stable_wrapper: dict[str, object] | None


class _FileOrchestrationExecutor:
    """Exclusive state writer, reader, and recovery executor."""

    __slots__ = ("_resolver",)

    def __init__(self, project_root: str | Path) -> None:
        self._resolver = _LayoutResolver(project_root)

    # --- reading / provision interface (§9, §13.2, §24.2 carry-over) ---

    def read_project_state(self, task_id: str) -> _ProjectStateObservation:
        """Read, symlink-check, and strictly validate the task's state.

        task/manifest are required and rebuilt through the strict model
        parser; instruction is optional (ABSENT otherwise); the record
        is parsed through the Step B strict recovery parser, so a
        malformed envelope, non-UTF-8 record bytes, or a corrupt stable
        self-fingerprint all surface here as the mapped recovery error
        (§14 E1/S0). This is the sole source of the planner's
        before-fingerprints and instruction text.
        """
        layout = self._resolver.resolve_state_layout(task_id)
        task_bytes = self._read_state_file(layout.task_path, "task", required=True)
        manifest_bytes = self._read_state_file(
            layout.manifest_path, "manifest", required=True
        )
        task = _load_model(task_bytes, GenerationTask, "task")
        manifest = _load_model(manifest_bytes, StepManifest, "manifest")
        instruction_bytes = self._read_state_file(
            layout.instruction_path, "instruction", required=False
        )
        if instruction_bytes is None:
            instruction_text: str | None = None
            instruction_fingerprint = ABSENT
        else:
            instruction_text = _decode_utf8(instruction_bytes, "instruction")
            instruction_fingerprint = _sha256_hex(instruction_bytes)
        record_bytes = self._read_state_file(
            layout.record_path, "record", required=False
        )
        record = None
        if record_bytes is not None:
            record = _parse_record_envelope(_load_record_json(record_bytes))
        return _ProjectStateObservation(
            task_id=layout.task_id,
            layout=layout,
            task=task,
            manifest=manifest,
            task_fingerprint=_sha256_hex(task_bytes),
            manifest_fingerprint=_sha256_hex(manifest_bytes),
            instruction_text=instruction_text,
            instruction_fingerprint=instruction_fingerprint,
            record=record,
        )

    # --- directory creation (§8.2) ---

    def create_approved_parents(self, layout: _StateLayout) -> None:
        """Create only the three approved parent directories (§8.2).

        Each approved directory is re-resolved per component and must
        stay within the project root both before and after the
        directory is created, so a symlink planted at any parent
        component (not only the leaf) in the post-derivation window is
        rejected rather than followed out of the root.
        """
        for parts in _APPROVED_PARENT_DIRS:
            name = "/".join(parts)
            target = layout.project_root.joinpath(*parts)
            self._assert_contained(target, name)
            if _is_symlink(target, name):
                raise PersistenceExecutionError(
                    f"approved parent directory is a symlink: {name}"
                )
            try:
                target.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise PersistenceExecutionError(
                    f"approved parent directory could not be created: {name}"
                ) from exc
            self._assert_contained(target, name)

    # --- pre-call intent durable writes (§11.5 rows 1-3) ---

    def write_pending_call_intent(
        self,
        task_id: str,
        stable: _StableStateSnapshot,
        pending_call: _PendingProviderCall,
    ) -> None:
        """Atomically land a provider-call intent envelope (§11.5 rows 1-3).

        A provider-call sequence begins only at PROVIDER_CALL_INTENT from
        a verified stable baseline; from an existing call phase it may
        replay the same phase or advance exactly one step, but never
        regress, change the call identity/content, or overwrite an
        applying/recovery record. The executor never calls the Provider;
        it only lands the durable intent.
        """
        if not isinstance(pending_call, _PendingProviderCall):
            raise PersistenceExecutionError(
                "pending_call: expected a pending provider call"
            )
        observation = self.read_project_state(task_id)
        self._require_call_identity(observation, stable)
        self._check_call_transition(observation, stable, pending_call)
        self.create_approved_parents(observation.layout)
        envelope = _build_envelope(pending_call.call_phase, stable, pending_call)
        self._write_record(observation.layout, envelope)

    def write_apply_intent(
        self,
        task_id: str,
        stable: _StableStateSnapshot | None,
        plan: _ExecutablePlan,
    ) -> None:
        """Atomically land an applying intent envelope (§11.5 rows 4/5)."""
        _validate_plan(plan)
        observation = self.read_project_state(task_id)
        self._require_plan_identity(observation, plan)
        resolved, _continuing = self._resolve_apply_baseline(plan, observation)
        self._require_stable_matches(resolved, stable)
        self.create_approved_parents(observation.layout)
        envelope = _build_envelope(RecordPhase.APPLYING, resolved, plan.pending_apply)
        self._write_record(observation.layout, envelope)

    # --- multi-file CAS apply + STABLE commit (§11.4) ---

    def commit_apply(self, plan: _ExecutablePlan) -> _ApplyOutcome:
        """Execute the §11.4 apply sequence and commit the STABLE record.

        Re-reads and strictly validates on-disk state, resolves and
        compares-and-sets the apply baseline (a fresh apply from a
        STABLE/∅/MAY_HAVE_STARTED predecessor, or an exact continuation
        of an already-landed APPLYING for this same plan), verifies the
        before fingerprints on a fresh apply, lands the applying intent,
        applies task/manifest/instruction by the file-fingerprint rules
        with an advisory confirmed-writes progress hint, and lands the
        final STABLE envelope. A file that is neither the before nor the
        after state lands a durable RECOVERY_REQUIRED envelope before
        raising (§11.5 row 8).
        """
        _validate_plan(plan)
        pending = plan.pending_apply
        observation = self.read_project_state(plan.task_id)
        self._require_plan_identity(observation, plan)
        layout = observation.layout
        stable, continuing = self._resolve_apply_baseline(plan, observation)
        self.create_approved_parents(layout)
        if not continuing:
            self._verify_before_fingerprints(pending, observation)
            self._write_record(
                layout, _build_envelope(RecordPhase.APPLYING, stable, pending)
            )
        self._apply_all(layout, stable, pending, progress=True)
        self._write_record(
            layout,
            _build_envelope(
                RecordPhase.STABLE,
                _stable_from_wrapper(pending.planned_stable_state_snapshot),
                None,
            ),
        )
        return _ApplyOutcome(
            task_id=layout.task_id,
            stable_wrapper=_thaw(pending.planned_stable_state_snapshot),
        )

    # --- recovery execution (§14, §13.2, §13.5) ---

    def recover(self, task_id: str) -> _RecoveryOutcome:
        """Classify the durable record and execute the recovery action.

        A clean STABLE re-verifies the committed file fingerprints (S1)
        before returning NONE (also covers R4). Record loss with traces
        raises MissingRecoveryRecordError (R1); a clean loss is a normal
        prepare (R2/NONE). A pending apply re-drives to STABLE by
        file-fingerprint judgment (P3-P8); a MAY_HAVE_STARTED /
        RESULT_UNKNOWN provider call and every conflict/manual class
        land a durable RECOVERY_REQUIRED envelope before raising the
        §14-mapped error.
        """
        observation = self.read_project_state(task_id)
        layout = observation.layout
        if observation.record is None:
            return self._recover_missing_record(observation)
        parsed = observation.record
        if parsed.phase is RecordPhase.STABLE:
            self._verify_committed_file_fingerprints(parsed.stable, observation)
            return _RecoveryOutcome(
                task_id=layout.task_id,
                disposition=RecoveryDisposition.NONE,
                committed=False,
                stable_wrapper=None,
            )
        classification = _classify_phase_recovery(
            parsed,
            task_fingerprint=observation.task_fingerprint,
            manifest_fingerprint=observation.manifest_fingerprint,
            instruction_fingerprint=observation.instruction_fingerprint,
        )
        if classification.disposition is RecoveryDisposition.SAFE_AUTO_RETRY:
            if parsed.phase is RecordPhase.PROVIDER_CALL_INTENT:
                return _RecoveryOutcome(
                    task_id=layout.task_id,
                    disposition=RecoveryDisposition.SAFE_AUTO_RETRY,
                    committed=False,
                    stable_wrapper=None,
                )
            stable_wrapper = self._redrive_apply(parsed, layout)
            return _RecoveryOutcome(
                task_id=layout.task_id,
                disposition=RecoveryDisposition.SAFE_AUTO_RETRY,
                committed=True,
                stable_wrapper=stable_wrapper,
            )
        # MANUAL_RECONCILIATION or CONFLICT: land RECOVERY_REQUIRED, then raise
        assert classification.error is not None
        self._write_recovery_required(layout, parsed.stable, parsed.pending)
        raise classification.error

    def _recover_missing_record(
        self, observation: _ProjectStateObservation
    ) -> _RecoveryOutcome:
        has_trace = _classify_orchestration_traces(
            task=observation.task,
            manifest=observation.manifest,
            instruction_exists=observation.instruction_text is not None,
        )
        if has_trace:
            raise MissingRecoveryRecordError(
                "recovery: the orchestration record is missing but "
                "orchestration traces exist"
            )
        return _RecoveryOutcome(
            task_id=observation.layout.task_id,
            disposition=RecoveryDisposition.NONE,
            committed=False,
            stable_wrapper=None,
        )

    def _redrive_apply(
        self, parsed: _ParsedRecord, layout: _StateLayout
    ) -> dict[str, object]:
        pending = parsed.pending
        if not isinstance(pending, _PendingApply):
            raise PersistenceExecutionError(
                "recovery: applying phase without a pending apply"
            )
        self.create_approved_parents(layout)
        self._apply_all(layout, parsed.stable, pending, progress=False)
        self._write_record(
            layout,
            _build_envelope(
                RecordPhase.STABLE,
                _stable_from_wrapper(pending.planned_stable_state_snapshot),
                None,
            ),
        )
        return _thaw(pending.planned_stable_state_snapshot)

    def _write_recovery_required(
        self,
        layout: _StateLayout,
        stable: _StableStateSnapshot | None,
        pending: _PendingProviderCall | _PendingApply | None,
    ) -> None:
        """Atomically land a RECOVERY_REQUIRED envelope (§11.5 row 8)."""
        self.create_approved_parents(layout)
        self._write_record(
            layout,
            _build_envelope(RecordPhase.RECOVERY_REQUIRED, stable, pending),
        )

    # --- identity / transition preconditions ---

    def _require_call_identity(
        self,
        observation: _ProjectStateObservation,
        stable: _StableStateSnapshot,
    ) -> None:
        layout = observation.layout
        if not isinstance(stable, _StableStateSnapshot):
            raise PersistenceExecutionError("stable: expected a stable state snapshot")
        if stable.task_id != layout.task_id:
            raise PartialCommitConflictError(
                "identity: stable task_id does not match the layout task_id"
            )
        if observation.task.task_id != layout.task_id:
            raise PartialCommitConflictError(
                "identity: task file task_id does not match the layout"
            )

    def _require_plan_identity(
        self,
        observation: _ProjectStateObservation,
        plan: _ExecutablePlan,
    ) -> None:
        if plan.task_id != observation.layout.task_id:
            raise PartialCommitConflictError(
                "identity: plan task_id does not match the layout task_id"
            )
        if plan.task_id != observation.task.task_id:
            raise PartialCommitConflictError(
                "identity: plan task_id does not match the task file"
            )

    def _check_call_transition(
        self,
        observation: _ProjectStateObservation,
        stable: _StableStateSnapshot,
        pending_call: _PendingProviderCall,
    ) -> None:
        target = pending_call.call_phase
        record = observation.record
        if record is None:
            raise MissingRecoveryRecordError(
                "intent: a provider-call intent requires an existing record"
            )
        if record.phase is RecordPhase.STABLE:
            if target is not RecordPhase.PROVIDER_CALL_INTENT:
                raise PartialCommitConflictError(
                    "intent: a provider-call sequence must begin at "
                    "PROVIDER_CALL_INTENT from a stable baseline"
                )
            self._verify_stable_baseline(record.stable, stable)
            self._verify_committed_file_fingerprints(record.stable, observation)
            return
        if record.phase in _CALL_PHASES:
            self._require_same_call_identity(record.pending, pending_call)
            self._verify_stable_baseline(record.stable, stable)
            current = _CALL_PHASE_ORDER[record.phase]
            advanced = _CALL_PHASE_ORDER[target]
            if advanced != current and advanced != current + 1:
                raise PartialCommitConflictError(
                    "intent: a provider-call phase may only replay in place "
                    "or advance exactly one step"
                )
            return
        raise PartialCommitConflictError(
            "intent: cannot write a provider-call intent over an "
            f"{record.phase.value} record"
        )

    def _require_same_call_identity(
        self,
        current: _PendingProviderCall | _PendingApply | None,
        new: _PendingProviderCall,
    ) -> None:
        if not isinstance(current, _PendingProviderCall):
            raise PartialCommitConflictError(
                "intent: the existing record is not a provider-call intent"
            )
        if _call_content_key(current) != _call_content_key(new):
            raise PartialCommitConflictError(
                "intent: the provider-call identity or content changed and "
                "must not overwrite the pending intent"
            )

    def _resolve_apply_baseline(
        self,
        plan: _ExecutablePlan,
        observation: _ProjectStateObservation,
    ) -> tuple[_StableStateSnapshot | None, bool]:
        """Validate the apply predecessor and return (stable, continuing).

        ``continuing`` is True only when the on-disk record is already an
        APPLYING intent for this exact plan; the redrive then judges each
        file by fingerprint rather than the strict before check.
        """
        pending = plan.pending_apply
        record = observation.record
        if pending.baseline_version == 0:
            if pending.before_fingerprints["stable_record"] != ABSENT:
                raise PartialCommitConflictError(
                    "apply: first prepare requires an absent stable baseline"
                )
            if record is None:
                return None, False
            if record.phase is RecordPhase.APPLYING:
                self._require_same_apply(record.pending, pending)
                return None, True
            raise PartialCommitConflictError(
                "apply: first prepare cannot proceed over an "
                f"{record.phase.value} record"
            )
        if record is None:
            raise MissingRecoveryRecordError(
                "apply: a subsequent apply requires an existing record"
            )
        if record.phase is RecordPhase.STABLE:
            stable = self._verify_stable_for_apply(record.stable, pending, observation)
            return stable, False
        if record.phase is RecordPhase.APPLYING:
            self._require_same_apply(record.pending, pending)
            return record.stable, True
        if record.phase is RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED:
            self._require_call_to_apply(record.pending, pending)
            stable = self._verify_stable_for_apply(record.stable, pending, observation)
            return stable, False
        raise PartialCommitConflictError(
            f"apply: cannot proceed over an {record.phase.value} record"
        )

    def _verify_stable_for_apply(
        self,
        stable: _StableStateSnapshot,
        pending: _PendingApply,
        observation: _ProjectStateObservation,
    ) -> _StableStateSnapshot:
        if stable.version != pending.baseline_version:
            raise BaselineMismatchError(
                "apply: stable version does not match the plan baseline"
            )
        if (
            stable.stable_record_fingerprint
            != pending.before_fingerprints["stable_record"]
        ):
            raise BaselineMismatchError(
                "apply: stable self fingerprint does not match the plan baseline"
            )
        self._verify_committed_file_fingerprints(stable, observation)
        return stable

    def _require_same_apply(
        self,
        current: _PendingProviderCall | _PendingApply | None,
        new: _PendingApply,
    ) -> None:
        if not isinstance(current, _PendingApply):
            raise PartialCommitConflictError(
                "apply: the existing record is not an applying intent"
            )
        if _apply_content_key(current) != _apply_content_key(new):
            raise PartialCommitConflictError(
                "apply: continuation must match the pre-landed plan exactly "
                "(identity, plan, baseline, and every associated fingerprint)"
            )

    def _require_call_to_apply(
        self,
        current: _PendingProviderCall | _PendingApply | None,
        new: _PendingApply,
    ) -> None:
        if not isinstance(current, _PendingProviderCall):
            raise PartialCommitConflictError(
                "apply: the existing record is not a pending provider call"
            )
        same = (
            current.operation_id == new.operation_id
            and current.action is new.action
            and current.baseline_version == new.baseline_version
            and current.request_fingerprint == new.request_fingerprint
            and current.action_input_fingerprint == new.action_input_fingerprint
        )
        if not same:
            raise PartialCommitConflictError(
                "apply: does not continue the pending provider call identity"
            )

    def _require_stable_matches(
        self,
        resolved: _StableStateSnapshot | None,
        provided: _StableStateSnapshot | None,
    ) -> None:
        if resolved is None:
            if provided is not None:
                raise PartialCommitConflictError(
                    "apply intent: expected a null stable baseline"
                )
            return
        if (
            not isinstance(provided, _StableStateSnapshot)
            or provided.stable_record_fingerprint != resolved.stable_record_fingerprint
        ):
            raise PartialCommitConflictError(
                "apply intent: the provided stable does not match the record baseline"
            )

    def _verify_stable_baseline(
        self,
        on_disk: _StableStateSnapshot,
        expected: _StableStateSnapshot,
    ) -> None:
        if on_disk.version != expected.version:
            raise BaselineMismatchError(
                "baseline: on-disk stable version does not match the baseline"
            )
        if on_disk.stable_record_fingerprint != expected.stable_record_fingerprint:
            raise BaselineMismatchError(
                "baseline: on-disk stable does not match the expected stable"
            )

    def _verify_committed_file_fingerprints(
        self,
        stable: _StableStateSnapshot,
        observation: _ProjectStateObservation,
    ) -> None:
        """Verify a STABLE baseline against the actual files (§13.2 S1).

        The committed task/manifest fingerprints are snapshot-wrapper
        fingerprints; the committed instruction fingerprint is the
        instruction file's raw-byte fingerprint (§11.6).
        """
        if stable.committed_task_fingerprint != _snapshot_file_fingerprint(
            observation.task, "generation_task"
        ):
            raise PartialCommitConflictError(
                "baseline: committed task fingerprint does not match the task file"
            )
        if stable.committed_manifest_fingerprint != _snapshot_file_fingerprint(
            observation.manifest, "step_manifest"
        ):
            raise PartialCommitConflictError(
                "baseline: committed manifest fingerprint does not match the "
                "manifest file"
            )
        if (
            stable.committed_instruction_fingerprint
            != observation.instruction_fingerprint
        ):
            raise PartialCommitConflictError(
                "baseline: committed instruction fingerprint does not match "
                "the instruction file"
            )

    def _verify_before_fingerprints(
        self,
        pending: _PendingApply,
        observation: _ProjectStateObservation,
    ) -> None:
        if pending.before_fingerprints["task"] != observation.task_fingerprint:
            raise PartialCommitConflictError("commit: task file changed since planning")
        if pending.before_fingerprints["manifest"] != observation.manifest_fingerprint:
            raise PartialCommitConflictError(
                "commit: manifest file changed since planning"
            )
        if (
            pending.before_fingerprints["instruction"]
            != observation.instruction_fingerprint
        ):
            raise PartialCommitConflictError(
                "commit: instruction file changed since planning"
            )

    # --- file application (§11.4 steps 3-6, §14 P3-P9) ---

    def _apply_all(
        self,
        layout: _StateLayout,
        stable: _StableStateSnapshot | None,
        pending: _PendingApply,
        *,
        progress: bool,
    ) -> None:
        base_envelope = (
            _build_envelope(RecordPhase.APPLYING, stable, pending) if progress else None
        )
        try:
            self._apply_task(pending, layout)
            if progress:
                self._write_confirmed(layout, base_envelope, ("task",))
            self._apply_manifest(pending, layout)
            if progress:
                self._write_confirmed(layout, base_envelope, ("task", "manifest"))
            after_bytes = (
                None
                if pending.instruction_after_text is None
                else pending.instruction_after_text.encode("utf-8")
            )
            self._apply_instruction(
                after_bytes,
                pending.instruction_after_fingerprint,
                pending.before_fingerprints["instruction"],
                layout,
            )
            if progress and pending.instruction_after_fingerprint != ABSENT:
                self._write_confirmed(
                    layout, base_envelope, ("task", "manifest", "instruction")
                )
        except PartialCommitConflictError:
            self._write_recovery_required(layout, stable, pending)
            raise

    def _write_confirmed(
        self,
        layout: _StateLayout,
        base_envelope: dict[str, object],
        confirmed: tuple[str, ...],
    ) -> None:
        """Advisory APPLYING → APPLYING confirmed-writes hint (§11.5 row 6).

        Recovery remains fingerprint-authoritative (§14 P8); this hint
        never gates the fingerprint judgment.
        """
        pending_payload = dict(base_envelope["pending"])
        pending_payload["confirmed_writes"] = list(confirmed)
        envelope = dict(base_envelope)
        envelope["pending"] = pending_payload
        self._write_record(layout, envelope)

    def _apply_task(self, pending: _PendingApply, layout: _StateLayout) -> None:
        after_model = _restore_generation_task(pending.task_after_snapshot)
        after_fp = _sha256_hex(model_to_json(after_model).encode("utf-8"))
        current = self._read_state_file(layout.task_path, "task", required=True)
        current_fp = _sha256_hex(current)
        if current_fp == after_fp:
            return
        if current_fp == pending.before_fingerprints["task"]:
            self._assert_contained(layout.task_path, "task")
            _assert_writable_target(layout.task_path, "task")
            write_model_json(layout.task_path, after_model, overwrite=True)
            return
        raise PartialCommitConflictError(
            "apply: task file is neither the before nor the after state"
        )

    def _apply_manifest(self, pending: _PendingApply, layout: _StateLayout) -> None:
        after_model = _restore_step_manifest(pending.manifest_after_snapshot)
        after_fp = _sha256_hex(model_to_json(after_model).encode("utf-8"))
        current = self._read_state_file(layout.manifest_path, "manifest", required=True)
        current_fp = _sha256_hex(current)
        if current_fp == after_fp:
            return
        if current_fp == pending.before_fingerprints["manifest"]:
            self._assert_contained(layout.manifest_path, "manifest")
            _assert_writable_target(layout.manifest_path, "manifest")
            write_model_json(layout.manifest_path, after_model, overwrite=True)
            return
        raise PartialCommitConflictError(
            "apply: manifest file is neither the before nor the after state"
        )

    def _apply_instruction(
        self,
        after_bytes: bytes | None,
        after_fingerprint: str,
        before_fingerprint: str,
        layout: _StateLayout,
    ) -> None:
        current = self._read_state_file(
            layout.instruction_path, "instruction", required=False
        )
        if after_fingerprint == ABSENT:
            if current is not None:
                raise PartialCommitConflictError(
                    "apply: an instruction file exists but the plan writes "
                    "no instruction"
                )
            return
        assert after_bytes is not None
        if current is None:
            self._atomic_write_bytes(layout.instruction_path, after_bytes)
            return
        current_fp = _sha256_hex(current)
        if current_fp == after_fingerprint:
            return
        if before_fingerprint != ABSENT and current_fp == before_fingerprint:
            self._atomic_write_bytes(layout.instruction_path, after_bytes)
            return
        raise PartialCommitConflictError(
            "apply: instruction file conflicts with both the before and after state"
        )

    # --- atomic record / bytes writers ---

    def _write_record(self, layout: _StateLayout, envelope: dict[str, object]) -> None:
        text = json.dumps(
            envelope,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        self._atomic_write_bytes(layout.record_path, (text + "\n").encode("utf-8"))

    def _atomic_write_bytes(self, path: Path, data: bytes) -> None:
        """Atomically publish exact bytes: temp → flush → fsync → replace.

        Immediately before the temporary file is created and again before
        the atomic replace, the target is re-verified for per-component
        root containment and rejected if it (or any parent component) is
        a symlink escaping the project root.
        """
        self._assert_contained(path, path.name)
        _assert_writable_target(path, path.name)
        temporary_path: Path | None = None
        raw_fd: int | None = None
        try:
            raw_fd, temporary_name = tempfile.mkstemp(
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
            )
            temporary_path = Path(temporary_name)
            stream = os.fdopen(raw_fd, "wb")
            raw_fd = None
            with stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self._assert_contained(path, path.name)
            _assert_writable_target(path, path.name)
            os.replace(temporary_path, path)
            temporary_path = None
        except OSError as exc:
            raise PersistenceExecutionError(
                f"atomic write failed: {path.name}"
            ) from exc
        finally:
            if raw_fd is not None:
                try:
                    os.close(raw_fd)
                except OSError:
                    pass
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except OSError:
                    pass

    def _assert_contained(self, path: Path, name: str) -> None:
        """Reject a target that resolves outside the project root (§8.1).

        Uses the layout resolver's per-component resolution so a symlink
        planted at any path component after derivation is caught, not
        only a symlink at the final leaf.
        """
        resolver = self._resolver
        real_root = resolver._resolve_for_safety(resolver.project_root)
        resolved = resolver._resolve_for_safety(Path(path))
        if not _within_or_equal(resolved, real_root):
            raise PersistenceExecutionError(
                f"{name}: path resolves outside the project root"
            )

    def _read_state_file(
        self, path: Path, name: str, *, required: bool
    ) -> bytes | None:
        """Read one state file with full execution-time path safety.

        The target is re-verified for per-component root containment and
        rejected if it (or any parent component) resolves outside the
        root, and a symlink at the final target — even one planted after
        layout derivation — is rejected. A missing required file raises
        MissingProjectStateError; a missing optional file returns None.
        """
        self._assert_contained(path, name)
        if _is_symlink(path, name):
            raise PersistenceExecutionError(f"{name}: state file target is a symlink")
        try:
            return path.read_bytes()
        except FileNotFoundError as exc:
            if required:
                raise MissingProjectStateError(
                    f"{name} file does not exist: {path.name}"
                ) from exc
            return None
        except OSError as exc:
            raise PersistenceExecutionError(
                f"{name} file could not be read: {path.name}"
            ) from exc


def _apply_content_key(pending: _PendingApply) -> str:
    """Return the identity/content fingerprint of a pending apply.

    Excludes only the advisory ``confirmed_writes`` progress field, so a
    continuation must match plan_id, operation_id, action, baseline, and
    every associated snapshot fingerprint exactly.
    """
    payload = pending.to_payload()
    payload.pop("confirmed_writes", None)
    return _fingerprint(payload)


def _call_content_key(pending_call: _PendingProviderCall) -> str:
    """Return the identity/content fingerprint of a pending provider call.

    Excludes only ``call_phase`` and ``call_may_have_started`` — the sole
    fields a legal forward transition (§11.5 rows 1-3) changes — so a
    same-phase replay must match the full payload (including
    ``started_at``) and a forward step may change nothing else.
    """
    payload = pending_call.to_payload()
    payload.pop("call_phase", None)
    payload.pop("call_may_have_started", None)
    return _fingerprint(payload)


def _snapshot_file_fingerprint(model: object, kind: str) -> str:
    return _fingerprint(_make_snapshot_wrapper(kind, model_to_dict(model)))


def _validate_plan(plan: object) -> None:
    if not isinstance(plan, _ExecutablePlan):
        raise PersistenceExecutionError(
            f"plan: expected _ExecutablePlan, got {type(plan).__name__}"
        )
    if plan.action is OrchestrationAction.RESUME:
        raise PersistenceExecutionError("plan: resume is not an executable apply")


def _stable_from_wrapper(wrapper: object) -> _StableStateSnapshot:
    return _parse_stable_wrapper(_thaw(wrapper))


def _thaw(value: object) -> dict[str, object]:
    return _thaw_mapping(value)


def _within_or_equal(path: Path, ancestor: Path) -> bool:
    path_parts = path.parts
    ancestor_parts = ancestor.parts
    return path_parts[: len(ancestor_parts)] == ancestor_parts


def _is_symlink(path: Path, name: str) -> bool:
    try:
        return path.is_symlink()
    except OSError as exc:
        raise PersistenceExecutionError(
            f"{name}: target could not be inspected"
        ) from exc


def _assert_writable_target(path: Path, name: str) -> None:
    """Reject a state target that is a symlink (post-derivation window)."""
    if _is_symlink(path, name):
        raise PersistenceExecutionError(f"{name}: state target is a symlink")


def _decode_utf8(data: bytes, name: str) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeError as exc:
        raise PersistenceExecutionError(f"{name} file is not valid UTF-8") from exc


def _load_model(data: bytes, model_type, name: str):
    from ai_video_workflow.errors import AiVideoWorkflowError

    text = _decode_utf8(data, name)
    try:
        return model_from_json(text, model_type)
    except AiVideoWorkflowError as exc:
        raise PersistenceExecutionError(
            f"{name} file is not a valid {model_type.__name__}"
        ) from exc


def _load_record_json(data: bytes) -> dict:
    """Decode and JSON-load the record, mapping every corruption to the
    recovery-record error family (§13/§15 E1)."""
    try:
        text = data.decode("utf-8")
    except UnicodeError as exc:
        raise InvalidRecoveryRecordError("record file is not valid UTF-8") from exc
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InvalidRecoveryRecordError("record file is not valid JSON") from exc
    if type(loaded) is not dict:
        raise InvalidRecoveryRecordError(
            "record file top-level value must be a JSON object"
        )
    return loaded
