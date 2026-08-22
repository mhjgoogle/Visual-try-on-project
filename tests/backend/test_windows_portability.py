"""Cross-platform primitives for native-Windows support (ADR-0049 / TASK-049).

The Windows opener branch in ``appendlog`` uses only cross-platform calls
(``resolve_within_root`` + plain ``os.open`` + ``lseek``/``read``), so we can
exercise it on the Linux CI runner by flipping the module's ``_WINDOWS`` flag —
that is how these branches get real coverage off Windows.
"""

from __future__ import annotations

import os

import pytest

from ai_video_workflow import appendlog
from ai_video_workflow._fslock import flock_exclusive, flock_unlock
from ai_video_workflow.errors import AiVideoWorkflowError


class _LogError(AiVideoWorkflowError):
    pass


_PARTS = ("evaluation", "events", "log.jsonl")


def test_lock_shim_roundtrip_on_this_platform(tmp_path):
    """The shim acquires and releases an exclusive lock without error on the
    current platform (POSIX fcntl / Windows msvcrt)."""
    fd = os.open(tmp_path / "x.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        flock_exclusive(fd)
        flock_unlock(fd)
        flock_exclusive(fd)  # re-acquire after release
    finally:
        os.close(fd)  # also releases on both platforms


@pytest.fixture()
def _force_windows(monkeypatch):
    monkeypatch.setattr(appendlog, "_WINDOWS", True)


def test_windows_branch_append_read_roundtrip(tmp_path, _force_windows):
    appendlog.append_line(tmp_path, _PARTS, b'{"a":1}\n', _LogError)
    appendlog.append_line(tmp_path, _PARTS, b'{"b":2}\n', _LogError)
    text = appendlog.read_text(tmp_path, _PARTS, _LogError)
    assert appendlog.split_complete_lines(text) == ['{"a":1}', '{"b":2}']


def test_windows_branch_missing_reads_none(tmp_path, _force_windows):
    assert appendlog.read_text(tmp_path, _PARTS, _LogError) is None


def test_windows_branch_torn_tail_refused(tmp_path, _force_windows):
    target = tmp_path / "evaluation" / "events" / "log.jsonl"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"no trailing newline")  # a torn final line
    with pytest.raises(_LogError):
        appendlog.append_line(tmp_path, _PARTS, b'{"c":3}\n', _LogError)


def test_windows_branch_rejects_path_escape(tmp_path, _force_windows):
    with pytest.raises(_LogError):
        appendlog.append_line(tmp_path, ("..", "escape.jsonl"), b"x\n", _LogError)


def test_windows_branch_rejects_symlinked_component(tmp_path, _force_windows):
    # a symlinked directory component below the root must be refused
    outside = tmp_path / "outside"
    outside.mkdir()
    link_parent = tmp_path / "evaluation"
    try:
        (tmp_path / "evaluation").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted on this host")
    assert link_parent.is_symlink()
    with pytest.raises(_LogError):
        appendlog.append_line(tmp_path, _PARTS, b"x\n", _LogError)
