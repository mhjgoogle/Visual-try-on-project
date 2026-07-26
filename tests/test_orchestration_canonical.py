import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import MappingProxyType

import pytest

from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.orchestration import CanonicalizationError, RecordPhase
from ai_video_workflow.orchestration.canonical import (
    _canonical_json_bytes,
    _fingerprint,
    _freeze_mapping,
    _freeze_value,
    _sha256_hex,
    _thaw_mapping,
    _thaw_value,
)
from ai_video_workflow.providers import ProviderStatus

UTC_AT = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
NAIVE_AT = datetime(2026, 7, 26, 12, 0, 0)
TOKYO_AT = datetime(2026, 7, 26, 21, 0, 0, tzinfo=timezone(timedelta(hours=9)))

# Independently computed with hashlib over the exact canonical bytes;
# never regenerated with the function under test.
VECTOR_EMPTY_OBJECT = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
VECTOR_SORTED_AB = "94a786c3662bc7beeb598efa7d8cb58d7bea25d6c275ea9785a0230ff1f8c2ba"
VECTOR_TRUE = "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"
VECTOR_ONE = "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b"
VECTOR_NFC_E = "0ca09f1dffb485d259fc791100d48ad7ae9c17f52a2bb07b608c0e28fbca34a1"


class TestCanonicalBytes:
    def test_exact_bytes_for_sorted_object(self) -> None:
        assert _canonical_json_bytes({"b": 1, "a": [1, 2]}) == b'{"a":[1,2],"b":1}'

    def test_insertion_order_independence(self) -> None:
        first = _canonical_json_bytes({"a": [1, 2], "b": 1})
        second = _canonical_json_bytes({"b": 1, "a": [1, 2]})
        assert first == second

    def test_nested_ordering_is_stable(self) -> None:
        first = _canonical_json_bytes({"outer": {"z": 1, "a": 2}})
        second = _canonical_json_bytes({"outer": {"a": 2, "z": 1}})
        assert first == second

    def test_output_is_utf8_bytes_without_bom_or_newline(self) -> None:
        encoded = _canonical_json_bytes({"k": "中文"})
        assert type(encoded) is bytes
        assert not encoded.startswith(b"\xef\xbb\xbf")
        assert b"\n" not in encoded
        assert b"\r" not in encoded
        assert "中文".encode() in encoded
        assert b"\\u" not in encoded

    def test_accepted_primitives(self) -> None:
        assert _canonical_json_bytes(None) == b"null"
        assert _canonical_json_bytes(True) == b"true"
        assert _canonical_json_bytes(False) == b"false"
        assert _canonical_json_bytes(7) == b"7"
        assert _canonical_json_bytes(1.5) == b"1.5"
        assert _canonical_json_bytes("text") == b'"text"'

    def test_bool_and_int_produce_distinct_bytes(self) -> None:
        assert _canonical_json_bytes(True) == b"true"
        assert _canonical_json_bytes(1) == b"1"
        assert _canonical_json_bytes(True) != _canonical_json_bytes(1)
        assert _canonical_json_bytes(False) != _canonical_json_bytes(0)

    def test_negative_zero_is_normalized(self) -> None:
        assert _canonical_json_bytes(-0.0) == b"0.0"
        assert _canonical_json_bytes(-0.0) == _canonical_json_bytes(0.0)

    @pytest.mark.parametrize(
        "value",
        [float("nan"), float("inf"), float("-inf")],
    )
    def test_non_finite_floats_are_rejected(self, value: float) -> None:
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes(value)

    @pytest.mark.parametrize(
        "value",
        [
            b"bytes",
            bytearray(b"bytes"),
            {1, 2},
            frozenset({1, 2}),
            Path("relative/path"),
            object(),
            (item for item in [1, 2]),
        ],
    )
    def test_forbidden_types_are_rejected(self, value: object) -> None:
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes(value)

    def test_non_string_mapping_keys_are_rejected(self) -> None:
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes({1: "one"})

    def test_str_is_scalar_and_not_a_sequence(self) -> None:
        assert _canonical_json_bytes("ab") == b'"ab"'

    def test_list_and_tuple_produce_identical_bytes(self) -> None:
        assert _canonical_json_bytes([1, "a"]) == _canonical_json_bytes((1, "a"))

    def test_mapping_proxy_is_thawed(self) -> None:
        proxy = MappingProxyType({"a": 1})
        assert _canonical_json_bytes(proxy) == b'{"a":1}'

    def test_cyclic_containers_are_rejected(self) -> None:
        cyclic: dict = {"inner": {}}
        cyclic["inner"]["self"] = cyclic
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes(cyclic)

    def test_datetime_uses_fixed_aware_utc_format(self) -> None:
        assert (
            _canonical_json_bytes({"at": UTC_AT})
            == b'{"at":"2026-07-26T12:00:00.000000+00:00"}'
        )

    @pytest.mark.parametrize("value", [NAIVE_AT, TOKYO_AT])
    def test_naive_and_non_utc_datetimes_are_rejected(
        self,
        value: datetime,
    ) -> None:
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes({"at": value})

    def test_string_enums_encode_their_values(self) -> None:
        assert _canonical_json_bytes(RecordPhase.STABLE) == b'"stable"'
        assert _canonical_json_bytes(ProviderStatus.SUCCEEDED) == b'"succeeded"'

    def test_non_string_enums_are_rejected(self) -> None:
        from enum import Enum

        class NumberEnum(Enum):
            ONE = 1

        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes(NumberEnum.ONE)


