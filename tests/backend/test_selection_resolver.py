"""Tests for the vendor-neutral provider selection resolver (TASK-014 c2)."""

from __future__ import annotations

import pytest

from ai_video_workflow.config import (
    SelectionError,
    parse_catalog,
    parse_project_config,
    resolve_provider_selection,
)


def _model(mode: str = "per_clip") -> dict:
    if mode == "per_clip":
        return {
            "billing_mode": "per_clip",
            "currency": "USD",
            "clip_prices": [
                {"resolution": "512p", "duration_seconds": 6, "amount_minor_units": 10}
            ],
            "per_second_minor_units": {},
        }
    return {
        "billing_mode": "per_second",
        "currency": "USD",
        "clip_prices": [],
        "per_second_minor_units": {"720p": 12},
    }


def _catalog() -> object:
    def i2v(models: dict) -> dict:
        return {
            "display_name": "p",
            "capabilities": ["image_to_video"],
            "credential_env_vars": [],
            "models": models,
        }

    raw = {
        "schema_version": 1,
        "catalog_id": "test",
        "version": 1,
        "providers": {
            "cloud-a": i2v({"m1": _model()}),
            "cloud-b": i2v({"m1": _model("per_second")}),
            "t2v-only": {
                "display_name": "text only",
                "capabilities": ["text_to_video"],
                "credential_env_vars": [],
                "models": {"tm": _model()},
            },
        },
    }
    return parse_catalog(raw)


def _config(**overrides) -> object:
    raw = {
        "schema_version": 2,
        "default_provider": "cloud-a",
        "fallback_provider": "cloud-b",
        "shot_overrides": {},
        "budgets_jpy": {
            "episode_soft": 1200,
            "episode_hard": 1500,
            "monthly_hard": 5000,
            "per_shot": 400,
        },
        "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
        "catalog_id": "test",
        "catalog_version": 1,
        "catalog_digest": "0" * 64,
    }
    raw.update(overrides)
    return parse_project_config(raw)


def _resolve(config, shot_id, *, capability="image_to_video", model_id="m1"):
    return resolve_provider_selection(
        config, _catalog(), shot_id, capability=capability, model_id=model_id
    )


def test_default_selection() -> None:
    sel = _resolve(_config(), "shot-1")
    assert sel.primary_provider_id == "cloud-a"
    assert sel.primary_model_id == "m1"
    assert sel.capability == "image_to_video"
    assert sel.fallback_provider_id == "cloud-b"
    assert sel.source == "default"


def test_shot_override_collapses_self_fallback() -> None:
    config = _config(shot_overrides={"shot-2": "cloud-b"})
    sel = _resolve(config, "shot-2")
    assert sel.primary_provider_id == "cloud-b"
    assert sel.source == "override"
    assert sel.fallback_provider_id is None


def test_capability_is_task_provided_not_fixed() -> None:
    # capability is not hardcoded to image_to_video: a text_to_video task
    # resolves against a text_to_video provider.
    config = _config(default_provider="t2v-only", fallback_provider=None)
    sel = resolve_provider_selection(
        config, _catalog(), "shot-1", capability="text_to_video", model_id="tm"
    )
    assert sel.primary_provider_id == "t2v-only"
    assert sel.capability == "text_to_video"


def test_unknown_primary_rejected() -> None:
    with pytest.raises(SelectionError, match="primary provider 'ghost' is not"):
        _resolve(_config(default_provider="ghost"), "shot-1")


def test_primary_missing_capability_rejected() -> None:
    config = _config(default_provider="t2v-only", fallback_provider=None)
    with pytest.raises(SelectionError, match="lacks the 'image_to_video'"):
        _resolve(config, "shot-1")


def test_primary_missing_model_rejected() -> None:
    with pytest.raises(SelectionError, match="no model 'ghost'"):
        _resolve(_config(), "shot-1", model_id="ghost")


def test_unknown_fallback_rejected() -> None:
    with pytest.raises(SelectionError, match="fallback provider 'ghost' is not"):
        _resolve(_config(fallback_provider="ghost"), "shot-1")


def test_fallback_missing_capability_rejected() -> None:
    with pytest.raises(SelectionError, match="fallback provider 't2v-only' lacks"):
        _resolve(_config(fallback_provider="t2v-only"), "shot-1")


def test_no_fallback_configured() -> None:
    sel = _resolve(_config(fallback_provider=None), "shot-1")
    assert sel.fallback_provider_id is None


def test_non_string_inputs_rejected() -> None:
    with pytest.raises(SelectionError, match="shot_id"):
        _resolve(_config(), 5)
    with pytest.raises(SelectionError, match="model_id"):
        _resolve(_config(), "shot-1", model_id=1)
