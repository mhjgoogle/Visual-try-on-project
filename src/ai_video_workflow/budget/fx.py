"""Locked-FX currency conversion, integer yen, always rounded up (TASK-B3).

Converts an integer minor-unit amount in some source currency to the
project's base currency (yen for WFM1) using the FX table locked in the
project config. The whole computation is exact integer arithmetic — no
floating-point money — and the result is **rounded up** (ceil), so a
pre-flight estimate or a spend total never *under*-states cost.

An FX rate is expressed per whole (major) unit of the source currency
(e.g. ``{"USD": 160}`` for 1 USD = 160 JPY), so conversion also needs the
ISO-4217 minor-unit exponent of each currency. Only a small set of
currencies is known; an unknown currency (missing rate *or* missing
minor-unit exponent) fails **closed** with ``FxError`` rather than
guessing.
"""

from __future__ import annotations

from ai_video_workflow.budget.errors import FxError
from ai_video_workflow.config.project_config import FxConfig

# ISO-4217 minor-unit exponents for the currencies WFM1 may meet. Fail
# closed on anything else instead of assuming a default.
_MINOR_UNIT_EXPONENT = {
    "JPY": 0,
    "KRW": 0,
    "USD": 2,
    "EUR": 2,
    "GBP": 2,
    "CNY": 2,
    "AUD": 2,
    "CAD": 2,
    "SGD": 2,
    "HKD": 2,
}


def minor_unit_exponent(currency: str) -> int:
    """Return the ISO-4217 minor-unit exponent, or fail closed."""
    try:
        return _MINOR_UNIT_EXPONENT[currency]
    except KeyError as exc:
        raise FxError(f"unknown minor-unit exponent for currency {currency!r}") from exc


def convert_to_base_minor(fx: FxConfig, amount_minor: int, currency: str) -> int:
    """Convert ``amount_minor`` in ``currency`` to base-currency minor units.

    The result is rounded up. Same-currency amounts pass through
    unchanged; a foreign currency with no locked rate raises ``FxError``.
    """
    if isinstance(amount_minor, bool) or not isinstance(amount_minor, int):
        raise FxError("amount_minor: expected a non-negative int")
    if amount_minor < 0:
        raise FxError("amount_minor: must not be negative")
    if not isinstance(currency, str) or not currency:
        raise FxError("currency: expected a non-empty string")

    if currency == fx.base_currency:
        return amount_minor

    rate = fx.rates.get(currency)
    if rate is None:
        raise FxError(f"no locked FX rate for currency {currency!r}")

    exp_source = minor_unit_exponent(currency)
    exp_base = minor_unit_exponent(fx.base_currency)
    numerator = amount_minor * rate * (10**exp_base)
    denominator = 10**exp_source
    # exact integer ceil division
    return (numerator + denominator - 1) // denominator
