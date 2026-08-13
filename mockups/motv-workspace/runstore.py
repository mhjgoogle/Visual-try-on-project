#!/usr/bin/env python3
"""Durable Run registry — the backend half of the Run contract (TASK-072 批次一).

THE ONE AUTHORITY ON "how did that task go". A Run is the single record for every
long task in the system: a Skill run, an image/video generation, a TTS render, an
FFmpeg mix, a rough cut, an export. They differ by ``kind``; they do NOT get their
own status vocabularies, their own files, or their own idea of what "cancelled"
means (creator-system-contract §5.0).

WHAT THIS MODULE IS NOT: it does not know HTTP, does not know routes, does not
import ``server``. It never spawns a process itself — the caller injects a
``runner`` callback. That is what lets the whole queue / cancel / restart
protocol be tested without launching a single CLI (TASK-072 §0.1).

OWNERSHIP (contract §5.5). The backend owns the LIFECYCLE (status, progress,
timings, failure, cost, side effect, outputs); the canvas document owns the
CREATOR'S DECISIONS (proposal disposition, context trace, the frozen prompt).
Each side owns what it actually knows, so no field needs arbitration and a canvas
save can never roll a running task's progress backwards.

PERSISTENCE. One file, one writer, one lock, atomic replace. A state change that
cannot be written down is a state change that FAILED — memory and file are never
allowed to diverge, because the file is what the next process boots from.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

# --- the vocabulary (contract §5.2 / §5.0) --------------------------------- #

#: The eight Run states. Ordered as the happy path reads, not alphabetically.
RUN_STATUSES = (
    "awaiting_confirmation",  # shown cost/impact, waiting for the user. NO slot held
    "queued",  # accepted (and confirmed, if it needed it), waiting for a slot
    "running",  # a real process is working
    "awaiting_input",  # MANUAL execution: waiting for the creator to bring a result
    "cancelling",  # cancel requested, being delivered to a real process tree
    "cancelled",
    "succeeded",
    "failed",
)

#: Terminal states never change again. This is what makes the cancel/completion
#: race deterministic (contract §5.9): whoever writes a terminal state first wins,
#: and the loser is refused rather than silently overwriting a real outcome.
TERMINAL_STATUSES = frozenset({"cancelled", "succeeded", "failed"})

#: States that hold (or are about to hold) an execution slot.
_SLOT_STATUSES = frozenset({"running", "cancelling"})

#: States the restart sweep must NOT touch. Their host is the CREATOR, not this
#: process — a backend restart took nothing away from them, so failing them would
#: throw away the user's in-flight work (contract §5.4 rule 4).
SWEEP_EXEMPT_STATUSES = frozenset({"awaiting_input", "awaiting_confirmation"})

#: Proposal disposition — a SECOND axis, deliberately not folded into `status`
#: (ADR-0066 决策 8). "the run finished" and "I accepted its answer" are different
#: facts and were previously crammed into one enum.
DISPOSITIONS = ("pending", "accepted", "rejected", "superseded")

#: Run kinds. Every long task is one of these.
RUN_KINDS = (
    "skill",
    "image-gen",
    "video-gen",
    "tts",
    "ffmpeg",
    "render",
    "export",
)

#: Executors, CLOSED SET (contract §5.3). `provider:<providerId>` is the one
#: parametrised form, and its prefix is meaningful: it marks the executors that
#: can produce an EXTERNAL side effect, which is what makes §5.8's `sideEffect`
#: tracking mandatory for them and trivially `none` for the local ones.
FIXED_EXECUTORS = (
    "claude-code",
    "codex-cli",
    "manual",
    "local-piper",
    "local-ffmpeg",
)
PROVIDER_EXECUTOR_PREFIX = "provider:"

#: Side effect on the outside world (contract §5.8). `unknown` is the whole point
#: of the field: it is the state in which AUTOMATIC RETRY IS FORBIDDEN, because
#: retrying something that may already have run (and billed) turns one uncertain
#: charge into two certain ones.
SIDE_EFFECTS = ("none", "applied", "unknown")

#: Failure categories that carry a specific meaning elsewhere in the contract.
#: However full the protected history gets, this many recent finished runs are
#: always retained, so a caller can still fetch the result it just waited for.
_MIN_RECENT_TERMINAL = 25

FAILURE_BACKEND_RESTARTED = "backend_restarted"
FAILURE_INTERRUPTED = "interrupted"


def is_valid_executor(name: str) -> bool:
    """Closed-set membership, including the one parametrised form."""
    if not isinstance(name, str) or not name:
        return False
    if name in FIXED_EXECUTORS:
        return True
    if not name.startswith(PROVIDER_EXECUTOR_PREFIX):
        return False
    # `provider:` alone names no provider; a bare prefix would let an unnamed
    # external service through the one check that exists to identify it.
    return bool(name[len(PROVIDER_EXECUTOR_PREFIX) :].strip())


def produces_external_side_effects(executor: str) -> bool:
    """Only `provider:*` reaches outside this machine — and therefore only it can
    leave us unsure whether something happened."""
    return isinstance(executor, str) and executor.startswith(PROVIDER_EXECUTOR_PREFIX)


# --- errors ----------------------------------------------------------------- #


class RunStoreError(Exception):
    """Base for refusals this module makes on purpose."""

    category = "run_error"

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class InvalidRun(RunStoreError):
    category = "bad_request"


class RunNotFound(RunStoreError):
    """Also raised for a run that exists but belongs to ANOTHER project.

    404, never 403: telling a caller "this exists but is not yours" leaks that
    the id is real, and one project has no business learning which runs another
    project has (contract §5.5).
    """

    category = "not_found"


class PersistFailed(RunStoreError):
    category = "storage_error"


# --- helpers ---------------------------------------------------------------- #


class _Missing:
    __slots__ = ()

    def __repr__(self):  # pragma: no cover - debugging aid only
        return "<no project named>"


#: Sentinel: "the caller did not name a project at all" (⚙ diagnostics), which is
#: a different question from "the caller named a project" and must not silently
#: become `None` — `None` is a REAL, matchable projectId for legacy runs, so
#: using it as the default would turn every unscoped lookup into a lookup for
#: exactly the project-less runs.
_MISSING = _Missing()


def _now_iso(clock) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock()))


def _str_or_none(x):
    return x if isinstance(x, str) and x else None


def _target_or_none(x):
    return x if isinstance(x, dict) else None


def _as_int(x, default=0):
    """A non-negative int, or the default. Used on values read from the journal,
    where anything at all may have been written by hand."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return default
    try:
        return max(0, int(x))
    except (ValueError, OverflowError):
        return default


