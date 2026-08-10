"""Account-level advisory budget lock (TASK-015/016 correction).

Serializes the whole "read spend + reserve" critical section across
projects so two concurrent paid submissions cannot both pass the
pre-flight budget check and then both reserve (a check-then-act
overspend). Uses an exclusive advisory file lock on the account root via
the cross-platform :mod:`ai_video_workflow._fslock` shim (POSIX
``fcntl.flock`` / Windows ``msvcrt.locking``; ADR-0049).
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from ai_video_workflow._fslock import flock_exclusive, flock_unlock

LOCK_FILENAME = ".wfm1-budget.lock"


@contextmanager
def account_budget_lock(account_root: Path):
    """Hold an exclusive lock over ``account_root`` for the critical section."""
    account_root.mkdir(parents=True, exist_ok=True)
    lock_path = account_root / LOCK_FILENAME
    handle = open(lock_path, "w")  # noqa: SIM115 - released in finally
    try:
        flock_exclusive(handle.fileno())
        yield
    finally:
        try:
            flock_unlock(handle.fileno())
        finally:
            handle.close()
