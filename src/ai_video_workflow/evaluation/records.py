"""Evaluation-domain record model, typed constructors, and envelope codec.

The append-only evaluation fact log (ADR-0034 / TASK-028) is the single source
of raw evaluation / experiment / creative-decision facts. This module defines
the three record types, the uniform :class:`EvaluationRecord` envelope, one
typed constructor per type that pins the exact payload key set and derives the
deterministic ``record_id``, and the strict envelope<->object codec used by
:mod:`ai_video_workflow.evaluation.log`.

Boundary invariants enforced here (ADR-0034):
- A separate state domain: record types / payload semantics never reuse
  approval / GenerationTask / StepManifest / Provider / reservation enums.
- Non-second-source: every record binds a ``target`` (ref + version +
  content_digest) and a ``goals_version`` that only REFERENCE existing facts;
  nothing here copies or rewrites QC / release / final-review evidence.
- ``actor`` is ``user`` or ``ai``; the AI-cannot-form-a-final-pass rule is a
  service/query concern (a single record just states who authored it).

No constructor reads the clock: ``occurred_at`` is supplied by the caller (the
TASK-004 time-authority rule carried into WFM1).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from types import MappingProxyType

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

EVALUATION_LOG_SCHEMA_VERSION = 1

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# The creative-decision types (ADR-0034 / 统一需求 §5.3): what the user did with
# a candidate. A separate value domain — never reused from workflow state.
_DECISION_TYPES = frozenset(
    {
        "select",
        "abandon",
        "change_prompt",
        "switch_model",
        "redo",
        "accept_imperfect",
    }
)

_TARGET_KEYS = frozenset({"ref", "version", "content_digest"})


class EvaluationRecordType(str, Enum):
    """The three record types carried by the single evaluation-domain log."""

    EVALUATION = "evaluation"
    EXPERIMENT = "experiment"
    CREATIVE_DECISION = "creative_decision"


class EvaluationActor(str, Enum):
    """Who authored a record. AI output is advisory evidence only (ADR-0034)."""

    USER = "user"
    AI = "ai"


# The per-type id field (caller-supplied, unique) that makes the deterministic
# record_id unique — repeated evaluations of the same target are distinct facts.
_ID_FIELD: dict[EvaluationRecordType, str] = {
    EvaluationRecordType.EVALUATION: "evaluation_id",
    EvaluationRecordType.EXPERIMENT: "experiment_id",
    EvaluationRecordType.CREATIVE_DECISION: "decision_id",
}

# Fixed payload key set per record type. Every listed key must appear; no other
# key may. Nullable keys are present with an explicit null.
_PAYLOAD_KEYS: dict[EvaluationRecordType, frozenset[str]] = {
    EvaluationRecordType.EVALUATION: frozenset(
        {"evaluation_id", "criterion", "score", "tag", "pass", "rationale"}
    ),
    EvaluationRecordType.EXPERIMENT: frozenset(
        {
            "experiment_id",
            "variants",
            "changed_factor",
            "expected_improvement",
            "actual_result",
            "reuse_conclusion",
        }
    ),
    EvaluationRecordType.CREATIVE_DECISION: frozenset(
        {"decision_id", "decision_type", "changed", "why", "expected", "actual"}
    ),
}

_ENVELOPE_KEYS = frozenset(
    {
        "schema_version",
        "record_id",
        "record_type",
        "occurred_at",
        "project_id",
        "actor",
        "target",
        "goals_version",
        "payload",
    }
)


@dataclass(frozen=True, slots=True)
class EvaluationRecord:
    """One append-only evaluation-domain fact (ADR-0034 uniform envelope)."""

    record_id: str
    record_type: EvaluationRecordType
    occurred_at: datetime
    project_id: str
    actor: EvaluationActor
    target: Mapping[str, JsonCompatibleValue]
    goals_version: int
    payload: Mapping[str, JsonCompatibleValue]

    def __post_init__(self) -> None:
        validate_stable_id(self.record_id, field_name="record_id")
        if not isinstance(self.record_type, EvaluationRecordType):
            got = type(self.record_type).__name__
            raise FieldTypeError(
                f"record_type: expected EvaluationRecordType, got {got}"
            )
        if not isinstance(self.actor, EvaluationActor):
            got = type(self.actor).__name__
            raise FieldTypeError(f"actor: expected EvaluationActor, got {got}")
        validate_utc_datetime(self.occurred_at, field_name="occurred_at")
        validate_stable_id(self.project_id, field_name="project_id")
        _validate_target(self.target)
        _validate_positive_int(self.goals_version, "goals_version")
        if not isinstance(self.payload, dict):
            raise FieldTypeError(
                f"payload: expected dict, got {type(self.payload).__name__}"
            )
        validate_json_compatible(self.payload, path="payload")
        expected_keys = _PAYLOAD_KEYS[self.record_type]
        actual_keys = frozenset(self.payload)
        if actual_keys != expected_keys:
            missing = expected_keys - actual_keys
            if missing:
                raise MissingFieldError(
                    f"payload: {self.record_type.value} is missing keys "
                    f"{sorted(missing)}"
                )
            raise InvariantViolationError(
                f"payload: {self.record_type.value} has unexpected keys "
                f"{sorted(actual_keys - expected_keys)}"
            )
        # Per-type value domains + record_id derivation are enforced here so a
        # plain EvaluationRecord(...) built by log deserialization is rejected
        # for a bad domain value or a mismatched record_id, not only the
        # typed constructors (ADR-0034 boundary).
        _validate_payload_domains(self.record_type, self.payload)
        expected_id = _expected_record_id(
            self.record_type, self.project_id, self.payload
        )
        if self.record_id != expected_id:
            raise InvariantViolationError(
                f"record_id: {self.record_id!r} does not match the derived id "
                f"{expected_id!r} for {self.record_type.value}"
            )
        # Decouple the validated fact from the caller's references AND make it
        # deeply immutable: a caller must not be able to alter (or invalidate) a
        # record after construction, whether through a dict it still holds or by
        # reaching into a nested list/dict via the record. _freeze rebuilds
        # every container as a read-only view / tuple, so the persisted fact is
        # exactly what was validated here. (frozen dataclass -> object.__setattr__.)
        object.__setattr__(self, "target", _freeze(dict(self.target)))
        object.__setattr__(self, "payload", _freeze(dict(self.payload)))

    def to_envelope(self) -> dict[str, JsonCompatibleValue]:
        """Return the JSON-compatible envelope dict (ADR-0034 / TASK-028)."""
        return {
            "schema_version": EVALUATION_LOG_SCHEMA_VERSION,
            "record_id": self.record_id,
            "record_type": self.record_type.value,
            "occurred_at": self.occurred_at.isoformat(timespec="microseconds"),
            "project_id": self.project_id,
            "actor": self.actor.value,
            "target": _to_plain(self.target),
            "goals_version": self.goals_version,
            "payload": _to_plain(self.payload),
        }


def _freeze(value: object) -> object:
    """Recursively make a JSON-compatible value read-only: dict ->
    MappingProxyType, list -> tuple; scalars are already immutable."""
    if isinstance(value, dict):
        return MappingProxyType({k: _freeze(v) for k, v in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(v) for v in value)
    return value


def _to_plain(value: object) -> JsonCompatibleValue:
    """Inverse of :func:`_freeze`: a frozen structure back to plain dict/list
    so it can be JSON-serialized (MappingProxyType/tuple are not serializable)."""
    if isinstance(value, (MappingProxyType, dict)):
        return {k: _to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(v) for v in value]
    return value


# --- value-domain validators --------------------------------------------------


def _validate_positive_int(value: object, field: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise InvariantViolationError(f"{field}: expected a positive int")


def _validate_sha256(value: object, field: str) -> None:
    if not isinstance(value, str) or _SHA256_RE.match(value) is None:
        raise InvariantViolationError(
            f"{field}: expected a lowercase hex SHA-256 digest"
        )


def _validate_non_empty_str(value: object, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise InvariantViolationError(f"{field}: expected a non-empty string")


def _validate_nullable_str(value: object, field: str) -> None:
    if value is not None and not isinstance(value, str):
        raise FieldTypeError(f"{field}: expected a string or null")


def _validate_target(target: object) -> None:
    """A target binds one evaluated artifact by ref + version + content_digest.

    The record only REFERENCES the target; the service/query layer checks the
    reference against authoritative facts and marks stale on drift (ADR-0034).
    """
    if not isinstance(target, dict):
        raise FieldTypeError(f"target: expected dict, got {type(target).__name__}")
    if frozenset(target) != _TARGET_KEYS:
        raise InvariantViolationError(
            f"target: expected exactly {sorted(_TARGET_KEYS)}, got {sorted(target)}"
        )
    validate_stable_id(target["ref"], field_name="target.ref")
    _validate_positive_int(target["version"], "target.version")
    _validate_sha256(target["content_digest"], "target.content_digest")


def _validate_payload_domains(
    record_type: EvaluationRecordType, payload: Mapping
) -> None:
    validate_stable_id(payload[_ID_FIELD[record_type]], field_name="id")
    if record_type is EvaluationRecordType.EVALUATION:
        _validate_non_empty_str(payload["criterion"], "criterion")
        score = payload["score"]
        if score is not None and (
            isinstance(score, bool) or not isinstance(score, int)
        ):
            raise FieldTypeError("score: expected an int or null")
        _validate_nullable_str(payload["tag"], "tag")
        if not isinstance(payload["pass"], bool):
            raise FieldTypeError("pass: expected a bool")
        _validate_non_empty_str(payload["rationale"], "rationale")
        return
    if record_type is EvaluationRecordType.EXPERIMENT:
        variants = payload["variants"]
        if not isinstance(variants, list) or len(variants) < 2:
            raise InvariantViolationError(
                "variants: expected a list of at least two compared variants"
            )
        for i, variant in enumerate(variants):
            _validate_target_like(variant, f"variants[{i}]")
        _validate_non_empty_str(payload["changed_factor"], "changed_factor")
        _validate_non_empty_str(payload["expected_improvement"], "expected_improvement")
        _validate_nullable_str(payload["actual_result"], "actual_result")
        _validate_nullable_str(payload["reuse_conclusion"], "reuse_conclusion")
        return
    # CREATIVE_DECISION. isinstance-first so an unhashable value (list/dict)
    # fails closed here instead of raising TypeError from the set membership.
    if (
        not isinstance(payload["decision_type"], str)
        or payload["decision_type"] not in _DECISION_TYPES
    ):
        raise InvariantViolationError(
            f"decision_type: expected one of {sorted(_DECISION_TYPES)}"
        )
    _validate_non_empty_str(payload["changed"], "changed")
    _validate_non_empty_str(payload["why"], "why")
    _validate_non_empty_str(payload["expected"], "expected")
    _validate_nullable_str(payload["actual"], "actual")


def _validate_target_like(value: object, field: str) -> None:
    if not isinstance(value, dict) or frozenset(value) != _TARGET_KEYS:
        raise InvariantViolationError(
            f"{field}: expected a target object {sorted(_TARGET_KEYS)}"
        )
    validate_stable_id(value["ref"], field_name=f"{field}.ref")
    _validate_positive_int(value["version"], f"{field}.version")
    _validate_sha256(value["content_digest"], f"{field}.content_digest")


def _expected_record_id(
    record_type: EvaluationRecordType, project_id: str, payload: Mapping
) -> str:
    """Re-derive the deterministic record_id from the type + project + id field."""
    return f"{record_type.value}:{project_id}:{payload[_ID_FIELD[record_type]]}"


# --- envelope codec -----------------------------------------------------------


def record_from_envelope(envelope: object) -> EvaluationRecord:
    """Strictly decode one envelope dict into an :class:`EvaluationRecord`.

    Every envelope key must be present and no other; unknown record types,
    bad datetimes/enums, wrong payload key sets and mismatched record_ids all
    raise (validation happens in ``EvaluationRecord.__post_init__``).
    """
    if not isinstance(envelope, dict):
        raise FieldTypeError(f"envelope: expected dict, got {type(envelope).__name__}")
    if frozenset(envelope) != _ENVELOPE_KEYS:
        raise InvariantViolationError("envelope: unexpected key set")
    schema_version = envelope["schema_version"]
    # bool is an int subclass and True == 1; reject it explicitly so a boolean
    # cannot masquerade as schema v1.
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version != EVALUATION_LOG_SCHEMA_VERSION
    ):
        raise InvariantViolationError(
            f"schema_version: expected {EVALUATION_LOG_SCHEMA_VERSION}, "
            f"got {schema_version!r}"
        )
    # (ValueError, TypeError): an unknown value raises ValueError; an
    # unhashable value (e.g. a list) raises TypeError. Both are a corrupt
    # envelope, not a crash — the reader must surface them as its documented
    # structured error, never an uncaught TypeError.
    try:
        record_type = EvaluationRecordType(envelope["record_type"])
    except (ValueError, TypeError) as exc:
        raise InvariantViolationError(
            f"record_type: unknown value {envelope['record_type']!r}"
        ) from exc
    try:
        actor = EvaluationActor(envelope["actor"])
    except (ValueError, TypeError) as exc:
        raise InvariantViolationError(
            f"actor: unknown value {envelope['actor']!r}"
        ) from exc
    occurred_at = _parse_iso_utc(envelope["occurred_at"])
    payload = envelope["payload"]
    if not isinstance(payload, dict):
        raise FieldTypeError("payload: expected dict")
    return EvaluationRecord(
        record_id=envelope["record_id"],
        record_type=record_type,
        occurred_at=occurred_at,
        project_id=envelope["project_id"],
        actor=actor,
        target=envelope["target"],
        goals_version=envelope["goals_version"],
        payload=payload,
    )


def _parse_iso_utc(value: object) -> datetime:
    if not isinstance(value, str):
        raise FieldTypeError("occurred_at: expected an ISO-8601 string")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise InvariantViolationError(
            f"occurred_at: not a valid ISO-8601 datetime: {value!r}"
        ) from exc
    return validate_utc_datetime(parsed, field_name="occurred_at")


# --- typed constructors (fix the payload key set + derive record_id) ----------


def build_evaluation_record(
    *,
    project_id: str,
    actor: EvaluationActor,
    target: Mapping[str, JsonCompatibleValue],
    goals_version: int,
    evaluation_id: str,
    criterion: str,
    score: int | None,
    tag: str | None,
    passed: bool,
    rationale: str,
    occurred_at: datetime,
) -> EvaluationRecord:
    """Build one evaluation record (a scored/tagged assessment of a target)."""
    payload = {
        "evaluation_id": evaluation_id,
        "criterion": criterion,
        "score": score,
        "tag": tag,
        "pass": passed,
        "rationale": rationale,
    }
    return EvaluationRecord(
        record_id=f"evaluation:{project_id}:{evaluation_id}",
        record_type=EvaluationRecordType.EVALUATION,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        target=target,
        goals_version=goals_version,
        payload=payload,
    )


def build_experiment_record(
    *,
    project_id: str,
    actor: EvaluationActor,
    target: Mapping[str, JsonCompatibleValue],
    goals_version: int,
    experiment_id: str,
    variants: list,
    changed_factor: str,
    expected_improvement: str,
    actual_result: str | None,
    reuse_conclusion: str | None,
    occurred_at: datetime,
) -> EvaluationRecord:
    """Build one experiment record (a comparison of two or more variants)."""
    payload = {
        "experiment_id": experiment_id,
        "variants": variants,
        "changed_factor": changed_factor,
        "expected_improvement": expected_improvement,
        "actual_result": actual_result,
        "reuse_conclusion": reuse_conclusion,
    }
    return EvaluationRecord(
        record_id=f"experiment:{project_id}:{experiment_id}",
        record_type=EvaluationRecordType.EXPERIMENT,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        target=target,
        goals_version=goals_version,
        payload=payload,
    )


def build_creative_decision_record(
    *,
    project_id: str,
    actor: EvaluationActor,
    target: Mapping[str, JsonCompatibleValue],
    goals_version: int,
    decision_id: str,
    decision_type: str,
    changed: str,
    why: str,
    expected: str,
    actual: str | None,
    occurred_at: datetime,
) -> EvaluationRecord:
    """Build one creative-decision record (select/abandon/redo/... + why)."""
    payload = {
        "decision_id": decision_id,
        "decision_type": decision_type,
        "changed": changed,
        "why": why,
        "expected": expected,
        "actual": actual,
    }
    return EvaluationRecord(
        record_id=f"creative_decision:{project_id}:{decision_id}",
        record_type=EvaluationRecordType.CREATIVE_DECISION,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        target=target,
        goals_version=goals_version,
        payload=payload,
    )