class TestNfcNormalization:
    def test_ascii_values_pass_through(self) -> None:
        assert _canonical_json_bytes("plain") == b'"plain"'

    def test_nfd_and_nfc_values_produce_identical_bytes(self) -> None:
        composed = "é"
        decomposed = "é"
        assert composed != decomposed
        assert _canonical_json_bytes(composed) == _canonical_json_bytes(decomposed)

    def test_nfd_and_nfc_keys_produce_identical_bytes(self) -> None:
        assert _canonical_json_bytes({"é": 1}) == _canonical_json_bytes({"é": 1})

    def test_top_level_normalized_key_collision_is_rejected(self) -> None:
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes({"é": 1, "é": 2})

    def test_nested_normalized_key_collision_is_rejected(self) -> None:
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes({"outer": {"é": 1, "é": 2}})

    def test_failed_canonicalization_does_not_mutate_input(self) -> None:
        payload = {"outer": {"é": 1, "é": 2}, "keep": [1, 2]}
        snapshot = copy.deepcopy(payload)
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes(payload)
        assert payload == snapshot


class TestFingerprint:
    def test_fixed_vector_empty_object(self) -> None:
        assert _fingerprint({}) == VECTOR_EMPTY_OBJECT

    def test_fixed_vector_sorted_object(self) -> None:
        assert _fingerprint({"b": 1, "a": [1, 2]}) == VECTOR_SORTED_AB

    def test_fixed_vector_bool_and_int_differ(self) -> None:
        assert _fingerprint(True) == VECTOR_TRUE
        assert _fingerprint(1) == VECTOR_ONE
        assert VECTOR_TRUE != VECTOR_ONE

    def test_fixed_vector_nfc_equivalents(self) -> None:
        assert _fingerprint({"k": "é"}) == VECTOR_NFC_E
        assert _fingerprint({"k": "é"}) == VECTOR_NFC_E

    def test_format_is_lowercase_hex_of_length_64(self) -> None:
        digest = _fingerprint({"a": 1})
        assert len(digest) == 64
        assert digest == digest.lower()
        assert all(character in "0123456789abcdef" for character in digest)

    def test_insertion_order_does_not_change_fingerprint(self) -> None:
        assert _fingerprint({"a": 1, "b": 2}) == _fingerprint({"b": 2, "a": 1})

    def test_content_changes_change_the_fingerprint(self) -> None:
        assert _fingerprint({"a": 1}) != _fingerprint({"a": 2})

    def test_repeated_calls_are_stable(self) -> None:
        payload = {"a": [1, {"b": "值"}]}
        assert _fingerprint(payload) == _fingerprint(payload)

    def test_fingerprint_does_not_mutate_input(self) -> None:
        payload = {"b": [2, 1], "a": {"z": 1}}
        snapshot = copy.deepcopy(payload)
        _fingerprint(payload)
        assert payload == snapshot

    def test_sha256_hex_over_exact_bytes(self) -> None:
        assert _sha256_hex(b"{}") == VECTOR_EMPTY_OBJECT

    def test_sha256_hex_rejects_non_bytes(self) -> None:
        with pytest.raises(CanonicalizationError):
            _sha256_hex("{}")


