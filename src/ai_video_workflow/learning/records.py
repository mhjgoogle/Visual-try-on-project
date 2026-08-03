"""Promoted-knowledge record model and envelope codec (ADR-0036 / TASK-032).

The account-level append-only knowledge log stores only USER-CONFIRMED promoted
knowledge — reusable, evidence-backed experience. A separate state domain
(ADR-0010 decision 7): it never reuses approval / GenerationTask / Provider /
reservation / Action state, and it only REFERENCES authoritative run / cost /
evaluation / Action facts by ``ref + content_digest`` (never copies or rewrites
them). Candidate experiences and cross-project analytics/recommendations are
DERIVED on demand — not stored here.

Promotion is the user's: a record's ``actor`` is always ``user`` and it must
carry at least one evidence ref with a source digest (the "user-confirmed +
source digest" rule). No constructor reads the clock (TASK-004 time authority).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
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

KNOWLEDGE_LOG_SCHEMA_VERSION = 1

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

_PAYLOAD_KEYS = frozenset(
    {
        "knowledge_id",
        "category",
        "applicability",
        "recommendation",
        "evidence_refs",
        "scope",
        "limits",
    }
)
_ENVELOPE_KEYS = frozenset(
    {"schema_version", "record_id", "occurred_at", "actor", "payload"}
)
_EVIDENCE_KEYS = frozenset({"ref", "content_digest", "project"})

# The one authoring actor: promotion to reusable knowledge is user-confirmed.
_ACTOR = "user"


@dataclass(frozen=True, slots=True)
class KnowledgeRecord:
    """One append-only, user-confirmed promoted-knowledge fact (ADR-0036)."""

    record_id: str
    occurred_at: datetime
    actor: str
    payload: Mapping[str, JsonCompatibleValue]

    def __post_init__(self) -> None:
        validate_stable_id(self.record_id, field_name="record_id")
        validate_utc_datetime(self.occurred_at, field_name="occurred_at")
        if self.actor != _ACTOR:
            raise InvariantViolationError(
                "actor: promoted knowledge is user-confirmed; actor must be 'user'"
            )
        if not isinstance(self.payload, dict):
            raise FieldTypeError("payload: expected dict")
        validate_json_compatible(self.payload, path="payload")
        actual = frozenset(self.payload)
        if actual != _PAYLOAD_KEYS:
            missing = _PAYLOAD_KEYS - actual
            if missing:
                raise MissingFieldError(f"payload: missing keys {sorted(missing)}")
            raise InvariantViolationError(
                f"payload: unexpected keys {sorted(actual - _PAYLOAD_KEYS)}"
            )
        _validate_payload(self.payload)
        expected_id = f"knowledge:{self.payload['knowledge_id']}"
        if self.record_id != expected_id:
            raise InvariantViolationError(
                f"record_id: {self.record_id!r} != derived {expected_id!r}"
            )
        object.__setattr__(self, "payload", _freeze(dict(self.payload)))

    def to_envelope(self) -> dict[str, JsonCompatibleValue]:
        return {
            "schema_version": KNOWLEDGE_LOG_SCHEMA_VERSION,
            "record_id": self.record_id,
            "occurred_at": self.occurred_at.isoformat(timespec="microseconds"),
            "actor": self.actor,
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


def _non_empty_str(value: object, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise InvariantViolationError(f"{field}: expected a non-empty string")


def _validate_applicability(value: object) -> None:
    """A flat conditions map: keys are non-empty strings, values str/int/null."""
    if not isinstance(value, dict):
        raise FieldTypeError("applicability: expected an object")
    for k, v in value.items():
        if not isinstance(k, str) or not k.strip():
            raise InvariantViolationError("applicability: keys must be strings")
        if isinstance(v, bool) or (v is not None and not isinstance(v, (str, int))):
            raise FieldTypeError(f"applicability[{k!r}]: expected str/int/null")


def _validate_evidence_refs(value: object) -> None:
    if not isinstance(value, list) or not value:
        raise InvariantViolationError(
            "evidence_refs: expected at least one source ref (user-confirmed + digest)"
        )
    for i, ref in enumerate(value):
        if not isinstance(ref, dict) or frozenset(ref) != _EVIDENCE_KEYS:
            raise InvariantViolationError(
                f"evidence_refs[{i}]: expected exactly {sorted(_EVIDENCE_KEYS)}"
            )
        validate_stable_id(ref["ref"], field_name=f"evidence_refs[{i}].ref")
        validate_stable_id(ref["project"], field_name=f"evidence_refs[{i}].project")
        digest = ref["content_digest"]
        if not isinstance(digest, str) or _SHA256_RE.match(digest) is None:
            raise InvariantViolationError(
                f"evidence_refs[{i}].content_digest: expected a sha256 hex"
            )


def _validate_payload(payload: Mapping) -> None:
    validate_stable_id(payload["knowledge_id"], field_name="knowledge_id")
    _non_empty_str(payload["category"], "category")
    _non_empty_str(payload["recommendation"], "recommendation")
    _non_empty_str(payload["scope"], "scope")
    _non_empty_str(payload["limits"], "limits")
    _validate_applicability(payload["applicability"])
    _validate_evidence_refs(payload["evidence_refs"])


def record_from_envelope(envelope: object) -> KnowledgeRecord:
    if not isinstance(envelope, dict) or frozenset(envelope) != _ENVELOPE_KEYS:
        raise InvariantViolationError("knowledge envelope: unexpected key set")
    sv = envelope["schema_version"]
    if isinstance(sv, bool) or sv != KNOWLEDGE_LOG_SCHEMA_VERSION:
        raise InvariantViolationError("knowledge: unsupported schema_version")
    occurred = envelope["occurred_at"]
    if not isinstance(occurred, str):
        raise FieldTypeError("occurred_at: expected ISO string")
    try:
        parsed = datetime.fromisoformat(occurred)
    except ValueError as exc:
        raise InvariantViolationError("occurred_at: not ISO-8601") from exc
    payload = envelope["payload"]
    if not isinstance(payload, dict):
        raise FieldTypeError("payload: expected dict")
    return KnowledgeRecord(
        record_id=envelope["record_id"],
        occurred_at=validate_utc_datetime(parsed, field_name="occurred_at"),
        actor=envelope["actor"],
        payload=payload,
    )


def build_knowledge_record(
    *,
    knowledge_id: str,
    category: str,
    applicability: Mapping[str, JsonCompatibleValue],
    recommendation: str,
    evidence_refs: list,
    scope: str,
    limits: str,
    occurred_at: datetime,
) -> KnowledgeRecord:
    """Build one user-confirmed promoted-knowledge record."""
    payload = {
        "knowledge_id": knowledge_id,
        "category": category,
        "applicability": applicability,
        "recommendation": recommendation,
        "evidence_refs": evidence_refs,
        "scope": scope,
        "limits": limits,
    }
    return KnowledgeRecord(
        record_id=f"knowledge:{knowledge_id}",
        occurred_at=occurred_at,
        actor=_ACTOR,
        payload=payload,
    )
