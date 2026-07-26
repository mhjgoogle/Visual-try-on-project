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

from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.orchestration.errors import CanonicalizationError


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
