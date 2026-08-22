"""Strict JSON parsing primitives shared by the config loaders (TASK-B1).

Every helper is parametrised by the concrete ``ConfigError`` subclass to
raise, so the catalog and project-config loaders share one strict,
closed-key parsing discipline while still reporting their own typed
error. ``bool`` is never accepted where an ``int`` is required, ``float``
is never accepted for money or rates, and unknown keys are always
rejected (which is what keeps API endpoints and credential *values* out
of the catalog).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import TypeVar

from ai_video_workflow.config.errors import ConfigError

_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")

ErrorT = TypeVar("ErrorT", bound=ConfigError)


def require_mapping(value: object, ctx: str, error: type[ErrorT]) -> dict:
    if not isinstance(value, dict):
        raise error(f"{ctx}: expected a JSON object, got {type(value).__name__}")
    return value


def require_exact_keys(
    mapping: Mapping, allowed: frozenset[str], ctx: str, error: type[ErrorT]
) -> None:
    actual = frozenset(mapping)
    missing = allowed - actual
    if missing:
        raise error(f"{ctx}: missing keys {sorted(missing)}")
    unknown = actual - allowed
    if unknown:
        raise error(f"{ctx}: unknown keys {sorted(unknown)}")


def require_str(value: object, ctx: str, error: type[ErrorT]) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise error(f"{ctx}: expected a non-empty, trimmed string")
    return value


def require_int(
    value: object, ctx: str, error: type[ErrorT], *, minimum: int | None = None
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise error(f"{ctx}: expected an int (no bool, no float)")
    if minimum is not None and value < minimum:
        raise error(f"{ctx}: must be >= {minimum}")
    return value


def require_currency(value: object, ctx: str, error: type[ErrorT]) -> str:
    if not isinstance(value, str) or _CURRENCY_RE.match(value) is None:
        raise error(f"{ctx}: expected an ISO-4217 code (three uppercase letters)")
    return value


def require_str_tuple(
    value: object, ctx: str, error: type[ErrorT], *, allow_empty: bool = True
) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise error(f"{ctx}: expected a JSON array")
    if not allow_empty and not value:
        raise error(f"{ctx}: must not be empty")
    items = tuple(require_str(item, f"{ctx}[]", error) for item in value)
    if len(set(items)) != len(items):
        raise error(f"{ctx}: duplicate entries are not allowed")
    return items


def require_keys(
    mapping: Mapping,
    required: frozenset[str],
    optional: frozenset[str],
    ctx: str,
    error: type[ErrorT],
) -> None:
    """Closed-key validation that admits a declared set of OPTIONAL keys.

    ``require_exact_keys`` above is the right default and stays the default: an
    unknown key in a config file is almost always a typo, and silently ignoring
    it is how a mis-spelled price sits in a catalog doing nothing.

    ADR-0071 决策 4 needs one genuinely optional key (``reference_images`` on a
    model), because an existing catalog that predates it must keep loading. It is
    optional in the FILE only — a missing declaration is not a missing rule: the
    parser substitutes the fail-closed default (``max: 0``), so an un-declared
    model carries no reference images rather than an unknown capability.
    """
    actual = frozenset(mapping)
    missing = required - actual
    if missing:
        raise error(f"{ctx}: missing keys {sorted(missing)}")
    unknown = actual - required - optional
    if unknown:
        raise error(f"{ctx}: unknown keys {sorted(unknown)}")


def require_bool(value: object, ctx: str, error: type[ErrorT]) -> bool:
    """A real JSON boolean. ``1`` / ``"true"`` are refused rather than coerced.

    Coercion is how a capability flag ends up ON because somebody typed a string:
    ``addressable`` decides whether a prompt may name the Nth image, so guessing
    it wrong sends an un-resolvable ordinal to a paid model.
    """
    if not isinstance(value, bool):
        raise error(f"{ctx}: expected a JSON boolean")
    return value
