"""Run registry unit tests — TASK-072 批次一 (creator-system-contract §5.0–§5.9).

STRICTLY OFFLINE. No HTTP, no subprocess, no spend: the store takes an injected
``runner``/``terminator``, which is exactly what TASK-072 §0.1 asked for — the
concurrency / cancel / restart protocol is the part that most needs isolated
tests, so it must be testable without launching a CLI.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import runstore  # noqa: E402 - path injected above


def _store(tmp_path, **kw):
    kw.setdefault("max_concurrent", 2)
    return runstore.RunStore(tmp_path / "runs.json", **kw)


def _mk(store, **kw):
    kw.setdefault("kind", "skill")
    kw.setdefault("task_type", "skill.story-development")
    # a LOCAL executor by default: `manual` is executed by a person, so it never
    # queues and is never handed to the runner — which is right, but makes it the
    # wrong default for tests about the queue, the runner or cancellation
    kw.setdefault("executor", "claude-code")
    kw.setdefault("project_id", "P1")
    return store.create(**kw)


# --- vocabulary ------------------------------------------------------------- #


def test_the_eight_statuses_and_four_dispositions_are_the_contract() -> None:
    assert runstore.RUN_STATUSES == (
        "awaiting_confirmation",
        "queued",
        "running",
        "awaiting_input",
        "cancelling",
        "cancelled",
        "succeeded",
        "failed",
    )
    assert runstore.DISPOSITIONS == ("pending", "accepted", "rejected", "superseded")
    # awaiting_input / awaiting_confirmation are HOSTED BY THE CREATOR, so a
    # backend restart takes nothing from them
    assert runstore.SWEEP_EXEMPT_STATUSES == {"awaiting_input", "awaiting_confirmation"}


def test_executor_is_a_closed_set_with_one_parametrised_form() -> None:
    for good in (
        "claude-code",
        "codex-cli",
        "manual",
        "local-piper",
        "local-ffmpeg",
        "provider:minimax",
    ):
        assert runstore.is_valid_executor(good), good
    for bad in ("", None, "claude", "gpt", "provider:", "provider:   ", "local-magic"):
        assert not runstore.is_valid_executor(bad), bad
    # the prefix is what marks "can bill you", and nothing else does
    assert runstore.produces_external_side_effects("provider:minimax")
    for local in ("claude-code", "local-ffmpeg", "manual", "local-piper"):
        assert not runstore.produces_external_side_effects(local)


# --- identity, project ownership, isolation --------------------------------- #


def test_a_new_run_gets_an_id_immediately_and_starts_queued(tmp_path) -> None:
    st = _store(tmp_path)
    r = _mk(st)
    assert r["runId"].startswith("run-")
    assert r["status"] == "queued"  # no runner injected -> nothing pumps it
    assert r["queuePosition"] == 1
    assert r["projectId"] == "P1"
    assert r["sideEffect"] == "none"
    # subscription cost is recorded as 0 WITH a basis; an absent cost would be
    # read as "we don't know"
    assert r["cost"]["amount"] == 0 and r["cost"]["basis"] == "subscription"


def test_a_non_legacy_call_without_a_project_is_refused_not_guessed(tmp_path) -> None:
    st = _store(tmp_path)
    with pytest.raises(runstore.InvalidRun):
        st.create(kind="skill", task_type="skill.x", executor="manual")
    # …and the legacy path is explicit about what it is
    legacy = st.create(
        kind="skill", task_type="skill.x", executor="manual", legacy_no_project=True
    )
    assert legacy["projectId"] is None
    assert legacy["origin"] == "legacy_no_project"


def test_unknown_kind_or_executor_is_refused(tmp_path) -> None:
    st = _store(tmp_path)
    with pytest.raises(runstore.InvalidRun):
        _mk(st, kind="sorcery")
    with pytest.raises(runstore.InvalidRun):
        _mk(st, executor="gpt-cli")
    with pytest.raises(runstore.InvalidRun):
        _mk(st, task_type="")


def test_runs_of_another_project_are_invisible_and_report_404_not_403(tmp_path) -> None:
    """Contract §5.5: cross-project isolation. `not found`, never `forbidden` —
    403 would confirm the id exists, which is itself the leak."""
    st = _store(tmp_path)
    a = _mk(st, project_id="A")
    _mk(st, project_id="B")
    assert [r["runId"] for r in st.list(project="A")] == [a["runId"]]
    assert len(st.list(project="B")) == 1
    with pytest.raises(runstore.RunNotFound):
        st.get(a["runId"], project="B")
    with pytest.raises(runstore.RunNotFound):
        st.cancel(a["runId"], project="B")
    # a legacy project-less run belongs to NO project page
    legacy = st.create(
        kind="skill", task_type="skill.x", executor="manual", legacy_no_project=True
    )
    assert legacy["runId"] not in [r["runId"] for r in st.list(project="A")]
    assert legacy["runId"] in [r["runId"] for r in st.list_unowned()]


# --- confirmation comes BEFORE the queue ------------------------------------ #


def test_confirmation_happens_before_queuing_not_after(tmp_path) -> None:
    """ADR-0066 §6 校正 2. A task the user has not approved must not be holding
    a slot — the slot is the scarce resource on this machine."""
    st = _store(tmp_path)
    r = _mk(st, needs_confirmation=True)
    assert r["status"] == "awaiting_confirmation"
    assert r["queuePosition"] is None  # not queued, so it has no position
    after = st.confirm(r["runId"], project="P1")
    assert after["status"] == "queued"
    assert after["confirmation"]["by"] == "user"


# --- queue ------------------------------------------------------------------ #


def test_over_the_limit_runs_queue_with_a_visible_position_and_are_not_dropped(
    tmp_path,
) -> None:
    release = threading.Event()

    def runner(run, on_spawn, is_cancelled):
        release.wait(5)
        return {"text": "ok"}, None

    st = _store(tmp_path, max_concurrent=2, runner=runner)
    made = [_mk(st, project_id="P1") for _ in range(4)]
    time.sleep(0.2)
    live = {r["runId"]: r for r in st.list(project="P1")}
    running = [r for r in live.values() if r["status"] == "running"]
    queued = sorted(
        (r for r in live.values() if r["status"] == "queued"),
        key=lambda r: r["queuePosition"],
    )
    assert len(running) == 2, "the concurrency cap must hold"
    assert len(queued) == 2, "excess work QUEUES — it is never dropped"
    assert [r["queuePosition"] for r in queued] == [1, 2]
    release.set()
    _wait_all_terminal(st, [r["runId"] for r in made])
    assert all(
        st.get(r["runId"], project="P1")["status"] == "succeeded" for r in made
    ), "every queued run eventually runs"


def test_the_slot_pool_is_shared_with_callers_outside_the_store(tmp_path) -> None:
    """codex review round 11: the synchronous route held its own semaphore, so
    mixed traffic could run twice the configured number of local CLIs."""
    release = threading.Event()

    def runner(run, on_spawn, is_cancelled):
        release.wait(5)
        return {}, None

    st = _store(tmp_path, max_concurrent=2, runner=runner)
    assert st.try_acquire_slot() is True
    assert st.try_acquire_slot() is True
    assert st.try_acquire_slot() is False, "the cap is the cap, whoever asks"
    # …and a run cannot start while those externally-held slots are out
    r = _mk(st)
    time.sleep(0.15)
    assert st.get(r["runId"])["status"] == "queued"
    st.release_slot()
    time.sleep(0.15)
    assert st.get(r["runId"])["status"] == "running", "a freed slot starts the queue"
    release.set()
    st.release_slot()


def test_queue_position_is_derived_never_persisted(tmp_path) -> None:
    """Contract §5.6: a stored position is wrong the moment another run ends,
    and it looks like a fact while being wrong."""
    st = _store(tmp_path)
    first = _mk(st)
    second = _mk(st)
    assert st.get(second["runId"], project="P1")["queuePosition"] == 2
    on_disk = json.loads((tmp_path / "runs.json").read_text("utf-8"))
    for row in on_disk["runs"]:
        assert "queuePosition" not in row, "position must not be written down"
        assert isinstance(row["queueSeq"], int), "the SEQUENCE is what persists"
    st.cancel(first["runId"], project="P1")
    assert st.get(second["runId"], project="P1")["queuePosition"] == 1


# --- idempotency ------------------------------------------------------------ #


def test_the_same_intent_in_flight_returns_the_same_run(tmp_path) -> None:
    st = _store(tmp_path)
    a = _mk(st, idempotency_key="k1")
    b = _mk(st, idempotency_key="k1")
    assert a["runId"] == b["runId"], "double click / retry / second tab = one run"
    assert len(st.list(project="P1")) == 1


def test_a_paid_success_refuses_to_silently_run_again(tmp_path) -> None:
    """Contract §5.7 rule 2: spending again must be a NEW, explicit decision."""
    st = _store(tmp_path)
    r = st.create(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="paid-1",
    )
    st.await_input(r["runId"], project="P1")
    st.submit_input(r["runId"], {"url": "x"}, project="P1")
    with pytest.raises(runstore.InvalidRun) as err:
        st.create(
            kind="image-gen",
            task_type="generation.image.minimax",
            executor="provider:minimax",
            project_id="P1",
            idempotency_key="paid-1",
        )
    assert "费用" in str(err.value)
    # an EXPLICIT retry is allowed, and starts its own clean side-effect ledger
    again = st.create(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="paid-1",
        retry_of_run_id=r["runId"],
    )
    assert again["runId"] != r["runId"]
    assert again["retryOfRunId"] == r["runId"]
    assert again["sideEffect"] == "none"


def test_a_paid_run_without_an_idempotency_key_is_refused(tmp_path) -> None:
    """codex review round 9: every duplicate-spend guard is keyed, so without a
    key a `provider:*` run has none of them — a replayed request is simply a
    second charge."""
    st = _store(tmp_path)
    with pytest.raises(runstore.InvalidRun) as err:
        st.create(
            kind="image-gen",
            task_type="generation.image.minimax",
            executor="provider:minimax",
            project_id="P1",
        )
    assert "idempotencyKey" in str(err.value)


def test_an_idempotency_key_never_matches_across_projects(tmp_path) -> None:
    """codex review round 1: a key is unique only within the project that minted
    it. Matching globally would hand project B a live run belonging to project A
    — a data leak AND the wrong answer, since two projects doing "the same"
    thing are two different jobs."""
    st = _store(tmp_path)
    a = _mk(st, project_id="A", idempotency_key="shared")
    b = _mk(st, project_id="B", idempotency_key="shared")
    assert a["runId"] != b["runId"], "same key, different projects = different runs"
    assert b["projectId"] == "B"
    # …and the paid-refusal is scoped the same way
    paid_a = st.create(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="A",
        idempotency_key="paid",
    )
    st.await_input(paid_a["runId"], project="A")
    st.submit_input(paid_a["runId"], {"url": "x"}, project="A")
    # project B is NOT blocked by project A's spend
    paid_b = st.create(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="B",
        idempotency_key="paid",
    )
    assert paid_b["runId"] != paid_a["runId"]


def test_a_started_run_is_persisted_before_the_work_begins(tmp_path) -> None:
    """codex review round 1: if the journal still said `queued` while a process
    was already running, a crash there would leave a record saying the work never
    began — and for a paid kind that is exactly when an automatic retry looks
    safe and charges twice."""
    seen = []

    def runner(run, on_spawn, is_cancelled):
        on_disk = json.loads((tmp_path / "runs.json").read_text("utf-8"))
        seen.append(
            next(r["status"] for r in on_disk["runs"] if r["runId"] == run["runId"])
        )
        return {"text": "ok"}, None

    st = _store(tmp_path, runner=runner)
    r = _mk(st)
    _wait_all_terminal(st, [r["runId"]])
    assert seen == ["running"], (
        "the journal must already say `running` by the time the work starts"
    )


def test_a_paid_retry_must_name_the_real_prior_run(tmp_path) -> None:
    """codex review round 6: accepting any truthy `retryOfRunId` made the
    duplicate-spend guard decoration — `retryOfRunId: "x"` walked straight past
    it and charged again."""
    st = _store(tmp_path)
    paid = dict(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="k",
    )
    first = st.create(**paid)
    st.await_input(first["runId"], project="P1")
    st.submit_input(first["runId"], {"url": "x"}, project="P1")
    with pytest.raises(runstore.InvalidRun) as err:
        st.create(**paid, retry_of_run_id="totally-made-up")
    assert "不是这个操作的既有运行" in str(err.value)
    # …and naming the REAL prior run authorises exactly one more attempt
    again = st.create(**paid, retry_of_run_id=first["runId"])
    assert again["retryOfRunId"] == first["runId"]


def test_an_unknown_side_effect_blocks_a_replay_like_a_success(tmp_path) -> None:
    """codex review round 10: a timed-out provider request MAY already have been
    charged — that is what `unknown` means — so replaying it freely is exactly
    the double charge the field exists to prevent."""
    st = _store(tmp_path)
    paid = dict(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="k",
    )
    first = st.create(**paid)
    with st._lock:  # noqa: SLF001 - the state a timed-out provider call leaves
        rec = st._find_locked(first["runId"])
        rec["status"] = "failed"
        rec["sideEffect"] = "unknown"
        st._persist_locked()
    with pytest.raises(runstore.InvalidRun) as err:
        st.create(**paid)
    assert "可能已经执行过" in str(err.value)


def test_spend_bearing_history_is_never_trimmed_away(tmp_path) -> None:
    """codex review round 10: the duplicate-charge guard reads history, so
    trimming those records quietly re-opens the replay it blocks."""
    st = _store(tmp_path, history_limit=2)
    paid = dict(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="old",
    )
    old = st.create(**paid)
    st.await_input(old["runId"], project="P1")
    st.submit_input(old["runId"], {"url": "x"}, project="P1")
    for _ in range(5):  # push far past the limit with ordinary local runs
        r = _mk(st, executor="manual")
        st.submit_input(r["runId"], {"text": "x"}, project="P1")
    with pytest.raises(runstore.InvalidRun):
        st.create(**paid)  # the guard still sees the old paid run


def test_a_local_run_records_no_external_side_effect(tmp_path) -> None:
    """codex review round 10: `applied` asserts an EXTERNAL effect. A local
    executor never leaves this machine, so claiming it put a false statement in
    the audit trail and in the data the retry rules read."""
    st = _store(tmp_path)
    r = _mk(st, executor="manual")
    st.submit_input(r["runId"], {"text": "x"}, project="P1")
    assert st.get(r["runId"], project="P1")["sideEffect"] == "none"


def test_a_retry_authorisation_is_spent_once(tmp_path) -> None:
    """codex review round 8: replaying the same request replayed the
    authorisation, and every replay was another provider charge."""
    st = _store(tmp_path)
    paid = dict(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="k",
    )
    first = st.create(**paid)
    st.await_input(first["runId"], project="P1")
    st.submit_input(first["runId"], {"url": "x"}, project="P1")
    retry = st.create(**paid, retry_of_run_id=first["runId"])
    st.await_input(retry["runId"], project="P1")
    st.submit_input(retry["runId"], {"url": "y"}, project="P1")
    with pytest.raises(runstore.InvalidRun) as err:
        st.create(**paid, retry_of_run_id=first["runId"])
    assert "已经被用过一次" in str(err.value)


def test_a_failed_write_does_not_drop_records_from_memory(tmp_path) -> None:
    """codex review round 8: trimming memory before the write succeeded meant a
    transient failure lost records, and the next successful write committed the
    loss permanently."""
    st = _store(tmp_path, history_limit=2)
    made = []
    for _ in range(4):
        r = _mk(st, executor="manual")
        st.submit_input(r["runId"], {"text": "x"}, project="P1")
        made.append(r["runId"])
    original = st._persist_locked

    def boom():
        raise runstore.PersistFailed("disk full")

    kept_before = len(st._runs)
    st._persist_locked = boom
    try:
        with pytest.raises(runstore.PersistFailed):
            st.create(
                kind="skill",
                task_type="skill.x",
                executor="manual",
                project_id="P1",
            )
    finally:
        st._persist_locked = original
    assert len(st._runs) == kept_before, "a failed write must not delete history"


def test_history_trimming_keeps_the_most_recently_finished(tmp_path) -> None:
    """codex review round 6: trimming by creation order dropped a long run the
    moment it finally finished — the client polling its valid id got a 404
    instead of the result it had been waiting for."""
    st = _store(tmp_path, history_limit=3)
    old = _mk(st, executor="manual")  # created first, finishes LAST
    for _ in range(4):
        r = _mk(st, executor="manual")
        st.submit_input(r["runId"], {"text": "x"}, project="P1")
    st.submit_input(old["runId"], {"text": "the long one"}, project="P1")
    assert st.get(old["runId"], project="P1")["outputs"] == {"text": "the long one"}


def test_a_free_kind_may_be_rerun_with_the_same_key(tmp_path) -> None:
    st = _store(tmp_path)
    r = _mk(st, idempotency_key="free-1")
    st.await_input(r["runId"], project="P1")
    st.submit_input(r["runId"], {"text": "x"}, project="P1")
    again = _mk(st, idempotency_key="free-1")
    assert again["runId"] != r["runId"], "re-rendering locally costs nothing"


# --- manual execution ------------------------------------------------------- #


def test_manual_work_waits_in_awaiting_input_not_in_running(tmp_path) -> None:
    st = _store(tmp_path)
    r = _mk(st, executor="manual")
    assert r["status"] == "awaiting_input", "a manual run starts there"
    waiting = st.await_input(r["runId"], project="P1")
    assert waiting["status"] == "awaiting_input"
    done = st.submit_input(r["runId"], {"text": "pasted back"}, project="P1")
    assert done["status"] == "succeeded"
    assert done["outputs"] == {"text": "pasted back"}
    assert done["progress"] == 100


def test_a_manual_run_never_queues_and_is_never_handed_to_the_runner(tmp_path) -> None:
    """codex review round 3: a `manual` run is executed by a PERSON. Queuing it
    let the runner pick it up and fail it before the caller could park it in
    `awaiting_input` — breaking the manual fallback exactly when it is needed,
    i.e. when no runtime is available. It also has no business occupying a slot
    that bounds MACHINE capacity."""
    handed = []

    def runner(run, on_spawn, is_cancelled):
        handed.append(run["runId"])
        raise OSError("a person was supposed to do this")

    st = _store(tmp_path, max_concurrent=1, runner=runner)
    manual = _mk(st, executor="manual")
    assert manual["status"] == "awaiting_input", "straight to waiting-for-a-person"
    time.sleep(0.2)
    assert handed == [], "the runner must never be given a manual run"
    # …and it does not consume the slot: real work still starts
    local = _mk(st, executor="claude-code")
    time.sleep(0.2)
    assert st.get(local["runId"])["status"] in ("running", "failed", "succeeded")
    # …and parking it explicitly is idempotent
    assert st.await_input(manual["runId"], project="P1")["status"] == "awaiting_input"


def test_awaiting_input_can_be_cancelled_directly(tmp_path) -> None:
    """No process exists, so there is nothing to deliver a signal to: it is
    cancelled at once and never passes through `cancelling`."""
    st = _store(tmp_path)
    r = _mk(st, executor="manual")
    out = st.cancel(r["runId"], project="P1")
    assert out["status"] == "cancelled"


# --- restart sweep ---------------------------------------------------------- #


def test_a_confirmed_manual_run_goes_to_the_person_not_the_queue(tmp_path) -> None:
    """codex review round 4: the pump skips manual executors, so sending a
    confirmed manual run to `queued` left it in a state it could never leave."""
    st = _store(tmp_path)
    r = _mk(st, executor="manual", needs_confirmation=True)
    assert r["status"] == "awaiting_confirmation"
    after = st.confirm(r["runId"], project="P1")
    assert after["status"] == "awaiting_input"


def test_a_malformed_queue_sequence_does_not_crash_startup(tmp_path) -> None:
    """codex review round 4: the corrupt-journal path exists so a bad file
    degrades instead of taking the backend down — an `int()` on a hand-written
    value defeated it for syntactically valid JSON."""
    (tmp_path / "runs.json").write_text(
        json.dumps(
            {
                "v": 1,
                "runs": [
                    {
                        "runId": "run-x",
                        "queueSeq": "not-a-number",
                        "status": "succeeded",
                        "projectId": "P1",
                        "proposal": None,
                    }
                ],
            }
        ),
        "utf-8",
    )
    st = _store(tmp_path)  # must not raise
    assert [r["runId"] for r in st.list(project="P1")] == ["run-x"]


def test_restart_sweeps_running_but_never_touches_creator_hosted_runs(tmp_path) -> None:
    """Contract §5.4 rule 4 + §5.9a."""
    st = _store(tmp_path)
    running = _mk(st, project_id="P1")
    queued = _mk(st, project_id="P1")
    manual = _mk(st, project_id="P1")
    confirm = _mk(st, project_id="P1", needs_confirmation=True)
    st.await_input(manual["runId"], project="P1")
    # simulate a process that was mid-flight when the backend died
    with st._lock:  # noqa: SLF001 - constructing the pre-crash state on purpose
        st._find_locked(running["runId"])["status"] = "running"
        st._find_locked(running["runId"])["executor"] = "claude-code"
        st._persist_locked()

    reborn = _store(tmp_path)  # a NEW process reading the same journal
    got = {r["runId"]: r for r in reborn.list(project="P1")}
    assert got[running["runId"]]["status"] == "failed"
    assert (
        got[running["runId"]]["failureReason"]["category"]
        == runstore.FAILURE_BACKEND_RESTARTED
    )
    # a `running` run's child could not be verified -> say so, do not claim it
    assert got[running["runId"]]["failureReason"]["childExitVerified"] is False
    # a QUEUED run never had a process, so its exit IS verified
    assert got[queued["runId"]]["status"] == "failed"
    assert got[queued["runId"]]["failureReason"]["childExitVerified"] is True
    # …and the two creator-hosted states are untouched
    assert got[manual["runId"]]["status"] == "awaiting_input"
    assert got[confirm["runId"]]["status"] == "awaiting_confirmation"


def test_an_unverifiable_paid_run_is_swept_to_side_effect_unknown(tmp_path) -> None:
    """Contract §5.8: "I don't know if it ran" forbids automatic retry."""
    st = _store(tmp_path)
    r = st.create(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="sweep",
    )
    with st._lock:  # noqa: SLF001
        st._find_locked(r["runId"])["status"] = "running"
        st._persist_locked()
    reborn = _store(tmp_path)
    got = reborn.get(r["runId"], project="P1")
    assert got["status"] == "failed"
    assert got["sideEffect"] == "unknown"


def test_the_sweep_never_kills_by_a_stale_pid(tmp_path) -> None:
    """Contract §5.9a. PIDs are REUSED — that number may now be the user's
    browser. The sweep therefore terminates nothing at all; orphans are
    prevented at launch instead."""
    killed = []
    st = _store(tmp_path)
    r = _mk(st)
    with st._lock:  # noqa: SLF001
        st._find_locked(r["runId"])["status"] = "running"
        st._find_locked(r["runId"])["process"] = {"pid": 4242, "argv0": "claude"}
        st._persist_locked()
    _store(tmp_path, terminator=killed.append)
    assert killed == [], "a restart must never signal a pid it did not spawn"


# --- cancel: the race ------------------------------------------------------- #


def test_cancel_terminates_the_real_handle_and_lands_cancelled(tmp_path) -> None:
    stop = threading.Event()
    spawned = threading.Event()
    killed = []

    def runner(run, on_spawn, is_cancelled):
        on_spawn("handle-1")
        spawned.set()
        stop.wait(5)
        raise OSError("killed")

    def terminator(handle):
        killed.append(handle)
        stop.set()
        return True  # a CONFIRMED kill — the real one returns this too

    st = _store(tmp_path, runner=runner, terminator=terminator)
    r = _mk(st)
    # wait for the SPAWN, not merely for `running`: the slot is reserved before
    # the worker thread is scheduled, so cancelling on `running` alone would be
    # testing the early-cancel race (covered separately) instead of delivery
    assert spawned.wait(5), "runner never started"
    out = st.cancel(r["runId"], project="P1")
    assert killed == ["handle-1"], "cancel must reach the real process"
    assert out["status"] == "cancelled"


def test_cancelling_before_the_process_spawns_lands_cancelled_and_kills_nothing(
    tmp_path,
) -> None:
    """The early-cancel race. `running` is reserved before the worker thread is
    scheduled, so a cancel can land in between. Nothing was spawned, so there is
    nothing to kill — and the run must NOT be stranded in `cancelling` with no
    process and no lander."""
    gate = threading.Event()
    killed = []

    def runner(run, on_spawn, is_cancelled):  # pragma: no cover - must not run
        gate.set()
        return {"text": "should never happen"}, None

    st = _store(tmp_path, runner=None, terminator=killed.append)
    r = _mk(st)  # queued; no runner yet, so nothing is pumped
    with st._lock:  # noqa: SLF001 - reproduce "slot reserved, thread not yet scheduled"
        st._find_locked(r["runId"])["status"] = "running"
    st._runner = runner  # noqa: SLF001
    st.cancel(r["runId"], project="P1", grace_seconds=0.1)
    st._work(r["runId"])  # noqa: SLF001 - the thread finally gets scheduled
    assert st.get(r["runId"], project="P1")["status"] == "cancelled"
    assert killed == [], "nothing was spawned, so nothing may be signalled"
    assert not gate.is_set(), "a cancelled run must not start work"


def test_a_cancel_that_cannot_kill_stays_cancelling_and_says_why(tmp_path) -> None:
    """Contract §5.4 rule 3. A process still burning subscription capacity,
    reported as `cancelled`, is worse than one honestly reported as `cancelling`."""
    release = threading.Event()
    spawned = threading.Event()

    def runner(run, on_spawn, is_cancelled):
        on_spawn("stubborn")
        spawned.set()
        release.wait(5)
        return {"text": "finished anyway"}, None

    st = _store(tmp_path, runner=runner, terminator=lambda h: None)  # kill does nothing
    r = _mk(st)
    assert spawned.wait(5)
    out = st.cancel(r["runId"], project="P1", grace_seconds=0.3)
    assert out["status"] == "cancelling", "an unconfirmed kill is NOT a cancel"
    assert out["cancelFailure"]["detail"]
    release.set()


def test_a_run_that_completes_during_cancellation_lands_cancelled_but_keeps_output(
    tmp_path,
) -> None:
    """Contract §5.9 race table row 2: the user asked it to stop, so the answer
    must not be silently adopted — but the bytes are kept, not destroyed."""
    release = threading.Event()
    spawned = threading.Event()

    def runner(run, on_spawn, is_cancelled):
        on_spawn("h")
        spawned.set()
        release.wait(5)
        return {"text": "landed anyway"}, None

    st = _store(tmp_path, runner=runner, terminator=lambda h: (release.set(), True)[1])
    r = _mk(st)
    assert spawned.wait(5)
    out = st.cancel(r["runId"], project="P1", grace_seconds=2.0)
    assert out["status"] == "cancelled"
    assert out["outputs"] == {"text": "landed anyway"}
    assert "不作为产物应用" in out["note"]


def test_an_unconfirmed_kill_keeps_the_run_in_cancelling(tmp_path) -> None:
    """codex review round 14: the worker ending (because the DIRECT child died)
    landed a clean `cancelled` even though the tree kill had reported failure —
    descendants could still be alive and spending."""
    release = threading.Event()
    spawned = threading.Event()

    def runner(run, on_spawn, is_cancelled):
        on_spawn("h")
        spawned.set()
        release.wait(5)
        raise OSError("direct child died, tree unknown")

    def terminator(handle):
        release.set()
        return False  # could not confirm the tree is gone

    st = _store(tmp_path, runner=runner, terminator=terminator)
    r = _mk(st)
    assert spawned.wait(5)
    st.cancel(r["runId"], project="P1", grace_seconds=0.5)
    time.sleep(0.3)
    got = st.get(r["runId"], project="P1")
    assert got["status"] == "cancelling", "an unconfirmed kill is NOT a cancel"
    assert got["cancelFailure"]["detail"]


def test_cancelling_a_finished_run_does_not_rewrite_history(tmp_path) -> None:
    st = _store(tmp_path)
    r = _mk(st)
    st.await_input(r["runId"], project="P1")
    st.submit_input(r["runId"], {"text": "done"}, project="P1")
    out = st.cancel(r["runId"], project="P1")
    assert out["status"] == "succeeded", "a terminal state is final"
    assert "未被取消" in out["cancelNote"]


def test_cancel_is_idempotent(tmp_path) -> None:
    st = _store(tmp_path)
    r = _mk(st)
    assert st.cancel(r["runId"], project="P1")["status"] == "cancelled"
    assert st.cancel(r["runId"], project="P1")["status"] == "cancelled"


# --- failure ---------------------------------------------------------------- #


def test_a_runner_failure_is_recorded_with_its_own_category(tmp_path) -> None:
    import subprocess

    cases = {
        FileNotFoundError("no claude"): "unavailable",
        PermissionError("not logged in"): "unauthenticated",
        subprocess.TimeoutExpired(["x"], 1): "timeout",
        OSError("boom"): "execution_error",
    }
    for exc, category in cases.items():

        def runner(run, on_spawn, is_cancelled, _e=exc):
            raise _e

        st = _store(tmp_path / category, runner=runner)
        (tmp_path / category).mkdir(exist_ok=True)
        r = _mk(st)
        _wait_all_terminal(st, [r["runId"]])
        got = st.get(r["runId"], project="P1")
        assert got["status"] == "failed"
        assert got["failureReason"]["category"] == category
        assert got["outputs"] is None, "a failure never becomes content"


def test_a_timeout_on_a_paid_executor_is_side_effect_unknown(tmp_path) -> None:
    import subprocess

    def runner(run, on_spawn, is_cancelled):
        raise subprocess.TimeoutExpired(["x"], 1)

    st = _store(tmp_path, runner=runner)
    r = st.create(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="timeout",
    )
    _wait_all_terminal(st, [r["runId"]])
    got = st.get(r["runId"], project="P1")
    # a timeout happens AFTER the request went out
    assert got["sideEffect"] == "unknown"


# --- persistence ------------------------------------------------------------ #


def test_state_survives_a_restart_and_the_file_is_the_only_source(tmp_path) -> None:
    st = _store(tmp_path)
    r = _mk(st)
    st.await_input(r["runId"], project="P1")
    reborn = _store(tmp_path)
    assert reborn.get(r["runId"], project="P1")["status"] == "awaiting_input"


def test_a_corrupt_journal_is_preserved_not_silently_replaced(tmp_path) -> None:
    (tmp_path / "runs.json").write_text("{not json", "utf-8")
    st = _store(tmp_path)
    assert st.list(project="P1") == []
    kept = list(tmp_path.glob("runs.json.corrupt-*"))
    assert kept, "the bytes must stay inspectable"
    assert kept[0].read_text("utf-8") == "{not json"
    # …and a SECOND corruption is preserved too, rather than overwriting the
    # first or being left to be silently replaced (codex review round 17)
    (tmp_path / "runs.json").write_text("{also broken", "utf-8")
    _store(tmp_path)
    kept2 = sorted(p.read_text("utf-8") for p in tmp_path.glob("runs.json.corrupt-*"))
    assert kept2 == ["{also broken", "{not json"]


def test_close_does_not_claim_a_kill_it_could_not_confirm(tmp_path) -> None:
    """codex review round 9: the kill path swallows its own errors on purpose,
    so "it did not raise" proves nothing — yet that was written into the durable
    record as `childExitVerified: true`."""
    release = threading.Event()
    spawned = threading.Event()

    def runner(run, on_spawn, is_cancelled):
        on_spawn("stubborn")
        spawned.set()
        release.wait(5)
        return {}, None

    # the terminator REPORTS failure rather than raising, exactly like _kill_tree
    st = _store(tmp_path, runner=runner, terminator=lambda h: False)
    r = _mk(st)
    assert spawned.wait(5)
    st.close()
    release.set()
    got = st.get(r["runId"], project="P1")
    assert got["failureReason"]["childExitVerified"] is False


def test_a_failed_terminal_write_releases_the_slot(tmp_path) -> None:
    """codex review round 9: rolling a terminal outcome back to `running` after
    the worker is gone meant nothing could ever move it again — it held a slot
    forever and every queued run stalled behind it."""
    st = _store(tmp_path, max_concurrent=1)
    r = _mk(st)
    with st._lock:  # noqa: SLF001 - reproduce a run mid-flight
        st._find_locked(r["runId"])["status"] = "running"
    original = st._persist_locked
    st._persist_locked = lambda: (_ for _ in ()).throw(
        runstore.PersistFailed("disk full")
    )
    try:
        st._work(r["runId"])  # noqa: SLF001 - land the outcome directly
    finally:
        st._persist_locked = original
    got = st.get(r["runId"], project="P1")
    assert got["status"] in runstore.TERMINAL_STATUSES, "the slot must be released"
    assert got["failureReason"]["category"] == "storage_error"


def test_shutdown_kills_first_then_writes_the_records(tmp_path) -> None:
    """Contract §5.9a: order is not a preference. Writing first and crashing
    leaves a lying journal plus an orphan."""
    order = []
    release = threading.Event()
    spawned = threading.Event()

    def runner(run, on_spawn, is_cancelled):
        on_spawn("child")
        spawned.set()
        release.wait(5)
        return {}, None

    def terminator(handle):
        order.append("killed")
        release.set()
        return True  # confirmed

    st = _store(tmp_path, runner=runner, terminator=terminator)
    r = _mk(st)
    assert spawned.wait(5), "runner never started"
    st.close()
    order.append("records-written")
    assert order[0] == "killed", "the process tree dies BEFORE the record is finalised"
    on_disk = json.loads((tmp_path / "runs.json").read_text("utf-8"))
    row = next(x for x in on_disk["runs"] if x["runId"] == r["runId"])
    assert row["status"] == "failed"
    assert row["failureReason"]["category"] == runstore.FAILURE_BACKEND_RESTARTED
    assert row["failureReason"]["childExitVerified"] is True


# --- helpers ---------------------------------------------------------------- #


def _wait_status(st, run_id, status, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if st.get(run_id)["status"] == status:
            return
        time.sleep(0.02)
    raise AssertionError(f"{run_id} never reached {status}: {st.get(run_id)['status']}")


def _wait_all_terminal(st, run_ids, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(st.get(i)["status"] in runstore.TERMINAL_STATUSES for i in run_ids):
            return
        time.sleep(0.02)
    raise AssertionError("runs did not settle")


# --- the frontend domain units --------------------------------------------- #


def test_frontend_run_units_via_node() -> None:
    """v15 状态拆分 / disposition / v14→v15 迁移 / 校验器 的前端单测。"""
    import shutil
    import subprocess

    if shutil.which("node") is None:
        pytest.skip("node not available")
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/runs.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        # node emits UTF-8; `text=True` alone would decode with the locale codec
        # and lose the failure output on a non-ASCII assertion message
        encoding="utf-8",
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
