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


# --- Step B additions: snapshot wrapper tools and stable self fingerprint ---

from ai_video_workflow.errors import InvariantViolationError  # noqa: E402
from ai_video_workflow.orchestration.canonical import (  # noqa: E402
    SNAPSHOT_WRAPPER_VERSION,
    _make_snapshot_wrapper,
    _stable_self_fingerprint,
    _validate_snapshot_wrapper,
)

ALL_SNAPSHOT_KINDS = (
    "provider_request",
    "provider_result",
    "provider_instruction",
    "artifact_reference",
    "generation_task",
    "step_manifest",
    "orchestration_stable_state",
    "action_input",
)

# Independently computed with hashlib over the exact canonical bytes;
# never regenerated with the function under test.
VECTOR_ACTION_INPUT_WRAPPER = (
    "5666f2a52c05722460c397ebf0a7481badd24ffd60e0dbab3a4648a1a0a38a68"
)
VECTOR_ARTIFACT_WRAPPER = (
    "f1d143f334a5fb641a79ebd2172e99562b0c602956213791c3ea9b284e060438"
)
VECTOR_STABLE_SELF = "dadf4fcf1393b8ff018dc792470477c8ab2ab20276f874de89cb28bad2841a65"

ACTION_INPUT_PAYLOAD = {
    "observed_at": "2026-07-26T10:00:00.000000+00:00",
    "artifact": None,
    "completed_at": None,
    "result_fingerprint": None,
}

ARTIFACT_PAYLOAD = {
    "reference": "staging/task-1/clip.mp4",
    "origin": "user",
    "location": "staging",
}


