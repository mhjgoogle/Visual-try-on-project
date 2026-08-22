"""Canonical JSON bytes, fingerprints, and freeze utilities.

Internal orchestration tools (not exported from the package):

- canonicalization turns an approved value into deterministic UTF-8
  JSON bytes;
- fingerprints digest those bytes (or exact file bytes) with SHA-256;
- freeze produces deep immutable snapshots; thaw restores plain
  JSON-compatible containers for output.

The responsibilities stay separate: freeze never grants JSON
semantics, canonicalization never mutates input, and fingerprints
never hash in-memory object representations.
"""

from __future__ import annotations

import json
import math
import unicodedata
from collections.abc import Mapping
from datetime import datetime, timedelta
from enum import Enum
from hashlib import sha256
from types import MappingProxyType

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.orchestration.errors import CanonicalizationError
from ai_video_workflow.validation import validate_json_compatible


def _canonical_json_bytes(value: object) -> bytes:
    """Return deterministic UTF-8 JSON bytes for one approved value."""
    normalized = _normalize(value, active_container_ids=set())
    text = json.dumps(
        normalized,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return text.encode("utf-8")


def _fingerprint(value: object) -> str:
    """Return the lowercase SHA-256 hex digest of the canonical bytes."""
    return sha256(_canonical_json_bytes(value)).hexdigest()


def _sha256_hex(data: bytes) -> str:
    """Return the lowercase SHA-256 hex digest of exact bytes."""
    if type(data) is not bytes:
        raise CanonicalizationError(f"data: expected bytes, got {type(data).__name__}")
    return sha256(data).hexdigest()


def _normalize(value: object, *, active_container_ids: set[int]) -> object:
    if isinstance(value, Enum):
        if type(value.value) is not str:
            raise CanonicalizationError(
                "enum: only string-valued Enum members are canonicalizable, "
                f"got {type(value).__name__}"
            )
        return unicodedata.normalize("NFC", value.value)
    if value is None:
        return None
    if type(value) is bool:
        return value
    if type(value) is int:
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise CanonicalizationError("float: must be finite")
        if value == 0.0:
            return 0.0
        return value
    if type(value) is str:
        return unicodedata.normalize("NFC", value)
    if isinstance(value, datetime):
        return _normalize_datetime(value)
    if type(value) in (list, tuple):
        return _normalize_sequence(
            value,
            active_container_ids=active_container_ids,
        )
    if isinstance(value, Mapping):
        return _normalize_mapping(
            value,
            active_container_ids=active_container_ids,
        )
    raise CanonicalizationError(
        f"value: type {type(value).__name__} is not canonicalizable"
    )


def _normalize_datetime(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise CanonicalizationError("datetime: must include timezone information")
    if value.utcoffset() != timedelta(0):
        raise CanonicalizationError("datetime: must have a zero UTC offset")
    return value.isoformat(timespec="microseconds")


def _normalize_sequence(
    value: list[object] | tuple[object, ...],
    *,
    active_container_ids: set[int],
) -> list[object]:
    container_id = id(value)
    if container_id in active_container_ids:
        raise CanonicalizationError("sequence: cyclic containers are not JSON")
    active_container_ids.add(container_id)
    try:
        return [
            _normalize(item, active_container_ids=active_container_ids)
            for item in value
        ]
    finally:
        active_container_ids.remove(container_id)


def _normalize_mapping(
    value: Mapping[object, object],
    *,
    active_container_ids: set[int],
) -> dict[str, object]:
    container_id = id(value)
    if container_id in active_container_ids:
        raise CanonicalizationError("mapping: cyclic containers are not JSON")
    active_container_ids.add(container_id)
    try:
        normalized: dict[str, object] = {}
        for key, item in value.items():
            if type(key) is not str:
                raise CanonicalizationError(
                    f"mapping key: expected str, got {type(key).__name__}"
                )
            canonical_key = unicodedata.normalize("NFC", key)
            if canonical_key in normalized:
                raise CanonicalizationError(
                    f"mapping key: NFC-normalized keys collide on {canonical_key!r}"
                )
            normalized[canonical_key] = _normalize(
                item,
                active_container_ids=active_container_ids,
            )
        return normalized
    finally:
        active_container_ids.remove(container_id)


def _freeze_value(value: object) -> object:
    """Return a deep immutable snapshot of one approved value."""
    if value is None or type(value) in {bool, int, float, str}:
        return value
    if type(value) in (list, tuple):
        return tuple(_freeze_value(item) for item in value)
    if type(value) in (set, frozenset):
        return frozenset(_freeze_value(item) for item in value)
    if isinstance(value, Mapping):
        return _freeze_mapping(value)
    raise FieldTypeError(f"value: type {type(value).__name__} cannot be frozen")


def _freeze_mapping(value: Mapping[object, object]) -> Mapping[str, object]:
    """Return a read-only deep copy of one string-keyed mapping."""
    frozen: dict[str, object] = {}
    for key, item in value.items():
        if type(key) is not str:
            raise FieldTypeError(f"mapping key: expected str, got {type(key).__name__}")
        frozen[key] = _freeze_value(item)
    return MappingProxyType(frozen)


def _thaw_value(value: object) -> object:
    """Return plain JSON-compatible containers for one frozen value."""
    if isinstance(value, Mapping):
        return {key: _thaw_value(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw_value(item) for item in value]
    return value


def _thaw_mapping(value: Mapping[str, object]) -> dict[str, object]:
    """Return a plain dict deep copy of one frozen mapping."""
    return {key: _thaw_value(item) for key, item in value.items()}


SNAPSHOT_WRAPPER_VERSION = 1

_SNAPSHOT_KINDS = frozenset(
    {
        "provider_request",
        "provider_result",
        "provider_instruction",
        "artifact_reference",
        "generation_task",
        "step_manifest",
        "orchestration_stable_state",
        "action_input",
    }
)

_SNAPSHOT_WRAPPER_KEYS = frozenset({"snapshot_kind", "snapshot_version", "payload"})

_STABLE_SELF_FINGERPRINT_FIELD = "stable_record_fingerprint"


def _make_snapshot_wrapper(
    kind: str,
    payload: Mapping[str, object],
) -> Mapping[str, object]:
    """Return a frozen, versioned snapshot wrapper around one payload."""
    if type(kind) is not str:
        raise FieldTypeError(
            f"snapshot_kind: expected string, got {type(kind).__name__}"
        )
    if kind not in _SNAPSHOT_KINDS:
        raise InvariantViolationError(f"snapshot_kind: unknown snapshot kind {kind!r}")
    if not isinstance(payload, Mapping):
        raise FieldTypeError(f"payload: expected mapping, got {type(payload).__name__}")
    plain_payload = _require_json_only_payload(payload, field_name="payload")
    return _freeze_mapping(
        {
            "snapshot_kind": kind,
            "snapshot_version": SNAPSHOT_WRAPPER_VERSION,
            "payload": plain_payload,
        }
    )


def _validate_snapshot_wrapper(
    value: object,
    *,
    expected_kind: str,
    field_name: str,
) -> Mapping[str, object]:
    """Validate one snapshot wrapper strictly and return a frozen copy."""
    if expected_kind not in _SNAPSHOT_KINDS:
        raise InvariantViolationError(
            f"{field_name}: unknown expected snapshot kind {expected_kind!r}"
        )
    if not isinstance(value, Mapping):
        raise FieldTypeError(
            f"{field_name}: expected snapshot wrapper mapping, "
            f"got {type(value).__name__}"
        )
    keys = set(value.keys())
    if keys != _SNAPSHOT_WRAPPER_KEYS:
        raise InvariantViolationError(
            f"{field_name}: wrapper must contain exactly snapshot_kind, "
            "snapshot_version, and payload"
        )
    kind = value["snapshot_kind"]
    if type(kind) is not str:
        raise FieldTypeError(
            f"{field_name}: snapshot_kind must be a string, got {type(kind).__name__}"
        )
    if kind not in _SNAPSHOT_KINDS:
        raise InvariantViolationError(f"{field_name}: unknown snapshot kind {kind!r}")
    if kind != expected_kind:
        raise InvariantViolationError(
            f"{field_name}: expected snapshot kind {expected_kind!r}, got {kind!r}"
        )
    version = value["snapshot_version"]
    if type(version) is not int:
        raise FieldTypeError(
            f"{field_name}: snapshot_version must be a strict int, "
            f"got {type(version).__name__}"
        )
    if version != SNAPSHOT_WRAPPER_VERSION:
        raise InvariantViolationError(
            f"{field_name}: unsupported snapshot version {version}"
        )
    payload = value["payload"]
    if not isinstance(payload, Mapping):
        raise FieldTypeError(
            f"{field_name}: wrapper payload must be a mapping, "
            f"got {type(payload).__name__}"
        )
    plain_payload = _require_json_only_payload(
        payload,
        field_name=f"{field_name}.payload",
    )
    return _freeze_mapping(
        {
            "snapshot_kind": kind,
            "snapshot_version": version,
            "payload": plain_payload,
        }
    )


def _require_json_only_payload(
    payload: Mapping[str, object],
    *,
    field_name: str,
) -> dict[str, object]:
    """Return a plain-dict copy of one strictly JSON-only payload.

    The canonicalization pass rejects cycles, sets, non-string keys,
    non-finite floats, and NFC key collisions before any thaw; the
    JSON-compatibility pass then rejects every remaining non-JSON
    value (such as datetime or Enum objects) on the plain copy.
    """
    _canonical_json_bytes(payload)
    plain_payload = _thaw_mapping(payload)
    validate_json_compatible(plain_payload, path=field_name)
    return plain_payload


def _stable_self_fingerprint(payload: Mapping[str, object]) -> str:
    """Return the stable self fingerprint over all fields except itself."""
    if not isinstance(payload, Mapping):
        raise FieldTypeError(
            f"stable payload: expected mapping, got {type(payload).__name__}"
        )
    reduced = {
        key: value
        for key, value in payload.items()
        if key != _STABLE_SELF_FINGERPRINT_FIELD
    }
    return _fingerprint(reduced)


PLAN_PREIMAGE_SCHEMA_VERSION = 1

_PLAN_PREIMAGE_KEYS = frozenset(
    {
        "plan_preimage_schema_version",
        "operation_id",
        "action",
        "baseline_version",
        "request_fingerprint",
        "result_fingerprint",
        "task_before_fingerprint",
        "task_after_fingerprint",
        "manifest_before_fingerprint",
        "manifest_after_fingerprint",
        "instruction_before_fingerprint",
        "observed_at",
        "completed_at",
        "artifact_input_fingerprint",
    }
)


def _make_plan_preimage(
    *,
    operation_id: str,
    action: str,
    baseline_version: int,
    request_fingerprint: str,
    result_fingerprint: str,
    task_before_fingerprint: str,
    task_after_fingerprint: str,
    manifest_before_fingerprint: str,
    manifest_after_fingerprint: str,
    instruction_before_fingerprint: str,
    observed_at: str,
    completed_at: str | None,
    artifact_input_fingerprint: str,
    plan_preimage_schema_version: int = PLAN_PREIMAGE_SCHEMA_VERSION,
) -> Mapping[str, object]:
    """Return the frozen, exact plan_id core preimage mapping.

    The preimage never contains the plan_id itself, instruction
    after bytes or fingerprint, or any planned stable state
    fingerprint.
    """
    _validate_plan_preimage_version(plan_preimage_schema_version)
    return _freeze_mapping(
        {
            "plan_preimage_schema_version": plan_preimage_schema_version,
            "operation_id": operation_id,
            "action": action,
            "baseline_version": baseline_version,
            "request_fingerprint": request_fingerprint,
            "result_fingerprint": result_fingerprint,
            "task_before_fingerprint": task_before_fingerprint,
            "task_after_fingerprint": task_after_fingerprint,
            "manifest_before_fingerprint": manifest_before_fingerprint,
            "manifest_after_fingerprint": manifest_after_fingerprint,
            "instruction_before_fingerprint": instruction_before_fingerprint,
            "observed_at": observed_at,
            "completed_at": completed_at,
            "artifact_input_fingerprint": artifact_input_fingerprint,
        }
    )


def _compute_plan_id(preimage: Mapping[str, object]) -> str:
    """Return the deterministic plan_id over one exact core preimage."""
    if not isinstance(preimage, Mapping):
        raise FieldTypeError(
            f"preimage: expected mapping, got {type(preimage).__name__}"
        )
    keys = set(preimage.keys())
    if keys != _PLAN_PREIMAGE_KEYS:
        missing = sorted(_PLAN_PREIMAGE_KEYS - keys)
        unknown = sorted(keys - _PLAN_PREIMAGE_KEYS)
        detail = missing[0] if missing else unknown[0]
        raise InvariantViolationError(
            f"preimage: keys must match the plan preimage exactly "
            f"(offending key {detail!r})"
        )
    _validate_plan_preimage_version(preimage["plan_preimage_schema_version"])
    return _fingerprint(preimage)


def _validate_plan_preimage_version(value: object) -> None:
    if type(value) is not int:
        raise FieldTypeError(
            "plan_preimage_schema_version: expected a strict int, "
            f"got {type(value).__name__}"
        )
    if value != PLAN_PREIMAGE_SCHEMA_VERSION:
        raise InvariantViolationError(
            f"plan_preimage_schema_version: unsupported version {value}"
        )
