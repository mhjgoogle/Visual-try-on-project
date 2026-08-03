"""Append-only evaluation-domain fact log writer and strict reader (ADR-0034).

The log is a single JSON Lines file, ``evaluation/events/log.jsonl``, relative
to the project data root (authorized in ADR-0001). Writes are strictly
append-only (``O_APPEND`` + flush + fsync); a torn final line blocks further
appends. The reader strictly parses every complete line, tolerates exactly one
torn final fragment, and never rewrites, patches, or truncates the log.
Duplicate ``record_id`` lines may exist on disk (replay); the reader
de-duplicates first-wins so every consumer sees each record once, in first-seen
order — mirroring the QCD event log (ADR-0003 §5).

This module is the domain's single writer. Comparisons, rankings and
incremental cost/time are NOT stored here; they are derived read-only in the
ADR-0031 query layer from these facts plus authoritative cost/run/lineage
facts (ADR-0034).
"""

from __future__ import annotations

import fcntl
import json
import os
import stat
from pathlib import Path

from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.evaluation.records import EvaluationRecord, record_from_envelope
from ai_video_workflow.security import resolve_within_root

_LOG_RELATIVE = ("evaluation", "events", "log.jsonl")


class EvaluationLogError(AiVideoWorkflowError):
    """Base error for evaluation-log IO and integrity failures."""


class CorruptEvaluationLogError(EvaluationLogError):
    """Raised when a complete log line cannot be strictly parsed."""


def log_path(project_root: Path) -> Path:
    """Return the append-only evaluation log path for a project root.

    Admitted through the ADR-0004 containment resolver: a symlinked
    ``evaluation/`` or ``evaluation/events/`` component (which would write the
    log outside the project root) is refused.
    """
    return resolve_within_root(project_root, Path(*_LOG_RELATIVE))