class TestSnapshotWrapperTools:
    @pytest.mark.parametrize("kind", ALL_SNAPSHOT_KINDS)
    def test_make_wrapper_shape_for_each_kind(self, kind: str) -> None:
        wrapper = _make_snapshot_wrapper(kind, {"value": 1})
        assert set(wrapper.keys()) == {
            "snapshot_kind",
            "snapshot_version",
            "payload",
        }
        assert wrapper["snapshot_kind"] == kind
        assert wrapper["snapshot_version"] == SNAPSHOT_WRAPPER_VERSION
        assert wrapper["snapshot_version"] == 1
        assert wrapper["payload"] == {"value": 1}

    def test_make_wrapper_rejects_unknown_kind(self) -> None:
        with pytest.raises(InvariantViolationError):
            _make_snapshot_wrapper("mystery", {})

    def test_make_wrapper_rejects_non_string_kind(self) -> None:
        with pytest.raises(FieldTypeError):
            _make_snapshot_wrapper(1, {})

    def test_make_wrapper_rejects_non_mapping_payload(self) -> None:
        with pytest.raises(FieldTypeError):
            _make_snapshot_wrapper("action_input", [1, 2])

    @pytest.mark.parametrize("kind", ALL_SNAPSHOT_KINDS)
    def test_validate_round_trips_each_kind(self, kind: str) -> None:
        wrapper = _make_snapshot_wrapper(kind, {"value": 1})
        validated = _validate_snapshot_wrapper(
            wrapper,
            expected_kind=kind,
            field_name="wrapper",
        )
        assert validated == wrapper
        assert _fingerprint(validated) == _fingerprint(wrapper)

    def test_validate_accepts_plain_dict_wrapper(self) -> None:
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": 1,
            "payload": dict(ACTION_INPUT_PAYLOAD),
        }
        validated = _validate_snapshot_wrapper(
            wrapper,
            expected_kind="action_input",
            field_name="wrapper",
        )
        assert validated["payload"] == ACTION_INPUT_PAYLOAD

    @pytest.mark.parametrize("version", [0, 2, -1, 999])
    def test_unknown_snapshot_version_is_rejected(self, version: int) -> None:
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": version,
            "payload": dict(ACTION_INPUT_PAYLOAD),
        }
        with pytest.raises(InvariantViolationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    @pytest.mark.parametrize("version", [True, False, "1", 1.0, None])
    def test_non_strict_int_snapshot_version_is_rejected(
        self,
        version: object,
    ) -> None:
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": version,
            "payload": dict(ACTION_INPUT_PAYLOAD),
        }
        with pytest.raises(FieldTypeError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_wrong_kind_is_rejected(self) -> None:
        wrapper = _make_snapshot_wrapper("provider_request", {"value": 1})
        with pytest.raises(InvariantViolationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="provider_result",
                field_name="wrapper",
            )

    def test_unknown_kind_is_rejected(self) -> None:
        wrapper = {
            "snapshot_kind": "mystery",
            "snapshot_version": 1,
            "payload": {},
        }
        with pytest.raises(InvariantViolationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_unknown_expected_kind_is_rejected(self) -> None:
        wrapper = _make_snapshot_wrapper("action_input", {})
        with pytest.raises(InvariantViolationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="mystery",
                field_name="wrapper",
            )

    def test_missing_wrapper_key_is_rejected(self) -> None:
        wrapper = {"snapshot_kind": "action_input", "snapshot_version": 1}
        with pytest.raises(InvariantViolationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_unknown_wrapper_key_is_rejected(self) -> None:
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": 1,
            "payload": {},
            "extra": True,
        }
        with pytest.raises(InvariantViolationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_non_mapping_wrapper_and_payload_are_rejected(self) -> None:
        with pytest.raises(FieldTypeError):
            _validate_snapshot_wrapper(
                "wrapper",
                expected_kind="action_input",
                field_name="wrapper",
            )
        with pytest.raises(FieldTypeError):
            _validate_snapshot_wrapper(
                {
                    "snapshot_kind": "action_input",
                    "snapshot_version": 1,
                    "payload": [1],
                },
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_wrapper_is_deep_frozen(self) -> None:
        wrapper = _make_snapshot_wrapper("action_input", {"nested": {"a": 1}})
        with pytest.raises(TypeError):
            wrapper["payload"] = {}
        with pytest.raises(TypeError):
            wrapper["payload"]["nested"]["a"] = 2

    def test_wrapper_is_isolated_from_original_payload(self) -> None:
        payload = {"nested": {"a": 1}}
        wrapper = _make_snapshot_wrapper("action_input", payload)
        payload["nested"]["a"] = 999
        payload["added"] = True
        assert wrapper["payload"] == {"nested": {"a": 1}}

    def test_fixed_vector_action_input_wrapper(self) -> None:
        wrapper = _make_snapshot_wrapper(
            "action_input",
            dict(ACTION_INPUT_PAYLOAD),
        )
        assert _fingerprint(wrapper) == VECTOR_ACTION_INPUT_WRAPPER

    def test_fixed_vector_artifact_reference_wrapper(self) -> None:
        wrapper = _make_snapshot_wrapper(
            "artifact_reference",
            dict(ARTIFACT_PAYLOAD),
        )
        assert _fingerprint(wrapper) == VECTOR_ARTIFACT_WRAPPER

    def test_wrapper_fingerprint_ignores_payload_insertion_order(
        self,
    ) -> None:
        forward = _make_snapshot_wrapper(
            "action_input",
            dict(ACTION_INPUT_PAYLOAD),
        )
        reversed_payload = dict(reversed(list(ACTION_INPUT_PAYLOAD.items())))
        backward = _make_snapshot_wrapper("action_input", reversed_payload)
        assert _fingerprint(forward) == _fingerprint(backward)
        assert _fingerprint(forward) == VECTOR_ACTION_INPUT_WRAPPER

    def test_wrapper_fingerprint_covers_kind_and_version(self) -> None:
        action_input = _make_snapshot_wrapper("action_input", {"a": 1})
        request = _make_snapshot_wrapper("provider_request", {"a": 1})
        assert _fingerprint(action_input) != _fingerprint(request)
        assert _fingerprint(action_input) != _fingerprint({"a": 1})


class TestStableSelfFingerprint:
    def test_fixed_vector_excludes_self_field(self) -> None:
        payload = {
            "alpha": 1,
            "beta": "中文",
            "stable_record_fingerprint": "ignored",
        }
        assert _stable_self_fingerprint(payload) == VECTOR_STABLE_SELF

    def test_result_is_independent_of_self_field_value(self) -> None:
        with_field = {"alpha": 1, "stable_record_fingerprint": "x"}
        without_field = {"alpha": 1}
        assert _stable_self_fingerprint(with_field) == (
            _stable_self_fingerprint(without_field)
        )

    def test_insertion_order_independence(self) -> None:
        forward = {"a": 1, "b": 2, "stable_record_fingerprint": "x"}
        backward = {"stable_record_fingerprint": "x", "b": 2, "a": 1}
        assert _stable_self_fingerprint(forward) == (_stable_self_fingerprint(backward))

    def test_nfc_equivalent_values_produce_the_same_fingerprint(
        self,
    ) -> None:
        composed = {"key": "caf\u00e9"}
        decomposed = {"key": "cafe\u0301"}
        assert composed["key"] != decomposed["key"]
        assert _stable_self_fingerprint(composed) == (
            _stable_self_fingerprint(decomposed)
        )

    def test_content_changes_change_the_fingerprint(self) -> None:
        assert _stable_self_fingerprint({"a": 1}) != (
            _stable_self_fingerprint({"a": 2})
        )

    def test_non_mapping_input_is_rejected(self) -> None:
        with pytest.raises(FieldTypeError):
            _stable_self_fingerprint([1, 2])

    def test_does_not_mutate_input(self) -> None:
        payload = {"a": 1, "stable_record_fingerprint": "x"}
        snapshot = copy.deepcopy(payload)
        _stable_self_fingerprint(payload)
        assert payload == snapshot


class TestSnapshotWrapperJsonOnlyBoundary:
    @pytest.mark.parametrize("bad_value", [{1, 2}, frozenset({1, 2})])
    def test_nested_set_values_are_rejected(self, bad_value: object) -> None:
        with pytest.raises(CanonicalizationError):
            _make_snapshot_wrapper("action_input", {"bad": bad_value})
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": 1,
            "payload": {"bad": bad_value},
        }
        with pytest.raises(CanonicalizationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_cyclic_payload_is_rejected(self) -> None:
        payload: dict = {"outer": {}}
        payload["outer"]["loop"] = payload
        with pytest.raises(CanonicalizationError):
            _make_snapshot_wrapper("action_input", payload)
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": 1,
            "payload": payload,
        }
        with pytest.raises(CanonicalizationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    @pytest.mark.parametrize(
        "bad_float",
        [float("nan"), float("inf"), float("-inf")],
    )
    def test_non_finite_floats_are_rejected(self, bad_float: float) -> None:
        with pytest.raises(CanonicalizationError):
            _make_snapshot_wrapper("action_input", {"bad": bad_float})
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": 1,
            "payload": {"bad": bad_float},
        }
        with pytest.raises(CanonicalizationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_nfc_normalized_key_collision_is_rejected(self) -> None:
        colliding = {"caf\u00e9": 1, "cafe\u0301": 2}
        assert len(colliding) == 2
        with pytest.raises(CanonicalizationError):
            _make_snapshot_wrapper("action_input", colliding)
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": 1,
            "payload": colliding,
        }
        with pytest.raises(CanonicalizationError):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    @pytest.mark.parametrize(
        "bad_value",
        [UTC_AT, ProviderStatus.SUCCEEDED, Path("clip.mp4"), b"bytes"],
    )
    def test_non_json_objects_are_rejected(self, bad_value: object) -> None:
        with pytest.raises((FieldTypeError, CanonicalizationError)):
            _make_snapshot_wrapper("action_input", {"bad": bad_value})
        wrapper = {
            "snapshot_kind": "action_input",
            "snapshot_version": 1,
            "payload": {"bad": bad_value},
        }
        with pytest.raises((FieldTypeError, CanonicalizationError)):
            _validate_snapshot_wrapper(
                wrapper,
                expected_kind="action_input",
                field_name="wrapper",
            )

    def test_non_string_payload_keys_are_rejected(self) -> None:
        with pytest.raises(CanonicalizationError):
            _make_snapshot_wrapper("action_input", {1: "x"})

    def test_valid_json_payload_still_round_trips(self) -> None:
        payload = {
            "text": "中文",
            "number": 1.5,
            "flag": True,
            "nothing": None,
            "nested": {"items": [1, "two", None]},
        }
        wrapper = _make_snapshot_wrapper("action_input", payload)
        validated = _validate_snapshot_wrapper(
            wrapper,
            expected_kind="action_input",
            field_name="wrapper",
        )
        assert validated == wrapper


# --- Step C additions: deterministic instruction rendering -------------------

import ai_video_workflow.orchestration as orchestration_package_c  # noqa: E402
from ai_video_workflow.orchestration.instructions import (  # noqa: E402
    INSTRUCTION_SCHEMA_VERSION,
    _render_instruction_bytes,
)
from ai_video_workflow.providers.models import (  # noqa: E402
    ProviderInstruction,
)

PLAN_ID_C = "ab" * 32
REQUEST_FP_C = "cd" * 32


def make_instruction(**overrides) -> ProviderInstruction:
    base = dict(
        provider_id="manual",
        task_id="task-1",
        shot_id="shot-1",
        prompt="a cat",
        expected_duration_seconds=4.0,
        expected_width=1280,
        expected_height=720,
        expected_frame_rate=24.0,
        staging_ref="staging/task-1",
        steps=("open tool", "generate"),
        suggested_parameters={"style": "anime"},
    )
    base.update(overrides)
    return ProviderInstruction(**base)


def render(instruction: ProviderInstruction | None = None, **overrides) -> bytes:
    if instruction is None:
        instruction = make_instruction()
    kwargs = dict(
        operation_id="op-1",
        plan_id=PLAN_ID_C,
        request_fingerprint=REQUEST_FP_C,
    )
    kwargs.update(overrides)
    return _render_instruction_bytes(instruction, **kwargs)


# Golden bytes written out literally; never regenerated with the
# renderer under test.
GOLDEN_INSTRUCTION_TEXT = (
    "# Manual Video Generation Task\n"
    "\n"
    "- schema_version: 1\n"
    "- task_id: task-1\n"
    "- shot_id: shot-1\n"
    "- provider_id: manual\n"
    "- operation_id: op-1\n"
    "- plan_id: " + PLAN_ID_C + "\n"
    "- request_fingerprint: " + REQUEST_FP_C + "\n"
    "\n"
    "## Prompt\n"
    "\n"
    "a cat\n"
    "\n"
    "## Expected Output\n"
    "\n"
    "- duration_seconds: 4.0\n"
    "- width: 1280\n"
    "- height: 720\n"
    "- frame_rate: 24.0\n"
    "- staging_ref: staging/task-1\n"
    "\n"
    "## Steps\n"
    "\n"
    "1. open tool\n"
    "2. generate\n"
    "\n"
    "## Suggested Parameters\n"
    "\n"
    "```json\n"
    '{"style":"anime"}\n'
    "```\n"
)


class TestInstructionRendererGoldenBytes:
    def test_schema_version_constant_is_one(self) -> None:
        assert INSTRUCTION_SCHEMA_VERSION == 1

    def test_golden_bytes_exact(self) -> None:
        assert render() == GOLDEN_INSTRUCTION_TEXT.encode("utf-8")

    def test_output_is_utf8_without_bom(self) -> None:
        rendered = render()
        assert isinstance(rendered, bytes)
        assert not rendered.startswith(b"\xef\xbb\xbf")
        rendered.decode("utf-8")

    def test_lf_only_line_endings(self) -> None:
        rendered = render()
        assert b"\r" not in rendered

    def test_ends_with_exactly_one_newline(self) -> None:
        rendered = render()
        assert rendered.endswith(b"\n")
        assert not rendered.endswith(b"\n\n")

    def test_no_trailing_whitespace_on_any_line(self) -> None:
        for line in render().decode("utf-8").split("\n"):
            assert line == line.rstrip()

    def test_fixed_section_order(self) -> None:
        text = render().decode("utf-8")
        positions = [
            text.index("# Manual Video Generation Task"),
            text.index("## Prompt"),
            text.index("## Expected Output"),
            text.index("## Steps"),
            text.index("## Suggested Parameters"),
        ]
        assert positions == sorted(positions)

    def test_repeated_render_is_byte_stable(self) -> None:
        assert render() == render()

    def test_equivalent_instruction_instances_render_identically(
        self,
    ) -> None:
        first = render(make_instruction())
        second = render(make_instruction())
        assert first == second

    def test_multiline_prompt_renders_verbatim(self) -> None:
        instruction = make_instruction(prompt="line one\n\nline two")
        text = render(instruction).decode("utf-8")
        assert "## Prompt\n\nline one\n\nline two\n\n## Expected" in text

    def test_unicode_prompt_is_rendered_verbatim_without_nfc(self) -> None:
        decomposed_prompt = "cafe\u0301 scene"
        rendered = render(make_instruction(prompt=decomposed_prompt))
        assert "cafe\u0301 scene".encode("utf-8") in rendered
        assert "caf\u00e9 scene".encode("utf-8") not in rendered

    def test_empty_parameters_render_as_empty_object(self) -> None:
        instruction = make_instruction(suggested_parameters={})
        text = render(instruction).decode("utf-8")
        assert text.endswith("```json\n{}\n```\n")


class TestInstructionParameterBlock:
    def test_insertion_order_does_not_change_bytes(self) -> None:
        forward = make_instruction(
            suggested_parameters={"alpha": 1, "beta": {"x": 1, "y": 2}}
        )
        backward = make_instruction(
            suggested_parameters={"beta": {"y": 2, "x": 1}, "alpha": 1}
        )
        assert render(forward) == render(backward)

    def test_parameter_block_uses_canonical_json(self) -> None:
        instruction = make_instruction(suggested_parameters={"b": [1, 2], "a": "中文"})
        text = render(instruction).decode("utf-8")
        assert '```json\n{"a":"中文","b":[1,2]}\n```\n' in text

    def test_nfc_equivalent_parameter_values_render_identically(
        self,
    ) -> None:
        composed = make_instruction(suggested_parameters={"key": "caf\u00e9"})
        decomposed = make_instruction(suggested_parameters={"key": "cafe\u0301"})
        assert "caf\u00e9" != "cafe\u0301"
        assert render(composed) == render(decomposed)

    def test_normalized_parameter_key_collision_is_rejected(self) -> None:
        instruction = make_instruction(
            suggested_parameters={"caf\u00e9": 1, "cafe\u0301": 2}
        )
        with pytest.raises(CanonicalizationError):
            render(instruction)

    def test_json_content_stays_inside_the_fenced_block(self) -> None:
        instruction = make_instruction(
            suggested_parameters={"note": "line\nbreak`and`fence"}
        )
        text = render(instruction).decode("utf-8")
        block_start = text.index("```json\n")
        block_body = text[block_start + len("```json\n") :]
        json_line, remainder = block_body.split("\n", 1)
        assert remainder == "```\n"
        assert "\\n" in json_line

    @pytest.mark.parametrize(
        "hostile_value",
        [
            "```",
            "```json",
            "before\n```\nafter",
            "carriage\rreturn",
            "</script>",
            "<!-- comment -->",
            "反引号```内容",
            "café with ``` fence",
        ],
        ids=[
            "bare-fence",
            "fence-with-language",
            "fence-on-own-line",
            "carriage-return",
            "html-like",
            "html-comment",
            "non-ascii-fence",
            "nfd-with-fence",
        ],
    )
    def test_fence_boundary_survives_hostile_parameter_values(
        self,
        hostile_value: str,
    ) -> None:
        instruction = make_instruction(suggested_parameters={"note": hostile_value})
        rendered = render(instruction)
        assert b"\r" not in rendered
        text = rendered.decode("utf-8")
        lines = text.split("\n")
        fence_indexes = [
            index for index, line in enumerate(lines) if line.startswith("```")
        ]
        assert len(fence_indexes) == 2
        opening, closing = fence_indexes
        assert lines[opening] == "```json"
        assert lines[closing] == "```"
        assert closing == opening + 2
        json_line = lines[opening + 1]
        assert json_line.startswith('{"note":')
        assert lines[closing + 1] == ""
        assert closing + 2 == len(lines)


class TestInstructionRendererInputContract:
    def test_non_instruction_input_is_rejected(self) -> None:
        with pytest.raises(FieldTypeError):
            _render_instruction_bytes(
                {"task_id": "task-1"},
                operation_id="op-1",
                plan_id=PLAN_ID_C,
                request_fingerprint=REQUEST_FP_C,
            )

    @pytest.mark.parametrize("operation_id", [1, None, "", "  "])
    def test_invalid_operation_id_is_rejected(
        self,
        operation_id: object,
    ) -> None:
        with pytest.raises((FieldTypeError, InvariantViolationError)):
            render(operation_id=operation_id)

    @pytest.mark.parametrize(
        "plan_id",
        [1, None, "xyz", "AB" * 32, "ab" * 31],
    )
    def test_invalid_plan_id_is_rejected(self, plan_id: object) -> None:
        with pytest.raises((FieldTypeError, InvariantViolationError)):
            render(plan_id=plan_id)

    @pytest.mark.parametrize("fingerprint", [1, "not-hex"])
    def test_invalid_request_fingerprint_is_rejected(
        self,
        fingerprint: object,
    ) -> None:
        with pytest.raises((FieldTypeError, InvariantViolationError)):
            render(request_fingerprint=fingerprint)

    def test_prompt_with_carriage_return_is_rejected(self) -> None:
        instruction = make_instruction(prompt="line one\r\nline two")
        with pytest.raises(InvariantViolationError):
            render(instruction)

    def test_step_with_carriage_return_is_rejected(self) -> None:
        instruction = make_instruction(steps=("open tool", "two\rlines"))
        with pytest.raises(InvariantViolationError):
            render(instruction)

    def test_prompt_internal_trailing_whitespace_is_preserved(self) -> None:
        instruction = make_instruction(prompt="line one \nline two")
        text = render(instruction).decode("utf-8")
        assert "## Prompt\n\nline one \nline two\n\n## Expected" in text

    def test_prompt_internal_tab_whitespace_is_preserved(self) -> None:
        instruction = make_instruction(prompt="line one\t\nline two")
        text = render(instruction).decode("utf-8")
        assert "\nline one\t\nline two\n" in text

    def test_multiline_step_is_rendered_verbatim_after_its_number(
        self,
    ) -> None:
        instruction = make_instruction(steps=("open tool", "two\nlines"))
        text = render(instruction).decode("utf-8")
        assert "## Steps\n\n1. open tool\n2. two\nlines\n\n## Suggested" in (text)

    def test_step_internal_trailing_whitespace_is_preserved(self) -> None:
        instruction = make_instruction(steps=("first line \nsecond line",))
        text = render(instruction).decode("utf-8")
        assert "## Steps\n\n1. first line \nsecond line\n\n## Suggested" in (text)

    def test_rendering_does_not_mutate_the_instruction(self) -> None:
        instruction = make_instruction()
        before = instruction.to_json_dict()
        render(instruction)
        assert instruction.to_json_dict() == before

    def test_failed_render_preserves_the_instruction(self) -> None:
        instruction = make_instruction(
            suggested_parameters={"caf\u00e9": 1, "cafe\u0301": 2}
        )
        before = instruction.to_json_dict()
        with pytest.raises(CanonicalizationError):
            render(instruction)
        assert instruction.to_json_dict() == before

    def test_renderer_is_not_publicly_exported(self) -> None:
        assert "_render_instruction_bytes" not in (orchestration_package_c.__all__)
        assert "INSTRUCTION_SCHEMA_VERSION" not in (orchestration_package_c.__all__)
