"""Global provider catalog: schema + strict loader (TASK-B1).

The catalog is a repository-level, version-controlled, vendor-neutral
description of *what* each provider can do and *how much it costs* — its
capabilities, models, prices, billing rules, and the *names* of the
environment variables that carry its credentials. It deliberately holds
**no API endpoints, no request/response shapes, and no credential
values**: the closed-key schema rejects any such extra key, and
credential material is only ever read from the environment by later
phases, never from this file.

Money is always an integer in the ISO-4217 minor unit (e.g. US cents),
matching the QCD event contract; there are no floating-point amounts.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.config._parsing import (
    require_bool,
    require_currency,
    require_exact_keys,
    require_int,
    require_keys,
    require_mapping,
    require_str,
    require_str_tuple,
)
from ai_video_workflow.config.errors import CatalogConfigError
from ai_video_workflow.digests import config_digest

CATALOG_SCHEMA_VERSION = 1

_ALLOWED_CAPABILITIES = frozenset({"image_to_video", "text_to_video"})
_BILLING_MODES = frozenset({"per_clip", "per_second"})

_CATALOG_KEYS = frozenset({"schema_version", "catalog_id", "version", "providers"})
_PROVIDER_KEYS = frozenset(
    {"display_name", "capabilities", "credential_env_vars", "models"}
)
_MODEL_KEYS = frozenset(
    {"billing_mode", "currency", "clip_prices", "per_second_minor_units"}
)
# ADR-0071 decision 4: OPTIONAL in the file, never optional as a rule. A model that
# does not declare it gets NO_REFERENCE_IMAGES below, i.e. "this model takes no
# reference images" -- the ADR's words are: a missing declaration is treated as
# max: 0 (fail-closed).
_MODEL_OPTIONAL_KEYS = frozenset({"reference_images"})
_REFERENCE_IMAGES_KEYS = frozenset({"max", "addressable", "roles"})


class _Undeclared:
    """The key was absent from the model, as opposed to present and null."""

    __slots__ = ()


_UNDECLARED = _Undeclared()
_CLIP_PRICE_KEYS = frozenset({"resolution", "duration_seconds", "amount_minor_units"})


@dataclass(frozen=True, slots=True)
class ClipPrice:
    """Price of one whole clip at a fixed resolution and duration."""

    resolution: str
    duration_seconds: int
    amount_minor_units: int


@dataclass(frozen=True, slots=True)
class ReferenceImageCapability:
    """What this model can be GIVEN as reference images (ADR-0071 decision 4).

    THE CATALOG IS THE FACT; THE PROVIDER NEVER GUESSES. Before this existed the
    studio labelled the character / location / prop / style references as "direct
    model input" while the paid request carried exactly one image (the first
    frame) -- four files the creator believed were sent and never were
    (TASK-077 1.3, GAP-27 / GAP-28).

    ``max_images``   how many reference images this model accepts. 0 means none,
                     and 0 is the DEFAULT for a model that says nothing.
    ``addressable``  whether the prompt may point at the Nth image (``[[ref:N]]``).
                     A model that cannot resolve an ordinal must refuse a prompt
                     that uses one rather than send it and hope.
    ``roles``        the reference roles it accepts; empty means no restriction.

    Option C (product owner, 2026-08-17): only providers that have declared that
    multi-image costs no extra are usable for multi-image at all, so a model whose
    multi-image billing is unknown simply keeps ``max_images = 0``. We do not price
    on the provider's behalf.
    """

    max_images: int
    addressable: bool
    roles: tuple[str, ...]
    # WHETHER THE CATALOG ACTUALLY SAID SO (codex round 1, P1). Without this, a
    # model that resolved but declared nothing is indistinguishable from one that
    # declared zero -- and the studio prints DIFFERENT sentences for those two
    # ("the catalog says this model takes none" vs "the catalog does not describe
    # this model"). Both mean no images are sent; only one of them is a statement
    # the catalog made, and claiming the wrong one is the class of lie this ADR
    # exists to remove.
    declared: bool = False

    @property
    def accepts_reference_images(self) -> bool:
        return self.max_images > 0


#: The fail-closed default for a model that declares nothing (decision 4).
NO_REFERENCE_IMAGES = ReferenceImageCapability(
    max_images=0, addressable=False, roles=(), declared=False
)


@dataclass(frozen=True, slots=True)
class ModelCatalogEntry:
    """One priced model of a provider.

    Exactly one price table is populated per billing mode: ``clip_prices``
    for ``per_clip`` (billed by whole generated clip) and
    ``per_second_minor_units`` for ``per_second`` (resolution -> minor
    units per second). The other is empty.
    """

    model_id: str
    billing_mode: str
    currency: str
    clip_prices: tuple[ClipPrice, ...]
    per_second_minor_units: Mapping[str, int]
    # additive (ADR-0071 decision 4); a catalog written before it loads unchanged
    # and reads as "takes no reference images", which is the truth for every model
    # that existed then
    reference_images: ReferenceImageCapability = NO_REFERENCE_IMAGES


@dataclass(frozen=True, slots=True)
class ProviderEntry:
    """One provider's vendor-neutral capability and price description."""

    provider_id: str
    display_name: str
    capabilities: tuple[str, ...]
    credential_env_vars: tuple[str, ...]
    models: Mapping[str, ModelCatalogEntry]


