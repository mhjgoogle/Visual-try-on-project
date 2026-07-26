"""Internal durable record models and the record envelope contract.

These types are the pure data layer of the orchestration record: the
stable state snapshot, the two pending variants, and the uniform
top-level envelope. They perform no I/O, no Provider calls, no
lifecycle decisions, and no clock reads. Construction enforces the
cross-field invariants of the approved design; strict parsing from
persisted JSON lives in ``recovery``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.orchestration.canonical import (
    _fingerprint,
    _freeze_mapping,
    _make_snapshot_wrapper,
    _sha256_hex,
    _stable_self_fingerprint,
    _thaw_mapping,
    _validate_snapshot_wrapper,
)
from ai_video_workflow.orchestration.models import (
    OrchestrationAction,
    RecordPhase,
    RecoveryDisposition,
)
from ai_video_workflow.validation import (
    validate_stable_id,
    validate_utc_datetime,
)

ABSENT = "absent"

RECORD_SCHEMA_KIND = "orchestration_record"
RECORD_SCHEMA_VERSION = 1
STABLE_SCHEMA_VERSION = 1
PENDING_CALL_SCHEMA_VERSION = 1
PENDING_APPLY_SCHEMA_VERSION = 1
PENDING_CALL_VARIANT = "provider_call"
PENDING_APPLY_VARIANT = "apply"

_HEX64_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_UTC_ISO_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$")

_PRE_CALL_ACTIONS = frozenset({OrchestrationAction.SUBMIT, OrchestrationAction.COLLECT})

_OPERATION_ACTIONS = frozenset(
    {
        OrchestrationAction.PREPARE,
        OrchestrationAction.SUBMIT,
        OrchestrationAction.POLL,
        OrchestrationAction.REPORT_ARTIFACT,
        OrchestrationAction.COLLECT,
        OrchestrationAction.REPLAY_RESULT,
    }
)

_CALL_PHASES = frozenset(
    {
        RecordPhase.PROVIDER_CALL_INTENT,
        RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
        RecordPhase.PROVIDER_RESULT_UNKNOWN,
    }
)

_ACTION_INPUT_KEYS = frozenset(
    {"observed_at", "artifact", "completed_at", "result_fingerprint"}
)

_BEFORE_FINGERPRINT_KEYS = frozenset(
    {"task", "manifest", "instruction", "stable_record"}
)

_COMMITTED_OPERATION_KEYS = frozenset(
    {
        "operation_id",
        "action",
        "request_fingerprint",
        "action_input_fingerprint",
        "observed_at",
    }
)

_CONFIRMED_WRITE_TARGETS = ("task", "manifest", "instruction")

_ENVELOPE_FORBIDDEN_STABLE_PAYLOAD_KEYS = ("phase", "pending", "record_schema")


@dataclass(frozen=True, slots=True)
class _StableStateSnapshot:
    """Last committed stable orchestration state for one task.

    ``stable_record_fingerprint`` is always derived at construction
    time from the canonical payload without the field itself; it is
    never caller-supplied.
    """

    task_id: str
    shot_id: str
    provider_id: str
    version: int
    last_committed_plan_id: str
    last_committed_operation: Mapping[str, object]
    committed_task_fingerprint: str
    committed_manifest_fingerprint: str
    committed_instruction_fingerprint: str
    committed_request_fingerprint: str
    committed_result_fingerprint: str
    request_snapshot: Mapping[str, object]
    request_fingerprint: str
    instruction_snapshot: Mapping[str, object] | None
    instruction_fingerprint: str
    authoritative_external_task_ref: str | None
    authoritative_artifact: Mapping[str, object] | None
    authoritative_error_summary: str | None
    authoritative_completed_at: datetime | None
    last_result_snapshot: Mapping[str, object]
    last_result_fingerprint: str
    last_completed_action: OrchestrationAction
    legal_actions: tuple[OrchestrationAction, ...]
    preferred_next_action: OrchestrationAction | None
    updated_at: datetime
    stable_schema_version: int = STABLE_SCHEMA_VERSION
    stable_record_fingerprint: str = field(default="")

    __hash__ = None

    def __post_init__(self) -> None:
        validate_stable_id(self.task_id, field_name="task_id")
        validate_stable_id(self.shot_id, field_name="shot_id")
        validate_stable_id(self.provider_id, field_name="provider_id")
        _validate_schema_version(
            self.stable_schema_version,
            expected=STABLE_SCHEMA_VERSION,
            field_name="stable_schema_version",
        )
        _validate_strict_int(self.version, field_name="version")
        if self.version < 1:
            raise InvariantViolationError("version: stable version must be at least 1")
        _validate_hex64(
            self.last_committed_plan_id,
            field_name="last_committed_plan_id",
        )
        object.__setattr__(
            self,
            "last_committed_operation",
            _validate_committed_operation(self.last_committed_operation),
        )
        _validate_hex64(
            self.committed_task_fingerprint,
            field_name="committed_task_fingerprint",
        )
        _validate_hex64(
            self.committed_manifest_fingerprint,
            field_name="committed_manifest_fingerprint",
        )
        _validate_hex64_or_absent(
            self.committed_instruction_fingerprint,
            field_name="committed_instruction_fingerprint",
        )
        _validate_hex64(
            self.committed_request_fingerprint,
            field_name="committed_request_fingerprint",
        )
        _validate_hex64(
            self.committed_result_fingerprint,
            field_name="committed_result_fingerprint",
        )
        object.__setattr__(
            self,
            "request_snapshot",
            _validate_snapshot_wrapper(
                self.request_snapshot,
                expected_kind="provider_request",
                field_name="request_snapshot",
            ),
        )
        _validate_hex64(
            self.request_fingerprint,
            field_name="request_fingerprint",
        )
        _require_fingerprint_match(
            self.request_fingerprint,
            _fingerprint(self.request_snapshot),
            field_name="request_fingerprint",
        )
        if self.instruction_snapshot is None:
            if self.instruction_fingerprint != ABSENT:
                raise InvariantViolationError(
                    "instruction_fingerprint: must be the absent marker "
                    "when instruction_snapshot is missing"
                )
        else:
            object.__setattr__(
                self,
                "instruction_snapshot",
                _validate_snapshot_wrapper(
                    self.instruction_snapshot,
                    expected_kind="provider_instruction",
                    field_name="instruction_snapshot",
                ),
            )
            _validate_hex64(
                self.instruction_fingerprint,
                field_name="instruction_fingerprint",
            )
            _require_fingerprint_match(
                self.instruction_fingerprint,
                _fingerprint(self.instruction_snapshot),
                field_name="instruction_fingerprint",
            )
        if self.authoritative_external_task_ref is not None:
            _validate_non_empty_text(
                self.authoritative_external_task_ref,
                field_name="authoritative_external_task_ref",
            )
        if self.authoritative_artifact is not None:
            object.__setattr__(
                self,
                "authoritative_artifact",
                _validate_snapshot_wrapper(
                    self.authoritative_artifact,
                    expected_kind="artifact_reference",
                    field_name="authoritative_artifact",
                ),
            )
        if self.authoritative_error_summary is not None:
            _validate_non_empty_text(
                self.authoritative_error_summary,
                field_name="authoritative_error_summary",
            )
        if self.authoritative_completed_at is not None:
            validate_utc_datetime(
                self.authoritative_completed_at,
                field_name="authoritative_completed_at",
            )
        object.__setattr__(
            self,
            "last_result_snapshot",
            _validate_snapshot_wrapper(
                self.last_result_snapshot,
                expected_kind="provider_result",
                field_name="last_result_snapshot",
            ),
        )
        _validate_hex64(
            self.last_result_fingerprint,
            field_name="last_result_fingerprint",
        )
        _require_fingerprint_match(
            self.last_result_fingerprint,
            _fingerprint(self.last_result_snapshot),
            field_name="last_result_fingerprint",
        )
        _validate_action(
            self.last_completed_action,
            field_name="last_completed_action",
        )
        object.__setattr__(
            self,
            "legal_actions",
            _validate_legal_actions(
                self.legal_actions,
                field_name="legal_actions",
            ),
        )
        _validate_preferred_action(
            self.preferred_next_action,
            self.legal_actions,
            field_name="preferred_next_action",
        )
        validate_utc_datetime(self.updated_at, field_name="updated_at")
        object.__setattr__(
            self,
            "stable_record_fingerprint",
            _stable_self_fingerprint(self.to_payload()),
        )

    def to_payload(self) -> dict[str, object]:
        """Return the plain JSON payload of this stable state."""
        return {
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "provider_id": self.provider_id,
            "stable_schema_version": self.stable_schema_version,
            "version": self.version,
            "last_committed_plan_id": self.last_committed_plan_id,
            "last_committed_operation": _thaw_mapping(self.last_committed_operation),
            "committed_task_fingerprint": self.committed_task_fingerprint,
            "committed_manifest_fingerprint": (self.committed_manifest_fingerprint),
            "committed_instruction_fingerprint": (
                self.committed_instruction_fingerprint
            ),
            "committed_request_fingerprint": (self.committed_request_fingerprint),
            "committed_result_fingerprint": self.committed_result_fingerprint,
            "request_snapshot": _thaw_mapping(self.request_snapshot),
            "request_fingerprint": self.request_fingerprint,
            "instruction_snapshot": (
                None
                if self.instruction_snapshot is None
                else _thaw_mapping(self.instruction_snapshot)
            ),
            "instruction_fingerprint": self.instruction_fingerprint,
            "authoritative_external_task_ref": (self.authoritative_external_task_ref),
            "authoritative_artifact": (
                None
                if self.authoritative_artifact is None
                else _thaw_mapping(self.authoritative_artifact)
            ),
            "authoritative_error_summary": self.authoritative_error_summary,
            "authoritative_completed_at": _optional_iso(
                self.authoritative_completed_at
            ),
            "last_result_snapshot": _thaw_mapping(self.last_result_snapshot),
            "last_result_fingerprint": self.last_result_fingerprint,
            "last_completed_action": self.last_completed_action.value,
            "legal_actions": [action.value for action in self.legal_actions],
            "preferred_next_action": (
                None
                if self.preferred_next_action is None
                else self.preferred_next_action.value
            ),
            "updated_at": _iso(self.updated_at),
            "stable_record_fingerprint": self.stable_record_fingerprint,
        }

    def to_wrapper(self) -> Mapping[str, object]:
        """Return the orchestration_stable_state snapshot wrapper."""
        return _make_snapshot_wrapper(
            "orchestration_stable_state",
            self.to_payload(),
        )


@dataclass(frozen=True, slots=True)
class _PendingProviderCall:
    """Durable pre-result intent for one provider call (submit/collect)."""

    operation_id: str
    action: OrchestrationAction
    baseline_version: int
    request_snapshot: Mapping[str, object]
    request_fingerprint: str
    action_input_snapshot: Mapping[str, object]
    action_input_fingerprint: str
    original_observed_at: datetime
    original_completed_at: datetime | None
    artifact_input: Mapping[str, object] | None
    call_phase: RecordPhase
    call_may_have_started: bool
    started_at: datetime
    recovery_policy: RecoveryDisposition
    pending_call_schema_version: int = PENDING_CALL_SCHEMA_VERSION
    variant: str = PENDING_CALL_VARIANT

    __hash__ = None

    def __post_init__(self) -> None:
        _validate_schema_version(
            self.pending_call_schema_version,
            expected=PENDING_CALL_SCHEMA_VERSION,
            field_name="pending_call_schema_version",
        )
        if self.variant != PENDING_CALL_VARIANT:
            raise InvariantViolationError(
                "variant: pending provider call variant must be "
                f"{PENDING_CALL_VARIANT!r}"
            )
        validate_stable_id(self.operation_id, field_name="operation_id")
        _validate_action(self.action, field_name="action")
        if self.action not in _PRE_CALL_ACTIONS:
            raise InvariantViolationError(
                "action: only submit and collect use a pre-call intent"
            )
        _validate_strict_int(
            self.baseline_version,
            field_name="baseline_version",
        )
        if self.baseline_version < 1:
            raise InvariantViolationError(
                "baseline_version: pre-call intents require an existing stable state"
            )
        object.__setattr__(
            self,
            "request_snapshot",
            _validate_snapshot_wrapper(
                self.request_snapshot,
                expected_kind="provider_request",
                field_name="request_snapshot",
            ),
        )
        _validate_hex64(
            self.request_fingerprint,
            field_name="request_fingerprint",
        )
        _require_fingerprint_match(
            self.request_fingerprint,
            _fingerprint(self.request_snapshot),
            field_name="request_fingerprint",
        )
        object.__setattr__(
            self,
            "action_input_snapshot",
            _validate_action_input_snapshot(
                self.action_input_snapshot,
                field_name="action_input_snapshot",
            ),
        )
        _validate_hex64(
            self.action_input_fingerprint,
            field_name="action_input_fingerprint",
        )
        _require_fingerprint_match(
            self.action_input_fingerprint,
            _fingerprint(self.action_input_snapshot),
            field_name="action_input_fingerprint",
        )
        validate_utc_datetime(
            self.original_observed_at,
            field_name="original_observed_at",
        )
        if self.original_completed_at is not None:
            validate_utc_datetime(
                self.original_completed_at,
                field_name="original_completed_at",
            )
        if self.artifact_input is not None:
            object.__setattr__(
                self,
                "artifact_input",
                _validate_snapshot_wrapper(
                    self.artifact_input,
                    expected_kind="artifact_reference",
                    field_name="artifact_input",
                ),
            )
        if not isinstance(self.call_phase, RecordPhase):
            raise FieldTypeError(
                "call_phase: expected RecordPhase, "
                f"got {type(self.call_phase).__name__}"
            )
        if self.call_phase not in _CALL_PHASES:
            raise InvariantViolationError("call_phase: must be a provider-call phase")
        if type(self.call_may_have_started) is not bool:
            raise FieldTypeError(
                "call_may_have_started: expected bool, "
                f"got {type(self.call_may_have_started).__name__}"
            )
        expected_started = self.call_phase is not RecordPhase.PROVIDER_CALL_INTENT
        if self.call_may_have_started is not expected_started:
            raise InvariantViolationError(
                "call_may_have_started: inconsistent with call_phase"
            )
        validate_utc_datetime(self.started_at, field_name="started_at")
        if not isinstance(self.recovery_policy, RecoveryDisposition):
            raise FieldTypeError(
                "recovery_policy: expected RecoveryDisposition, "
                f"got {type(self.recovery_policy).__name__}"
            )
        payload = self.action_input_snapshot["payload"]
        if payload["result_fingerprint"] is not None:
            raise InvariantViolationError(
                "action_input_snapshot: result_fingerprint must be null "
                "for a pre-call intent"
            )
        _require_duplicated_action_input_facts(
            payload,
            observed_at=self.original_observed_at,
            completed_at=self.original_completed_at,
            artifact_input=self.artifact_input,
            field_name="action_input_snapshot",
        )

    def to_payload(self) -> dict[str, object]:
        """Return the plain JSON payload of this pending call intent."""
        return {
            "pending_call_schema_version": self.pending_call_schema_version,
            "variant": self.variant,
            "operation_id": self.operation_id,
            "action": self.action.value,
            "baseline_version": self.baseline_version,
            "request_snapshot": _thaw_mapping(self.request_snapshot),
            "request_fingerprint": self.request_fingerprint,
            "action_input_snapshot": _thaw_mapping(self.action_input_snapshot),
            "action_input_fingerprint": self.action_input_fingerprint,
            "original_observed_at": _iso(self.original_observed_at),
            "original_completed_at": _optional_iso(self.original_completed_at),
            "artifact_input": (
                None
                if self.artifact_input is None
                else _thaw_mapping(self.artifact_input)
            ),
            "call_phase": self.call_phase.value,
            "call_may_have_started": self.call_may_have_started,
            "started_at": _iso(self.started_at),
            "recovery_policy": self.recovery_policy.value,
        }


@dataclass(frozen=True, slots=True)
class _PendingApply:
    """Durable, self-contained post-result executable apply payload."""

    operation_id: str
    action: OrchestrationAction
    baseline_version: int
    request_snapshot: Mapping[str, object]
    request_fingerprint: str
    action_input_snapshot: Mapping[str, object]
    action_input_fingerprint: str
    result_snapshot: Mapping[str, object]
    result_fingerprint: str
    plan_id: str
    before_fingerprints: Mapping[str, str]
    task_after_snapshot: Mapping[str, object]
    task_after_fingerprint: str
    manifest_after_snapshot: Mapping[str, object]
    manifest_after_fingerprint: str
    instruction_after_text: str | None
    instruction_after_fingerprint: str
    planned_stable_state_snapshot: Mapping[str, object]
    planned_stable_state_wrapper_fingerprint: str
    confirmed_writes: tuple[str, ...]
    recovery_disposition: RecoveryDisposition
    original_observed_at: datetime
    post_commit_legal_actions: tuple[OrchestrationAction, ...]
    post_commit_preferred_next_action: OrchestrationAction | None
    pending_apply_schema_version: int = PENDING_APPLY_SCHEMA_VERSION
    variant: str = PENDING_APPLY_VARIANT

    __hash__ = None

    def __post_init__(self) -> None:
        _validate_schema_version(
            self.pending_apply_schema_version,
            expected=PENDING_APPLY_SCHEMA_VERSION,
            field_name="pending_apply_schema_version",
        )
        if self.variant != PENDING_APPLY_VARIANT:
            raise InvariantViolationError(
                f"variant: pending apply variant must be {PENDING_APPLY_VARIANT!r}"
            )
        validate_stable_id(self.operation_id, field_name="operation_id")
        _validate_action(self.action, field_name="action")
        if self.action not in _OPERATION_ACTIONS:
            raise InvariantViolationError(
                "action: resume never produces a pending apply"
            )
        _validate_strict_int(
            self.baseline_version,
            field_name="baseline_version",
        )
        if self.baseline_version < 0:
            raise InvariantViolationError("baseline_version: must not be negative")
        object.__setattr__(
            self,
            "request_snapshot",
            _validate_snapshot_wrapper(
                self.request_snapshot,
                expected_kind="provider_request",
                field_name="request_snapshot",
            ),
        )
        _validate_hex64(
            self.request_fingerprint,
            field_name="request_fingerprint",
        )
        _require_fingerprint_match(
            self.request_fingerprint,
            _fingerprint(self.request_snapshot),
            field_name="request_fingerprint",
        )
        object.__setattr__(
            self,
            "action_input_snapshot",
            _validate_action_input_snapshot(
                self.action_input_snapshot,
                field_name="action_input_snapshot",
            ),
        )
        _validate_hex64(
            self.action_input_fingerprint,
            field_name="action_input_fingerprint",
        )
        _require_fingerprint_match(
            self.action_input_fingerprint,
            _fingerprint(self.action_input_snapshot),
            field_name="action_input_fingerprint",
        )
        object.__setattr__(
            self,
            "result_snapshot",
            _validate_snapshot_wrapper(
                self.result_snapshot,
                expected_kind="provider_result",
                field_name="result_snapshot",
            ),
        )
        _validate_hex64(
            self.result_fingerprint,
            field_name="result_fingerprint",
        )
        _require_fingerprint_match(
            self.result_fingerprint,
            _fingerprint(self.result_snapshot),
            field_name="result_fingerprint",
        )
        _validate_hex64(self.plan_id, field_name="plan_id")
        object.__setattr__(
            self,
            "before_fingerprints",
            _validate_before_fingerprints(
                self.before_fingerprints,
                baseline_version=self.baseline_version,
            ),
        )
        object.__setattr__(
            self,
            "task_after_snapshot",
            _validate_snapshot_wrapper(
                self.task_after_snapshot,
                expected_kind="generation_task",
                field_name="task_after_snapshot",
            ),
        )
        _validate_hex64(
            self.task_after_fingerprint,
            field_name="task_after_fingerprint",
        )
        _require_fingerprint_match(
            self.task_after_fingerprint,
            _fingerprint(self.task_after_snapshot),
            field_name="task_after_fingerprint",
        )
        object.__setattr__(
            self,
            "manifest_after_snapshot",
            _validate_snapshot_wrapper(
                self.manifest_after_snapshot,
                expected_kind="step_manifest",
                field_name="manifest_after_snapshot",
            ),
        )
        _validate_hex64(
            self.manifest_after_fingerprint,
            field_name="manifest_after_fingerprint",
        )
        _require_fingerprint_match(
            self.manifest_after_fingerprint,
            _fingerprint(self.manifest_after_snapshot),
            field_name="manifest_after_fingerprint",
        )
        if self.instruction_after_text is None:
            if self.instruction_after_fingerprint != ABSENT:
                raise InvariantViolationError(
                    "instruction_after_fingerprint: must be the absent "
                    "marker when instruction_after_text is missing"
                )
        else:
            if type(self.instruction_after_text) is not str:
                raise FieldTypeError(
                    "instruction_after_text: expected string, got "
                    f"{type(self.instruction_after_text).__name__}"
                )
            _validate_hex64(
                self.instruction_after_fingerprint,
                field_name="instruction_after_fingerprint",
            )
            _require_fingerprint_match(
                self.instruction_after_fingerprint,
                _sha256_hex(self.instruction_after_text.encode("utf-8")),
                field_name="instruction_after_fingerprint",
            )
        object.__setattr__(
            self,
            "planned_stable_state_snapshot",
            _validate_snapshot_wrapper(
                self.planned_stable_state_snapshot,
                expected_kind="orchestration_stable_state",
                field_name="planned_stable_state_snapshot",
            ),
        )
        _validate_hex64(
            self.planned_stable_state_wrapper_fingerprint,
            field_name="planned_stable_state_wrapper_fingerprint",
        )
        _require_fingerprint_match(
            self.planned_stable_state_wrapper_fingerprint,
            _fingerprint(self.planned_stable_state_snapshot),
            field_name="planned_stable_state_wrapper_fingerprint",
        )
        object.__setattr__(
            self,
            "confirmed_writes",
            _validate_confirmed_writes(self.confirmed_writes),
        )
        if not isinstance(self.recovery_disposition, RecoveryDisposition):
            raise FieldTypeError(
                "recovery_disposition: expected RecoveryDisposition, "
                f"got {type(self.recovery_disposition).__name__}"
            )
        validate_utc_datetime(
            self.original_observed_at,
            field_name="original_observed_at",
        )
        object.__setattr__(
            self,
            "post_commit_legal_actions",
            _validate_legal_actions(
                self.post_commit_legal_actions,
                field_name="post_commit_legal_actions",
            ),
        )
        _validate_preferred_action(
            self.post_commit_preferred_next_action,
            self.post_commit_legal_actions,
            field_name="post_commit_preferred_next_action",
        )
        action_input_payload = self.action_input_snapshot["payload"]
        if action_input_payload["observed_at"] != _iso(self.original_observed_at):
            raise InvariantViolationError(
                "action_input_snapshot: observed_at must equal original_observed_at"
            )
        self._validate_planned_stable_state()

    def _validate_planned_stable_state(self) -> None:
        payload = self.planned_stable_state_snapshot["payload"]
        for forbidden in _ENVELOPE_FORBIDDEN_STABLE_PAYLOAD_KEYS:
            if forbidden in payload:
                raise InvariantViolationError(
                    "planned_stable_state_snapshot: must not contain the "
                    f"envelope field {forbidden!r}"
                )
        persisted_self = _planned_field(payload, "stable_record_fingerprint")
        if type(persisted_self) is not str:
            raise FieldTypeError(
                "planned_stable_state_snapshot: stable_record_fingerprint "
                f"must be a string, got {type(persisted_self).__name__}"
            )
        recomputed_self = _stable_self_fingerprint(payload)
        if persisted_self != recomputed_self:
            raise InvariantViolationError(
                "planned_stable_state_snapshot: embedded self fingerprint "
                "does not match the canonical stable payload"
            )
        if _planned_field(payload, "version") != self.baseline_version + 1:
            raise InvariantViolationError(
                "planned_stable_state_snapshot: version must equal baseline_version + 1"
            )
        expected_committed = {
            "committed_task_fingerprint": self.task_after_fingerprint,
            "committed_manifest_fingerprint": (self.manifest_after_fingerprint),
            "committed_instruction_fingerprint": (self.instruction_after_fingerprint),
            "committed_request_fingerprint": self.request_fingerprint,
            "committed_result_fingerprint": self.result_fingerprint,
        }
        for key, expected in expected_committed.items():
            if _planned_field(payload, key) != expected:
                raise InvariantViolationError(
                    f"planned_stable_state_snapshot: {key} must equal the "
                    "pending after fingerprint"
                )
        operation = _planned_field(payload, "last_committed_operation")
        if not isinstance(operation, Mapping):
            raise FieldTypeError(
                "planned_stable_state_snapshot: last_committed_operation "
                f"must be a mapping, got {type(operation).__name__}"
            )
        expected_operation = {
            "operation_id": self.operation_id,
            "action": self.action.value,
            "request_fingerprint": self.request_fingerprint,
            "action_input_fingerprint": self.action_input_fingerprint,
            "observed_at": _iso(self.original_observed_at),
        }
        if dict(operation) != expected_operation:
            raise InvariantViolationError(
                "planned_stable_state_snapshot: last_committed_operation "
                "must match the pending operation identity"
            )
        if _planned_field(payload, "last_committed_plan_id") != self.plan_id:
            raise InvariantViolationError(
                "planned_stable_state_snapshot: last_committed_plan_id "
                "must equal plan_id"
            )
        planned_legal = _planned_field(payload, "legal_actions")
        if not isinstance(planned_legal, (list, tuple)):
            raise FieldTypeError(
                "planned_stable_state_snapshot: legal_actions must be an "
                f"array, got {type(planned_legal).__name__}"
            )
        pending_legal = [action.value for action in self.post_commit_legal_actions]
        if list(planned_legal) != pending_legal:
            raise InvariantViolationError(
                "post_commit_legal_actions: must equal the planned stable legal_actions"
            )
        planned_preferred = _planned_field(payload, "preferred_next_action")
        pending_preferred = (
            None
            if self.post_commit_preferred_next_action is None
            else self.post_commit_preferred_next_action.value
        )
        if planned_preferred != pending_preferred:
            raise InvariantViolationError(
                "post_commit_preferred_next_action: must equal the planned "
                "stable preferred_next_action"
            )

    def to_payload(self) -> dict[str, object]:
        """Return the plain JSON payload of this pending apply."""
        return {
            "pending_apply_schema_version": self.pending_apply_schema_version,
            "variant": self.variant,
            "operation_id": self.operation_id,
            "action": self.action.value,
            "baseline_version": self.baseline_version,
            "request_snapshot": _thaw_mapping(self.request_snapshot),
            "request_fingerprint": self.request_fingerprint,
            "action_input_snapshot": _thaw_mapping(self.action_input_snapshot),
            "action_input_fingerprint": self.action_input_fingerprint,
            "result_snapshot": _thaw_mapping(self.result_snapshot),
            "result_fingerprint": self.result_fingerprint,
            "plan_id": self.plan_id,
            "before_fingerprints": _thaw_mapping(self.before_fingerprints),
            "task_after_snapshot": _thaw_mapping(self.task_after_snapshot),
            "task_after_fingerprint": self.task_after_fingerprint,
            "manifest_after_snapshot": _thaw_mapping(self.manifest_after_snapshot),
            "manifest_after_fingerprint": self.manifest_after_fingerprint,
            "instruction_after_text": self.instruction_after_text,
            "instruction_after_fingerprint": (self.instruction_after_fingerprint),
            "planned_stable_state_snapshot": _thaw_mapping(
                self.planned_stable_state_snapshot
            ),
            "planned_stable_state_wrapper_fingerprint": (
                self.planned_stable_state_wrapper_fingerprint
            ),
            "confirmed_writes": list(self.confirmed_writes),
            "recovery_disposition": self.recovery_disposition.value,
            "original_observed_at": _iso(self.original_observed_at),
            "post_commit_legal_actions": [
                action.value for action in self.post_commit_legal_actions
            ],
            "post_commit_preferred_next_action": (
                None
                if self.post_commit_preferred_next_action is None
                else self.post_commit_preferred_next_action.value
            ),
        }


def _validate_envelope_parts(
    phase: RecordPhase,
    stable: _StableStateSnapshot | None,
    pending: _PendingProviderCall | _PendingApply | None,
) -> None:
    """Enforce the phase × stable × pending invariants of the envelope."""
    if not isinstance(phase, RecordPhase):
        raise FieldTypeError(f"phase: expected RecordPhase, got {type(phase).__name__}")
    if stable is not None and not isinstance(stable, _StableStateSnapshot):
        raise FieldTypeError(
            "stable: expected _StableStateSnapshot or None, "
            f"got {type(stable).__name__}"
        )
    if pending is not None and not isinstance(
        pending, (_PendingProviderCall, _PendingApply)
    ):
        raise FieldTypeError(
            f"pending: expected a pending variant or None, got {type(pending).__name__}"
        )
    if phase is RecordPhase.STABLE:
        if stable is None:
            raise InvariantViolationError("stable: required for the stable phase")
        if pending is not None:
            raise InvariantViolationError("pending: must be null for the stable phase")
    elif phase in _CALL_PHASES:
        if stable is None:
            raise InvariantViolationError("stable: required for provider-call phases")
        if not isinstance(pending, _PendingProviderCall):
            raise InvariantViolationError(
                "pending: provider-call phases require a pending provider call"
            )
        if pending.call_phase is not phase:
            raise InvariantViolationError(
                "pending.call_phase: must match the envelope phase"
            )
    elif phase is RecordPhase.APPLYING:
        if not isinstance(pending, _PendingApply):
            raise InvariantViolationError(
                "pending: the applying phase requires a pending apply"
            )
        if stable is None:
            _require_first_prepare_pending(pending)
    else:
        if stable is None:
            if pending is None or not isinstance(pending, _PendingApply):
                raise InvariantViolationError(
                    "stable: recovery_required with null stable is only "
                    "allowed for the first-prepare applying branch"
                )
            _require_first_prepare_pending(pending)
    if stable is not None and pending is not None:
        if pending.baseline_version != stable.version:
            raise InvariantViolationError(
                "pending.baseline_version: must equal the stable version"
            )


def _require_first_prepare_pending(pending: _PendingApply) -> None:
    if pending.baseline_version != 0:
        raise InvariantViolationError(
            "stable: null is only allowed for the first prepare"
        )
    if pending.action is not OrchestrationAction.PREPARE:
        raise InvariantViolationError(
            "stable: null is only allowed for the first prepare action"
        )


def _build_envelope(
    phase: RecordPhase,
    stable: _StableStateSnapshot | None,
    pending: _PendingProviderCall | _PendingApply | None,
) -> dict[str, object]:
    """Return the uniform top-level record envelope as a plain dict."""
    _validate_envelope_parts(phase, stable, pending)
    return {
        "record_schema": {
            "kind": RECORD_SCHEMA_KIND,
            "version": RECORD_SCHEMA_VERSION,
        },
        "phase": phase.value,
        "stable": (None if stable is None else _thaw_mapping(stable.to_wrapper())),
        "pending": None if pending is None else pending.to_payload(),
    }


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="microseconds")


def _optional_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _iso(value)


def _planned_field(payload: Mapping[str, object], key: str) -> object:
    if key not in payload:
        raise InvariantViolationError(
            f"planned_stable_state_snapshot: missing stable field {key!r}"
        )
    return payload[key]


def _validate_strict_int(value: object, *, field_name: str) -> None:
    if type(value) is not int:
        raise FieldTypeError(
            f"{field_name}: expected a strict int, got {type(value).__name__}"
        )


def _validate_schema_version(
    value: object,
    *,
    expected: int,
    field_name: str,
) -> None:
    _validate_strict_int(value, field_name=field_name)
    if value != expected:
        raise InvariantViolationError(
            f"{field_name}: unsupported schema version {value}"
        )


def _validate_hex64(value: object, *, field_name: str) -> None:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if _HEX64_PATTERN.fullmatch(value) is None:
        raise InvariantViolationError(
            f"{field_name}: expected a lowercase 64-character hex digest"
        )


def _validate_hex64_or_absent(value: object, *, field_name: str) -> None:
    if value == ABSENT:
        return
    _validate_hex64(value, field_name=field_name)


def _validate_non_empty_text(value: object, *, field_name: str) -> None:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if not value or value.isspace():
        raise InvariantViolationError(f"{field_name}: must not be empty or blank")


def _validate_iso_utc(value: object, *, field_name: str) -> None:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected a UTC ISO string, got {type(value).__name__}"
        )
    if _UTC_ISO_PATTERN.fullmatch(value) is None:
        raise InvariantViolationError(
            f"{field_name}: expected YYYY-MM-DDTHH:MM:SS.ffffff+00:00"
        )
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise InvariantViolationError(
            f"{field_name}: invalid UTC calendar datetime"
        ) from exc
    validate_utc_datetime(parsed, field_name=field_name)


def _validate_action(value: object, *, field_name: str) -> None:
    if not isinstance(value, OrchestrationAction):
        raise FieldTypeError(
            f"{field_name}: expected OrchestrationAction, got {type(value).__name__}"
        )


def _validate_legal_actions(
    value: object,
    *,
    field_name: str,
) -> tuple[OrchestrationAction, ...]:
    if type(value) is not tuple:
        raise FieldTypeError(
            f"{field_name}: expected tuple, got {type(value).__name__}"
        )
    for action in value:
        _validate_action(action, field_name=field_name)
    if len(set(value)) != len(value):
        raise InvariantViolationError(
            f"{field_name}: duplicate actions are not allowed"
        )
    order = list(OrchestrationAction)
    indexes = [order.index(action) for action in value]
    if indexes != sorted(indexes):
        raise InvariantViolationError(
            f"{field_name}: must follow the enum definition order"
        )
    return value


def _validate_preferred_action(
    preferred: object,
    legal_actions: tuple[OrchestrationAction, ...],
    *,
    field_name: str,
) -> None:
    if preferred is None:
        return
    _validate_action(preferred, field_name=field_name)
    if preferred not in legal_actions:
        raise InvariantViolationError(f"{field_name}: must be a legal action or None")


def _validate_committed_operation(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise FieldTypeError(
            f"last_committed_operation: expected mapping, got {type(value).__name__}"
        )
    keys = set(value.keys())
    if keys != _COMMITTED_OPERATION_KEYS:
        raise InvariantViolationError(
            "last_committed_operation: must contain exactly the committed "
            "operation identity fields"
        )
    validate_stable_id(
        value["operation_id"],
        field_name="last_committed_operation.operation_id",
    )
    action = value["action"]
    if type(action) is not str or action not in {
        member.value for member in OrchestrationAction
    }:
        raise InvariantViolationError(
            "last_committed_operation.action: unknown action value"
        )
    _validate_hex64(
        value["request_fingerprint"],
        field_name="last_committed_operation.request_fingerprint",
    )
    _validate_hex64(
        value["action_input_fingerprint"],
        field_name="last_committed_operation.action_input_fingerprint",
    )
    _validate_iso_utc(
        value["observed_at"],
        field_name="last_committed_operation.observed_at",
    )
    return _freeze_mapping(dict(value))


def _validate_action_input_snapshot(
    value: object,
    *,
    field_name: str,
) -> Mapping[str, object]:
    wrapper = _validate_snapshot_wrapper(
        value,
        expected_kind="action_input",
        field_name=field_name,
    )
    payload = wrapper["payload"]
    keys = set(payload.keys())
    if keys != _ACTION_INPUT_KEYS:
        raise InvariantViolationError(
            f"{field_name}: payload must contain exactly observed_at, "
            "artifact, completed_at, and result_fingerprint"
        )
    _validate_iso_utc(
        payload["observed_at"],
        field_name=f"{field_name}.observed_at",
    )
    artifact = payload["artifact"]
    if artifact is not None:
        _validate_snapshot_wrapper(
            artifact,
            expected_kind="artifact_reference",
            field_name=f"{field_name}.artifact",
        )
    completed_at = payload["completed_at"]
    if completed_at is not None:
        _validate_iso_utc(
            completed_at,
            field_name=f"{field_name}.completed_at",
        )
    result_fingerprint = payload["result_fingerprint"]
    if result_fingerprint is not None:
        _validate_hex64(
            result_fingerprint,
            field_name=f"{field_name}.result_fingerprint",
        )
    return wrapper


def _require_fingerprint_match(
    declared: str,
    computed: str,
    *,
    field_name: str,
) -> None:
    if declared != computed:
        raise InvariantViolationError(
            f"{field_name}: declared fingerprint does not match the canonical content"
        )


def _validate_before_fingerprints(
    value: object,
    *,
    baseline_version: int,
) -> Mapping[str, str]:
    if not isinstance(value, Mapping):
        raise FieldTypeError(
            f"before_fingerprints: expected mapping, got {type(value).__name__}"
        )
    keys = set(value.keys())
    if keys != _BEFORE_FINGERPRINT_KEYS:
        raise InvariantViolationError(
            "before_fingerprints: must contain exactly task, manifest, "
            "instruction, and stable_record"
        )
    _validate_hex64(value["task"], field_name="before_fingerprints.task")
    _validate_hex64(
        value["manifest"],
        field_name="before_fingerprints.manifest",
    )
    _validate_hex64_or_absent(
        value["instruction"],
        field_name="before_fingerprints.instruction",
    )
    stable_before = value["stable_record"]
    if baseline_version == 0:
        if stable_before != ABSENT:
            raise InvariantViolationError(
                "before_fingerprints.stable_record: must be the absent "
                "marker for the first operation"
            )
    else:
        _validate_hex64(
            stable_before,
            field_name="before_fingerprints.stable_record",
        )
    return _freeze_mapping(dict(value))


def _validate_confirmed_writes(value: object) -> tuple[str, ...]:
    if type(value) is not tuple:
        raise FieldTypeError(
            f"confirmed_writes: expected tuple, got {type(value).__name__}"
        )
    seen: list[str] = []
    for item in value:
        if item not in _CONFIRMED_WRITE_TARGETS:
            raise InvariantViolationError(
                "confirmed_writes: only task, manifest, and instruction "
                "targets are allowed"
            )
        if item in seen:
            raise InvariantViolationError(
                "confirmed_writes: duplicate targets are not allowed"
            )
        seen.append(item)
    return value


def _require_duplicated_action_input_facts(
    payload: Mapping[str, object],
    *,
    observed_at: datetime,
    completed_at: datetime | None,
    artifact_input: Mapping[str, object] | None,
    field_name: str,
) -> None:
    if payload["observed_at"] != _iso(observed_at):
        raise InvariantViolationError(
            f"{field_name}: observed_at must equal original_observed_at"
        )
    if payload["completed_at"] != _optional_iso(completed_at):
        raise InvariantViolationError(
            f"{field_name}: completed_at must equal original_completed_at"
        )
    snapshot_artifact = payload["artifact"]
    expected_artifact = (
        None if artifact_input is None else _thaw_mapping(artifact_input)
    )
    thawed_snapshot_artifact = (
        None if snapshot_artifact is None else _thaw_mapping(snapshot_artifact)
    )
    if thawed_snapshot_artifact != expected_artifact:
        raise InvariantViolationError(
            f"{field_name}: artifact must equal the artifact_input field"
        )
