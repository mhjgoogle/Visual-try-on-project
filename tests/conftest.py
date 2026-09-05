"""Test-suite pytest configuration.

Two process-wide things, both set before any test module is imported.

**1. tmpfs for ``tmp_path``.** Routes pytest's ``tmp_path`` tree onto a
RAM-backed tmpfs when one is available (WSL2 exposes ``/dev/shm``). The core
library fsyncs on every persist for crash safety; on the WSL2 virtual disk each
fsync costs ~85 ms, and the fixture-heavy end-to-end suites do hundreds per test
(one episode ≈ 28 s of pure fsync wait). tmpfs fsync is ~0.01 ms, so the same
episode builds in ~1.3 s. Tests need no real durability, so this changes nothing
under test — only where the throwaway bytes land.

Implemented via ``config.option.basetemp`` in ``pytest_configure`` (the
programmatic equivalent of ``--basetemp``); setting ``TMPDIR`` does NOT work
because pytest resolves its temp root independently of that env var. No-op when
the user passes ``--basetemp`` explicitly, or off any platform without a
writable tmpfs (CI, macOS), so it never breaks a non-WSL2 run.

**2. A throwaway application-data directory.** TASK-056 moved the studio
backend's account-level registries (``projects.json``, ``runs.json``) out of the
repository and into ``%LOCALAPPDATA%\\motv`` / ``$XDG_DATA_HOME/motv``. That is
the developer's REAL directory, and the suite creates projects and runs by the
hundred — the first run without this guard wrote five pytest ``tmp_path``
projects into the live registry.

``MOTV_APP_DATA_DIR`` is read by ``server.resolve_app_data_dir()`` at import
time, and the studio tests import ``server.py`` freshly per test via
``spec_from_file_location``, so an env var set here reaches every one of them —
including tests written later that never think about this. It is a SAFETY NET,
not isolation: a test that asserts on registry contents still points
``server.APP_DATA_DIR`` at its own ``tmp_path``, because this directory is
shared by every test in the worker.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path


def _is_wsl2() -> bool:
    """这个优化**只给 WSL2**，判据是内核字符串，不是「有没有 tmpfs」。

    原来的判据是「`/dev/shm` 可写就用它」，注释里写着「CI 上没有可写 tmpfs，
    所以是 no-op」——**那句话是错的**：GitHub 的 ubuntu runner 有可写 `/dev/shm`。
    于是 CI 上每个 `tmp_path` 都落进 `/dev/shm/…`，而 `rootadmit` 的保护清单里有
    `/dev`（产品规则：用户资产不许放进系统目录）——**测试自己的临时目录被产品自己的
    安全规则拒了**，Ubuntu job 因此 82 failed + 14 errors，从 8/24 起连红九天
    （TASK-140 取证：日志里逐条都是「这是受保护的系统或仓库目录…：/dev」）。

    本地（Windows）永远看不到，因为这段在非 POSIX 上本来就不生效。
    """
    try:
        return "microsoft" in Path("/proc/sys/kernel/osrelease").read_text().lower()
    except OSError:
        return False


def _tmpfs_basetemp(config) -> None:
    if getattr(config.option, "basetemp", None):
        return  # respect an explicit --basetemp
    if not _is_wsl2():
        return  # 只有 WSL2 需要它；别处（CI / 原生 Linux）用 pytest 的默认根
    shm = Path("/dev/shm")
    if not (shm.is_dir() and os.access(shm, os.W_OK)):
        return  # no tmpfs here — keep pytest's default temp root
    base = shm / "vtp-pytest"
    try:
        base.mkdir(exist_ok=True)
    except OSError:
        return  # tmpfs became unwritable — fall back to the default
    config.option.basetemp = str(base)


#: The throwaway directory this process created, removed again on exit.
_APP_DATA_TMP: str | None = None


def _throwaway_app_data_dir() -> None:
    """Point `MOTV_APP_DATA_DIR` at a fresh directory this run owns. Always.

    Three properties, each of which was wrong in the first version and each of
    which fails the same way — silently, onto the developer's REAL registries:

    * **Unconditional.** An operator who has legitimately relocated their app
      data (that is what the variable is FOR) would otherwise have the suite
      run against their live `projects.json` and `runs.json`. Under pytest
      there is no such thing as a real app data directory.
    * **Fail-closed.** If the directory cannot be made, the variable must NOT
      be left unset — unset means "use the platform default", i.e. exactly the
      live location this guard exists to avoid. Failing here fails the whole
      session instead.
    * **Fresh per run and per worker.** `mkdtemp` gives a unique name, so a
      registry left by an earlier run cannot leak into this one, and eight
      xdist workers cannot share one registry file — a project name another
      worker already created comes back as 409 "exists", which is how the
      missing guard first showed up.
    """
    global _APP_DATA_TMP
    # `pytest_configure` runs in the controller AND in every xdist worker, so
    # each gets its own; the prefix makes an abandoned one obvious in %TEMP%.
    _APP_DATA_TMP = tempfile.mkdtemp(prefix="motv-pytest-app-data-")
    os.environ["MOTV_APP_DATA_DIR"] = _APP_DATA_TMP


def pytest_configure(config) -> None:
    _tmpfs_basetemp(config)
    _throwaway_app_data_dir()


def pytest_unconfigure(config) -> None:
    global _APP_DATA_TMP
    if _APP_DATA_TMP:
        shutil.rmtree(_APP_DATA_TMP, ignore_errors=True)
        _APP_DATA_TMP = None
