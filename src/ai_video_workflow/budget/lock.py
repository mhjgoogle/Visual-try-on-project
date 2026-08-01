"""Account-level advisory budget lock (TASK-015/016 correction).

Serializes the whole "read spend + reserve" critical section across
projects so two concurrent paid submissions cannot both pass the
pre-flight budget check and then both reserve (a check-then-act
overspend). Uses an ``fcntl`` exclusive file lock on the account root;
the project is Linux/WSL2-only, so ``fcntl`` is always available.
"""

from __future__ import annotations

import fcntl
from contextlib import contextmanager
from pathlib import Path

LOCK_FILENAME = ".wfm1-budget.lock"


@contextmanager
def account_budget_lock(account_root: Path):
    """Hold an exclusive lock over ``account_root`` for the critical section."""
    account_root.mkdir(parents=True, exist_ok=True)
    lock_path = account_root / LOCK_FILENAME
    handle = open(lock_path, "w")  # noqa: SIM115 - released in finally
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
