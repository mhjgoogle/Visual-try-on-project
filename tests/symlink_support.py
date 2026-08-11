"""Shared helper for tests whose FIXTURE (not assertion) needs a real symlink.

Creating a symlink on Windows requires Developer Mode or an elevated shell;
without that privilege ``os.symlink`` raises ``OSError`` WinError 1314 before
the test under review runs at all. That is a host-capability gap, not a defect
in the code under test, so the test skips rather than reporting a failure.

ADR-0049 already accepts this reduced local guarantee for the native-Windows
target and names Windows CI the verification of record; the CI runner may
create symlinks, so every guard below still executes there and on Linux. A
developer who wants the real coverage locally enables Developer Mode
(Settings -> System -> For developers).

Only fixture construction is guarded. A symlink the code under test is
expected to REFUSE is still asserted normally once the fixture exists.
"""

from __future__ import annotations

import errno
import os
import subprocess
from pathlib import Path

import pytest

SKIP_REASON = (
    "symlink creation not permitted on this host "
    "(Windows needs Developer Mode or elevation) - ADR-0049"
)

# ONLY a missing capability may skip. Anything else -- a missing parent
# directory (ENOENT), an already-existing link (EEXIST), a genuine I/O error --
# means the fixture itself is broken, and turning that into a skip would
# silently drop a symlink security test on every platform.
_UNSUPPORTED_ERRNOS = frozenset({errno.EPERM, errno.EACCES, errno.ENOSYS})
_WINDOWS_PRIVILEGE_NOT_HELD = 1314  # ERROR_PRIVILEGE_NOT_HELD


def symlink_or_skip(
    link: Path,
    target: Path,
    *,
    target_is_directory: bool = False,
) -> Path:
    """Create ``link`` pointing at ``target``, or skip the test.

    Argument order follows :meth:`pathlib.Path.symlink_to` (link first), which
    is the reverse of :func:`os.symlink`.
    """
    try:
        Path(link).symlink_to(target, target_is_directory=target_is_directory)
    except NotImplementedError as exc:  # pragma: no cover - host dependent
        pytest.skip(f"{SKIP_REASON}: {exc}")
    except OSError as exc:  # pragma: no cover - host dependent
        unsupported = (
            getattr(exc, "winerror", None) == _WINDOWS_PRIVILEGE_NOT_HELD
            or exc.errno in _UNSUPPORTED_ERRNOS
        )
        if not unsupported:
            raise  # a broken fixture, not a missing capability
        pytest.skip(f"{SKIP_REASON}: {exc}")
    return Path(link)


def junction_or_skip(link: Path, target: Path) -> Path:
    """Create a Windows directory JUNCTION, or skip (non-Windows / failure).

    Junctions need NO elevation, so on the very platform ADR-0049 targets this
    actually runs where `symlink_or_skip` can only skip — which matters,
    because a skipped containment test proves nothing. Python reports a
    junction as ``is_symlink() == False`` while ``resolve()`` still follows it,
    so it is also the sharper test of a containment check.
    """
    if os.name != "nt":
        pytest.skip("junctions are Windows-only; the symlink variant covers POSIX")
    # NOT text=True: cmd writes its banner in the OEM codepage, and letting
    # subprocess decode it as UTF-8 raises inside its reader thread.
    res = subprocess.run(  # noqa: S603 - fixed argv, no shell interpolation
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
    )
    if res.returncode != 0:
        out = (res.stdout + res.stderr).decode("utf-8", "replace")
        pytest.skip(f"could not create a junction: {out}")
    return Path(link)
