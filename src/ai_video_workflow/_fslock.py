"""Cross-platform exclusive advisory file lock (ADR-0049).

The project's advisory locks (append-log critical section, account budget lock,
Command Gateway command lock) were written for POSIX ``fcntl.flock``. The
``fcntl`` module does not exist on native Windows, so importing it at module top
took the whole importer down. This shim provides ``flock_exclusive`` /
``flock_unlock`` over an OS file descriptor, using ``fcntl.flock`` on POSIX and
``msvcrt.locking`` on Windows, importing the platform module LAZILY so the wrong
one is never imported.

Semantics preserved on both platforms:
- an exclusive lock excludes other holders of the same file (mutual exclusion);
- the lock is released explicitly by ``flock_unlock`` and also implicitly when
  the descriptor is closed (both platforms), which the append-log path relies on.

Windows notes: ``msvcrt.locking`` locks a byte range from the current file
position, so we lock one byte at offset 0 (a fixed range every holder agrees on)
and restore the position; ``LK_LOCK`` blocks with a bounded retry (~10s) then
raises ``OSError`` under contention, which for this single-user local tool is an
acceptable, visible failure rather than a silent deadlock.
"""

from __future__ import annotations

import os
import sys

_WINDOWS = sys.platform == "win32"


def flock_exclusive(fd: int) -> None:
    """Take an exclusive advisory lock over the whole file behind ``fd``."""
    if _WINDOWS:
        import msvcrt  # noqa: PLC0415 - lazy, Windows-only

        pos = os.lseek(fd, 0, os.SEEK_CUR)
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        finally:
            os.lseek(fd, pos, os.SEEK_SET)
    else:
        import fcntl  # noqa: PLC0415 - lazy, POSIX-only

        fcntl.flock(fd, fcntl.LOCK_EX)


def flock_unlock(fd: int) -> None:
    """Release the advisory lock held over ``fd`` (no-op if already released)."""
    if _WINDOWS:
        import msvcrt  # noqa: PLC0415 - lazy, Windows-only

        pos = os.lseek(fd, 0, os.SEEK_CUR)
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass  # not locked / already released — closing the fd also releases
        finally:
            os.lseek(fd, pos, os.SEEK_SET)
    else:
        import fcntl  # noqa: PLC0415 - lazy, POSIX-only

        fcntl.flock(fd, fcntl.LOCK_UN)
