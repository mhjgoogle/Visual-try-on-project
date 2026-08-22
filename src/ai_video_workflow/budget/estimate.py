"""Pre-flight cost estimate: catalog price -> locked FX -> integer yen (TASK-B3).

Combines the vendor-neutral catalog quote with the project's locked FX to
produce the yen figure the guard checks *before* a generation call. Keeps
both the original-currency amount and the converted yen so the dual-
currency audit trail is available to callers.
"""

from __future__ import annotations

from dataclasses import dataclass

from ai_video_workflow.budget.fx import convert_to_base_minor
from ai_video_workflow.budget.quote import quote_original
from ai_video_workflow.config.catalog import ProviderCatalog
from ai_video_workflow.config.project_config import FxConfig


@dataclass(frozen=True, slots=True)
class CostEstimate:
    """A pre-flight estimate carrying both original and converted amounts."""

    original_amount_minor_units: int
    original_currency: str
    jpy: int


def estimate_generation_cost(
    catalog: ProviderCatalog,
    fx: FxConfig,
    provider_id: str,
    model_id: str,
    *,
    resolution: str,
    duration_seconds: int,
) -> CostEstimate:
    """Estimate one generation's cost, in yen (rounded up), plus its origin."""
    quote = quote_original(
        catalog,
        provider_id,
        model_id,
        resolution=resolution,
        duration_seconds=duration_seconds,
    )
    jpy = convert_to_base_minor(fx, quote.amount_minor_units, quote.currency)
    return CostEstimate(
        original_amount_minor_units=quote.amount_minor_units,
        original_currency=quote.currency,
        jpy=jpy,
    )
