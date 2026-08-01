"""QCD event model, typed payload constructors, and envelope codec.

The append-only QCD event log (ADR-0003) is the single source of raw
QCD facts. This module defines the seven event types, the uniform
``QcdEvent`` envelope, one typed constructor per event type that pins
the exact payload key set and derives the deterministic ``event_id``,
and the strict envelope <-> object codec used by ``qcd.log``.

No constructor reads the clock: ``occurred_at`` (and any duration or
identity input) is supplied by the caller, per the TASK-004 time
authority rule carried into M1.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from ai_video_workflow.errors import (
    FieldTypeError,
    InvariantViolationError,
    MissingFieldError,
)
from ai_video_workflow.manifest import JsonCompatibleValue
from ai_video_workflow.validation import (
    validate_json_compatible,
    validate_stable_id,
    validate_utc_datetime,
)

QCD_LOG_SCHEMA_VERSION = 1
RATING_SCALE = "m1-rating-1to5-v1"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# Fixed value domains (ADR-0003): the GenerationTask lifecycle statuses and
# the orchestration actions that may drive a status change.
_TASK_STATUSES = frozenset({"pending", "in_progress", "done", "failed", "cancelled"})
_ORCHESTRATION_ACTIONS = frozenset(
    {"prepare", "submit", "poll", "report_artifact", "collect", "replay_result"}
)


class QcdEventType(str, Enum):
    """The fixed QCD event types.

    Seven were fixed by ADR-0003 §3; ADR-0008 adds the eighth,
    ``provider_cost_recorded``, as the authoritative cloud cost fact.
    """

    TASK_CREATED = "task_created"
    TASK_STATUS_CHANGED = "task_status_changed"
    MANUAL_ATTEMPT_RECORDED = "manual_attempt_recorded"
    ASSET_IMPORTED = "asset_imported"
    VALIDATION_COMPLETED = "validation_completed"
    COMPOSITION_COMPLETED = "composition_completed"
    MANUAL_QUALITY_RATING_RECORDED = "manual_quality_rating_recorded"
    PROVIDER_COST_RECORDED = "provider_cost_recorded"


# Fixed payload key set per event type (ADR-0003 §4). Every listed key
# must appear; no other key may. Nullable keys are present with an
# explicit null.
_PAYLOAD_KEYS: dict[QcdEventType, frozenset[str]] = {
    QcdEventType.TASK_CREATED: frozenset(
        {
            "initial_status",
            "task_kind",
            "configured_provider_id",
            "origin",
            "redo_of_task_id",
        }
    ),
    QcdEventType.TASK_STATUS_CHANGED: frozenset(
        {
            "previous_status",
            "new_status",
            "orchestration_action",
            "reason",
            "operation_id",
        }
    ),
    QcdEventType.MANUAL_ATTEMPT_RECORDED: frozenset(
        {
            "attempt_id",
            "provider_id",
            "action",
            "elapsed_ms",
            "cost_minor_units",
            "currency",
            "outcome",
            "note",
        }
    ),
    QcdEventType.ASSET_IMPORTED: frozenset(
        {
            "asset_id",
            "asset_kind",
            "sha256",
            "size_bytes",
            "duration_ms",
            "source_task_id",
            "source_attempt_id",
            "path",
            "version",
        }
    ),
    QcdEventType.VALIDATION_COMPLETED: frozenset(
        {
            "passed",
            "report_path",
            "report_version",
            "checks_total",
            "checks_failed",
            "elapsed_ms",
            "asset_id",
            "input_sha256",
        }
    ),
    QcdEventType.COMPOSITION_COMPLETED: frozenset(
        {
            "output_path",
            "output_version",
            "output_sha256",
            "output_duration_ms",
            "input_asset_ids",
            "entry_count",
            "profile_digest",
            "elapsed_ms",
        }
    ),
    QcdEventType.MANUAL_QUALITY_RATING_RECORDED: frozenset(
        {"rating_id", "asset_id", "score", "scale", "note"}
    ),
    QcdEventType.PROVIDER_COST_RECORDED: frozenset(
        {
            "provider_id",
            "model_id",
            "operation_id",
            "cost_minor_units",
            "currency",
            "billing_source",
            "observed_amount",
            "observed_unit",
        }
    ),
}


@dataclass(frozen=True, slots=True)
class QcdEvent:
    """One append-only QCD event (ADR-0003 uniform envelope)."""

    event_id: str
    event_type: QcdEventType
    occurred_at: datetime
    project_id: str
    shot_id: str | None
    task_id: str | None
    payload: Mapping[str, JsonCompatibleValue]

    def __post_init__(self) -> None:
        validate_stable_id(self.event_id, field_name="event_id")
        if not isinstance(self.event_type, QcdEventType):
            got = type(self.event_type).__name__
            raise FieldTypeError(f"event_type: expected QcdEventType, got {got}")
        validate_utc_datetime(self.occurred_at, field_name="occurred_at")
        validate_stable_id(self.project_id, field_name="project_id")
        if self.shot_id is not None:
            validate_stable_id(self.shot_id, field_name="shot_id")
        if self.task_id is not None:
            validate_stable_id(self.task_id, field_name="task_id")
        if not isinstance(self.payload, dict):
            raise FieldTypeError(
                f"payload: expected dict, got {type(self.payload).__name__}"
            )
        validate_json_compatible(self.payload, path="payload")
        expected_keys = _PAYLOAD_KEYS[self.event_type]
        actual_keys = frozenset(self.payload)
        if actual_keys != expected_keys:
            missing = expected_keys - actual_keys
            if missing:
                raise MissingFieldError(
                    f"payload: {self.event_type.value} is missing keys "
                    f"{sorted(missing)}"
                )
            raise InvariantViolationError(
                f"payload: {self.event_type.value} has unexpected keys "
                f"{sorted(actual_keys - expected_keys)}"
            )
        # per-type value domains + event_id derivation are enforced here so
        # that both the typed constructors and log deserialization (a plain
        # QcdEvent(...)) reject bad SHA/int/status/path and a mismatched
        # event_id, not only the builders (ADR-0003).
        _validate_payload_domains(self.event_type, self.payload)
        expected_id = _expected_event_id(
            self.event_type, self.project_id, self.shot_id, self.task_id, self.payload
        )
        if self.event_id != expected_id:
            raise InvariantViolationError(
                f"event_id: {self.event_id!r} does not match the derived id "
                f"{expected_id!r} for {self.event_type.value}"
            )

    def to_envelope(self) -> dict[str, JsonCompatibleValue]:
        """Return the JSON-compatible envelope dict (ADR-0003 §3)."""
        return {
            "schema_version": QCD_LOG_SCHEMA_VERSION,
            "event_id": self.event_id,
            "event_type": self.event_type.value,
            "occurred_at": self.occurred_at.isoformat(timespec="microseconds"),
            "project_id": self.project_id,
            "shot_id": self.shot_id,
            "task_id": self.task_id,
            "payload": dict(self.payload),
        }


# --- money helper ---------------------------------------------------------


def _validate_money(cost_minor_units: int | None, currency: str | None) -> None:
    if (cost_minor_units is None) != (currency is None):
        raise InvariantViolationError(
            "cost_minor_units and currency must both be null or both non-null"
        )
    if cost_minor_units is not None:
        if isinstance(cost_minor_units, bool) or not isinstance(cost_minor_units, int):
            raise FieldTypeError("cost_minor_units: expected int")
        if (
            not isinstance(currency, str)
            or currency != currency.upper()
            or not currency
        ):
            raise InvariantViolationError("currency: expected non-empty ISO-4217 code")


def _validate_elapsed_ms(value: int | None) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise InvariantViolationError("elapsed_ms: expected a non-negative int or null")


def _validate_sha256(value: object, field: str) -> None:
    if not isinstance(value, str) or _SHA256_RE.match(value) is None:
        raise InvariantViolationError(
            f"{field}: expected a lowercase hex SHA-256 digest"
        )


def _validate_positive_int(value: object, field: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise InvariantViolationError(f"{field}: expected a positive int")


def _validate_non_negative_int(value: object, field: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise InvariantViolationError(f"{field}: expected a non-negative int")


def _validate_duration_ms(value: object, field: str) -> None:
    if value is None:
        return
    _validate_non_negative_int(value, field)


def _validate_rel_path(value: object, field: str) -> None:
    if not isinstance(value, str) or not value:
        raise InvariantViolationError(f"{field}: expected a non-empty path")
    if value.startswith("/") or ".." in value.split("/"):
        raise InvariantViolationError(
            f"{field}: expected a relative path without '..' components"
        )


def _validate_bool(value: object, field: str) -> None:
    if not isinstance(value, bool):
        raise InvariantViolationError(f"{field}: expected a bool")


def _require_fixed(value: object, expected: str, field: str) -> None:
    """Enforce an ADR-0003 single fixed value (type-safe, never a TypeError)."""
    if value != expected:
        raise InvariantViolationError(f"{field}: expected {expected!r}")


def _require_enum(value: object, domain: frozenset[str], field: str) -> None:
    """Enforce membership in a fixed domain without an unhashable TypeError."""
    if not isinstance(value, str) or value not in domain:
        raise InvariantViolationError(f"{field}: unknown value")


def _require_opt_stable_id(value: object, field: str) -> None:
    if value is None:
        return
    validate_stable_id(value, field_name=field)


def _validate_payload_domains(event_type: QcdEventType, payload: Mapping) -> None:
    """Enforce per-type value domains on a key-validated payload.

    Every check is type-safe: a non-string value never reaches a set
    membership test, so a malformed log line raises InvariantViolationError
    (an AiVideoWorkflowError the reader maps to CorruptEventLogError) rather
    than leaking a bare TypeError.
    """
    if event_type is QcdEventType.TASK_CREATED:
        _require_fixed(payload["initial_status"], "pending", "initial_status")
        _require_fixed(payload["task_kind"], "generation", "task_kind")
        if not isinstance(payload["configured_provider_id"], str):
            raise InvariantViolationError("configured_provider_id: expected a str")
        _require_enum(payload["origin"], frozenset({"bootstrap", "redo"}), "origin")
        if not (
            payload["redo_of_task_id"] is None
            or isinstance(payload["redo_of_task_id"], str)
        ):
            raise InvariantViolationError("redo_of_task_id: expected a str or null")
    elif event_type is QcdEventType.TASK_STATUS_CHANGED:
        _require_enum(payload["previous_status"], _TASK_STATUSES, "previous_status")
        _require_enum(payload["new_status"], _TASK_STATUSES, "new_status")
        _require_enum(
            payload["orchestration_action"],
            _ORCHESTRATION_ACTIONS,
            "orchestration_action",
        )
        _require_fixed(payload["reason"], "provider_transition", "reason")
        validate_stable_id(payload["operation_id"], field_name="operation_id")
    elif event_type is QcdEventType.MANUAL_ATTEMPT_RECORDED:
        validate_stable_id(payload["attempt_id"], field_name="attempt_id")
        if not isinstance(payload["provider_id"], str):
            raise InvariantViolationError("provider_id: expected a str")
        _require_fixed(payload["action"], "manual_generation", "action")
        _require_enum(
            payload["outcome"],
            frozenset({"produced_candidate", "discarded", "unknown"}),
            "outcome",
        )
        _validate_elapsed_ms(payload["elapsed_ms"])
        _validate_money(payload["cost_minor_units"], payload["currency"])
    elif event_type is QcdEventType.ASSET_IMPORTED:
        validate_stable_id(payload["asset_id"], field_name="asset_id")
        _require_fixed(payload["asset_kind"], "video", "asset_kind")
        _validate_sha256(payload["sha256"], "sha256")
        _validate_positive_int(payload["size_bytes"], "size_bytes")
        _validate_positive_int(payload["version"], "version")
        _validate_duration_ms(payload["duration_ms"], "duration_ms")
        validate_stable_id(payload["source_task_id"], field_name="source_task_id")
        _require_opt_stable_id(payload["source_attempt_id"], "source_attempt_id")
        _validate_rel_path(payload["path"], "path")
    elif event_type is QcdEventType.VALIDATION_COMPLETED:
        _validate_bool(payload["passed"], "passed")
        _validate_sha256(payload["input_sha256"], "input_sha256")
        _validate_positive_int(payload["report_version"], "report_version")
        _validate_non_negative_int(payload["checks_total"], "checks_total")
        _validate_non_negative_int(payload["checks_failed"], "checks_failed")
        if payload["checks_failed"] > payload["checks_total"]:
            raise InvariantViolationError("checks_failed: must not exceed checks_total")
        _validate_elapsed_ms(payload["elapsed_ms"])
        _require_opt_stable_id(payload["asset_id"], "asset_id")
        _validate_rel_path(payload["report_path"], "report_path")
    elif event_type is QcdEventType.COMPOSITION_COMPLETED:
        _validate_sha256(payload["output_sha256"], "output_sha256")
        _validate_positive_int(payload["output_version"], "output_version")
        _validate_duration_ms(payload["output_duration_ms"], "output_duration_ms")
        _validate_non_negative_int(payload["entry_count"], "entry_count")
        _validate_rel_path(payload["output_path"], "output_path")
        if not isinstance(payload["profile_digest"], str):
            raise InvariantViolationError("profile_digest: expected a str")
        _validate_elapsed_ms(payload["elapsed_ms"])
        ids = payload["input_asset_ids"]
        if not isinstance(ids, list):
            raise InvariantViolationError("input_asset_ids: expected a list")
        for asset_id in ids:
            validate_stable_id(asset_id, field_name="input_asset_ids[]")
        if payload["entry_count"] != len(ids):
            raise InvariantViolationError(
                "entry_count: must equal len(input_asset_ids)"
            )
    elif event_type is QcdEventType.MANUAL_QUALITY_RATING_RECORDED:
        validate_stable_id(payload["rating_id"], field_name="rating_id")
        _require_opt_stable_id(payload["asset_id"], "asset_id")
        _require_fixed(payload["scale"], RATING_SCALE, "scale")
        score = payload["score"]
        if isinstance(score, bool) or not isinstance(score, int) or not 1 <= score <= 5:
            raise InvariantViolationError("score: expected an int in [1, 5]")
    elif event_type is QcdEventType.PROVIDER_COST_RECORDED:
        if not isinstance(payload["provider_id"], str) or not payload["provider_id"]:
            raise InvariantViolationError("provider_id: expected a non-empty str")
        if not isinstance(payload["model_id"], str) or not payload["model_id"]:
            raise InvariantViolationError("model_id: expected a non-empty str")
        validate_stable_id(payload["operation_id"], field_name="operation_id")
        cost = payload["cost_minor_units"]
        if isinstance(cost, bool) or not isinstance(cost, int) or cost < 0:
            raise InvariantViolationError(
                "cost_minor_units: expected a non-negative int"
            )
        currency = payload["currency"]
        if (
            not isinstance(currency, str)
            or not currency
            or currency != currency.upper()
        ):
            raise InvariantViolationError(
                "currency: expected a non-empty ISO-4217 code"
            )
        if (
            not isinstance(payload["billing_source"], str)
            or not payload["billing_source"]
        ):
            raise InvariantViolationError("billing_source: expected a non-empty str")
        observed_amount = payload["observed_amount"]
        if observed_amount is not None and (
            isinstance(observed_amount, bool)
            or not isinstance(observed_amount, (int, float))
        ):
            raise InvariantViolationError("observed_amount: expected a float or null")
        observed_unit = payload["observed_unit"]
        if observed_unit is not None and not isinstance(observed_unit, str):
            raise InvariantViolationError("observed_unit: expected a str or null")


def _expected_event_id(
    event_type: QcdEventType,
    project_id: str,
    shot_id: str | None,
    task_id: str | None,
    payload: Mapping,
) -> str:
    """Re-derive the deterministic event_id from the envelope + payload."""
    if event_type is QcdEventType.TASK_CREATED:
        return f"task_created:{task_id}"
    if event_type is QcdEventType.TASK_STATUS_CHANGED:
        return f"task_status_changed:{task_id}:{payload['operation_id']}"
    if event_type is QcdEventType.MANUAL_ATTEMPT_RECORDED:
        return f"manual_attempt_recorded:{task_id}:{payload['attempt_id']}"
    if event_type is QcdEventType.ASSET_IMPORTED:
        return (
            f"asset_imported:{project_id}:{shot_id}:{task_id}"
            f":{payload['asset_id']}:{payload['sha256']}"
        )
    if event_type is QcdEventType.VALIDATION_COMPLETED:
        return f"validation_completed:{task_id}:v{payload['report_version']}"
    if event_type is QcdEventType.COMPOSITION_COMPLETED:
        return f"composition_completed:{project_id}:v{payload['output_version']}"
    if event_type is QcdEventType.PROVIDER_COST_RECORDED:
        return f"provider_cost_recorded:{task_id}:{payload['operation_id']}"
    return f"manual_quality_rating_recorded:{shot_id}:{payload['rating_id']}"


# --- typed constructors (fix the payload key set + derive event_id) -------


def build_task_created_event(
    *,
    project_id: str,
    shot_id: str,
    task_id: str,
    configured_provider_id: str,
    origin: str,
    redo_of_task_id: str | None,
    occurred_at: datetime,
) -> QcdEvent:
    if origin not in ("bootstrap", "redo"):
        raise InvariantViolationError("origin: expected 'bootstrap' or 'redo'")
    validate_stable_id(task_id, field_name="task_id")
    return QcdEvent(
        event_id=f"task_created:{task_id}",
        event_type=QcdEventType.TASK_CREATED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        payload={
            "initial_status": "pending",
            "task_kind": "generation",
            "configured_provider_id": configured_provider_id,
            "origin": origin,
            "redo_of_task_id": redo_of_task_id,
        },
    )


def build_task_status_changed_event(
    *,
    project_id: str,
    shot_id: str,
    task_id: str,
    previous_status: str,
    new_status: str,
    orchestration_action: str,
    operation_id: str,
    occurred_at: datetime,
    reason: str = "provider_transition",
) -> QcdEvent:
    validate_stable_id(task_id, field_name="task_id")
    validate_stable_id(operation_id, field_name="operation_id")
    if previous_status not in _TASK_STATUSES:
        raise InvariantViolationError(f"previous_status: unknown {previous_status!r}")
    if new_status not in _TASK_STATUSES:
        raise InvariantViolationError(f"new_status: unknown {new_status!r}")
    if orchestration_action not in _ORCHESTRATION_ACTIONS:
        raise InvariantViolationError(
            f"orchestration_action: unknown {orchestration_action!r}"
        )
    return QcdEvent(
        event_id=f"task_status_changed:{task_id}:{operation_id}",
        event_type=QcdEventType.TASK_STATUS_CHANGED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        payload={
            "previous_status": previous_status,
            "new_status": new_status,
            "orchestration_action": orchestration_action,
            "reason": reason,
            "operation_id": operation_id,
        },
    )


def build_manual_attempt_recorded_event(
    *,
    project_id: str,
    shot_id: str,
    task_id: str,
    attempt_id: str,
    provider_id: str,
    outcome: str,
    occurred_at: datetime,
    action: str = "manual_generation",
    elapsed_ms: int | None = None,
    cost_minor_units: int | None = None,
    currency: str | None = None,
    note: str | None = None,
) -> QcdEvent:
    validate_stable_id(task_id, field_name="task_id")
    validate_stable_id(attempt_id, field_name="attempt_id")
    if outcome not in ("produced_candidate", "discarded", "unknown"):
        raise InvariantViolationError(
            "outcome: expected 'produced_candidate', 'discarded', or 'unknown'"
        )
    _validate_elapsed_ms(elapsed_ms)
    _validate_money(cost_minor_units, currency)
    return QcdEvent(
        event_id=f"manual_attempt_recorded:{task_id}:{attempt_id}",
        event_type=QcdEventType.MANUAL_ATTEMPT_RECORDED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        payload={
            "attempt_id": attempt_id,
            "provider_id": provider_id,
            "action": action,
            "elapsed_ms": elapsed_ms,
            "cost_minor_units": cost_minor_units,
            "currency": currency,
            "outcome": outcome,
            "note": note,
        },
    )


def build_asset_imported_event(
    *,
    project_id: str,
    shot_id: str,
    task_id: str,
    asset_id: str,
    sha256: str,
    size_bytes: int,
    path: str,
    version: int,
    duration_ms: int | None,
    source_attempt_id: str | None,
    occurred_at: datetime,
    asset_kind: str = "video",
) -> QcdEvent:
    validate_stable_id(task_id, field_name="task_id")
    validate_stable_id(shot_id, field_name="shot_id")
    validate_stable_id(asset_id, field_name="asset_id")
    _validate_sha256(sha256, "sha256")
    _validate_positive_int(size_bytes, "size_bytes")
    _validate_positive_int(version, "version")
    _validate_duration_ms(duration_ms, "duration_ms")
    return QcdEvent(
        event_id=(
            f"asset_imported:{project_id}:{shot_id}:{task_id}:{asset_id}:{sha256}"
        ),
        event_type=QcdEventType.ASSET_IMPORTED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        payload={
            "asset_id": asset_id,
            "asset_kind": asset_kind,
            "sha256": sha256,
            "size_bytes": size_bytes,
            "duration_ms": duration_ms,
            "source_task_id": task_id,
            "source_attempt_id": source_attempt_id,
            "path": path,
            "version": version,
        },
    )


def build_validation_completed_event(
    *,
    project_id: str,
    shot_id: str,
    task_id: str,
    passed: bool,
    report_path: str,
    report_version: int,
    checks_total: int,
    checks_failed: int,
    input_sha256: str,
    asset_id: str | None,
    occurred_at: datetime,
    elapsed_ms: int | None = None,
) -> QcdEvent:
    validate_stable_id(task_id, field_name="task_id")
    _validate_elapsed_ms(elapsed_ms)
    _validate_sha256(input_sha256, "input_sha256")
    _validate_positive_int(report_version, "report_version")
    _validate_non_negative_int(checks_total, "checks_total")
    _validate_non_negative_int(checks_failed, "checks_failed")
    return QcdEvent(
        event_id=f"validation_completed:{task_id}:v{report_version}",
        event_type=QcdEventType.VALIDATION_COMPLETED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        payload={
            "passed": passed,
            "report_path": report_path,
            "report_version": report_version,
            "checks_total": checks_total,
            "checks_failed": checks_failed,
            "elapsed_ms": elapsed_ms,
            "asset_id": asset_id,
            "input_sha256": input_sha256,
        },
    )


def build_composition_completed_event(
    *,
    project_id: str,
    output_path: str,
    output_version: int,
    output_sha256: str,
    input_asset_ids: tuple[str, ...],
    profile_digest: str,
    occurred_at: datetime,
    output_duration_ms: int | None,
    elapsed_ms: int | None = None,
) -> QcdEvent:
    _validate_elapsed_ms(elapsed_ms)
    _validate_sha256(output_sha256, "output_sha256")
    _validate_positive_int(output_version, "output_version")
    _validate_duration_ms(output_duration_ms, "output_duration_ms")
    for asset_id in input_asset_ids:
        validate_stable_id(asset_id, field_name="input_asset_ids[]")
    return QcdEvent(
        event_id=f"composition_completed:{project_id}:v{output_version}",
        event_type=QcdEventType.COMPOSITION_COMPLETED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=None,
        task_id=None,
        payload={
            "output_path": output_path,
            "output_version": output_version,
            "output_sha256": output_sha256,
            "output_duration_ms": output_duration_ms,
            "input_asset_ids": list(input_asset_ids),
            "entry_count": len(input_asset_ids),
            "profile_digest": profile_digest,
            "elapsed_ms": elapsed_ms,
        },
    )


def build_provider_cost_recorded_event(
    *,
    project_id: str,
    shot_id: str,
    task_id: str,
    provider_id: str,
    model_id: str,
    operation_id: str,
    cost_minor_units: int,
    currency: str,
    billing_source: str,
    occurred_at: datetime,
    observed_amount: float | None = None,
    observed_unit: str | None = None,
) -> QcdEvent:
    """Build the authoritative cloud cost fact event (ADR-0008).

    ``cost_minor_units`` + ``currency`` are the authoritative integer
    amount; ``observed_amount`` / ``observed_unit`` carry the provider's
    non-authoritative float telemetry, and ``billing_source`` records how
    the authoritative amount was derived.
    """
    validate_stable_id(task_id, field_name="task_id")
    validate_stable_id(operation_id, field_name="operation_id")
    if isinstance(cost_minor_units, bool) or not isinstance(cost_minor_units, int):
        raise InvariantViolationError("cost_minor_units: expected a non-negative int")
    return QcdEvent(
        event_id=f"provider_cost_recorded:{task_id}:{operation_id}",
        event_type=QcdEventType.PROVIDER_COST_RECORDED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        payload={
            "provider_id": provider_id,
            "model_id": model_id,
            "operation_id": operation_id,
            "cost_minor_units": cost_minor_units,
            "currency": currency,
            "billing_source": billing_source,
            "observed_amount": observed_amount,
            "observed_unit": observed_unit,
        },
    )


def build_manual_quality_rating_event(
    *,
    project_id: str,
    shot_id: str,
    task_id: str | None,
    rating_id: str,
    score: int,
    asset_id: str | None,
    occurred_at: datetime,
    note: str | None = None,
) -> QcdEvent:
    validate_stable_id(shot_id, field_name="shot_id")
    validate_stable_id(rating_id, field_name="rating_id")
    if isinstance(score, bool) or not isinstance(score, int) or not 1 <= score <= 5:
        raise InvariantViolationError(
            "score: expected an int in the closed range [1, 5]"
        )
    return QcdEvent(
        event_id=f"manual_quality_rating_recorded:{shot_id}:{rating_id}",
        event_type=QcdEventType.MANUAL_QUALITY_RATING_RECORDED,
        occurred_at=occurred_at,
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        payload={
            "rating_id": rating_id,
            "asset_id": asset_id,
            "score": score,
            "scale": RATING_SCALE,
            "note": note,
        },
    )