class TestFreeze:
    def test_type_mapping(self) -> None:
        frozen = _freeze_value(
            {"m": {"k": 1}, "l": [1, 2], "t": (3,), "s": {4}, "x": "v"}
        )
        assert isinstance(frozen, MappingProxyType)
        assert isinstance(frozen["m"], MappingProxyType)
        assert type(frozen["l"]) is tuple
        assert type(frozen["t"]) is tuple
        assert type(frozen["s"]) is frozenset
        assert frozen["x"] == "v"

    def test_primitives_pass_through(self) -> None:
        for value in (None, True, 3, 1.5, "text"):
            assert _freeze_value(value) == value

    def test_forbidden_types_are_rejected(self) -> None:
        with pytest.raises(FieldTypeError):
            _freeze_value(object())
        with pytest.raises(FieldTypeError):
            _freeze_value(b"bytes")

    def test_non_string_keys_are_rejected(self) -> None:
        with pytest.raises(FieldTypeError):
            _freeze_mapping({1: "one"})

    def test_top_level_assignment_is_rejected(self) -> None:
        frozen = _freeze_mapping({"a": 1})
        with pytest.raises(TypeError):
            frozen["a"] = 2

    def test_nested_assignment_and_append_are_rejected(self) -> None:
        frozen = _freeze_mapping({"m": {"k": 1}, "l": [1]})
        with pytest.raises(TypeError):
            frozen["m"]["k"] = 2
        assert not hasattr(frozen["l"], "append")

    def test_original_mutation_does_not_change_frozen_result(self) -> None:
        source = {"l": [1], "m": {"k": 1}}
        frozen = _freeze_mapping(source)
        source["l"].append(2)
        source["m"]["k"] = 9
        source["new"] = True
        assert frozen["l"] == (1,)
        assert frozen["m"]["k"] == 1
        assert "new" not in frozen

    def test_freeze_is_idempotent_by_equality(self) -> None:
        source = {"a": [1, 2], "b": {"c": 3}}
        once = _freeze_mapping(source)
        twice = _freeze_mapping(_thaw_mapping(once))
        assert once == twice
        assert _freeze_value(once) == once

    def test_two_freezes_of_equal_inputs_are_equal(self) -> None:
        assert _freeze_mapping({"a": [1]}) == _freeze_mapping({"a": [1]})

    def test_failed_freeze_does_not_mutate_input(self) -> None:
        source = {"good": [1], "bad": object()}
        snapshot_keys = set(source)
        with pytest.raises(FieldTypeError):
            _freeze_mapping(source)
        assert set(source) == snapshot_keys
        assert source["good"] == [1]

    def test_no_mutable_alias_leaks(self) -> None:
        inner = {"k": [1]}
        frozen = _freeze_mapping({"m": inner})
        inner["k"].append(2)
        assert frozen["m"]["k"] == (1,)


class TestThaw:
    def test_thaw_returns_plain_containers(self) -> None:
        frozen = _freeze_mapping({"m": {"k": 1}, "l": [1, 2]})
        thawed = _thaw_mapping(frozen)
        assert type(thawed) is dict
        assert type(thawed["m"]) is dict
        assert type(thawed["l"]) is list

    def test_thaw_round_trip_preserves_values(self) -> None:
        source = {"m": {"k": 1}, "l": [1, 2], "x": "v"}
        assert _thaw_mapping(_freeze_mapping(source)) == source

    def test_thawed_output_is_detached_from_frozen_input(self) -> None:
        frozen = _freeze_mapping({"l": [1]})
        thawed = _thaw_mapping(frozen)
        thawed["l"].append(2)
        assert frozen["l"] == (1,)

    def test_thaw_value_handles_scalars(self) -> None:
        assert _thaw_value("text") == "text"
        assert _thaw_value(3) == 3


class TestResponsibilityBoundaries:
    def test_frozen_mapping_is_canonicalizable_via_thaw_semantics(
        self,
    ) -> None:
        frozen = _freeze_mapping({"b": [2], "a": 1})
        assert _canonical_json_bytes(frozen) == b'{"a":1,"b":[2]}'

    def test_freeze_does_not_grant_json_semantics_to_sets(self) -> None:
        frozen = _freeze_value({1, 2})
        assert type(frozen) is frozenset
        with pytest.raises(CanonicalizationError):
            _canonical_json_bytes(frozen)

    def test_fingerprint_uses_canonical_bytes_not_object_identity(
        self,
    ) -> None:
        assert _fingerprint({"a": 1}) == _fingerprint(MappingProxyType({"a": 1}))
