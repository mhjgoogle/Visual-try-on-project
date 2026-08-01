"""Provider float cost -> authoritative integer minor units (TASK-016).

ADR-0008: the provider's ``ProviderCostObservation.amount`` (a float) is
non-authoritative telemetry. The authoritative cost fact is an integer in
the currency's minor unit. This boundary converts the float observation
to that integer deterministically (``Decimal``, half-up), tagging the
result ``billing_source = "float_boundary_conversion"``, and keeps the
original float + unit as telemetry. The frozen ``ProviderCostObservation``
is not modified.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from ai_video_workflow.budget.fx import minor_unit_exponent
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.providers.models import ProviderCostObservation

FLOAT_BOUNDARY = "float_boundary_conversion"
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


class CostBoundaryError(AiVideoWorkflowError):
    """Raised when a provider cost observation cannot be made authoritative."""


@dataclass(frozen=True, slots=True)
class AuthoritativeCost:
    """The authoritative integer cost plus the float telemetry it came from."""

    cost_minor_units: int
    currency: str
    billing_source: str
    observed_amount: float
    observed_unit: str


def to_authoritative_cost(observation: ProviderCostObservation) -> AuthoritativeCost:
    """Convert a float cost observation to an authoritative integer amount.

    The observation's ``unit`` must be an ISO-4217 currency with a known
    minor-unit exponent; otherwise it cannot be booked and this fails
    closed with ``CostBoundaryError``.
    """
    if not isinstance(observation, ProviderCostObservation):
        raise CostBoundaryError(
            f"observation: expected ProviderCostObservation, "
            f"got {type(observation).__name__}"
        )
    currency = observation.unit
    if _CURRENCY_RE.match(currency) is None:
        raise CostBoundaryError(
            f"cost unit {currency!r} is not an ISO-4217 currency; cannot book"
        )
    try:
        exponent = minor_unit_exponent(currency)
    except AiVideoWorkflowError as exc:
        raise CostBoundaryError(str(exc)) from exc

    try:
        amount = Decimal(str(observation.amount))
        minor = (amount * (10**exponent)).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError) as exc:
        raise CostBoundaryError(f"cannot convert cost {observation.amount!r}") from exc

    cost_minor_units = int(minor)
    if cost_minor_units < 0:
        raise CostBoundaryError("converted cost is negative")

    return AuthoritativeCost(
        cost_minor_units=cost_minor_units,
        currency=currency,
        billing_source=FLOAT_BOUNDARY,
        observed_amount=observation.amount,
        observed_unit=observation.unit,
    )
