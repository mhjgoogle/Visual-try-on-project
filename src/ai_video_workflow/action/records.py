"""Feedback / Action fact-domain record model and envelope codec (ADR-0035).

The append-only feedback/action log (ADR-0035 / TASK-029) is the single source
of raw problem-report (``feedback``) and controlled-handling (``action``) facts,
plus the append-only lifecycle events that a running Action accumulates
(``transition`` / ``handling`` / ``verification`` / ``rebind``). This module
defines those record types, the uniform :class:`ActionRecord` envelope, one
typed constructor per type that pins the exact payload key set and derives the
deterministic ``record_id``, and the strict envelope<->object codec.

Boundary invariants enforced here (ADR-0035):
- A SEPARATE state domain: the Action lifecycle states never reuse
  workflow-approval / GenerationTask / StepManifest / Provider / reservation
  state (ADR-0010 decision 7). The current Action state is DERIVED by folding
  these append-only events (see :mod:`ai_video_workflow.action.state`); the log
  only stores immutable facts.
- Version binding: ``feedback`` / ``action`` / ``rebind`` bind a ``target``
  (ref + version + content_digest); staleness is derived at read time.
- Feedback stands alone: a ``feedback`` never carries execution/handling
  semantics.
- Credential isolation: the context snapshot rejects credential-looking keys
  and URL-looking values so no secret/private URL can enter a record.

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

ACTION_LOG_SCHEMA_VERSION = 1

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TARGET_KEYS = frozenset({"ref", "version", "content_digest"})

# The Action lifecycle states (ADR-0035). A SEPARATE value domain — never
# reused from workflow/approval/provider state. ``stale`` is DERIVED (target
# digest drift), never an explicit stored transition, so it is not a valid
# ``to_state``; ``pending`` is the implicit initial state at action creation.
_TERMINAL_STATES = frozenset({"completed", "cancelled"})
_TRANSITION_STATES = frozenset(
    {"in_progress", "waiting_for_user", "completed", "blocked", "cancelled"}
)
_VERIFICATION_VERDICTS = frozenset({"resolved", "continue"})

# Context-snapshot credential isolation (ADR-0035 §5): reject any key whose
# normalized form CONTAINS a secret-bearing token (so refresh_token,
# client_secret, authorization-header, x-api-key, etc. are all caught), and any
# value that looks like a URL (a private download link).
# Separator-free tokens: the key is normalized by stripping ALL non-alphanumerics
# (so api_key / api.key / x-api-key / apiKey all become "apikey"), then matched
# by substring — catching snake_case, kebab-case, dotted, and camelCase alike.
_SENSITIVE_KEY_SUBSTRINGS = (
    "authorization",
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "credential",
    "cookie",
    "accesskey",
    "privatekey",
    "session",
    "bearer",
)


_KEY_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")


def _key_is_sensitive(key: str) -> bool:
    # Strip EVERY non-alphanumeric char so api.key / access/key / x-api-key /
    # "api key" / apiKey all normalize to the same separator-free form the
    # substring list matches (camelCase is already separator-free once lowered).
    normalized = _KEY_NORMALIZE_RE.sub("", key.lower())
    return any(bad in normalized for bad in _SENSITIVE_KEY_SUBSTRINGS)


class ActionRecordType(str, Enum):
    """The record types carried by the single feedback/action-domain log."""

    FEEDBACK = "feedback"
    ACTION = "action"
    TRANSITION = "transition"
    HANDLING = "handling"
    VERIFICATION = "verification"
    REBIND = "rebind"


class ActionActor(str, Enum):
    """Who authored a record (ADR-0035: user / Agent / execution system)."""

    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


# The per-type id field (caller-supplied, unique) that makes the deterministic
# record_id unique.
_ID_FIELD: dict[ActionRecordType, str] = {
    ActionRecordType.FEEDBACK: "feedback_id",
    ActionRecordType.ACTION: "action_id",
    ActionRecordType.TRANSITION: "event_id",
    ActionRecordType.HANDLING: "event_id",
    ActionRecordType.VERIFICATION: "event_id",
    ActionRecordType.REBIND: "event_id",
}

# Fixed payload key set per record type. Every listed key must appear; no other
# key may. Nullable keys are present with an explicit null.
_PAYLOAD_KEYS: dict[ActionRecordType, frozenset[str]] = {
    ActionRecordType.FEEDBACK: frozenset(
        {"feedback_id", "target", "context", "summary", "detail"}
    ),
    ActionRecordType.ACTION: frozenset(
        {"action_id", "feedback_id", "target", "context", "intent"}
    ),
    ActionRecordType.TRANSITION: frozenset({"event_id", "action_id", "to_state"}),
    ActionRecordType.HANDLING: frozenset(
        {
            "event_id",
            "action_id",
            "execution_note",
            "old_artifact",
            "new_artifact",
            "cost_change",
        }
    ),
    ActionRecordType.VERIFICATION: frozenset(
        {"event_id", "action_id", "verdict", "note"}
    ),
    ActionRecordType.REBIND: frozenset({"event_id", "action_id", "target"}),
}

_ENVELOPE_KEYS = frozenset(
    {
        "schema_version",
        "record_id",
        "record_type",
        "occurred_at",
        "project_id",
        "actor",
        "payload",
    }
)


@dataclass(frozen=True, slots=True)
class ActionRecord:
    """One append-only feedback/action-domain fact (ADR-0035 uniform envelope)."""

    record_id: str
    record_type: ActionRecordType
    occurred_at: datetime
    project_id: str
    actor: ActionActor
    payload: Mapping[str, JsonCompatibleValue]

    def __post_init__(self) -> None:
        validate_stable_id(self.record_id, field_name="record_id")
        if not isinstance(self.record_type, ActionRecordType):
            got = type(self.record_type).__name__
            raise FieldTypeError(f"record_type: expected ActionRecordType, got {got}")
        if not isinstance(self.actor, ActionActor):
            got = type(self.actor).__name__
            raise FieldTypeError(f"actor: expected ActionActor, got {got}")
        validate_utc_datetime(self.occurred_at, field_name="occurred_at")
        validate_stable_id(self.project_id, field_name="project_id")
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
        _validate_payload_domains(self.record_type, self.payload)
        expected_id = _expected_record_id(
            self.record_type, self.project_id, self.payload
        )
        if self.record_id != expected_id:
            raise InvariantViolationError(
                f"record_id: {self.record_id!r} does not match the derived id "
                f"{expected_id!r} for {self.record_type.value}"
            )
        # Decouple from caller references and make the fact deeply immutable.
        object.__setattr__(self, "payload", _freeze(dict(self.payload)))

    def to_envelope(self) -> dict[str, JsonCompatibleValue]:
        """Return the JSON-compatible envelope dict (ADR-0035 / TASK-029)."""
        return {
            "schema_version": ACTION_LOG_SCHEMA_VERSION,
            "record_id": self.record_id,
            "record_type": self.record_type.value,
            "occurred_at": self.occurred_at.isoformat(timespec="microseconds"),
            "project_id": self.project_id,
            "actor": self.actor.value,
            "payload": _to_plain(self.payload),
        }


def _freeze(value: object) -> object:
    if isinstance(value, dict):
        return MappingProxyType({k: _freeze(v) for k, v in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(v) for v in value)
    return value


def _to_plain(value: object) -> JsonCompatibleValue:
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


def _validate_free_text(value: object, field: str) -> None:
    """A non-empty free-text field with credential/private-URL isolation.

    User-supplied prose (summary / detail / intent / notes) must not smuggle a
    private download URL into the append-only log (ADR-0035 §5). A URL-looking
    value is refused, the same rule applied to context values.
    """
    _validate_non_empty_str(value, field)
    if "://" in value:
        raise InvariantViolationError(
            f"{field}: a URL-like value must not be stored "
            "(credential/private-URL isolation)"
        )


def _validate_nullable_str(value: object, field: str) -> None:
    if value is not None and not isinstance(value, str):
        raise FieldTypeError(f"{field}: expected a string or null")


def _validate_target(target: object, field: str = "target") -> None:
    if not isinstance(target, dict):
        raise FieldTypeError(f"{field}: expected dict, got {type(target).__name__}")
    if frozenset(target) != _TARGET_KEYS:
        raise InvariantViolationError(
            f"{field}: expected exactly {sorted(_TARGET_KEYS)}, got {sorted(target)}"
        )
    validate_stable_id(target["ref"], field_name=f"{field}.ref")
    _validate_positive_int(target["version"], f"{field}.version")
    _validate_sha256(target["content_digest"], f"{field}.content_digest")


def _validate_context(context: object) -> None:
    """A flat context snapshot, credential-isolated (ADR-0035 §5).

    Keys are non-empty strings; values are str / int / null. A key that names a
    secret or a value that looks like a URL is refused, so no credential or
    private download link can enter the fact.
    """
    if not isinstance(context, dict):
        raise FieldTypeError(f"context: expected dict, got {type(context).__name__}")
    for key, value in context.items():
        if not isinstance(key, str) or not key.strip():
            raise InvariantViolationError("context: keys must be non-empty strings")
        if _key_is_sensitive(key):
            raise InvariantViolationError(
                f"context: key {key!r} names a credential and must not be stored"
            )
        if isinstance(value, bool) or (
            value is not None and not isinstance(value, (str, int))
        ):
            raise FieldTypeError(f"context[{key!r}]: expected a string, int, or null")
        if isinstance(value, str) and "://" in value:
            raise InvariantViolationError(
                f"context[{key!r}]: a URL-like value must not be stored "
                "(credential/private-URL isolation)"
            )


def _validate_cost_change(value: object) -> None:
    """Cost change is null or a flat {currency: minor_units_int} delta map."""
    if value is None:
        return
    if not isinstance(value, dict) or not value:
        raise FieldTypeError("cost_change: expected null or a non-empty currency map")
    for cur, amount in value.items():
        if not isinstance(cur, str) or not cur.strip():
            raise InvariantViolationError("cost_change: currency keys must be strings")
        if isinstance(amount, bool) or not isinstance(amount, int):
            raise FieldTypeError(f"cost_change[{cur!r}]: expected an int (minor units)")


def _validate_payload_domains(record_type: ActionRecordType, payload: Mapping) -> None:
    validate_stable_id(payload[_ID_FIELD[record_type]], field_name="id")
    if record_type is ActionRecordType.FEEDBACK:
        _validate_target(payload["target"])
        _validate_context(payload["context"])
        _validate_free_text(payload["summary"], "summary")
        _validate_free_text(payload["detail"], "detail")
        return
    if record_type is ActionRecordType.ACTION:
        if payload["feedback_id"] is not None:
            validate_stable_id(payload["feedback_id"], field_name="feedback_id")
        _validate_target(payload["target"])
        _validate_context(payload["context"])
        _validate_free_text(payload["intent"], "intent")
        return
    # every event binds an action_id
    validate_stable_id(payload["action_id"], field_name="action_id")
    if record_type is ActionRecordType.TRANSITION:
        to_state = payload["to_state"]
        if not isinstance(to_state, str) or to_state not in _TRANSITION_STATES:
            raise InvariantViolationError(
                f"to_state: expected one of {sorted(_TRANSITION_STATES)}"
            )
        return
    if record_type is ActionRecordType.HANDLING:
        _validate_free_text(payload["execution_note"], "execution_note")
        if payload["old_artifact"] is not None:
            _validate_target(payload["old_artifact"], "old_artifact")
        if payload["new_artifact"] is not None:
            _validate_target(payload["new_artifact"], "new_artifact")
        _validate_cost_change(payload["cost_change"])
        return
    if record_type is ActionRecordType.VERIFICATION:
        verdict = payload["verdict"]
        if not isinstance(verdict, str) or verdict not in _VERIFICATION_VERDICTS:
            raise InvariantViolationError(
                f"verdict: expected one of {sorted(_VERIFICATION_VERDICTS)}"
            )
        _validate_free_text(payload["note"], "note")
        return
    # REBIND
    _validate_target(payload["target"])


def _expected_record_id(
    record_type: ActionRecordType, project_id: str, payload: Mapping
) -> str:
    return f"{record_type.value}:{project_id}:{payload[_ID_FIELD[record_type]]}"


# --- envelope codec -----------------------------------------------------------


def record_from_envelope(envelope: object) -> ActionRecord:
    """Strictly decode one envelope dict into an :class:`ActionRecord`."""
    if not isinstance(envelope, dict):
        raise FieldTypeError(f"envelope: expected dict, got {type(envelope).__name__}")
    if frozenset(envelope) != _ENVELOPE_KEYS:
        raise InvariantViolationError("envelope: unexpected key set")
    schema_version = envelope["schema_version"]
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version != ACTION_LOG_SCHEMA_VERSION
    ):
        raise InvariantViolationError(
            f"schema_version: expected {ACTION_LOG_SCHEMA_VERSION}, "
            f"got {schema_version!r}"
        )
    try:
        record_type = ActionRecordType(envelope["record_type"])
    except (ValueError, TypeError) as exc:
        raise InvariantViolationError(
            f"record_type: unknown value {envelope['record_type']!r}"
        ) from exc
    try:
        actor = ActionActor(envelope["actor"])
    except (ValueError, TypeError) as exc:
        raise InvariantViolationError(
            f"actor: unknown value {envelope['actor']!r}"
        ) from exc
    occurred_at = _parse_iso_utc(envelope["occurred_at"])
    payload = envelope["payload"]
    if not isinstance(payload, dict):
        raise FieldTypeError("payload: expected dict")
    return ActionRecord(
        record_id=envelope["record_id"],
        record_type=record_type,
        occurred_at=occurred_at,
        project_id=envelope["project_id"],
        actor=actor,
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


# --- typed constructors -------------------------------------------------------


def build_feedback_record(
    *,
    project_id: str,
    actor: ActionActor,
    feedback_id: str,
    target: Mapping[str, JsonCompatibleValue],
    context: Mapping[str, JsonCompatibleValue],
    summary: str,
    detail: str,
    occurred_at: datetime,
) -> ActionRecord:
    """Build one feedback record (a problem report bound to an object version)."""
    payload = {
        "feedback_id": feedback_id,
        "target": target,
        "context": context,
        "summary": summary,
        "detail": detail,
    }
    return ActionRecord(
        record_id=f"feedback:{project_id}:{feedback_id}",
        record_type=ActionRecordType.FEEDBACK,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        payload=payload,
    )


def build_action_record(
    *,
    project_id: str,
    actor: ActionActor,
    action_id: str,
    feedback_id: str | None,
    target: Mapping[str, JsonCompatibleValue],
    context: Mapping[str, JsonCompatibleValue],
    intent: str,
    occurred_at: datetime,
) -> ActionRecord:
    """Build one action record (a controlled-handling commitment; state pending)."""
    payload = {
        "action_id": action_id,
        "feedback_id": feedback_id,
        "target": target,
        "context": context,
        "intent": intent,
    }
    return ActionRecord(
        record_id=f"action:{project_id}:{action_id}",
        record_type=ActionRecordType.ACTION,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        payload=payload,
    )


def build_transition_record(
    *,
    project_id: str,
    actor: ActionActor,
    event_id: str,
    action_id: str,
    to_state: str,
    occurred_at: datetime,
) -> ActionRecord:
    """Build one Action state-transition event."""
    payload = {"event_id": event_id, "action_id": action_id, "to_state": to_state}
    return ActionRecord(
        record_id=f"transition:{project_id}:{event_id}",
        record_type=ActionRecordType.TRANSITION,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        payload=payload,
    )


def build_handling_record(
    *,
    project_id: str,
    actor: ActionActor,
    event_id: str,
    action_id: str,
    execution_note: str,
    old_artifact: Mapping[str, JsonCompatibleValue] | None,
    new_artifact: Mapping[str, JsonCompatibleValue] | None,
    cost_change: Mapping[str, int] | None,
    occurred_at: datetime,
) -> ActionRecord:
    """Build one handling record (who processed it, old/new artifacts, cost)."""
    payload = {
        "event_id": event_id,
        "action_id": action_id,
        "execution_note": execution_note,
        "old_artifact": old_artifact,
        "new_artifact": new_artifact,
        "cost_change": cost_change,
    }
    return ActionRecord(
        record_id=f"handling:{project_id}:{event_id}",
        record_type=ActionRecordType.HANDLING,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        payload=payload,
    )


def build_verification_record(
    *,
    project_id: str,
    actor: ActionActor,
    event_id: str,
    action_id: str,
    verdict: str,
    note: str,
    occurred_at: datetime,
) -> ActionRecord:
    """Build one user-verification record (resolved / continue)."""
    payload = {
        "event_id": event_id,
        "action_id": action_id,
        "verdict": verdict,
        "note": note,
    }
    return ActionRecord(
        record_id=f"verification:{project_id}:{event_id}",
        record_type=ActionRecordType.VERIFICATION,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        payload=payload,
    )


def build_rebind_record(
    *,
    project_id: str,
    actor: ActionActor,
    event_id: str,
    action_id: str,
    target: Mapping[str, JsonCompatibleValue],
    occurred_at: datetime,
) -> ActionRecord:
    """Build one explicit rebind record (re-point an Action to a new version)."""
    payload = {"event_id": event_id, "action_id": action_id, "target": target}
    return ActionRecord(
        record_id=f"rebind:{project_id}:{event_id}",
        record_type=ActionRecordType.REBIND,
        occurred_at=occurred_at,
        project_id=project_id,
        actor=actor,
        payload=payload,
    )
