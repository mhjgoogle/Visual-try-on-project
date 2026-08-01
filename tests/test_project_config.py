"""Tests for the project-level WFM1 config loader and writer (TASK-B1)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_video_workflow.config import (
    PROJECT_CONFIG_RELPATH,
    ProjectConfig,
    load_project_config,
    parse_project_config,
    write_project_config,
)
from ai_video_workflow.config.project_config import _canonical_json, _config_to_dict
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.security.paths import PathEscapeError

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_CONFIG = (
    REPO_ROOT / "examples" / "projects" / "minimal" / "config" / "wfm1.example.json"
)


_DIGEST = "0" * 64


def _valid_config() -> dict:
    return {
        "schema_version": 2,
        "default_provider": "cloud-a",
        "fallback_provider": "cloud-b",
        "shot_overrides": {"shot-002": "cloud-b"},
        "budgets_jpy": {
            "episode_soft": 1200,
            "episode_hard": 1500,
            "monthly_hard": 5000,
            "per_shot": 400,
        },
        "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
        "catalog_id": "wfm1-default",
        "catalog_version": 1,
        "catalog_digest": _DIGEST,
    }


def _config_object() -> ProjectConfig:
    return parse_project_config(_valid_config())


# --- happy paths ----------------------------------------------------------


def test_shipped_example_config_parses() -> None:
    raw = json.loads(EXAMPLE_CONFIG.read_text(encoding="utf-8"))
    config = parse_project_config(raw)
    assert config.default_provider == "cloud-a"
    assert config.fx.rates == {"USD": 160}
    assert config.budgets_jpy.monthly_hard == 5000
    assert config.catalog_id == "wfm1-default"
    assert config.catalog_version == 1
    assert len(config.catalog_digest) == 64


def test_rejects_bad_catalog_digest() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["catalog_digest"] = "not-a-digest"
    with pytest.raises(ProjectConfigError, match="catalog_digest"):
        parse_project_config(raw)


def test_rejects_non_positive_catalog_version() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["catalog_version"] = 0
    with pytest.raises(ProjectConfigError, match="catalog_version"):
        parse_project_config(raw)


def test_write_then_load_roundtrip(tmp_path: Path) -> None:
    written_path = write_project_config(tmp_path, _config_object())
    assert written_path == tmp_path / PROJECT_CONFIG_RELPATH
    reloaded = load_project_config(tmp_path)
    assert reloaded == _config_object()


def test_write_is_deterministic_and_sorted(tmp_path: Path) -> None:
    path = write_project_config(tmp_path, _config_object())
    text = path.read_text(encoding="utf-8")
    assert text == _canonical_json(_config_to_dict(_config_object()))
    # sorted keys: top-level keys appear in sorted order
    assert text.index('"budgets_jpy"') < text.index('"default_provider"')


def test_optional_fields_may_be_null() -> None:
    raw = _valid_config()
    raw["fallback_provider"] = None
    raw["shot_overrides"] = {}
    config = parse_project_config(raw)
    assert config.fallback_provider is None
    assert config.shot_overrides == {}
    assert config.catalog_id == "wfm1-default"


# --- overwrite protection & containment ----------------------------------


def test_second_write_refuses_overwrite(tmp_path: Path) -> None:
    write_project_config(tmp_path, _config_object())
    with pytest.raises(OverwriteRefusedError, match="refusing to overwrite"):
        write_project_config(tmp_path, _config_object())


def test_symlinked_config_component_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "root"
    root.mkdir()
    (root / "config").symlink_to(outside, target_is_directory=True)
    with pytest.raises(PathEscapeError):
        write_project_config(root, _config_object())
    with pytest.raises(PathEscapeError):
        load_project_config(root)


def test_missing_file_raises_typed_error(tmp_path: Path) -> None:
    from ai_video_workflow.config import ProjectConfigError

    with pytest.raises(ProjectConfigError, match="does not exist"):
        load_project_config(tmp_path)


# --- rejection paths ------------------------------------------------------


def test_rejects_unknown_key() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["surprise"] = 1
    with pytest.raises(ProjectConfigError, match="unknown keys"):
        parse_project_config(raw)


def test_rejects_missing_key() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    del raw["fx"]
    with pytest.raises(ProjectConfigError, match="missing keys"):
        parse_project_config(raw)


def test_rejects_fallback_equal_to_default() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["fallback_provider"] = raw["default_provider"]
    with pytest.raises(ProjectConfigError, match="must differ"):
        parse_project_config(raw)


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda b: b.update(episode_soft=1600), "episode_soft must not exceed"),
        (lambda b: b.update(per_shot=1600), "per_shot must not exceed"),
        (lambda b: b.update(monthly_hard=1000), "episode_hard must not exceed"),
    ],
)
def test_rejects_budget_invariant_violations(mutate, match) -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    mutate(raw["budgets_jpy"])
    with pytest.raises(ProjectConfigError, match=match):
        parse_project_config(raw)


def test_rejects_zero_budget() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["budgets_jpy"]["per_shot"] = 0
    with pytest.raises(ProjectConfigError, match="per_shot"):
        parse_project_config(raw)


def test_rejects_float_fx_rate() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["fx"]["rates"]["USD"] = 160.5
    with pytest.raises(ProjectConfigError, match="USD"):
        parse_project_config(raw)


def test_rejects_non_positive_fx_rate() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["fx"]["rates"]["USD"] = 0
    with pytest.raises(ProjectConfigError, match="USD"):
        parse_project_config(raw)


def test_rejects_fx_restating_base_currency() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["fx"]["rates"]["JPY"] = 1
    with pytest.raises(ProjectConfigError, match="base currency"):
        parse_project_config(raw)


def test_rejects_empty_fx_rates() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["fx"]["rates"] = {}
    with pytest.raises(ProjectConfigError, match="at least one rate"):
        parse_project_config(raw)


def test_rejects_bad_base_currency() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["fx"]["base_currency"] = "Yen"
    with pytest.raises(ProjectConfigError, match="ISO-4217"):
        parse_project_config(raw)


def test_rejects_wrong_schema_version() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["schema_version"] = 99
    with pytest.raises(ProjectConfigError, match="unsupported version"):
        parse_project_config(raw)


def test_rejects_non_string_override_target() -> None:
    from ai_video_workflow.config import ProjectConfigError

    raw = _valid_config()
    raw["shot_overrides"]["shot-002"] = 5
    with pytest.raises(ProjectConfigError, match="shot_overrides"):
        parse_project_config(raw)
