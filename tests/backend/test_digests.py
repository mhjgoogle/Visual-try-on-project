"""Tests for the content and configuration digest primitives (TASK-005)."""

from __future__ import annotations

import hashlib

import pytest

from ai_video_workflow.digests import config_digest, file_sha256
from ai_video_workflow.errors import (
    DataFileNotFoundError,
    FieldTypeError,
    InvariantViolationError,
)


def test_file_sha256_matches_hashlib(tmp_path) -> None:
    path = tmp_path / "clip.mp4"
    data = b"\x00\x01binary media payload\xff"
    path.write_bytes(data)
    assert file_sha256(path) == hashlib.sha256(data).hexdigest()


def test_file_sha256_is_lowercase_hex_64(tmp_path) -> None:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"abc")
    digest = file_sha256(path)
    assert len(digest) == 64 and digest == digest.lower()
    assert all(character in "0123456789abcdef" for character in digest)


def test_file_sha256_differs_on_different_content(tmp_path) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.write_bytes(b"one")
    b.write_bytes(b"two")
    assert file_sha256(a) != file_sha256(b)


def test_file_sha256_missing_file(tmp_path) -> None:
    with pytest.raises(DataFileNotFoundError):
        file_sha256(tmp_path / "absent.mp4")


def test_file_sha256_rejects_non_path() -> None:
    with pytest.raises(FieldTypeError):
        file_sha256("clip.mp4")  # type: ignore[arg-type]


def test_config_digest_is_deterministic() -> None:
    value = {"schema": "m1", "policy": {"a": 1, "b": [2, 3]}}
    assert config_digest(value) == config_digest(dict(value))


def test_config_digest_ignores_key_order() -> None:
    assert config_digest({"a": 1, "b": 2}) == config_digest({"b": 2, "a": 1})


def test_config_digest_is_sensitive_to_value_changes() -> None:
    base = {"policy": {"duration_tolerance_ratio": 0.1}}
    changed = {"policy": {"duration_tolerance_ratio": 0.2}}
    assert config_digest(base) != config_digest(changed)


def test_config_digest_lowercase_hex_64() -> None:
    digest = config_digest({"x": 1})
    assert len(digest) == 64 and digest == digest.lower()


def test_config_digest_rejects_non_finite_float() -> None:
    with pytest.raises(InvariantViolationError):
        config_digest({"ratio": float("inf")})


def test_config_digest_rejects_non_json_compatible() -> None:
    with pytest.raises(FieldTypeError):
        config_digest({"path": object()})  # type: ignore[dict-item]
