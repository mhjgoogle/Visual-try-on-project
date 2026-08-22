"""Tests for locked-FX conversion to integer yen (TASK-B3)."""

from __future__ import annotations

import pytest

from ai_video_workflow.budget import convert_to_base_minor, minor_unit_exponent
from ai_video_workflow.budget.errors import FxError
from ai_video_workflow.config.project_config import FxConfig

_FX = FxConfig(base_currency="JPY", rates={"USD": 160})


def test_usd_dollars_to_yen() -> None:
    # 1000 cents = $10 -> 10 * 160 = 1600 JPY
    assert convert_to_base_minor(_FX, 1000, "USD") == 1600


def test_rounds_up() -> None:
    # 1 cent -> 1 * 160 / 100 = 1.6 -> ceil 2
    assert convert_to_base_minor(_FX, 1, "USD") == 2
    # 3 cents -> 4.8 -> ceil 5
    assert convert_to_base_minor(_FX, 3, "USD") == 5


def test_exact_conversion_not_rounded() -> None:
    # 5 cents -> 8.0 -> 8 exactly
    assert convert_to_base_minor(_FX, 5, "USD") == 8


def test_zero_amount() -> None:
    assert convert_to_base_minor(_FX, 0, "USD") == 0


def test_base_currency_passthrough() -> None:
    assert convert_to_base_minor(_FX, 500, "JPY") == 500


def test_unknown_rate_fails_closed() -> None:
    with pytest.raises(FxError, match="no locked FX rate"):
        convert_to_base_minor(_FX, 100, "EUR")


def test_unknown_minor_unit_exponent_fails_closed() -> None:
    fx = FxConfig(base_currency="JPY", rates={"XYZ": 100})
    with pytest.raises(FxError, match="minor-unit exponent"):
        convert_to_base_minor(fx, 100, "XYZ")


def test_negative_amount_rejected() -> None:
    with pytest.raises(FxError, match="negative"):
        convert_to_base_minor(_FX, -1, "USD")


def test_bool_amount_rejected() -> None:
    with pytest.raises(FxError, match="non-negative int"):
        convert_to_base_minor(_FX, True, "USD")


def test_minor_unit_exponent_lookup() -> None:
    assert minor_unit_exponent("JPY") == 0
    assert minor_unit_exponent("USD") == 2
    with pytest.raises(FxError):
        minor_unit_exponent("ZZZ")
