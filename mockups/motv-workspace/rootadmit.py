"""Asset-root admission for the motv prototype backend (ADR-0051).

The studio lets the creator pick WHERE a project's assets live, and the backend
then writes there. That moves the write boundary from "one root the operator
fixed at launch" to "several roots the page can name", so every candidate root
passes through this module first.

The rules (ADR-0051 §3) are deliberately blunt:

* absolute, and after ``realpath`` still a directory;
* judged AFTER ``realpath``, so a symlink or junction pointing into the
  repo or a system directory is refused like any other path, and the
  location we admit is the one the OS will really write to;
* not a filesystem/drive root, a system directory, this repository, its venv,
  or the bare home directory;
* actually writable, proven by creating and removing a probe directory rather
  than by reading permission bits (which lie on Windows ACLs and on NFS);
* and, for a root never used before, an explicit human confirmation.

Pure-ish: filesystem inspection only, no HTTP, no globals. Everything is a
plain function so the whole policy is unit-testable without a server.

Platform note (AGENTS.md §3): nothing here hardcodes a separator or a
platform path. The deny-list is BUILT at call time from the interpreter's own
notion of the system directories, so it is correct on the host it runs on.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "RootRejected",
    "AdmittedRoot",
    "denied_roots",
    "admit_root",
]


class RootRejected(Exception):
    """A candidate root violated the admission policy.

    ``code`` is a stable machine token the UI branches on; ``args[0]`` is the
    human explanation shown to the creator.
    """

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class AdmittedRoot:
    """A root that passed every check, with the resolved path to actually use."""

    declared: str
    resolved: Path
    created: bool


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        return Path(raw).resolve()
    except OSError:
        return None


def denied_roots(repo_root: Path | None = None) -> tuple[list[Path], list[Path]]:
    """The deny-list, as ``(trees, exact)``.

    ``trees``  — the directory AND everything under it is refused.
    ``exact``  — only the directory itself is refused; subdirectories are fine.

    Built from the running system rather than a hardcoded table, so it stays
    right on both native Windows and POSIX (ADR-0049 runs both).
    """
    trees: list[Path] = []
    exact: list[Path] = []

    def add(into: list[Path], p: Path | None) -> None:
        if p is None:
            return
        try:
            into.append(p.resolve())
        except OSError:
            into.append(p)

    # Windows system locations
    for var in (
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ):
        add(trees, _env_path(var))
    # POSIX system locations
    for name in (
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/boot",
        "/dev",
        "/proc",
        "/sys",
        "/var",
    ):
        p = Path(name)
        if p.exists():
            add(trees, p)
    # the repository and its virtualenv — generated media never goes anywhere
    # inside the repo (AGENTS.md §23), so this is a TREE denial
    if repo_root is not None:
        add(trees, repo_root)
    # the bare home directory: refused as a root itself, but ~/media is fine
    try:
        add(exact, Path.home())
    except (RuntimeError, OSError):
        pass
    return trees, exact


def _is_filesystem_root(p: Path) -> bool:
    """True for ``/``, ``C:\\`` and UNC shares' server/share root."""
    return p == p.parent


def _probe_writable(path: Path) -> None:
    """Prove writability by actually creating and removing something."""
    try:
        with tempfile.TemporaryDirectory(dir=str(path), prefix=".motv-probe-"):
            pass
    except OSError as exc:
        raise RootRejected("not_writable", f"这个位置不可写：{exc}") from exc


def admit_root(
    declared: str,
    *,
    repo_root: Path | None = None,
    confirmed_roots: set[str] | None = None,
    confirm: bool = False,
    create: bool = True,
) -> AdmittedRoot:
    """Validate (and optionally create) a candidate asset root.

    Raises ``RootRejected`` with a stable ``code``:
    ``empty`` / ``not_absolute`` / ``fs_root`` / ``denied`` / ``not_a_directory``
    / ``not_writable`` / ``unresolvable`` / ``missing``
    / ``root_unconfirmed``.
    """
    raw = (declared or "").strip()
    if not raw:
        raise RootRejected("empty", "请填写资产保存位置。")

    candidate = Path(raw)
    if not candidate.is_absolute():
        raise RootRejected(
            "not_absolute", "请填写绝对路径（例如 D:\\media 或 /home/me/media）。"
        )
    if ".." in candidate.parts:
        raise RootRejected("not_absolute", "路径不能包含 ..")

    # RESOLVE FIRST, then judge. Following ADR-0004 §4, a root that merely
    # lives under a symlink is not an escape (``/tmp`` is a symlink on macOS,
    # and Windows junctions are a normal way to organise drives). What matters
    # is that every later decision — deny-list, containment, what we SHOW the
    # creator — is made about the location the OS will actually write to.
    try:
        resolved = candidate.resolve()
    except OSError as exc:
        raise RootRejected("unresolvable", f"无法解析该路径：{exc}") from exc

    if _is_filesystem_root(resolved):
        raise RootRejected("fs_root", "不能直接用盘符根 / 文件系统根作为资产位置。")

    # The deny-list is applied to the RESOLVED path, so a symlink or junction
    # pointing into the repo or a system directory is refused just the same.
    trees, exact = denied_roots(repo_root)
    for d in exact:
        if resolved == d:
            raise RootRejected(
                "denied",
                f"不能直接用这个目录作为资产位置：{d}（它下面的子文件夹可以）。",
            )
    for d in trees:
        if resolved == d or d in resolved.parents:
            raise RootRejected(
                "denied", f"这是受保护的系统或仓库目录，不能作为资产位置：{d}"
            )

    existed = resolved.exists()
    if existed and not resolved.is_dir():
        raise RootRejected("not_a_directory", "这个位置不是一个文件夹。")
    if not existed and not create:
        raise RootRejected("missing", "这个位置不存在。")

    # CONFIRM BEFORE CREATING. Asking after mkdir would let an unconfirmed
    # request scatter directory trees around the filesystem just by being sent.
    known = confirmed_roots or set()
    if str(resolved) not in known and not confirm:
        raise RootRejected(
            "root_unconfirmed",
            f"这是一个新的项目保存位置：{resolved}。确认后，项目文件夹会创建在这里。",
        )

    if not existed:
        try:
            resolved.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise RootRejected("not_writable", f"无法创建这个位置：{exc}") from exc

    _probe_writable(resolved)
    return AdmittedRoot(declared=raw, resolved=resolved, created=not existed)