class RunStore:
    """The registry. Thread-safe; one lock guards state AND the file.

    ``runner`` is called on a worker thread as::

        runner(run_snapshot, on_spawn, is_cancelled)
            -> (outputs: dict, model: str | None)

    and may raise. ``on_spawn(handle)`` hands back something the store can later
    terminate; ``is_cancelled()`` lets a cooperative runner bail early. Neither
    this module nor its tests need a real process for any of that.
    """

    def __init__(
        self,
        path,
        *,
        max_concurrent: int = 2,
        runner=None,
        terminator=None,
        clock=time.time,
        history_limit: int = 400,
    ):
        self.path = Path(path)
        self.max_concurrent = max(1, int(max_concurrent))
        self._runner = runner
        # how to kill something `on_spawn` gave us; injected so the cancel
        # protocol is testable with a fake handle
        self._terminator = terminator
        self._clock = clock
        self._history_limit = max(1, int(history_limit))
        self._lock = threading.RLock()
        self._runs: list[dict] = []
        self._seq = 0
        self._handles: dict[str, object] = {}
        #: slots held by callers outside this store (the synchronous route), so
        #: both paths draw from ONE pool rather than two independent ones
        self._external_slots = 0
        self._threads: dict[str, threading.Thread] = {}
        self._closed = False
        self._load()

    # -- persistence --------------------------------------------------------- #

    def _load(self) -> None:
        """Read the journal, then SWEEP. Both happen before anyone can call in."""
        raw = None
        try:
            raw = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            raw = None
        except OSError as exc:
            # A transient sharing / permission error is NOT corruption. Treating
            # it as such started with an EMPTY registry — silently discarding
            # live history and, with it, the duplicate-spend protection that
            # reads it (codex review, round 21). Refuse to start instead.
            raise PersistFailed(f"无法读取运行记录：{exc}") from exc
        except ValueError:
            # A corrupt journal must not take the backend down, and must not be
            # silently replaced either: keep the bytes so the operator can look.
            try:
                # A UNIQUE name per corruption. A single `.corrupt` slot meant
                # the second damaged journal was left in place and then quietly
                # overwritten by the next successful write — the most recent
                # evidence, lost (codex review, round 17).
                stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(self._clock()))
                backup = self.path.with_suffix(f"{self.path.suffix}.corrupt-{stamp}")
                n = 0
                while backup.exists() and n < 100:
                    n += 1
                    backup = self.path.with_suffix(
                        f"{self.path.suffix}.corrupt-{stamp}-{n}"
                    )
                os.replace(self.path, backup)
            except OSError:
                pass
            raw = None
        runs = []
        if isinstance(raw, dict) and isinstance(raw.get("runs"), list):
            runs = [r for r in raw["runs"] if isinstance(r, dict) and r.get("runId")]
        self._runs = runs
        # A malformed `queueSeq` must not crash initialisation: the whole point
        # of the corrupt-journal handling above is that a bad file degrades
        # instead of taking the backend down (codex review, round 4).
        self._seq = max((_as_int(r.get("queueSeq")) for r in runs), default=0)
        self._sweep_locked()

    def _commit_locked(self, run: dict, changes: dict) -> dict:
        """Apply a state change and write it down — or do NEITHER.

        Every transition in this module goes through here (codex review, rounds
        4–5). Mutating first and persisting second leaves, on a disk error, a
        caller told the change failed while memory carries on as if it worked —
        and for a paid kind that gap ends with a charge nobody authorised.

        Memory and the file move together, or not at all.
        """
        before = {k: run.get(k) for k in changes}
        run.update(changes)
        try:
            self._persist_locked()
        except PersistFailed:
            for k, v in before.items():
                if v is None and k not in ("status",):
                    run.pop(k, None)
                else:
                    run[k] = v
            raise
        return run

    def _persist_locked(self) -> None:
        """Atomic replace, in the same directory (os.replace is not cross-volume).

        A failure here RAISES: the caller's state change did not happen. Letting
        memory move on while the file stays behind would mean the next process
        boots from a past this one already abandoned.
        """
        # bound the journal: terminal runs are history, and history that grows
        # without limit eventually makes startup slow for no added truth
        runs = self._runs
        trimmed = None
        if len(runs) > self._history_limit:
            # A run that could bear on SPEND is never trimmed. The duplicate
            # charge guard reads history, so dropping those records quietly
            # re-opens the replay it exists to block (codex review, round 10).
            def _protected(r):
                if r.get("status") not in TERMINAL_STATUSES:
                    return True
                if not produces_external_side_effects(r.get("executor") or ""):
                    return False
                # Anything the spend guard reads: a run that may have been
                # charged, AND a run that already SPENT a retry authorisation —
                # dropping the latter makes a one-use approval reusable
                # (codex review, round 13).
                return (
                    r.get("sideEffect") in ("applied", "unknown")
                    or r.get("retryOfRunId") is not None
                )

            live = [r for r in runs if _protected(r)]
            done = [r for r in runs if not _protected(r)]
            # Trim by WHEN THEY FINISHED, not when they were created. By creation
            # order, a long run that finally completes after the limit is reached
            # is the oldest record and gets dropped immediately — so the client
            # that is polling its perfectly valid run id gets a 404 instead of
            # the result it waited for (codex review, round 6).
            done.sort(
                key=lambda r: (str(r.get("endedAt") or ""), _as_int(r.get("queueSeq")))
            )
            # ALWAYS keep a floor of the most recent finished runs. Once
            # protected (spend-bearing) history filled the limit, `keep` went to
            # zero and every ordinary run was trimmed the instant it finished —
            # so a client polling its own just-completed run got `RunNotFound`
            # instead of the result (codex review, round 15).
            keep = max(_MIN_RECENT_TERMINAL, self._history_limit - len(live))
            trimmed = live + done[-keep:]
            trimmed.sort(key=lambda r: _as_int(r.get("queueSeq")))
            runs = trimmed
        payload = {"v": 1, "runs": runs}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + f".tmp{os.getpid()}")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), "utf-8")
            os.replace(tmp, self.path)
        except OSError as exc:
            raise PersistFailed(f"无法写入运行记录：{exc}") from exc
        # The trim is applied to MEMORY only after the write succeeded. Dropping
        # records first meant a transient write failure lost them from memory,
        # and the next successful write then committed that loss permanently
        # (codex review, round 8).
        if trimmed is not None:
            self._runs = trimmed

    # -- restart sweep ------------------------------------------------------- #

    def _sweep_locked(self) -> int:
        """Nothing may stay `running` across a restart (contract §5.4 rule 4).

        WE DO NOT KILL ANYTHING HERE. The pid in an old record belongs to a
        process this process never started, and pids are REUSED — that number may
        now be an editor, a database, the user's browser. Killing on a stale pid
        is the only operation in this contract that could hurt an unrelated
        program, so it is simply not done (contract §5.9a).

        Orphans are prevented at LAUNCH instead (job object / process group), and
        what we cannot verify we report as unverified rather than assume.
        """
        swept = 0
        for r in self._runs:
            status = r.get("status")
            if status in TERMINAL_STATUSES or status in SWEEP_EXEMPT_STATUSES:
                continue
            if status not in ("queued", "running", "cancelling"):
                continue
            r["status"] = "failed"
            r["endedAt"] = _now_iso(self._clock)
            verified = status == "queued"  # a queued run never had a process
            r["failureReason"] = {
                "category": FAILURE_BACKEND_RESTARTED,
                "detail": (
                    "后端进程已重启，这次运行随之中断。"
                    if verified
                    else "后端进程已重启；**未能确认**它启动的子进程是否已退出"
                    "（不凭旧 PID 盲杀，PID 可能已被复用）。"
                ),
                "childExitVerified": verified,
            }
            # "I don't know whether it ran" is not "it didn't run". For anything
            # that could have reached an external provider, that uncertainty is
            # exactly what forbids an automatic retry (§5.8).
            if not verified and produces_external_side_effects(r.get("executor") or ""):
                r["sideEffect"] = "unknown"
            elif r.get("sideEffect") not in SIDE_EFFECTS:
                r["sideEffect"] = "none"
            swept += 1
        if swept:
            self._persist_locked()
        return swept

    # -- queue --------------------------------------------------------------- #

    def _slots_used_locked(self) -> int:
        return (
            sum(1 for r in self._runs if r.get("status") in _SLOT_STATUSES)
            + self._external_slots
        )

    def try_acquire_slot(self) -> bool:
        """Take a slot for work this store does not manage (the synchronous
        `/api/skill/run`), or report that there is none.

        THE POOL IS ONE POOL (codex review, round 11). A second, independent
        semaphore beside this one meant mixed sync/async traffic could run
        `max_concurrent` executors twice over — and the cap exists because each
        one is a real local CLI consuming the machine and the subscription.
        """
        with self._lock:
            if self._closed or self._slots_used_locked() >= self.max_concurrent:
                return False
            self._external_slots += 1
            return True

    def release_slot(self) -> None:
        with self._lock:
            self._external_slots = max(0, self._external_slots - 1)
            self._pump_locked()  # someone queued may now start

    def _queue_position_locked(self, run: dict):
        """DERIVED, never stored (contract §5.6).

        A stored position is wrong the moment some other run finishes, and it
        looks like a fact while being wrong. Ordering uses the integer sequence
        rather than a timestamp: integers have no ties and need no clock.
        """
        if run.get("status") != "queued":
            return None
        seq = _as_int(run.get("queueSeq"))
        ahead = sum(
            1
            for r in self._runs
            if r.get("status") == "queued" and _as_int(r.get("queueSeq")) < seq
        )
        return ahead + 1

    def _pump_locked(self) -> None:
        """Start as many queued runs as there are free slots, oldest first."""
        if self._closed or self._runner is None:
            return
        free = self.max_concurrent - self._slots_used_locked()
        if free <= 0:
            return
        ready = sorted(
            (
                r
                for r in self._runs
                # A MANUAL run is executed by a PERSON. It must never be handed
                # to the runner and must never occupy an execution slot: doing so
                # sent it straight to `failed` before the caller could park it in
                # `awaiting_input`, which broke the manual fallback exactly when
                # it is needed — no runtime available (codex review, round 3).
                if r.get("status") == "queued" and r.get("executor") != "manual"
            ),
            key=lambda r: _as_int(r.get("queueSeq")),
        )
        started = []
        for run in ready[:free]:
            run["status"] = "running"
            run["startedAt"] = _now_iso(self._clock)
            started.append(run)
        if not started:
            return
        # PERSIST BEFORE THE WORK STARTS. If the journal still said `queued` while
        # a process was already running, a crash here would leave a record saying
        # the work never began — and for a paid kind that is exactly the state in
        # which an automatic retry looks safe and charges the user twice (§5.8).
        # Write first, then spawn: the record may over-report, never under-report.
        try:
            self._persist_locked()
        except PersistFailed:
            # ROLL BACK, or the slots are lost for good: these runs would sit in
            # `running` with no worker behind them, permanently occupying the
            # capacity that bounds everything else (codex review, round 4).
            # Back to `queued` is the truth — nothing was started.
            for run in started:
                run["status"] = "queued"
                run["startedAt"] = None
            return
        for run in started:
            t = threading.Thread(
                target=self._work, args=(run["runId"],), daemon=True, name="motv-run"
            )
            self._threads[run["runId"]] = t
            t.start()

    # -- the worker ---------------------------------------------------------- #

    def _work(self, run_id: str) -> None:
        with self._lock:
            run = self._find_locked(run_id)
            if run is None:
                return
            status = run.get("status")
            if status == "cancelling":
                # THE EARLY-CANCEL RACE. The slot (and `running`) is reserved in
                # `_pump_locked` before this thread gets scheduled, so a cancel
                # can arrive in between. Nothing was spawned, so there is nothing
                # to kill and nothing that could still produce a result — this is
                # the same situation as cancelling a `queued` run, and it lands
                # `cancelled` at once. Returning early instead would strand the
                # run in `cancelling` forever with no process and no lander.
                run["status"] = "cancelled"
                run["endedAt"] = _now_iso(self._clock)
                try:
                    self._persist_locked()
                except PersistFailed:
                    pass
                self._threads.pop(run_id, None)
                self._pump_locked()
                return
            if status != "running":
                return
            snapshot = dict(run)

        def on_spawn(handle):
            with self._lock:
                self._handles[run_id] = handle
                cur = self._find_locked(run_id)
                # A cancel that arrived while the process was still starting has
                # already set `cancelling`; deliver it now that there is
                # something to deliver it TO, rather than letting the process run
                # on because the request was a few milliseconds early.
                if cur is not None and cur.get("status") == "cancelling":
                    # …and RECORD the verdict. Discarding it here left a process
                    # that was successfully killed stuck in `cancelling` forever,
                    # with its handle already gone so no retry could ever confirm
                    # it (codex review, round 15).
                    try:
                        cur["cancelKillVerified"] = self._terminate(handle) is True
                    except Exception:  # noqa: BLE001
                        cur["cancelKillVerified"] = False

        def is_cancelled():
            with self._lock:
                cur = self._find_locked(run_id)
                return cur is not None and cur.get("status") in (
                    "cancelling",
                    "cancelled",
                )

        outputs, model, failure = None, None, None
        try:
            outputs, model = self._runner(snapshot, on_spawn, is_cancelled)
        except Exception as exc:  # noqa: BLE001 - every failure becomes a RECORD
            failure = _classify(exc)
        with self._lock:
            self._threads.pop(run_id, None)
            run = self._find_locked(run_id)
            try:
                if run is not None:
                    self._land_locked(run, outputs, model, failure)
            except PersistFailed as exc:
                # The outcome could not be written down. The rollback restored
                # `running` — which is now a LIE that also holds a slot forever:
                # the worker and its handle are already gone, so nothing will
                # ever move it again and every queued run stalls behind it
                # (codex review, round 9).
                #
                # So it is forced to a terminal state in MEMORY even though the
                # file could not be updated. That divergence is safe in the one
                # direction that matters: the journal still says `running`, and
                # the next start's sweep turns exactly that into
                # `failed(backend_restarted)` — the same terminal outcome. A held
                # slot has no such self-correction.
                if run is not None:
                    run["status"] = "failed"
                    run["endedAt"] = _now_iso(self._clock)
                    run["failureReason"] = {
                        "category": "storage_error",
                        "detail": f"结果无法写入运行记录：{exc.detail}",
                    }
            # The handle is released only once the run is really finished. A run
            # that stayed `cancelling` (its tree kill unverified) still needs it:
            # without a handle no retry could ever terminate the descendants that
            # are still out there (codex review, round 16).
            if run is None or run.get("status") in TERMINAL_STATUSES:
                self._handles.pop(run_id, None)
            self._pump_locked()

    def _land_locked(self, run: dict, outputs, model, failure) -> None:
        """Write the outcome — respecting a cancel that is already in flight.

        THE RACE (contract §5.9). A cancel request and the process finishing will
        collide; the result must not depend on which thread the scheduler picked.
        `cancelling` wins over a successful finish: the user asked it to stop, so
        the answer must not be quietly adopted as a product. The bytes are still
        KEPT and reported — throwing away a result (especially a billed one)
        would be a second, different kind of dishonesty.
        """
        changes = {"endedAt": _now_iso(self._clock)}
        if _str_or_none(model):
            changes["model"] = model
        if run.get("status") == "cancelling":
            # …whatever came back. Exempting the case where the runner returned
            # a dict meant a surviving tree was reported as cancelled and its
            # slot freed, purely because the direct child happened to produce
            # output on its way out (codex review, round 22). The outputs are
            # still recorded below on the next attempt; what must not happen is
            # calling it `cancelled`.
            if run.get("cancelKillVerified") is not True:
                # The kill was NOT confirmed and nothing came back. Contract
                # §5.4 rule 3: stay in `cancelling` and say so. A process that
                # may still be burning subscription capacity, reported as
                # `cancelled`, is the one lie this contract cares most about.
                # It is not stuck forever: a repeat cancel retries the kill, and
                # the restart sweep terminalises it.
                self._commit_locked(
                    run,
                    {
                        "cancelFailure": {
                            "detail": "子进程树未确认退出，取消尚未完成",
                            "at": _now_iso(self._clock),
                        }
                    },
                )
                return
            changes["status"] = "cancelled"
            if isinstance(outputs, dict):
                changes["outputs"] = outputs
                changes["note"] = (
                    "子进程在取消传递期间已完成；结果已记录，但不作为产物应用"
                )
                changes["sideEffect"] = (
                    "applied"
                    if produces_external_side_effects(run.get("executor") or "")
                    else "none"
                )
            elif produces_external_side_effects(run.get("executor") or ""):
                # Cancelled mid-flight with nothing to show: the request had
                # already gone out, so the provider MAY have run and billed it.
                # Leaving `none` said 「没花钱」 and let the same request be
                # replayed for a second charge (codex review, round 13).
                changes["sideEffect"] = "unknown"
        elif run.get("status") in TERMINAL_STATUSES:
            return  # already decided; a late answer never rewrites a real outcome
        elif failure is not None:
            changes["status"] = "failed"
            if self._closed:
                # We killed it. Recording the resulting `execution_error` would
                # blame the executor for the backend's own shutdown, and would
                # win the race against `close()` — which then refuses to replace
                # a terminal state (codex review, round 13).
                #
                # But the VERDICT is the terminator's, not an assumption:
                # hardcoding True here published "the tree is gone" for a kill
                # that may have failed (codex review, round 17).
                verified = run.get("cancelKillVerified") is True
                changes["failureReason"] = {
                    "category": FAILURE_BACKEND_RESTARTED,
                    "detail": (
                        "后端正在退出，这次运行随之终止。"
                        if verified
                        else "后端正在退出；**未能确认**它的子进程树已终止。"
                    ),
                    "childExitVerified": verified,
                }
            else:
                changes["failureReason"] = failure
            if run.get("sideEffect") == "none" and produces_external_side_effects(
                run.get("executor") or ""
            ):
                changes["sideEffect"] = failure.get("sideEffect") or "unknown"
        else:
            changes["status"] = "succeeded"
            changes["outputs"] = outputs if isinstance(outputs, dict) else {}
            changes["progress"] = 100
            # `applied` means an EXTERNAL side effect happened (§5.8). A local
            # executor never leaves this machine, so recording `applied` for it
            # put a false claim into the audit trail and into the data the retry
            # rules read (codex review, round 10).
            changes["sideEffect"] = (
                "applied"
                if produces_external_side_effects(run.get("executor") or "")
                else "none"
            )
        # commit-or-rollback like every other transition: a disk error must not
        # leave memory holding an outcome the journal never received
        self._commit_locked(run, changes)

    def _terminate(self, handle):
        """Ask the injected terminator to kill something.

        Returns whatever the terminator reports — `False` means "could not
        confirm it died", and callers must not upgrade that to a claim.
        """
        if handle is not None and self._terminator is not None:
            return self._terminator(handle)
        return None

    # -- public API ---------------------------------------------------------- #

    def create(
        self,
        *,
        kind: str,
        task_type: str,
        executor: str,
        project_id=None,
        legacy_no_project: bool = False,
        needs_confirmation: bool = False,
        skill_id=None,
        skill_version=None,
        command_id=None,
        idempotency_key=None,
        retry_of_run_id=None,
        target=None,
        context=None,
        inputs=None,
        params=None,
        provider=None,
        cost=None,
    ) -> dict:
        """Accept a task and hand back its identity IMMEDIATELY.

        Refuses rather than guesses: an unknown kind/executor, or a missing
        project on a non-legacy call, is a 400. There is no "current project" on
        the backend, so inferring one would file the run under whoever happened
        to be active (contract §5.5).
        """
        if kind not in RUN_KINDS:
            raise InvalidRun(f"unknown run kind {kind!r}")
        if not is_valid_executor(executor):
            raise InvalidRun(f"unknown executor {executor!r}")
        if not _str_or_none(task_type):
            raise InvalidRun("taskType is required")
        project_id = _str_or_none(project_id)
        if project_id is None and not legacy_no_project:
            raise InvalidRun("project is required")
        with self._lock:
            if self._closed:
                raise InvalidRun("backend is shutting down")
            key = _str_or_none(idempotency_key)
            # EVERY duplicate-spend guard below is keyed. Without a key, a
            # `provider:*` run has none of them — a replayed request simply
            # creates a second charge (codex review, round 9). A key is therefore
            # required for anything that can bill, rather than optional.
            if produces_external_side_effects(executor) and not key:
                raise InvalidRun(
                    "付费执行器必须带 idempotencyKey——没有它就没有任何重复扣费保护"
                )
            if key:
                # SCOPED BY PROJECT, always. An idempotency key is only unique
                # within the project that minted it — matching it globally would
                # hand project B a live run belonging to project A (and its
                # outputs), which is both a data leak and the wrong answer:
                # two projects doing "the same" thing are two different jobs.
                # The key alone does not identify an intent: the SAME key sent to
                # two different endpoints is two different jobs, and matching on
                # the key alone would hand the second one the first one's run —
                # answering a shot-list request with an outline, under a 200
                # (codex review, round 2). An intent is the whole tuple.
                # An intent is the whole tuple, not the key alone. The CALLER is
                # responsible for deriving a key that also covers its inputs and
                # params (contract §5.7); what is checked here is everything the
                # store itself can see, so a key reused across executors or
                # targets cannot return the other one's run (codex review,
                # round 16).
                def _same_intent(r):
                    return (
                        r.get("idempotencyKey") == key
                        and r.get("projectId") == project_id
                        and r.get("kind") == kind
                        and r.get("taskType") == task_type
                        and r.get("executor") == executor
                        and r.get("target") == _target_or_none(target)
                    )

                # Same intent, still in flight -> the SAME run. A double click, a
                # retried request and a second tab all land on one execution.
                for r in self._runs:
                    if _same_intent(r) and r.get("status") not in TERMINAL_STATUSES:
                        return self._view_locked(r)
                # Same intent, already PAID FOR and succeeded -> refuse. Spending
                # again has to be a new, explicit decision (`retryOfRunId`).
                # A retry must NAME the run it retries, and that run must be the
                # matching one. Accepting any truthy string let a caller bypass
                # duplicate-spend protection with `retryOfRunId: "x"` — the guard
                # would have been decoration (codex review, round 6).
                # …and it is SPENT once used. Without that, replaying the same
                # request replays the authorisation, and every replay is another
                # provider charge (codex review, round 8). One approval, one
                # attempt — the same rule as the idempotency key itself.
                already_retried = any(
                    r.get("retryOfRunId") == retry_of_run_id for r in self._runs
                )
                authorised_retry = (
                    bool(retry_of_run_id)
                    and not already_retried
                    and any(
                        r.get("runId") == retry_of_run_id and _same_intent(r)
                        for r in self._runs
                    )
                )
                if retry_of_run_id and not authorised_retry:
                    raise InvalidRun(
                        f"retryOfRunId {retry_of_run_id} 不能授权这次重跑："
                        "它要么不是这个操作的既有运行，要么已经被用过一次"
                    )
                if produces_external_side_effects(executor) and not authorised_retry:
                    for r in self._runs:
                        if not _same_intent(r):
                            continue
                        # `unknown` blocks a replay just as hard as `applied`
                        # (codex review, round 10). A timed-out provider request
                        # MAY already have been charged — that is the whole
                        # meaning of `unknown` (§5.8) — so replaying it freely is
                        # exactly the double charge the field exists to prevent.
                        if r.get("sideEffect") in ("applied", "unknown"):
                            spent = (
                                "已经成功执行过"
                                if r.get("sideEffect") == "applied"
                                else "可能已经执行过（结果未确认）"
                            )
                            raise InvalidRun(
                                f"这个操作{spent}（会再次产生费用）。"
                                f"已有记录：{r['runId']}；确实要重跑请显式重试。"
                            )
            self._seq += 1
            if needs_confirmation:
                initial = "awaiting_confirmation"
            elif executor == "manual":
                # Straight to waiting-for-a-person. It never queues, because it
                # is not waiting for a machine: parking it in `queued` would put
                # a human-paced task in the queue that bounds MACHINE capacity,
                # and the queue position shown to other work would be a fiction.
                initial = "awaiting_input"
            else:
                initial = "queued"
            run = {
                "runId": f"run-{uuid.uuid4().hex[:16]}",
                "kind": kind,
                "taskType": task_type,
                "projectId": project_id,
                "status": initial,
                "queueSeq": self._seq,
                "executor": executor,
                "provider": _str_or_none(provider),
                "model": None,
                "skillId": _str_or_none(skill_id),
                "skillVersion": skill_version
                if isinstance(skill_version, int)
                else None,
                "commandId": _str_or_none(command_id),
                "idempotencyKey": key,
                "retryOfRunId": _str_or_none(retry_of_run_id),
                # a NEW attempt starts clean: it has not spent anything yet, and
                # inheriting the previous attempt's side effect would double-count
                "sideEffect": "none",
                "target": _target_or_none(target),
                "context": context if isinstance(context, dict) else None,
                "inputs": inputs if isinstance(inputs, dict) else None,
                "params": params if isinstance(params, dict) else None,
                "outputs": None,
                "progress": 0,
                # subscription work is free, and saying so is not the same as
                # saying nothing: an absent cost reads as "we don't know"
                # Subscription work is 0 AND SAYS SO. A PAID one is not free and
                # must never default to 0: that put "this cost nothing" into the
                # budget record for an execution that will be billed (codex
                # review, round 13). Unknown-until-reported is the truth.
                "cost": cost
                if isinstance(cost, dict)
                else (
                    {"currency": "USD", "amount": None, "basis": "provider-pending"}
                    if produces_external_side_effects(executor)
                    else {"currency": "USD", "amount": 0, "basis": "subscription"}
                ),
                "createdAt": _now_iso(self._clock),
                "startedAt": None,
                "endedAt": None,
                "failureReason": None,
                "confirmation": None,
                "origin": "legacy_no_project" if project_id is None else None,
            }
            self._runs.append(run)
            try:
                self._persist_locked()
            except PersistFailed:
                # ROLL BACK. Without this the caller is told the run was not
                # accepted while it sits in memory, queued, and runs anyway a
                # moment later — for a paid kind, a charge nobody asked for and
                # nobody is expecting (codex review, round 2). A create that
                # cannot be written down did not happen.
                self._runs.remove(run)
                raise
            if run["status"] == "queued":
                self._pump_locked()
            return self._view_locked(run)

    def confirm(self, run_id: str, *, project=_MISSING, by="user", digest=None) -> dict:
        """The user approved it. NOW it may queue for a slot (contract §5.2)."""
        with self._lock:
            run = self._require_locked(run_id, project)
            if run.get("status") != "awaiting_confirmation":
                raise InvalidRun(f"这次运行是「{run.get('status')}」，不需要确认")
            # A confirmed MANUAL run goes to the person, not to the queue: the
            # pump deliberately skips manual executors, so `queued` would be a
            # dead end it could never leave (codex review, round 4).
            self._commit_locked(
                run,
                {
                    "status": (
                        "awaiting_input"
                        if run.get("executor") == "manual"
                        else "queued"
                    ),
                    "confirmation": {
                        "by": by,
                        "at": _now_iso(self._clock),
                        "kind": "explicit",
                        "digest": _str_or_none(digest),
                    },
                },
            )
            self._pump_locked()
            return self._view_locked(run)

    def await_input(self, run_id: str, *, project=_MISSING) -> dict:
        """A MANUAL run is not `running` — nothing is running, the system is
        waiting for a person. Saying `running` made the restart sweep treat
        perfectly healthy manual work as a zombie."""
        with self._lock:
            run = self._require_locked(run_id, project)
            if run.get("status") == "awaiting_input":
                return self._view_locked(run)  # idempotent: manual runs start here
            if run.get("status") not in ("queued", "running"):
                raise InvalidRun(f"这次运行是「{run.get('status')}」，不能转为等待输入")
            self._commit_locked(run, {"status": "awaiting_input"})
            self._pump_locked()
            return self._view_locked(run)

    def submit_input(self, run_id: str, outputs: dict, *, project=_MISSING) -> dict:
        """The creator brought the external result back."""
        with self._lock:
            run = self._require_locked(run_id, project)
            if run.get("status") != "awaiting_input":
                raise InvalidRun(f"这次运行是「{run.get('status')}」，不在等待输入")
            self._commit_locked(
                run,
                {
                    "status": "succeeded",
                    "outputs": outputs if isinstance(outputs, dict) else {},
                    "progress": 100,
                    # a manually-delivered result DID come from outside this
                    # machine, so for a paid kind it is a real external effect;
                    # for a local one it is not (see `_land_locked`)
                    "sideEffect": (
                        "applied"
                        if produces_external_side_effects(run.get("executor") or "")
                        else "none"
                    ),
                    "endedAt": _now_iso(self._clock),
                },
            )
            return self._view_locked(run)

    def fail(
        self, run_id: str, category: str, detail: str, *, project=_MISSING
    ) -> dict:
        with self._lock:
            run = self._require_locked(run_id, project)
            if run.get("status") in TERMINAL_STATUSES:
                return self._view_locked(run)
            self._commit_locked(
                run,
                {
                    "status": "failed",
                    "endedAt": _now_iso(self._clock),
                    "failureReason": {"category": category, "detail": detail},
                },
            )
            self._pump_locked()
            return self._view_locked(run)

    def progress(self, run_id: str, value) -> None:
        """Best-effort: progress is a courtesy, never a reason to fail a run."""
        with self._lock:
            run = self._find_locked(run_id)
            if run is None or run.get("status") != "running":
                return
            run["progress"] = value
            try:
                self._persist_locked()
            except PersistFailed:
                pass

    def cancel(
        self, run_id: str, *, project=_MISSING, grace_seconds: float = 5.0
    ) -> dict:
        """Stop it for real, or say honestly that we could not.

        Pre-execution states cancel INSTANTLY — they hold no process, so there is
        nothing to deliver a signal to. Only `running` passes through
        `cancelling`, because killing a process tree takes time and CAN FAIL, and
        a cancel that failed must never be reported as a cancel that worked
        (contract §5.4 rule 3).
        """
        with self._lock:
            run = self._require_locked(run_id, project)
            status = run.get("status")
            if status in TERMINAL_STATUSES:
                # A finished run is not retroactively cancelled. Rewriting a real
                # outcome to match a late request would falsify history.
                return self._view_locked(run, note="这次运行已经结束，未被取消")
            if status in ("awaiting_confirmation", "queued", "awaiting_input"):
                self._commit_locked(
                    run,
                    {"status": "cancelled", "endedAt": _now_iso(self._clock)},
                )
                self._pump_locked()
                return self._view_locked(run)
            self._commit_locked(
                run,
                {
                    "status": "cancelling",
                    "cancelRequestedAt": _now_iso(self._clock),
                    # PENDING until a terminator reports. Absent meant a worker
                    # landing in the meantime read "not False" as success and
                    # published a `cancelled` nobody had verified (codex review,
                    # round 15).
                    "cancelKillVerified": None,
                },
            )
            handle = self._handles.get(run_id)
        # terminate OUTSIDE the lock: killing a tree can block, and holding the
        # single lock through it would stall every other run's bookkeeping
        try:
            killed = self._terminate(handle)
            kill_error = None
        except Exception as exc:  # noqa: BLE001
            killed, kill_error = False, str(exc)[:300]
        with self._lock:
            run = self._find_locked(run_id)
            if run is not None:
                # The verdict is REMEMBERED, not discarded. Otherwise the worker
                # ending (because the direct child died) landed a clean
                # `cancelled` even though the tree kill had reported failure —
                # descendants could still be alive (codex review, round 14).
                #
                # A CONFIRMED kill is never downgraded: `on_spawn` may have
                # terminated the process a moment earlier and recorded True,
                # while the `handle` we read was still None — writing our stale
                # False over it left a genuinely dead run stuck in `cancelling`,
                # holding a slot until restart (codex review, round 16).
                if killed is True:
                    run["cancelKillVerified"] = True
                    # …and if the worker already finished while we were killing
                    # outside the lock, NOTHING else will ever move this run:
                    # `_land_locked` has run, and it refused to finalise because
                    # the verdict was not yet in. Finish it here, or a
                    # successfully killed run holds a slot until restart (codex
                    # review, round 23).
                    if (
                        run.get("status") == "cancelling"
                        and run_id not in self._threads
                    ):
                        run["status"] = "cancelled"
                        run["endedAt"] = _now_iso(self._clock)
                        self._handles.pop(run_id, None)
                elif handle is not None and run.get("cancelKillVerified") is not True:
                    run["cancelKillVerified"] = False
        deadline = self._clock() + max(0.0, grace_seconds)
        while self._clock() < deadline:
            with self._lock:
                run = self._find_locked(run_id)
                if run is None or run.get("status") in TERMINAL_STATUSES:
                    break
            time.sleep(0.05)
        with self._lock:
            run = self._require_locked(run_id, project)
            if run.get("status") == "cancelling":
                # STILL not gone. Stay in `cancelling` and say why — a process
                # that is still burning subscription capacity reported as
                # "cancelled" is worse than one honestly reported as "cancelling".
                run["cancelFailure"] = {
                    "detail": kill_error
                    or f"子进程未在 {grace_seconds:g} 秒内退出，取消尚未确认",
                    "at": _now_iso(self._clock),
                }
                self._persist_locked()
            return self._view_locked(run)

    def get(self, run_id: str, *, project=_MISSING) -> dict:
        with self._lock:
            return self._view_locked(self._require_locked(run_id, project))

    def list(self, *, project, status=None, task_type=None, limit=100) -> list[dict]:
        """Runs of ONE project. `project` is required by signature, not by
        convention: "no project means everything" is exactly the path that lets
        another project's runs appear on this project's board (contract §5.5)."""
        with self._lock:
            out = []
            for r in self._runs:
                if r.get("projectId") != project:
                    continue
                if status and r.get("status") != status:
                    continue
                if task_type and r.get("taskType") != task_type:
                    continue
                out.append(self._view_locked(r))
            out.sort(key=lambda r: _as_int(r.get("queueSeq")), reverse=True)
            return out[: max(1, int(limit))]

    def list_unowned(self, limit=100) -> list[dict]:
        """The legacy, project-less runs. They appear ONLY in ⚙ diagnostics —
        never on a project page, because they belong to no project."""
        with self._lock:
            out = [
                self._view_locked(r) for r in self._runs if r.get("projectId") is None
            ]
            out.sort(key=lambda r: _as_int(r.get("queueSeq")), reverse=True)
            return out[: max(1, int(limit))]

    def stop_accepting(self) -> None:
        """Refuse new work and stop pumping the queue — WITHOUT killing anything.

        Shutdown has to do this FIRST (codex review, round 6). If children are
        killed while the pump is still live, a worker finishing in between starts
        the next queued run, and that brand-new child is not in the snapshot that
        was just killed — it outlives the backend.
        """
        with self._lock:
            self._closed = True

    def close(self, *, terminate=True) -> None:
        """Shut down: KILL FIRST, then write the records (contract §5.9a).

        The order is not a preference. Writing the records first and crashing
        mid-shutdown leaves "record says finished, process still running" — a
        lying journal plus an orphan burning capacity, which is worse than either
        alone because the board reports nothing is happening here.
        """
        with self._lock:
            self._closed = True
            handles = list(self._handles.items())
        # Track PER RUN whether the kill actually succeeded. Swallowing the
        # failure and then writing `childExitVerified: True` would put a claim in
        # the durable journal that nobody checked — the exact pretence §5.4 rule 3
        # forbids, and worse here because the journal outlives the process that
        # wrote it (codex review, round 2).
        killed: dict[str, bool] = {}

        def _record(run_id, verdict):
            # Written IMMEDIATELY, under the lock. Recording verdicts only after
            # the whole loop let a worker land its shutdown failure first, read
            # an unset `cancelKillVerified`, and publish a confirmed clean kill
            # as unverified (codex review, round 20).
            with self._lock:
                run = self._find_locked(run_id)
                if run is not None:
                    run["cancelKillVerified"] = verdict

        for run_id, handle in handles:
            try:
                # The terminator REPORTS whether the process actually exited.
                # Treating "it did not raise" as proof was wrong: the kill path
                # deliberately swallows its own errors so a failed kill cannot
                # mask the timeout being reported, so not-raising says nothing
                # at all (codex review, round 9).
                # Only an explicit True is evidence. `None` (no terminator
                # configured) is not a kill, and treating it as one wrote an
                # unfounded `childExitVerified: true` into the durable record
                # (codex review, round 14).
                killed[run_id] = self._terminate(handle) is True
            except Exception:  # noqa: BLE001 - shutdown must not raise
                killed[run_id] = False
            _record(run_id, killed[run_id])
        if not terminate:
            return
        with self._lock:
            self._handles.clear()
            for r in self._runs:
                if r.get("status") in ("running", "cancelling"):
                    verified = killed.get(r["runId"], False)
                    r["status"] = "failed"
                    r["endedAt"] = _now_iso(self._clock)
                    r["failureReason"] = {
                        "category": FAILURE_BACKEND_RESTARTED,
                        "detail": (
                            "后端已退出，这次运行随之终止。"
                            if verified
                            else "后端已退出；**未能确认**它的子进程已终止。"
                        ),
                        "childExitVerified": verified,
                    }
                    if not verified and produces_external_side_effects(
                        r.get("executor") or ""
                    ):
                        r["sideEffect"] = "unknown"
            try:
                self._persist_locked()
            except PersistFailed:
                pass

    # -- internals ----------------------------------------------------------- #

    def _find_locked(self, run_id):
        for r in self._runs:
            if r.get("runId") == run_id:
                return r
        return None

    def _require_locked(self, run_id, project):
        run = self._find_locked(run_id)
        if run is None:
            raise RunNotFound("unknown run")
        # A run of another project is reported as ABSENT, not as forbidden.
        # `_MISSING` distinguishes "caller named no project" (diagnostics) from
        # "caller named a different project" (isolation).
        if project is not _MISSING and run.get("projectId") != project:
            raise RunNotFound("unknown run")
        return run

    def _view_locked(self, run: dict, note=None) -> dict:
        out = dict(run)
        out["queuePosition"] = self._queue_position_locked(run)
        if note:
            out["cancelNote"] = note
        return out


