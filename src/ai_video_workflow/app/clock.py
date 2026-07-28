"""The application-layer clock (TASK-007).

The core library never reads the clock; the application layer is the one
place that does. All timestamps flow explicitly from here into the core
APIs.
"""

from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)
