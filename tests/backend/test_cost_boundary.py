"""Tests for the float->authoritative-integer cost boundary (TASK-016)."""

from __future__ import annotations

import pytest

from ai_video_workflow.app.cost_boundary import (
    CostBoundaryError,
    to_authoritative_cost,
)
from ai_video_workflow.providers.models import ProviderCostObservation


def _obs(amount: float, unit: str) -> ProviderCostObservation:
    return ProviderCostObservation(amount=amount, unit=unit)


def test_usd_cents_conversion() -> None:
    auth = to_authoritative_cost(_obs(0.10, "USD"))
    assert auth.cost_minor_units == 10
    assert auth.currency == "USD"
    assert auth.billing_source == "float_boundary_conversion"
    assert auth.observed_amount == 0.10
    assert auth.observed_unit == "USD"


def test_whole_dollar() -> None:
    assert to_authoritative_cost(_obs(1.0, "USD")).cost_minor_units == 100


def test_half_up_rounding() -> None:
    assert to_authoritative_cost(_obs(0.005, "USD")).cost_minor_units == 1  # 0.5 -> 1


def test_jpy_zero_exponent() -> None:
    auth = to_authoritative_cost(_obs(500.0, "JPY"))
    assert auth.cost_minor_units == 500
    assert auth.currency == "JPY"


def test_zero_cost() -> None:
    assert to_authoritative_cost(_obs(0.0, "USD")).cost_minor_units == 0


def test_non_currency_unit_rejected() -> None:
    with pytest.raises(CostBoundaryError, match="ISO-4217"):
        to_authoritative_cost(_obs(1.0, "credits"))


def test_unknown_currency_exponent_rejected() -> None:
    with pytest.raises(CostBoundaryError):
        to_authoritative_cost(_obs(1.0, "XBT"))


def test_non_observation_rejected() -> None:
    with pytest.raises(CostBoundaryError, match="ProviderCostObservation"):
        to_authoritative_cost("nope")  # type: ignore[arg-type]
