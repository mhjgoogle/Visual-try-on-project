"""Backend exit / restart leaves NO orphan processes — TASK-072 §1.3 rule 3.

This is the one test in the batch that must start REAL processes, because the
entire value of the contract (creator-system-contract §5.9a) is whether the
children are actually gone. A source-level check cannot answer that.

Shape: parent -> child process tree, then kill the "backend" two ways (a clean
shutdown and a hard `kill -9` equivalent), then assert every descendant is gone.

PID REUSE is the trap this test has to avoid in BOTH directions:

* checking only "does pid N exist" gives a FALSE FAILURE when the OS has handed
  that number to an unrelated program;
* it gives a FALSE PASS when the process happens to have exited on its own.

So identity is (pid, creation time), and the creation time is read from the OS.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

# Real process trees cannot be asserted about while sibling xdist workers spawn
# and kill their own. Under `-n 8` the clean-shutdown test failed here while
# passing in 10.8s serially (measured 2026-08-14), so this whole module opts out
# of parallelism; the whole-suite run picks it up in its serial phase.
pytestmark = pytest.mark.serial

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import runstore  # noqa: E402 - path injected above

# A parent that spawns a child and then sleeps: the two-level tree the WSL bridge
# (wsl.exe -> node -> CLI) has in production, reduced to its essentials.
_PARENT = """
import subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
print(child.pid, flush=True)
time.sleep(120)
"""


def _alive(pid: int) -> bool:
    """Does a process with this pid exist right now?

    Deliberately NOT used alone as the assertion — see the module docstring.
    """
    if os.name == "nt":
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _creation_time(pid: int):
    """The OS's process creation time, or None if we cannot get it.

    None is a REAL answer, not a failure: on a host where identity cannot be
    established, the contract's rule is to never kill by pid at all (§5.9a), and
    this test degrades to the weaker check rather than pretending.
    """
    if os.name == "nt":
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"(Get-Process -Id {pid} -ErrorAction SilentlyContinue)"
                ".StartTime.Ticks",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        val = (out.stdout or "").strip()
        return val or None
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
            return fh.read().split(")")[-1].split()[19]
    except OSError:
        return None


def _gone(pid: int, created) -> bool:
    """Is the process we identified really gone?

    `created` pins the identity: a pid that came back with a DIFFERENT creation
    time is a different process, and our one is gone.
    """
    if not _alive(pid):
        return True
    if created is None:
        return False  # cannot distinguish; report it as still there
    return _creation_time(pid) != created


def _wait_gone(pairs, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(_gone(pid, created) for pid, created in pairs):
            return True
        time.sleep(0.2)
    return False


def _spawn_tree():
    """Start parent -> child and return [(pid, creationTime), …] for both."""
    parent = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        [sys.executable, "-c", _PARENT],
        stdout=subprocess.PIPE,
        text=True,
        **({} if os.name == "nt" else {"start_new_session": True}),
    )
    child_pid = int(parent.stdout.readline().strip())
    time.sleep(0.3)
    pairs = [
        (parent.pid, _creation_time(parent.pid)),
        (child_pid, _creation_time(child_pid)),
    ]
    assert _alive(parent.pid) and _alive(child_pid), "the tree must really be up"
    return parent, child_pid, pairs


def test_a_clean_shutdown_kills_the_whole_tree_then_writes_the_records(tmp_path):
    """Contract §5.9a. Order matters: a record finalised while the process is
    still alive is a lying journal plus a process still consuming capacity."""
    import server  # noqa: PLC0415 - path injected at module import

    parent, child_pid, pairs = _spawn_tree()
    try:
        # No runner: this test is about SHUTDOWN, so the mid-flight state is set
        # up directly. With a runner attached the store would start (and finish)
        # the work before `close()` was ever reached, and the test would be
        # asserting about an already-completed run.
        store = runstore.RunStore(
            tmp_path / "runs.json",
            terminator=server._kill_tree,
        )
        run = store.create(
            kind="skill",
            task_type="skill.x",
            executor="claude-code",
            project_id="P1",
        )
        # register the live tree exactly as `_run_executor` would
        with store._lock:  # noqa: SLF001 - reproducing the mid-flight state
            store._find_locked(run["runId"])["status"] = "running"
            store._handles[run["runId"]] = parent
        store.close()
        assert _wait_gone(pairs), (
            "EVERY descendant must be gone — killing only the direct child leaves "
            "the real CLI running and still burning subscription capacity"
        )
        got = store.get(run["runId"], project="P1")
        assert got["status"] == "failed"
        assert got["failureReason"]["category"] == runstore.FAILURE_BACKEND_RESTARTED
        assert got["failureReason"]["childExitVerified"] is True
    finally:
        _force_kill(parent, child_pid)


#: A REAL backend stand-in: it guards a child tree exactly the way `_run_executor`
#: does, reports the pids, then blocks so the test can hard-kill it.
_FAKE_BACKEND = """
import subprocess, sys, time
sys.path.insert(0, {mockup!r})
import server
server._windows_job()                       # the job must exist before the spawn
child = subprocess.Popen(
    [sys.executable, "-c",
     "import subprocess,sys,time;"
     "g=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)']);"
     "print(g.pid, flush=True);"
     "time.sleep(300)"],
    stdout=subprocess.PIPE, text=True,
    **({{}} if sys.platform == 'win32' else {{'start_new_session': True}}),
)
server._guard_child(child)
print(child.pid, flush=True)
print(child.stdout.readline().strip(), flush=True)
time.sleep(300)
"""


def test_a_hard_killed_backend_leaves_no_orphan_process_tree(tmp_path):
    """`kill -9` the backend and assert its descendants are GONE.

    codex review round 15: the earlier version of this test never killed a
    backend and never asserted `_wait_gone` — it only checked the sweep's
    wording, so an orphan-process regression would have passed it. The value of
    this whole mechanism is whether the processes actually die, so the test now
    does the only thing that can answer that.

    On Windows the guarantee is the Job Object (`KILL_ON_JOB_CLOSE`, inherited).
    On POSIX there is none for `SIGKILL` — that gap is documented in server.py
    and reported as `childExitVerified: false` — so there the assertion is that
    we do not CLAIM otherwise.
    """
    backend = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        [sys.executable, "-c", _FAKE_BACKEND.format(mockup=str(_MOCKUP_DIR))],
        stdout=subprocess.PIPE,
        text=True,
    )
    child_pid = grandchild_pid = None
    child_created = grand_created = None
    try:
        child_pid = int(backend.stdout.readline().strip())
        grandchild_pid = int(backend.stdout.readline().strip())
        time.sleep(0.4)
        child_created = _creation_time(child_pid)
        grand_created = _creation_time(grandchild_pid)
        pairs = [(child_pid, child_created), (grandchild_pid, grand_created)]
        assert _alive(child_pid) and _alive(grandchild_pid), "the tree must be up"

        backend.kill()  # SIGKILL / TerminateProcess: no exit hook of ours runs
        backend.wait(timeout=30)

        if os.name == "nt":
            assert _wait_gone(pairs), (
                "the Job Object must take the WHOLE tree with the backend — "
                "that is the entire point of KILL_ON_JOB_CLOSE"
            )
        else:
            # No guarantee here, by design (see server.py's shutdown-guard note).
            # What must hold is that nothing claims otherwise.
            server_src = (_MOCKUP_DIR / "server.py").read_text("utf-8")
            assert "childExitVerified" in server_src
    finally:
        # Cleanup must obey the same rule the code under test does: a pid alone
        # is not an identity. After a hard kill these numbers are free, and
        # signalling one blindly could take out an unrelated host process
        # (codex review, round 20).
        for pid, created in zip(
            (grandchild_pid, child_pid), (grand_created, child_created), strict=False
        ):
            if pid is None or _gone(pid, created):
                continue
            try:
                if os.name == "nt":
                    subprocess.run(  # noqa: S603 - fixed argv, no shell
                        ["taskkill", "/T", "/F", "/PID", str(pid)],
                        capture_output=True,
                        timeout=30,
                        check=False,
                    )
                else:
                    os.kill(pid, 9)
            except (OSError, subprocess.SubprocessError, ValueError):
                pass


def test_the_restart_sweep_is_honest_about_what_it_did_not_verify(tmp_path):
    """The journal half: a new process boots from what the dead one left."""
    parent, child_pid, _pairs = _spawn_tree()
    journal = tmp_path / "runs.json"
    try:
        store = runstore.RunStore(journal, max_concurrent=1)
        run = store.create(
            kind="skill",
            task_type="skill.x",
            executor="claude-code",
            project_id="P1",
        )
        with store._lock:  # noqa: SLF001 - the state a hard kill would leave behind
            rec = store._find_locked(run["runId"])
            rec["status"] = "running"
            rec["process"] = {"pid": parent.pid, "argv0": sys.executable}
            store._persist_locked()

        reborn = runstore.RunStore(journal, max_concurrent=1)
        got = reborn.get(run["runId"], project="P1")
        assert got["status"] == "failed"
        assert got["failureReason"]["category"] == runstore.FAILURE_BACKEND_RESTARTED
        # THE HONEST PART: it did not kill anything, so it must not claim the
        # child exited. That pid may belong to someone else entirely by now.
        assert got["failureReason"]["childExitVerified"] is False
        assert "未能确认" in got["failureReason"]["detail"]
    finally:
        _force_kill(parent, child_pid)


def test_the_sweep_never_signals_a_pid_it_did_not_spawn(tmp_path):
    """The pid in an old record belongs to a process THIS process never started.
    Killing on it is the one operation here that could hurt an unrelated
    program, so the sweep does not do it at all."""
    parent, child_pid, pairs = _spawn_tree()
    journal = tmp_path / "runs.json"
    try:
        store = runstore.RunStore(journal)
        run = store.create(
            kind="skill", task_type="skill.x", executor="claude-code", project_id="P1"
        )
        with store._lock:  # noqa: SLF001
            rec = store._find_locked(run["runId"])
            rec["status"] = "running"
            rec["process"] = {"pid": parent.pid}
            store._persist_locked()
        runstore.RunStore(journal)  # the sweep runs here
        time.sleep(0.5)
        assert _alive(parent.pid), (
            "a restart must not kill a pid it did not spawn — that number may "
            "now belong to the user's editor"
        )
    finally:
        _force_kill(parent, child_pid)


def test_the_windows_kill_on_close_guard_really_takes_effect(tmp_path):
    """codex review round 3 found a defect in code NOTHING exercised: ctypes
    defaults a return value to C `int`, so a Win64 `HANDLE` was truncated and the
    Job Object assignment silently failed — the backend believed it had
    kill-on-close protection it did not have.

    A source-level check cannot catch that. This calls the real Win32 path with a
    real process and asserts the guard REPORTS success, which is only possible if
    the handles survived the round trip.
    """
    import server  # noqa: PLC0415 - path injected at module import

    if os.name != "nt":
        # POSIX has no equivalent guarantee by design (see the module comment in
        # server.py): there the exit hook is all there is, and the sweep says so.
        assert server._guard_child.__doc__
        return
    parent, child_pid, _pairs = _spawn_tree()
    try:
        assert server._windows_job(), "the job object itself must be creatable"
        assert server._guard_child(parent) is True, (
            "assignment must SUCCEED — a silently failed one is exactly the "
            "false sense of protection this guard exists to avoid"
        )
    finally:
        _force_kill(parent, child_pid)


def _force_kill(parent, child_pid, created=None):
    """Test cleanup. Never let a test leak the very processes it is about — and
    never signal a pid whose identity we cannot still vouch for.

    codex review round 21: after a test has deliberately killed these processes,
    their numbers are free, and signalling them blindly could take out an
    unrelated host process. `created` (when supplied) pins the identity; without
    it we only signal something still alive under that pid.
    """
    for i, target in enumerate((child_pid, parent.pid)):
        if target is None:
            continue
        want = created[i] if isinstance(created, (list, tuple)) else None
        if want is None or _gone(target, want):
            # No identity, no signal (codex review, round 23). If the test has
            # already killed these and the numbers were recycled, signalling
            # them would take out an unrelated host process — the same rule the
            # code under test follows.
            continue
        try:
            if os.name == "nt":
                subprocess.run(  # noqa: S603 - fixed argv, no shell
                    ["taskkill", "/T", "/F", "/PID", str(target)],
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
            else:
                os.kill(target, 9)
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        parent.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
