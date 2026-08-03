"""Repo-root pytest configuration.

Routes pytest's ``tmp_path`` tree onto a RAM-backed tmpfs when one is available
(WSL2 exposes ``/dev/shm``). The core library fsyncs on every persist for
crash safety; on the WSL2 virtual disk each fsync costs ~85 ms, and the
fixture-heavy end-to-end suites do hundreds per test (one episode ≈ 28 s of
pure fsync wait). tmpfs fsync is ~0.01 ms, so the same episode builds in ~1.3 s.
Tests need no real durability, so this changes nothing under test — only where
the throwaway bytes land.

Implemented via ``config.option.basetemp`` in ``pytest_configure`` (the
programmatic equivalent of ``--basetemp``); setting ``TMPDIR`` does NOT work
because pytest resolves its temp root independently of that env var. No-op when
the user passes ``--basetemp`` explicitly, or off any platform without a
writable tmpfs (CI, macOS), so it never breaks a non-WSL2 run.
"""

from __future__ import annotations

import os
from pathlib import Path


def pytest_configure(config) -> None:
    if getattr(config.option, "basetemp", None):
        return  # respect an explicit --basetemp
    shm = Path("/dev/shm")
    if not (shm.is_dir() and os.access(shm, os.W_OK)):
        return  # no tmpfs here — keep pytest's default temp root
    base = shm / "vtp-pytest"
    try:
        base.mkdir(exist_ok=True)
    except OSError:
        return  # tmpfs became unwritable — fall back to the default
    config.option.basetemp = str(base)
