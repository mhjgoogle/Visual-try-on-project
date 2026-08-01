"""Vendor-neutral price lookup from the global catalog (TASK-B3).

Given a provider, model, and generation spec (resolution + duration),
return the original-currency cost from the catalog price table. Holds no
vendor constants: per-clip models are billed by a matching whole-clip
price, per-second models by ``rate * duration``. A spec with no matching
price fails closed with ``QuoteError``.
"""

from __future__ import annotations

from dataclasses import dataclass

from ai_video_workflow.budget.errors import QuoteError
from ai_video_workflow.config.catalog import ProviderCatalog


@dataclass(frozen=True, slots=True)
class Quote:
    """An original-currency cost for one generation, in minor units."""

    amount_minor_units: int
    currency: str


def quote_original(
    catalog: ProviderCatalog,
    provider_id: str,
    model_id: str,
    *,
    resolution: str,
    duration_seconds: int,
) -> Quote:
    """Return the original-currency price for one generation."""
    if not isinstance(resolution, str) or not resolution:
        raise QuoteError("resolution: expected a non-empty string")
    if isinstance(duration_seconds, bool) or not isinstance(duration_seconds, int):
        raise QuoteError("duration_seconds: expected an int")
    if duration_seconds < 1:
        raise QuoteError("duration_seconds: must be >= 1")

    provider = catalog.providers.get(provider_id)
    if provider is None:
        raise QuoteError(f"provider {provider_id!r} is not in the catalog")
    model = provider.models.get(model_id)
    if model is None:
        raise QuoteError(
            f"provider {provider_id!r} has no model {model_id!r} in the catalog"
        )

    if model.billing_mode == "per_clip":
        for price in model.clip_prices:
            if (
                price.resolution == resolution
                and price.duration_seconds == duration_seconds
            ):
                return Quote(price.amount_minor_units, model.currency)
        raise QuoteError(
            f"provider {provider_id!r} model {model_id!r} has no per-clip price "
            f"for {resolution!r}/{duration_seconds}s"
        )

    # per_second
    rate = model.per_second_minor_units.get(resolution)
    if rate is None:
        raise QuoteError(
            f"provider {provider_id!r} model {model_id!r} has no per-second rate "
            f"for {resolution!r}"
        )
    return Quote(rate * duration_seconds, model.currency)