@dataclass(frozen=True, slots=True)
class ProviderCatalog:
    """The whole global provider catalog.

    ``catalog_id`` + ``version`` identify a published catalog; a project
    locks these plus the content digest (see ``config.catalog_lock``) so
    prices cannot drift underneath it.
    """

    schema_version: int
    catalog_id: str
    version: int
    providers: Mapping[str, ProviderEntry]


def compute_catalog_digest(raw: object) -> str:
    """Return the canonical SHA-256 digest of a raw catalog JSON value.

    Computed over the whole catalog document (id, version, providers), so
    any content or price change changes the digest. Reuses the M1
    ``config_digest`` (canonical JSON) contract.
    """
    return config_digest(raw)


def load_catalog(path: Path) -> ProviderCatalog:
    """Read and strictly validate a global provider catalog JSON file."""
    if not isinstance(path, Path):
        raise CatalogConfigError(f"path: expected Path, got {type(path).__name__}")
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise CatalogConfigError(f"catalog file does not exist: {path}") from exc
    except (OSError, UnicodeError) as exc:
        raise CatalogConfigError(f"unable to read catalog file: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise CatalogConfigError(f"catalog is not valid JSON: {path}") from exc
    return parse_catalog(raw)


def parse_catalog(raw: object) -> ProviderCatalog:
    """Build a ``ProviderCatalog`` from already-parsed JSON data."""
    top = require_mapping(raw, "catalog", CatalogConfigError)
    require_exact_keys(top, _CATALOG_KEYS, "catalog", CatalogConfigError)
    version = require_int(
        top["schema_version"], "catalog.schema_version", CatalogConfigError, minimum=1
    )
    if version != CATALOG_SCHEMA_VERSION:
        raise CatalogConfigError(
            f"catalog.schema_version: unsupported version {version}"
        )
    catalog_id = require_str(
        top["catalog_id"], "catalog.catalog_id", CatalogConfigError
    )
    catalog_version = require_int(
        top["version"], "catalog.version", CatalogConfigError, minimum=1
    )
    providers_raw = require_mapping(
        top["providers"], "catalog.providers", CatalogConfigError
    )
    if not providers_raw:
        raise CatalogConfigError("catalog.providers: at least one provider is required")
    providers = {
        require_str(pid, "catalog.providers key", CatalogConfigError): _parse_provider(
            pid, entry
        )
        for pid, entry in providers_raw.items()
    }
    return ProviderCatalog(
        schema_version=version,
        catalog_id=catalog_id,
        version=catalog_version,
        providers=providers,
    )


def _parse_provider(provider_id: str, raw: object) -> ProviderEntry:
    ctx = f"provider {provider_id!r}"
    entry = require_mapping(raw, ctx, CatalogConfigError)
    require_exact_keys(entry, _PROVIDER_KEYS, ctx, CatalogConfigError)
    capabilities = require_str_tuple(
        entry["capabilities"],
        f"{ctx}.capabilities",
        CatalogConfigError,
        allow_empty=False,
    )
    for capability in capabilities:
        if capability not in _ALLOWED_CAPABILITIES:
            raise CatalogConfigError(
                f"{ctx}.capabilities: unknown capability {capability!r}"
            )
    credential_env_vars = require_str_tuple(
        entry["credential_env_vars"], f"{ctx}.credential_env_vars", CatalogConfigError
    )
    models_raw = require_mapping(entry["models"], f"{ctx}.models", CatalogConfigError)
    models = {
        require_str(mid, f"{ctx}.models key", CatalogConfigError): _parse_model(
            provider_id, mid, model
        )
        for mid, model in models_raw.items()
    }
    return ProviderEntry(
        provider_id=provider_id,
        display_name=require_str(
            entry["display_name"], f"{ctx}.display_name", CatalogConfigError
        ),
        capabilities=capabilities,
        credential_env_vars=credential_env_vars,
        models=models,
    )


def _parse_model(provider_id: str, model_id: str, raw: object) -> ModelCatalogEntry:
    ctx = f"provider {provider_id!r} model {model_id!r}"
    entry = require_mapping(raw, ctx, CatalogConfigError)
    require_keys(entry, _MODEL_KEYS, _MODEL_OPTIONAL_KEYS, ctx, CatalogConfigError)
    billing_mode = require_str(
        entry["billing_mode"], f"{ctx}.billing_mode", CatalogConfigError
    )
    if billing_mode not in _BILLING_MODES:
        raise CatalogConfigError(f"{ctx}.billing_mode: unknown mode {billing_mode!r}")
    currency = require_currency(
        entry["currency"], f"{ctx}.currency", CatalogConfigError
    )
    clip_prices = _parse_clip_prices(entry["clip_prices"], ctx)
    per_second = _parse_per_second(entry["per_second_minor_units"], ctx)

    if billing_mode == "per_clip":
        if not clip_prices:
            raise CatalogConfigError(
                f"{ctx}: per_clip requires a non-empty clip_prices"
            )
        if per_second:
            raise CatalogConfigError(
                f"{ctx}: per_clip must leave per_second_minor_units empty"
            )
    else:  # per_second
        if not per_second:
            raise CatalogConfigError(
                f"{ctx}: per_second requires a non-empty per_second_minor_units"
            )
        if clip_prices:
            raise CatalogConfigError(f"{ctx}: per_second must leave clip_prices empty")

    return ModelCatalogEntry(
        model_id=model_id,
        billing_mode=billing_mode,
        currency=currency,
        clip_prices=clip_prices,
        per_second_minor_units=per_second,
        reference_images=_parse_reference_images(
            # ABSENT vs EXPLICIT NULL (codex round 2, P2). `.get()` collapsed them,
            # so `"reference_images": null` silently disabled the capability instead
            # of being reported as a malformed declaration. A catalog is
            # version-controlled and reviewed; a null there is a mistake somebody
            # should be told about, not a quiet default.
            entry["reference_images"] if "reference_images" in entry else _UNDECLARED,
            ctx,
        ),
    )


def _parse_reference_images(raw: object, ctx: str) -> ReferenceImageCapability:
    """Parse a model's reference-image declaration, or fail closed to none.

    A model that says nothing carries no reference images. That is not a guess: it
    is the only safe reading, and it is exactly what every model in this catalog
    could do before the field existed.
    """
    if raw is _UNDECLARED:
        return NO_REFERENCE_IMAGES
    entry = require_mapping(raw, f"{ctx}.reference_images", CatalogConfigError)
    require_exact_keys(
        entry, _REFERENCE_IMAGES_KEYS, f"{ctx}.reference_images", CatalogConfigError
    )
    max_images = require_int(
        entry["max"], f"{ctx}.reference_images.max", CatalogConfigError, minimum=0
    )
    addressable = require_bool(
        entry["addressable"],
        f"{ctx}.reference_images.addressable",
        CatalogConfigError,
    )
    roles = require_str_tuple(
        entry["roles"], f"{ctx}.reference_images.roles", CatalogConfigError
    )
    # Two declarations that cannot both be true. Refused at load rather than
    # normalised, because a catalog that says one thing and means another is the
    # single source of truth being wrong -- the whole point of decision 4.
    if max_images == 0 and addressable:
        raise CatalogConfigError(
            f"{ctx}.reference_images: addressable requires max >= 1 -- a prompt "
            "cannot point at an image the model is never given"
        )
    if max_images == 0 and roles:
        raise CatalogConfigError(
            f"{ctx}.reference_images: roles are meaningless with max = 0"
        )
    return ReferenceImageCapability(
        max_images=max_images, addressable=addressable, roles=roles, declared=True
    )


def _parse_clip_prices(raw: object, ctx: str) -> tuple[ClipPrice, ...]:
    if not isinstance(raw, list):
        raise CatalogConfigError(f"{ctx}.clip_prices: expected a JSON array")
    prices: list[ClipPrice] = []
    seen: set[tuple[str, int]] = set()
    for item in raw:
        row = require_mapping(item, f"{ctx}.clip_prices[]", CatalogConfigError)
        require_exact_keys(
            row, _CLIP_PRICE_KEYS, f"{ctx}.clip_prices[]", CatalogConfigError
        )
        resolution = require_str(
            row["resolution"], f"{ctx}.clip_prices[].resolution", CatalogConfigError
        )
        duration = require_int(
            row["duration_seconds"],
            f"{ctx}.clip_prices[].duration_seconds",
            CatalogConfigError,
            minimum=1,
        )
        amount = require_int(
            row["amount_minor_units"],
            f"{ctx}.clip_prices[].amount_minor_units",
            CatalogConfigError,
            minimum=0,
        )
        key = (resolution, duration)
        if key in seen:
            raise CatalogConfigError(
                f"{ctx}.clip_prices: duplicate (resolution, duration) {key}"
            )
        seen.add(key)
        prices.append(ClipPrice(resolution, duration, amount))
    return tuple(prices)


def _parse_per_second(raw: object, ctx: str) -> Mapping[str, int]:
    table = require_mapping(raw, f"{ctx}.per_second_minor_units", CatalogConfigError)
    return {
        require_str(
            resolution, f"{ctx}.per_second_minor_units key", CatalogConfigError
        ): require_int(
            rate,
            f"{ctx}.per_second_minor_units[{resolution!r}]",
            CatalogConfigError,
            minimum=0,
        )
        for resolution, rate in table.items()
    }
