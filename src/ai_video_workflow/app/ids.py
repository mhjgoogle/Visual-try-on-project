"""Application-layer identity generation (TASK-007).

The core library never generates randomness; the application layer
mints operation / attempt / rating identities here and passes them
explicitly into the core APIs.
"""

from __future__ import annotations

import uuid


def new_operation_id() -> str:
    """Return a fresh orchestration operation identity."""
    return f"op-{uuid.uuid4()}"


def new_attempt_id() -> str:
    """Return a fresh manual-attempt identity."""
    return f"attempt-{uuid.uuid4()}"


def new_rating_id() -> str:
    """Return a fresh manual-quality-rating identity."""
    return f"rating-{uuid.uuid4()}"
