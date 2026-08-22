"""Tests for the global provider catalog loader (TASK-B1)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from ai_video_workflow.config import (
    CATALOG_SCHEMA_VERSION,
    CatalogConfigError,
    compute_catalog_digest,
    load_catalog,
    parse_catalog,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_CATALOG = REPO_ROOT / "config" / "providers" / "wfm1-default.json"


def _valid_catalog() -> dict:
    return {
        "schema_version": CATALOG_SCHEMA_VERSION,
        "catalog_id": "test-catalog",
        "version": 1,
        "providers": {
            "manual": {
                "display_name": "Manual",
                "capabilities": ["image_to_video"],
                "credential_env_vars": [],
                "models": {},
            },
            "cloud-a": {
                "display_name": "Cloud A",
                "capabilities": ["image_to_video", "text_to_video"],
                "credential_env_vars": ["WFM1_CLOUD_A_API_KEY"],
                "models": {
                    "clip-model": {
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
                    },
                    "sec-model": {
                        "billing_mode": "per_second",
                        "currency": "USD",
                        "clip_prices": [],
                        "per_second_minor_units": {"720p": 12},
                    },
                },
            },
        },
    }


# --- happy paths ----------------------------------------------------------


def test_shipped_catalog_loads() -> None:
    catalog = load_catalog(EXAMPLE_CATALOG)
    assert catalog.schema_version == CATALOG_SCHEMA_VERSION
    assert catalog.catalog_id == "wfm1-default"
    assert catalog.version == 1
    assert set(catalog.providers) == {"manual", "cloud-a", "cloud-b"}
    assert catalog.providers["cloud-a"].models["std-6s"].billing_mode == "per_clip"


def test_catalog_digest_is_deterministic_and_content_sensitive() -> None:
    raw = _valid_catalog()
    assert compute_catalog_digest(raw) == compute_catalog_digest(_valid_catalog())
    drifted = _valid_catalog()
    drifted["providers"]["cloud-a"]["models"]["clip-model"]["clip_prices"][0][
        "amount_minor_units"
    ] = 999
    assert compute_catalog_digest(drifted) != compute_catalog_digest(raw)


def test_rejects_missing_catalog_id() -> None:
    raw = _valid_catalog()
    del raw["catalog_id"]
    with pytest.raises(CatalogConfigError, match="missing keys"):
        parse_catalog(raw)


def test_parse_both_billing_modes() -> None:
    catalog = parse_catalog(_valid_catalog())
    cloud = catalog.providers["cloud-a"]
    clip = cloud.models["clip-model"]
    assert clip.clip_prices[0].amount_minor_units == 10
    assert clip.per_second_minor_units == {}
    sec = cloud.models["sec-model"]
    assert sec.per_second_minor_units == {"720p": 12}
    assert sec.clip_prices == ()
    assert cloud.credential_env_vars == ("WFM1_CLOUD_A_API_KEY",)


def test_provider_with_no_models_allowed() -> None:
    catalog = parse_catalog(_valid_catalog())
    assert catalog.providers["manual"].models == {}


# --- rejection paths ------------------------------------------------------


def test_rejects_endpoint_key() -> None:
    raw = _valid_catalog()
    raw["providers"]["cloud-a"]["endpoint"] = "https://api.example.com"
    with pytest.raises(CatalogConfigError, match="unknown keys"):
        parse_catalog(raw)


def test_rejects_credential_value_key() -> None:
    raw = _valid_catalog()
    raw["providers"]["cloud-a"]["api_key"] = "sk-secret"
    with pytest.raises(CatalogConfigError, match="unknown keys"):
        parse_catalog(raw)


def test_rejects_unknown_top_key() -> None:
    raw = _valid_catalog()
    raw["extra"] = 1
    with pytest.raises(CatalogConfigError, match="unknown keys"):
        parse_catalog(raw)


def test_rejects_missing_field() -> None:
    raw = _valid_catalog()
    del raw["providers"]["cloud-a"]["display_name"]
    with pytest.raises(CatalogConfigError, match="missing keys"):
        parse_catalog(raw)


def test_rejects_float_amount() -> None:
    raw = _valid_catalog()
    raw["providers"]["cloud-a"]["models"]["clip-model"]["clip_prices"][0][
        "amount_minor_units"
    ] = 10.5
    with pytest.raises(CatalogConfigError, match="amount_minor_units"):
        parse_catalog(raw)


def test_rejects_bool_as_int() -> None:
    raw = _valid_catalog()
    raw["providers"]["cloud-a"]["models"]["clip-model"]["clip_prices"][0][
        "duration_seconds"
    ] = True
    with pytest.raises(CatalogConfigError, match="duration_seconds"):
        parse_catalog(raw)


def test_rejects_unknown_billing_mode() -> None:
    raw = _valid_catalog()
    raw["providers"]["cloud-a"]["models"]["clip-model"]["billing_mode"] = "per_frame"
    with pytest.raises(CatalogConfigError, match="unknown mode"):
        parse_catalog(raw)


def test_rejects_unknown_capability() -> None:
    raw = _valid_catalog()
    raw["providers"]["manual"]["capabilities"] = ["teleportation"]
    with pytest.raises(CatalogConfigError, match="unknown capability"):
        parse_catalog(raw)


def test_rejects_empty_providers() -> None:
    with pytest.raises(CatalogConfigError, match="at least one provider"):
        parse_catalog(
            {
                "schema_version": 1,
                "catalog_id": "test",
                "version": 1,
                "providers": {},
            }
        )


def test_rejects_per_clip_without_prices() -> None:
    raw = _valid_catalog()
    raw["providers"]["cloud-a"]["models"]["clip-model"]["clip_prices"] = []
    with pytest.raises(CatalogConfigError, match="per_clip requires"):
        parse_catalog(raw)


def test_rejects_per_second_with_clip_prices() -> None:
    raw = _valid_catalog()
    model = raw["providers"]["cloud-a"]["models"]["sec-model"]
    model["clip_prices"] = [
        {"resolution": "720p", "duration_seconds": 6, "amount_minor_units": 5}
    ]
    with pytest.raises(CatalogConfigError, match="per_second must leave"):
        parse_catalog(raw)


def test_rejects_bad_currency() -> None:
    raw = _valid_catalog()
    raw["providers"]["cloud-a"]["models"]["clip-model"]["currency"] = "usd"
    with pytest.raises(CatalogConfigError, match="ISO-4217"):
        parse_catalog(raw)


def test_rejects_duplicate_clip_price_key() -> None:
    raw = _valid_catalog()
    prices = raw["providers"]["cloud-a"]["models"]["clip-model"]["clip_prices"]
    prices.append(copy.deepcopy(prices[0]))
    with pytest.raises(CatalogConfigError, match="duplicate"):
        parse_catalog(raw)


def test_rejects_wrong_schema_version() -> None:
    raw = _valid_catalog()
    raw["schema_version"] = 2
    with pytest.raises(CatalogConfigError, match="unsupported version"):
        parse_catalog(raw)


def test_missing_file_raises_typed_error(tmp_path: Path) -> None:
    with pytest.raises(CatalogConfigError, match="does not exist"):
        load_catalog(tmp_path / "nope.json")


def test_invalid_json_raises_typed_error(tmp_path: Path) -> None:
    bad = tmp_path / "catalog.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(CatalogConfigError, match="not valid JSON"):
        load_catalog(bad)


def test_non_path_argument_rejected() -> None:
    with pytest.raises(CatalogConfigError, match="expected Path"):
        load_catalog("config/providers/wfm1-default.json")  # type: ignore[arg-type]


def test_top_level_array_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "catalog.json"
    bad.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    with pytest.raises(CatalogConfigError, match="expected a JSON object"):
        load_catalog(bad)
