"""Tests for locked-catalog resolution (TASK-014 contract 3)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_video_workflow.config import (
    CatalogLockError,
    compute_catalog_digest,
    load_locked_catalog,
    parse_project_config,
)


def _catalog_raw(catalog_id: str = "wfm1-default", version: int = 1) -> dict:
    return {
        "schema_version": 1,
        "catalog_id": catalog_id,
        "version": version,
        "providers": {
            "cloud-a": {
                "display_name": "A",
                "capabilities": ["image_to_video"],
                "credential_env_vars": ["WFM1_CLOUD_A_API_KEY"],
                "models": {
                    "m1": {
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
            }
        },
    }


def _write_catalog(catalog_dir: Path, raw: dict) -> str:
    catalog_dir.mkdir(parents=True, exist_ok=True)
    (catalog_dir / f"{raw['catalog_id']}.json").write_text(
        json.dumps(raw), encoding="utf-8"
    )
    return compute_catalog_digest(raw)


def _config(catalog_id="wfm1-default", version=1, digest="x") -> object:
    return parse_project_config(
        {
            "schema_version": 2,
            "default_provider": "cloud-a",
            "fallback_provider": None,
            "shot_overrides": {},
            "budgets_jpy": {
                "episode_soft": 1200,
                "episode_hard": 1500,
                "monthly_hard": 5000,
                "per_shot": 400,
            },
            "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
            "catalog_id": catalog_id,
            "catalog_version": version,
            "catalog_digest": digest if digest != "x" else "0" * 64,
        }
    )


def test_load_locked_catalog_success(tmp_path: Path) -> None:
    raw = _catalog_raw()
    digest = _write_catalog(tmp_path, raw)
    config = _config(digest=digest)
    catalog = load_locked_catalog(config, tmp_path)
    assert catalog.catalog_id == "wfm1-default"
    assert catalog.version == 1


def test_version_mismatch_fails_closed(tmp_path: Path) -> None:
    raw = _catalog_raw(version=2)
    digest = _write_catalog(tmp_path, raw)
    config = _config(version=1, digest=digest)
    with pytest.raises(CatalogLockError, match="version mismatch"):
        load_locked_catalog(config, tmp_path)


def test_digest_drift_fails_closed(tmp_path: Path) -> None:
    raw = _catalog_raw()
    _write_catalog(tmp_path, raw)
    # lock a different digest than the file's actual content
    config = _config(digest="a" * 64)
    with pytest.raises(CatalogLockError, match="drifted"):
        load_locked_catalog(config, tmp_path)


def test_price_edit_is_detected_as_drift(tmp_path: Path) -> None:
    raw = _catalog_raw()
    digest = _write_catalog(tmp_path, raw)
    config = _config(digest=digest)
    # someone edits a price in place after the project locked the catalog
    raw["providers"]["cloud-a"]["models"]["m1"]["clip_prices"][0][
        "amount_minor_units"
    ] = 999
    (tmp_path / "wfm1-default.json").write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(CatalogLockError, match="drifted"):
        load_locked_catalog(config, tmp_path)


def test_missing_catalog_file_fails_closed(tmp_path: Path) -> None:
    config = _config(digest="0" * 64)
    with pytest.raises(CatalogLockError, match="not found"):
        load_locked_catalog(config, tmp_path)


def test_id_mismatch_fails_closed(tmp_path: Path) -> None:
    # file <id>.json whose internal catalog_id differs
    raw = _catalog_raw(catalog_id="something-else")
    (tmp_path).mkdir(parents=True, exist_ok=True)
    (tmp_path / "wfm1-default.json").write_text(json.dumps(raw), encoding="utf-8")
    config = _config(digest=compute_catalog_digest(raw))
    with pytest.raises(CatalogLockError, match="id mismatch"):
        load_locked_catalog(config, tmp_path)
