"""Project-level WFM1 config: schema, loader, creation-time writer (TASK-B1).

One JSON file, written once at project creation and never silently
overwritten, holds the per-project *selection*, *budget*, and *locked
FX* decisions:

- which provider is the default, which is the fallback, and any
  per-shot provider overrides;
- the yen budget thresholds (soft / hard per episode, monthly hard,
  per-shot);
- the FX rate table, **locked at creation** so a project's yen figures
  never drift when the global default rate is later changed.

FX rates are integers (base-currency units per one foreign unit), so the
whole budget pipeline stays in integer yen with no floating-point money.
The file lives inside the project data root and is admitted through the
ADR-0004 containment resolver, so a symlinked ``config`` component cannot
redirect the read or the write outside the root.

This layer validates *structure* only. Cross-checking that
``default_provider`` / ``fallback_provider`` / override targets actually
exist in the global catalog is the selection resolver's job (TASK-B2).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.config._parsing import (
    require_currency,
    require_exact_keys,
    require_int,
    require_mapping,
    require_str,
)
from ai_video_workflow.config.errors import ProjectConfigError
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.security.paths import resolve_within_root

PROJECT_CONFIG_SCHEMA_VERSION = 2
PROJECT_CONFIG_RELPATH = "config/wfm1.json"

_TOP_KEYS = frozenset(
    {
        "schema_version",
        "default_provider",
        "fallback_provider",
        "shot_overrides",
        "budgets_jpy",
        "fx",
        "catalog_id",
        "catalog_version",
        "catalog_digest",
    }
)
_BUDGET_KEYS = frozenset({"episode_soft", "episode_hard", "monthly_hard", "per_shot"})
_FX_KEYS = frozenset({"base_currency", "rates"})

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class BudgetsJpy:
    """Yen budget thresholds. All positive integers, in whole yen."""

    episode_soft: int
    episode_hard: int
    monthly_hard: int
    per_shot: int


@dataclass(frozen=True, slots=True)
class FxConfig:
    """FX rate table locked at project creation.

    ``rates`` maps a foreign ISO-4217 code to the integer number of
    ``base_currency`` units per one foreign unit (e.g. ``{"USD": 160}``
    for 1 USD = 160 JPY). The base currency itself is implicitly 1 and
    need not appear in ``rates``.
    """

    base_currency: str
    rates: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class ProjectConfig:
    """The whole per-project WFM1 configuration.

    ``catalog_id`` + ``catalog_version`` + ``catalog_digest`` lock the
    exact priced catalog (see ``config.catalog_lock``); the project
    references a catalog by id, never by an arbitrary path.
    """

    schema_version: int
    default_provider: str
    fallback_provider: str | None
    shot_overrides: Mapping[str, str]
    budgets_jpy: BudgetsJpy
    fx: FxConfig
    catalog_id: str
    catalog_version: int
    catalog_digest: str


def load_project_config(project_root: Path) -> ProjectConfig:
    """Read and strictly validate ``<root>/config/wfm1.json``."""
    path = resolve_within_root(project_root, PROJECT_CONFIG_RELPATH)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ProjectConfigError(f"project config does not exist: {path}") from exc
    except (OSError, UnicodeError) as exc:
        raise ProjectConfigError(f"unable to read project config: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise ProjectConfigError(f"project config is not valid JSON: {path}") from exc
    return parse_project_config(raw)


def write_project_config(project_root: Path, config: ProjectConfig) -> Path:
    """Publish the project config once; refuse to overwrite an existing file.

    Creation-time only: a second write raises ``OverwriteRefusedError`` so
    the locked FX and budgets cannot be silently changed mid-project.
    """
    path = resolve_within_root(project_root, PROJECT_CONFIG_RELPATH)
    text = _canonical_json(_config_to_dict(config))
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_new(path, text.encode("utf-8"))
    return path


def parse_project_config(raw: object) -> ProjectConfig:
    """Build a ``ProjectConfig`` from already-parsed JSON data."""
    top = require_mapping(raw, "project config", ProjectConfigError)
    require_exact_keys(top, _TOP_KEYS, "project config", ProjectConfigError)
    version = require_int(
        top["schema_version"], "schema_version", ProjectConfigError, minimum=1
    )
    if version != PROJECT_CONFIG_SCHEMA_VERSION:
        raise ProjectConfigError(f"schema_version: unsupported version {version}")

    default_provider = require_str(
        top["default_provider"], "default_provider", ProjectConfigError
    )
    fallback_provider = _optional_str(top["fallback_provider"], "fallback_provider")
    shot_overrides = _parse_shot_overrides(top["shot_overrides"])

    if fallback_provider is not None and fallback_provider == default_provider:
        raise ProjectConfigError("fallback_provider: must differ from default_provider")

    catalog_id = require_str(top["catalog_id"], "catalog_id", ProjectConfigError)
    catalog_version = require_int(
        top["catalog_version"], "catalog_version", ProjectConfigError, minimum=1
    )
    catalog_digest = require_str(
        top["catalog_digest"], "catalog_digest", ProjectConfigError
    )
    if _SHA256_RE.match(catalog_digest) is None:
        raise ProjectConfigError(
            "catalog_digest: expected a lowercase hex SHA-256 digest"
        )

    return ProjectConfig(
        schema_version=version,
        default_provider=default_provider,
        fallback_provider=fallback_provider,
        shot_overrides=shot_overrides,
        budgets_jpy=_parse_budgets(top["budgets_jpy"]),
        fx=_parse_fx(top["fx"]),
        catalog_id=catalog_id,
        catalog_version=catalog_version,
        catalog_digest=catalog_digest,
    )


def _parse_shot_overrides(raw: object) -> Mapping[str, str]:
    table = require_mapping(raw, "shot_overrides", ProjectConfigError)
    return {
        require_str(shot_id, "shot_overrides key", ProjectConfigError): require_str(
            provider_id, f"shot_overrides[{shot_id!r}]", ProjectConfigError
        )
        for shot_id, provider_id in table.items()
    }


def _parse_budgets(raw: object) -> BudgetsJpy:
    entry = require_mapping(raw, "budgets_jpy", ProjectConfigError)
    require_exact_keys(entry, _BUDGET_KEYS, "budgets_jpy", ProjectConfigError)
    episode_soft = require_int(
        entry["episode_soft"], "budgets_jpy.episode_soft", ProjectConfigError, minimum=1
    )
    episode_hard = require_int(
        entry["episode_hard"], "budgets_jpy.episode_hard", ProjectConfigError, minimum=1
    )
    monthly_hard = require_int(
        entry["monthly_hard"], "budgets_jpy.monthly_hard", ProjectConfigError, minimum=1
    )
    per_shot = require_int(
        entry["per_shot"], "budgets_jpy.per_shot", ProjectConfigError, minimum=1
    )
    if episode_soft > episode_hard:
        raise ProjectConfigError(
            "budgets_jpy: episode_soft must not exceed episode_hard"
        )
    if per_shot > episode_hard:
        raise ProjectConfigError("budgets_jpy: per_shot must not exceed episode_hard")
    if episode_hard > monthly_hard:
        raise ProjectConfigError(
            "budgets_jpy: episode_hard must not exceed monthly_hard"
        )
    return BudgetsJpy(episode_soft, episode_hard, monthly_hard, per_shot)


def _parse_fx(raw: object) -> FxConfig:
    entry = require_mapping(raw, "fx", ProjectConfigError)
    require_exact_keys(entry, _FX_KEYS, "fx", ProjectConfigError)
    base_currency = require_currency(
        entry["base_currency"], "fx.base_currency", ProjectConfigError
    )
    rates_raw = require_mapping(entry["rates"], "fx.rates", ProjectConfigError)
    if not rates_raw:
        raise ProjectConfigError("fx.rates: at least one rate is required")
    rates: dict[str, int] = {}
    for currency, rate in rates_raw.items():
        code = require_currency(currency, "fx.rates key", ProjectConfigError)
        if code == base_currency:
            raise ProjectConfigError(
                "fx.rates: must not restate the base currency (implicitly 1)"
            )
        rates[code] = require_int(
            rate, f"fx.rates[{code!r}]", ProjectConfigError, minimum=1
        )
    return FxConfig(base_currency=base_currency, rates=rates)


def _optional_str(value: object, ctx: str) -> str | None:
    if value is None:
        return None
    return require_str(value, ctx, ProjectConfigError)


# --- serialization --------------------------------------------------------


def _config_to_dict(config: ProjectConfig) -> dict:
    if not isinstance(config, ProjectConfig):
        raise ProjectConfigError(
            f"config: expected ProjectConfig, got {type(config).__name__}"
        )
    return {
        "schema_version": config.schema_version,
        "default_provider": config.default_provider,
        "fallback_provider": config.fallback_provider,
        "shot_overrides": dict(config.shot_overrides),
        "budgets_jpy": {
            "episode_soft": config.budgets_jpy.episode_soft,
            "episode_hard": config.budgets_jpy.episode_hard,
            "monthly_hard": config.budgets_jpy.monthly_hard,
            "per_shot": config.budgets_jpy.per_shot,
        },
        "fx": {
            "base_currency": config.fx.base_currency,
            "rates": dict(config.fx.rates),
        },
        "catalog_id": config.catalog_id,
        "catalog_version": config.catalog_version,
        "catalog_digest": config.catalog_digest,
    }


def _canonical_json(data: object) -> str:
    return (
        json.dumps(
            data,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    )


def _atomic_write_new(path: Path, payload: bytes) -> None:
    """Atomically create ``path``; refuse if it already exists."""
    raw_fd, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary_path, path)
        except FileExistsError as exc:
            raise OverwriteRefusedError(
                f"refusing to overwrite existing project config: {path}"
            ) from exc
    finally:
        try:
            temporary_path.unlink()
        except OSError:
            pass