def append_record(project_root: Path, record: EvaluationRecord) -> None:
    """Atomically append one record line (O_APPEND + flush + fsync).

    Refuses to append when the existing file is non-empty and does not end
    with a newline (a torn final line): appending there would turn the torn
    fragment into a corrupt middle line.
    """
    if not isinstance(record, EvaluationRecord):
        raise EvaluationLogError(
            f"record: expected EvaluationRecord, got {type(record).__name__}"
        )
    line = (
        json.dumps(
            record.to_envelope(),
            ensure_ascii=False,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    fd = _open_append_contained(project_root, _LOG_RELATIVE)
    try:
        # The domain has a single writer by design (ADR-0034); an exclusive
        # advisory lock additionally makes the torn-tail check + write + fsync
        # one critical section w.r.t. any other flock-using appender, so even
        # under accidental concurrency a partial write can never interleave
        # into a corrupt middle line. Released when the fd is closed.
        fcntl.flock(fd, fcntl.LOCK_EX)
        # Torn-tail guard on the SAME contained descriptor (no separate,
        # racy resolve+read): if the existing file is non-empty and does not
        # end with a newline, appending would turn the torn fragment into a
        # corrupt middle line, so refuse.
        size = os.fstat(fd).st_size
        if size > 0 and os.pread(fd, 1, size - 1) != b"\n":
            raise CorruptEvaluationLogError(
                "evaluation log has a torn final line; refusing to append"
            )
        # Write the whole line, looping over short writes: a partial write
        # (disk full / interrupted) must never silently drop the tail, which
        # would corrupt the log as a torn line. fsync only once it is all on
        # disk; a genuinely unfinishable write leaves a torn tail that the
        # torn-tail guard then blocks (fail-closed), never a lost middle line.
        view = memoryview(line)
        written = 0
        while written < len(view):
            n = os.write(fd, view[written:])
            if n == 0:
                raise EvaluationLogError("short write to evaluation log")
            written += n
        os.fsync(fd)
    finally:
        os.close(fd)


def _open_append_contained(root: Path, parts: tuple[str, ...]) -> int:
    """Open ``root/*parts`` read-write for append, creating dirs, no symlink.

    Walks the path component by component through directory descriptors, each
    opened ``O_NOFOLLOW`` — so a directory (or the final file) swapped for a
    symlink pointing outside ``root`` cannot be traversed. This closes the
    TOCTOU window that a post-open containment re-check would only detect
    *after* ``O_CREAT`` had already created a file outside the root. Opened
    ``O_RDWR`` so the torn-tail guard can pread the last byte on this same fd.
    """
    try:
        dir_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                try:
                    os.mkdir(part, 0o755, dir_fd=dir_fd)
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
                0o644,
                dir_fd=dir_fd,
            )
            _require_private_regular_file(file_fd)
            return file_fd
        finally:
            os.close(dir_fd)
    except OSError as exc:
        raise EvaluationLogError(
            f"refusing to open the evaluation log (symlinked component "
            f"or unopenable path under {root})"
        ) from exc


def _require_private_regular_file(fd: int) -> None:
    """Refuse a final path that is not a private regular file.

    ``O_NOFOLLOW`` stops symlinks but not: a FIFO/device/socket (whose peer
    could leak the record or block the open — hence ``O_NONBLOCK`` so the FIFO
    open returns before this check), nor a hard link to a file outside the
    project root (containment bypass). A legitimate log has exactly one link;
    ``st_nlink != 1`` means it is hard-linked elsewhere, so refuse fail-closed.
    """
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise EvaluationLogError(
            "evaluation log path is not a private regular file "
            "(non-regular, or hard-linked elsewhere)"
        )


def _open_read_contained(root: Path, parts: tuple[str, ...]) -> int | None:
    """Open ``root/*parts`` read-only for reading, refusing any symlink.

    Walks components through ``O_NOFOLLOW`` directory descriptors so a
    concurrently-swapped symlink component cannot redirect the read outside
    ``root`` (the read counterpart of :func:`_open_append_contained`). Returns
    ``None`` when the log (or a parent) simply does not exist yet; a symlinked
    component or any other open failure raises.
    """
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
            _require_private_regular_file(file_fd)
            return file_fd
        finally:
            os.close(dir_fd)
    except OSError as exc:
        raise EvaluationLogError(
            f"refusing to read the evaluation log (symlinked component "
            f"or unopenable path under {root})"
        ) from exc


def read_records(project_root: Path) -> tuple[EvaluationRecord, ...]:
    """Strictly read every complete record line, de-duplicated first-wins.

    A missing log is an empty tuple. A corrupt middle line raises
    ``CorruptEvaluationLogError`` with its 1-based line number. A single torn
    final fragment (no trailing newline) is ignored, and nothing else. Every
    complete line is parsed (so a corrupt duplicate still raises), but only the
    first record per ``record_id`` is returned, in first-seen order.
    """
    fd = _open_read_contained(project_root, _LOG_RELATIVE)
    if fd is None:
        return ()
    try:
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read()
    except OSError as exc:
        raise EvaluationLogError("unable to read evaluation log") from exc
    if not raw:
        return ()
    try:
        text = raw.decode("utf-8")
    except UnicodeError as exc:
        raise CorruptEvaluationLogError("evaluation log is not valid UTF-8") from exc
    segments = text.split("\n")
    # A trailing newline yields a final empty segment (a fully written log);
    # any non-empty final segment is the tolerated torn tail and is dropped.
    segments.pop()
    records: list[EvaluationRecord] = []
    seen: set[str] = set()
    for index, segment in enumerate(segments, start=1):
        record = _parse_line(segment, index)
        if record.record_id in seen:
            continue
        seen.add(record.record_id)
        records.append(record)
    return tuple(records)


def _parse_line(segment: str, line_number: int) -> EvaluationRecord:
    try:
        obj = json.loads(segment)
    except json.JSONDecodeError as exc:
        raise CorruptEvaluationLogError(
            f"evaluation log line {line_number}: invalid JSON"
        ) from exc
    try:
        return record_from_envelope(obj)
    except AiVideoWorkflowError as exc:
        raise CorruptEvaluationLogError(
            f"evaluation log line {line_number}: {exc}"
        ) from exc
