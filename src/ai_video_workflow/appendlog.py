"""Shared hardened append-only JSON Lines log primitives.

Extracted from the evaluation-domain log (ADR-0034 / TASK-028), whose write and
read paths were hardened over many independent review rounds. New append-only
fact logs (e.g. the feedback/action log, ADR-0035 / TASK-029) reuse these
primitives instead of re-deriving the same security-critical file handling.

Guarantees, per caller-supplied relative path under a project root:
- **Containment, no symlink**: the path is walked component-by-component through
  ``O_NOFOLLOW`` directory descriptors, so a directory or the final file swapped
  for a symlink pointing outside the root cannot be traversed (closes the TOCTOU
  window a post-open re-check would miss after ``O_CREAT``).
- **Private regular file only**: a FIFO/device/socket (``O_NONBLOCK`` + ``S_ISREG``)
  or a hard-linked file (``st_nlink != 1``) is refused fail-closed.
- **Atomic append**: an exclusive advisory ``flock`` makes the torn-tail guard +
  write + fsync one critical section; a torn final line (no trailing newline)
  blocks further appends; a short write loops so the tail is never dropped.

The caller owns JSON encoding/decoding and dedup; this module only moves bytes.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

from ai_video_workflow._fslock import flock_exclusive
from ai_video_workflow.errors import AiVideoWorkflowError

# Native Windows lacks O_NOFOLLOW/O_DIRECTORY/dir_fd/os.pread/os.fchmod and
# fcntl. On Windows the opener falls back to the pathlib containment resolver
# (resolve_within_root, per-component symlink rejection + root containment) plus
# a regular-file guard. The residual symlink-TOCTOU window POSIX closes with
# O_NOFOLLOW is accepted on Windows because creating a symlink there requires
# elevation/Developer Mode (single-user local model) — ADR-0049.
_WINDOWS = sys.platform == "win32"


def append_line(
    project_root: Path, parts: tuple[str, ...], line: bytes, error_cls: type
) -> None:
    """Atomically append one newline-terminated ``line`` to ``root/*parts``.

    ``line`` must already end in ``b"\\n"``. ``error_cls`` (an
    :class:`AiVideoWorkflowError` subclass) is raised on any IO/containment
    failure, including a pre-existing torn final line.
    """
    fd = _open_append_contained(project_root, parts, error_cls)
    try:
        flock_exclusive(fd)
        size = os.fstat(fd).st_size
        if size > 0 and _read_at(fd, size - 1, 1) != b"\n":
            raise error_cls("log has a torn final line; refusing to append")
        view = memoryview(line)
        written = 0
        while written < len(view):
            n = os.write(fd, view[written:])
            if n == 0:
                raise error_cls("short write to log")
            written += n
        os.fsync(fd)
    finally:
        os.close(fd)


def read_text(
    project_root: Path, parts: tuple[str, ...], error_cls: type
) -> str | None:
    """Read ``root/*parts`` as UTF-8 text, or ``None`` if it does not exist.

    Raises ``error_cls`` on a symlinked component or unreadable path, and a
    ``UnicodeError``-wrapped ``error_cls`` on invalid UTF-8.
    """
    fd = _open_read_contained(project_root, parts, error_cls)
    if fd is None:
        return None
    try:
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read()
    except OSError as exc:
        raise error_cls("unable to read log") from exc
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeError as exc:
        raise error_cls("log is not valid UTF-8") from exc


def resolve_log_path(project_root: Path, parts: tuple[str, ...]) -> Path:
    """Return the log path, admitted through the ADR-0004 containment resolver."""
    from ai_video_workflow.security import resolve_within_root

    return resolve_within_root(project_root, Path(*parts))


def _read_at(fd: int, offset: int, n: int) -> bytes:
    """Read ``n`` bytes at ``offset`` — ``os.pread`` on POSIX, a locked
    lseek+read on Windows (no ``os.pread`` there; we hold the exclusive lock and
    O_APPEND writes ignore the file position, so moving it is safe)."""
    if not _WINDOWS:
        return os.pread(fd, n, offset)
    pos = os.lseek(fd, 0, os.SEEK_CUR)
    try:
        os.lseek(fd, offset, os.SEEK_SET)
        return os.read(fd, n)
    finally:
        os.lseek(fd, pos, os.SEEK_SET)


def _contained_target(root: Path, parts: tuple[str, ...], error_cls: type) -> Path:
    """Windows containment: the pathlib resolver rejects an absolute/``..``/
    symlinked-component/escaping path, returning the un-resolved join."""
    from ai_video_workflow.security import PathEscapeError, resolve_within_root

    try:
        return resolve_within_root(root, Path(*parts))
    except PathEscapeError as exc:
        raise error_cls(
            f"refusing to open the log (uncontained path under {root})"
        ) from exc


def _open_append_windows(root: Path, parts: tuple[str, ...], error_cls: type) -> int:
    target = _contained_target(root, parts, error_cls)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():  # resolver already rejected existing symlinks
            raise error_cls("refusing to open the log (symlinked path)")
        fd = os.open(target, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o600)
    except OSError as exc:
        raise error_cls(
            f"refusing to open the log (unopenable path under {root})"
        ) from exc
    _require_regular_file_windows(fd, error_cls)
    return fd


def _open_read_windows(
    root: Path, parts: tuple[str, ...], error_cls: type
) -> int | None:
    target = _contained_target(root, parts, error_cls)
    if not target.exists():
        return None
    try:
        if target.is_symlink():
            raise error_cls("refusing to read the log (symlinked path)")
        fd = os.open(target, os.O_RDONLY)
    except OSError as exc:
        raise error_cls(
            f"refusing to read the log (unopenable path under {root})"
        ) from exc
    _require_regular_file_windows(fd, error_cls)
    return fd


def _require_regular_file_windows(fd: int, error_cls: type) -> None:
    """Windows regular-file guard: S_ISREG only (``st_nlink`` is unreliable and
    ``os.fchmod`` is unavailable on Windows — see ADR-0049)."""
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise error_cls("log path is not a regular file")


def _open_append_contained(root: Path, parts: tuple[str, ...], error_cls: type) -> int:
    if _WINDOWS:
        return _open_append_windows(root, parts, error_cls)
    try:
        dir_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                # 0o700: per-user private. Fact-log content (e.g. feedback) can
                # be sensitive, so it is never world/group readable regardless
                # of umask.
                try:
                    os.mkdir(part, 0o700, dir_fd=dir_fd)
                except FileExistsError:
                    pass
                next_fd = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=dir_fd,
                )
                os.close(dir_fd)
                dir_fd = next_fd
            file_fd = os.open(
                parts[-1],
                os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                0o600,  # per-user private (see the 0o700 note above)
                dir_fd=dir_fd,
            )
            _require_private_regular_file(file_fd, error_cls)
            return file_fd
        finally:
            os.close(dir_fd)
    except OSError as exc:
        raise error_cls(
            f"refusing to open the log (symlinked component or unopenable "
            f"path under {root})"
        ) from exc


def _open_read_contained(
    root: Path, parts: tuple[str, ...], error_cls: type
) -> int | None:
    if _WINDOWS:
        return _open_read_windows(root, parts, error_cls)
    try:
        dir_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                try:
                    next_fd = os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=dir_fd,
                    )
                except FileNotFoundError:
                    return None
                os.close(dir_fd)
                dir_fd = next_fd
            try:
                file_fd = os.open(
                    parts[-1],
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=dir_fd,
                )
            except FileNotFoundError:
                return None
            _require_private_regular_file(file_fd, error_cls)
            return file_fd
        finally:
            os.close(dir_fd)
    except OSError as exc:
        raise error_cls(
            f"refusing to read the log (symlinked component or unopenable "
            f"path under {root})"
        ) from exc


def _require_private_regular_file(fd: int, error_cls: type) -> None:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise error_cls(
            "log path is not a private regular file "
            "(non-regular, or hard-linked elsewhere)"
        )
    # Enforce the private-log guarantee on an EXISTING file too: a pre-existing
    # world/group-accessible log (e.g. created before this rule, or under a
    # loose umask) is tightened to owner-only 0o600 on open, so fact-log content
    # is never left readable by other local users. We own the file (single-user
    # model), so fchmod succeeds regardless of the open mode.
    if stat.S_IMODE(info.st_mode) & 0o077:
        os.fchmod(fd, 0o600)


def split_complete_lines(text: str) -> list[str]:
    """Return the complete lines of ``text``, dropping one tolerated torn tail.

    A trailing newline yields a final empty segment (a fully written log); any
    non-empty final segment is the tolerated torn tail and is dropped.
    """
    segments = text.split("\n")
    segments.pop()
    return segments


# Re-exported for callers that want to isinstance-check the base.
_BASE = AiVideoWorkflowError
