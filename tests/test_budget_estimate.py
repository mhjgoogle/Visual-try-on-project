"""Tests for catalog quote + yen estimate (TASK-B3)."""

from __future__ import annotations

import pytest

from ai_video_workflow.budget import (
    CostEstimate,
    estimate_generation_cost,
    quote_original,
)
from ai_video_workflow.budget.errors import QuoteError
from ai_video_workflow.config import parse_catalog
from ai_video_workflow.config.project_config import FxConfig

_FX = FxConfig(base_currency="JPY", rates={"USD": 160})


def _catalog() -> object:
    return parse_catalog(
        {
            "schema_version": 1,
            "catalog_id": "test",
            "version": 1,
            "providers": {
                "cloud-a": {
                    "display_name": "A",
                    "capabilities": ["image_to_video"],
                    "credential_env_vars": ["WFM1_CLOUD_A_API_KEY"],
                    "models": {
                        "clip": {
                            "billing_mode": "per_clip",
                            "currency": "USD",
                            "clip_prices": [
                                {
                                    "resolution": "512p",
                                    "duration_seconds": 6,
                                    "amount_minor_units": 10,
                                }
                            ],
                            "per_second_minor_units": {},
                        }
                    },
                },
                "cloud-b": {
                    "display_name": "B",
                    "capabilities": ["image_to_video"],
                    "credential_env_vars": [],
                    "models": {
                        "sec": {
                            "billing_mode": "per_second",
                            "currency": "USD",
                            "clip_prices": [],
                            "per_second_minor_units": {"720p": 12},
                        }
                    },
                },
            },
        }
    )


# --- quote ----------------------------------------------------------------


def test_per_clip_quote() -> None:
    quote = quote_original(
        _catalog(), "cloud-a", "clip", resolution="512p", duration_seconds=6
    )
    assert quote.amount_minor_units == 10
    assert quote.currency == "USD"


def test_per_second_quote_scales_with_duration() -> None:
    quote = quote_original(
        _catalog(), "cloud-b", "sec", resolution="720p", duration_seconds=5
    )
    assert quote.amount_minor_units == 60  # 12 * 5


def test_unknown_provider_rejected() -> None:
    with pytest.raises(QuoteError, match="not in the catalog"):
        quote_original(
            _catalog(), "ghost", "clip", resolution="512p", duration_seconds=6
        )


def test_unknown_model_rejected() -> None:
    with pytest.raises(QuoteError, match="no model"):
        quote_original(
            _catalog(), "cloud-a", "ghost", resolution="512p", duration_seconds=6
        )


def test_per_clip_missing_spec_rejected() -> None:
    with pytest.raises(QuoteError, match="no per-clip price"):
        quote_original(
            _catalog(), "cloud-a", "clip", resolution="512p", duration_seconds=10
        )


def test_per_second_missing_resolution_rejected() -> None:
    with pytest.raises(QuoteError, match="no per-second rate"):
        quote_original(
            _catalog(), "cloud-b", "sec", resolution="1080p", duration_seconds=5
        )


def test_zero_duration_rejected() -> None:
    with pytest.raises(QuoteError, match="duration_seconds"):
        quote_original(
            _catalog(), "cloud-b", "sec", resolution="720p", duration_seconds=0
        )


# --- estimate -------------------------------------------------------------


def test_estimate_converts_to_yen_with_audit() -> None:
    est = estimate_generation_cost(
        _catalog(), _FX, "cloud-a", "clip", resolution="512p", duration_seconds=6
    )
    assert isinstance(est, CostEstimate)
    assert est.original_amount_minor_units == 10
    assert est.original_currency == "USD"
    assert est.jpy == 16  # ceil(10 * 160 / 100)


def test_estimate_per_second() -> None:
    est = estimate_generation_cost(
        _catalog(), _FX, "cloud-b", "sec", resolution="720p", duration_seconds=5
    )
    assert est.jpy == 96  # 60 cents -> ceil(60 * 1.6)