def _classify(exc: BaseException) -> dict:
    """Map a runner failure onto the contract's categories.

    The kinds stay APART because the creator's next action differs for each:
    install/log in, retry, fix the skill. Collapsing them into "it failed" leaves
    them guessing which.
    """
    import subprocess  # noqa: PLC0415 - only needed for the type check

    # `_executor_argv` raises FileNotFoundError with OUR OWN actionable text
    # (which env var to set); anything else is an OS message that can carry
    # absolute paths and usernames, so only ours is forwarded (codex review,
    # round 8 — the same rule already applied to OSError in round 2).
    if isinstance(exc, FileNotFoundError):
        detail = str(exc)
        ours = "MOTV_RUNTIME_" in detail or "没有「完全无工具」模式" in detail
        return {
            "category": "unavailable",
            "detail": detail[:300] if ours else "执行器不可用（未找到可执行体）",
        }
    if isinstance(exc, PermissionError):
        # its message embeds the CLI's own output — say WHAT happened, not what
        # the tool printed
        return {"category": "unauthenticated", "detail": "执行器未登录，请先登录一次"}
    if isinstance(exc, subprocess.TimeoutExpired):
        return {
            "category": "timeout",
            # NOT `str(exc)`: it embeds the resolved command line, which is an
            # absolute local path (codex review, round 9). The timeout value is
            # the actionable part and carries nothing about this machine.
            "detail": f"执行器超过 {exc.timeout} 秒未返回",
            # a timeout happens AFTER the request went out: for an external
            # provider we cannot know whether it ran (§5.8)
            "sideEffect": "unknown",
        }
    if isinstance(exc, RunStoreError):
        return {"category": exc.category, "detail": exc.detail}
    if getattr(exc, "motv_invalid_output", False):
        # The executor answered, but not in the required shape. Distinct from a
        # crash: the fix is the prompt or the answer, not the environment. Its
        # message is OURS (a parser reason plus a bounded excerpt of the model's
        # own answer), so it is safe to pass through.
        #
        # Matched on an explicit MARKER, not on `ValueError` (codex review round
        # 4): any incidental ValueError from inside the runner would otherwise be
        # relabelled as bad model output AND have its message forwarded — the
        # same disclosure hole closed for OSError, one type over.
        return {"category": "invalid_output", "detail": str(exc)[:800]}
    # A generic failure carries the TYPE only, never the message.
    #
    # `_run_executor` embeds the CLI's merged stdout/stderr in its OSError, and
    # that text can contain local absolute paths, environment details, or
    # whatever the tool decided to print. It goes into a DURABLE record and into
    # an HTTP response; the endpoint it replaced deliberately reported only
    # `unexpected <Type>` for exactly this reason (codex review, round 2).
    #
    # The full text is not lost — it is what the creator sees in the executor's
    # own terminal — it simply does not travel through this surface.
    return {
        "category": "execution_error",
        "detail": f"执行器异常（{type(exc).__name__}）；详情见执行器自身的输出",
    }
