"""Run API + legacy-agent-endpoint contract — TASK-072 批次一.

Drives the mockup backend's ``_App`` directly (no sockets, no browser).
STRICTLY OFFLINE: the Runtime layer is stubbed at ``_run_executor``, so no CLI is
ever launched and nothing is spent.

What is guarded here:

- the five legacy ``/api/agent/*`` creative endpoints go through the Runtime
  layer and the Run registry — ``_run_claude`` no longer exists (ADR-0065 决策 1);
- their DEFAULT response contract is byte-for-byte the old one, with additive
  fields only (contract §5.9c);
- the async contract returns ``202 {run_id}`` and NO product keys, and the
  product later appears under the SAME key;
- cross-project isolation, including 404-not-403;
- a canvas save cannot roll back a running task (contract §5.5).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import runstore  # noqa: E402 - path injected above

_RUNTIME_HEADERS = {"X-Motv-Runtime": "1"}
#: A breakdown the strict parser accepts: it refuses an empty one, because
#: "found nothing" is a failed extraction, not a valid proposal.
_BREAKDOWN_ANSWER = '{"characters":[{"name":"阿澈"}],"locations":[]}'
_ASYNC_HEADERS = {"X-Motv-Runtime": "1", "X-Motv-Async": "1"}
#: The SKILL's shape (TASK-075 §1.6): an object holding `shots`, not a bare
#: array. The endpoint's RESPONSE key is still `shots` — only what the model
#: is asked for changed.
#: A VALID `storyboard-director` answer. 景别 / 运镜 became required at
#: skillVersion 2 (TASK-078 §2.1), so a fixture without them is now refused by
#: the package's own contract — which is the point of the change, not a quirk of
#: this file.
_SHOTS_ANSWER = (
    '{"shots":[{"title":"t","description":"d",'
    '"shotSize":"中近景","cameraMotion":"固定机位","duration_seconds":6}]}'
)
#: A TEXT product as a creator would submit it — no model wrapper, because a
#: person has none to give.
_SCRIPT_TEXT = "【金銮殿·日】\n正文"
_OUTLINE_ANSWER = (
    '{"premise":"p","logline":"l","centralConflict":"c",'
    '"storyArc":"a","climax":"x","ending":"e"}'
)


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    """A fresh server module with an isolated run journal per test."""
    spec = importlib.util.spec_from_file_location(
        f"motv_server_runs_{tmp_path.name}", _MOCKUP_DIR / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_RUNS_PATH", tmp_path / "runs.json")
    monkeypatch.setattr(module, "_RUNS", None)
    return module


@pytest.fixture()
def stub_executor(srv, monkeypatch):
    """Replace the RUNTIME LAYER, not the CLI: there is no `_run_claude` to stub
    any more, which is exactly the point of TASK-072 §1.8."""
    seen = {"prompts": [], "answer": _OUTLINE_ANSWER}

    def fake(name, prompt, timeout, on_spawn=None):
        seen["prompts"].append(prompt)
        seen["executor"] = name
        if callable(seen.get("raise")):
            seen["raise"]()
        return seen["answer"], None

    monkeypatch.setattr(srv, "_run_executor", fake)
    # make claude-code look resolvable so the default executor is chosen
    monkeypatch.setattr(srv, "_executor_argv", lambda n: (["fake", n], "path"))
    return seen


def _post(app, path, payload, headers=None):
    resp = app.handle_post(path, json.dumps(payload).encode("utf-8"), headers or {})
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _get(app, path, headers=None):
    resp = app.handle(path, headers or {})
    return resp.status, json.loads(resp.body.decode("utf-8"))


# --- the legacy endpoints now run through the Runtime layer ----------------- #


def test_run_claude_is_gone_and_no_handler_can_call_it(srv) -> None:
    """ADR-0065 决策 1 / TASK-072 §4 第 4c 条: there is exactly ONE way to start
    an AI process. A dormant second launcher is an invitation to call it."""
    assert not hasattr(srv, "_run_claude")
    source = (_MOCKUP_DIR / "server.py").read_text("utf-8")
    body = source.split("def _creative_agent", 1)[1]
    assert "_run_executor" in source
    assert "_run_claude(" not in body


def test_the_five_creative_endpoints_keep_their_old_response_shape(
    srv, stub_executor
) -> None:
    """Compatibility (contract §5.9c): the promise is about the RESPONSE, and
    additive fields only. An un-migrated caller must not notice anything."""
    app = srv._App(None, None)
    stub_executor["answer"] = _SHOTS_ANSWER
    status, j = _post(app, "/api/agent/shots-draft", {"script": "剧本正文"})
    assert status == 200, j
    assert j["shots"][0]["title"] == "t"
    assert j["draft"] is True
    # additive only
    assert j["run_id"].startswith("run-")
    assert j["executor"] == "claude-code"
    assert "model" in j
    # `source` keeps the value it has always had for the case that used to be
    # the only case — an additive promise cannot change an existing value
    # (codex review round 1)
    assert j["source"] == "claude -p"


def test_every_creative_endpoint_produces_a_durable_run(srv, stub_executor) -> None:
    """The whole reason for §1.8: 「AI 生成的剧本 v3」 had no run to point at."""
    app = srv._App(None, None)
    cases = [
        (
            "/api/agent/story-develop",
            {"idea": "创意"},
            _OUTLINE_ANSWER,
            "skill.story-development",
        ),
        (
            "/api/agent/episode-plan",
            {
                "outline": {
                    "premise": "p",
                    "logline": "l",
                    "centralConflict": "c",
                    "storyArc": "a",
                    "climax": "x",
                    "ending": "e",
                }
            },
            '{"episodes":[{"epNumber":1,"title":"第一集","synopsis":"梗概"}]}',
            "skill.episode-plan",
        ),
        (
            "/api/agent/script-draft",
            {"idea": "创意"},
            '{"script":"正文"}',
            "skill.script-writer",
        ),
        (
            "/api/agent/shots-draft",
            {"script": "s"},
            _SHOTS_ANSWER,
            "skill.storyboard-director",
        ),
        (
            "/api/agent/bible-breakdown",
            {"script": "s"},
            _BREAKDOWN_ANSWER,
            "skill.script-breakdown",
        ),
    ]
    for path, payload, answer, task_type in cases:
        stub_executor["answer"] = answer
        status, j = _post(app, path, {**payload, "project": "P1"})
        assert status == 200, (path, j)
        run = srv.runs().get(j["run_id"], project="P1")
        assert run["taskType"] == task_type, path
        assert run["kind"] == "skill"
        assert run["status"] == "succeeded"
        assert run["executor"] == "claude-code"


def test_task_type_is_a_stable_machine_key_not_the_display_name(srv) -> None:
    """Contract §5.3 / TASK-072 §4 第 4d 条."""
    for slug, task_type in srv._AGENT_TASK_TYPES.items():
        assert task_type.startswith("skill."), slug
        assert " " not in task_type
        assert task_type.lower() == task_type
    # episode-plan deliberately has no catalog entry yet; the KEY is stable
    # regardless of how that design question is settled (contract §5.9b)
    assert srv._AGENT_TASK_TYPES["episode-plan"] == "skill.episode-plan"


def test_the_async_header_returns_a_run_id_and_no_product(srv, stub_executor) -> None:
    """Contract §5.9c rule 2: an async response carries NO product key. Two
    names (or two shapes) for one thing is the next parsing bug."""
    app = srv._App(None, None)
    stub_executor["answer"] = _SHOTS_ANSWER
    status, j = _post(
        app, "/api/agent/shots-draft", {"script": "s", "project": "P1"}, _ASYNC_HEADERS
    )
    assert status == 202
    assert j["run_id"]
    assert "shots" not in j
    run = _wait(srv, j["run_id"], project="P1")
    # …and the product arrives under the SAME key the sync response uses
    assert run["outputs"]["shots"][0]["title"] == "t"


def test_a_missing_runtime_offers_the_manual_route_instead_of_a_dead_end(
    srv, monkeypatch
) -> None:
    """ADR-0065 决策 2. 「装不上 CLI 就完全做不了」 is not an acceptable state."""
    monkeypatch.setattr(srv, "_executor_argv", lambda n: (None, "claude not on PATH"))
    app = srv._App(None, None)
    status, j = _post(app, "/api/agent/story-develop", {"idea": "x", "project": "P1"})
    assert status == 503
    assert j["error"]["category"] == "agent_unavailable"
    fallback = j["error"]["manual_fallback"]
    assert fallback["prompt"], "the creator must get the compiled prompt"
    # the run EXISTS and is waiting for a person — not `running`, not `failed`
    run = srv.runs().get(fallback["run_id"], project="P1")
    assert run["status"] == "awaiting_input"
    # …and bringing the answer back goes through the same contract
    status, j2 = _post(
        app,
        f"/api/runs/{fallback['run_id']}/submit",
        {
            "project": "P1",
            "outputs": {
                "outline": {
                    "premise": "p",
                    "logline": "l",
                    "centralConflict": "c",
                    "storyArc": "a",
                    "climax": "x",
                    "ending": "e",
                }
            },
        },
        _RUNTIME_HEADERS,
    )
    assert status == 200
    assert j2["status"] == "succeeded"


def test_a_bad_answer_is_a_failure_with_the_old_category(srv, stub_executor) -> None:
    app = srv._App(None, None)
    stub_executor["answer"] = "这是一段没有 JSON 的解释性文字。"
    status, j = _post(app, "/api/agent/shots-draft", {"script": "s"})
    assert status == 502
    assert j["error"]["category"] == "agent_bad_output"
    # an unparseable answer needs a sample to be actionable — in the LEGACY
    # field, which callers already render (see the round-1 regression test)
    assert j["error"]["raw_excerpt"]


def test_failure_categories_keep_their_historical_status_codes(
    srv, stub_executor
) -> None:
    import subprocess

    app = srv._App(None, None)
    for exc, status, category in (
        (FileNotFoundError("gone"), 503, "agent_unavailable"),
        (subprocess.TimeoutExpired(["x"], 1), 504, "agent_timeout"),
        (OSError("boom"), 502, "agent_failed"),
    ):
        stub_executor["raise"] = lambda e=exc: (_ for _ in ()).throw(e)
        got, j = _post(app, "/api/agent/shots-draft", {"script": "s"})
        assert (got, j["error"]["category"]) == (status, category)
        assert j["error"]["run_id"], "a failure is a RECORD, not just a toast"
    stub_executor["raise"] = None


# --- /api/runs -------------------------------------------------------------- #


def test_the_runs_routes_require_the_runtime_header(srv) -> None:
    app = srv._App(None, None)
    assert app.handle("/api/runs?project=P1", {}).status == 403
    assert app.handle_post("/api/runs/x/cancel", b"{}", {}).status == 403


def test_listing_runs_without_a_project_is_refused(srv) -> None:
    """Contract §5.5 rule 1: "no project means everything" is exactly the path
    that mixes another project's runs into this project's page."""
    app = srv._App(None, None)
    status, j = _get(app, "/api/runs", _RUNTIME_HEADERS)
    assert status == 400
    assert "project" in j["error"]["detail"]


def test_runs_are_isolated_per_project_and_report_404_not_403(
    srv, stub_executor
) -> None:
    app = srv._App(None, None)
    stub_executor["answer"] = _BREAKDOWN_ANSWER
    _, a = _post(app, "/api/agent/bible-breakdown", {"script": "s", "project": "A"})
    _, b = _post(app, "/api/agent/bible-breakdown", {"script": "s", "project": "B"})
    status, listing = _get(app, "/api/runs?project=A", _RUNTIME_HEADERS)
    assert status == 200
    ids = [r["run_id"] for r in listing["runs"]]
    assert ids == [a["run_id"]], "a project sees only its own runs"
    assert b["run_id"] not in ids
    # cross-project read is ABSENT, not forbidden
    status, _ = _get(app, f"/api/runs/{a['run_id']}?project=B", _RUNTIME_HEADERS)
    assert status == 404
    status, _ = _post(
        app, f"/api/runs/{a['run_id']}/cancel", {"project": "B"}, _RUNTIME_HEADERS
    )
    assert status == 404


def test_a_legacy_project_less_run_appears_on_no_project_page(
    srv, stub_executor
) -> None:
    app = srv._App(None, None)
    stub_executor["answer"] = _BREAKDOWN_ANSWER
    _, legacy = _post(app, "/api/agent/bible-breakdown", {"script": "s"})  # no project
    _, listing = _get(app, "/api/runs?project=P1", _RUNTIME_HEADERS)
    assert legacy["run_id"] not in [r["run_id"] for r in listing["runs"]]
    # …it is visible only in the diagnostics view
    _, unowned = _get(app, "/api/runs?scope=unowned", _RUNTIME_HEADERS)
    assert legacy["run_id"] in [r["run_id"] for r in unowned["runs"]]
    # …and the diagnostics view is NOT reachable by naming a project: a sentinel
    # a user can type as a project name is not a sentinel (codex review round 2)
    _, spoofed = _get(app, "/api/runs?project=__unowned__", _RUNTIME_HEADERS)
    assert spoofed["runs"] == []


def test_a_page_refresh_can_recover_a_run_from_the_backend(srv, stub_executor) -> None:
    """Acceptance criterion 2: the run survives the page, because its identity
    lives in the backend rather than in a blocked HTTP call."""
    app = srv._App(None, None)
    stub_executor["answer"] = _BREAKDOWN_ANSWER
    _, j = _post(
        app,
        "/api/agent/bible-breakdown",
        {"script": "s", "project": "P1"},
        _ASYNC_HEADERS,
    )
    _wait(srv, j["run_id"], project="P1")
    # a brand-new "page" asks the backend and gets the whole story back
    status, got = _get(app, f"/api/runs/{j['run_id']}?project=P1", _RUNTIME_HEADERS)
    assert status == 200
    assert got["status"] == "succeeded"
    assert got["taskType"] == "skill.script-breakdown"
    assert got["outputs"]["breakdown"]["characters"][0]["name"] == "阿澈"


# --- canvas ownership ------------------------------------------------------- #


def test_a_canvas_save_cannot_roll_back_a_running_task(srv) -> None:
    """Contract §5.5 / TASK-072 §1.3a. The page holds what it LAST READ; the task
    kept moving. Ownership settles it — and the save is NOT refused, because the
    page was never the owner of these fields."""
    store = srv.runs()
    run = store.create(
        kind="skill",
        task_type="skill.story-development",
        executor="manual",
        project_id="P1",
    )
    store.await_input(run["runId"], project="P1")
    stale = {
        "skillRuns": [
            {
                "runId": run["runId"],
                "status": "running",  # the page's stale snapshot
                "progress": 20,
                "proposal": {"disposition": "pending", "payload": {"a": 1}},
            }
        ]
    }
    srv._reconcile_skill_runs(stale, project="P1")
    rec = stale["skillRuns"][0]
    assert rec["status"] == "awaiting_input", "the backend's state wins"
    assert rec["progress"] == 0
    # …and what the CANVAS owns is untouched
    assert rec["proposal"] == {"disposition": "pending", "payload": {"a": 1}}


def test_a_finished_run_is_not_resurrected_by_a_stale_save(srv) -> None:
    store = srv.runs()
    run = store.create(
        kind="skill", task_type="skill.x", executor="manual", project_id="P1"
    )
    store.await_input(run["runId"], project="P1")
    store.submit_input(run["runId"], {"text": "done"}, project="P1")
    # the realistic stale save: the page had already landed the proposal, then
    # saved a snapshot taken before the run finished
    doc = {
        "skillRuns": [
            {
                "runId": run["runId"],
                "status": "running",
                "progress": 5,
                "proposal": {"disposition": "pending"},
            }
        ]
    }
    srv._reconcile_skill_runs(doc, project="P1")
    assert doc["skillRuns"][0]["status"] == "succeeded"
    # …and the BACKEND is never moved by a canvas save, whatever it said
    assert srv.runs().get(run["runId"], project="P1")["status"] == "succeeded"


def test_a_run_the_backend_does_not_know_is_left_alone(srv) -> None:
    """Local/demo mode and purely front-end manual runs: there, the canvas IS the
    only truth, so touching it would destroy the only record."""
    srv.runs()  # ensure a registry exists
    doc = {
        "skillRuns": [{"runId": "run-not-ours", "status": "running", "progress": 42}]
    }
    srv._reconcile_skill_runs(doc)
    assert doc["skillRuns"][0] == {
        "runId": "run-not-ours",
        "status": "running",
        "progress": 42,
    }


# --- the closed executor set ------------------------------------------------ #


def test_the_endpoint_map_and_the_executor_enum_agree(srv) -> None:
    """Contract §5.9b / TASK-072 §4 第 4n 条: one table naming an executor the
    other does not know is an execution path with no contract."""
    contract = (_REPO / "docs" / "design" / "creator-system-contract.md").read_text(
        "utf-8"
    )
    table = contract.split("### 5.9b", 1)[1].split("### 5.9c", 1)[0]
    named = set()
    for token in ("claude-code", "codex-cli", "manual", "local-piper", "local-ffmpeg"):
        if f"`{token}`" in table:
            named.add(token)
    assert named == set(runstore.FIXED_EXECUTORS), (
        "every executor in the endpoint table must be in the closed enum"
    )
    assert "provider:minimax" in table
    assert runstore.is_valid_executor("provider:minimax")


def _wait(srv, run_id, *, project, timeout=8.0):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        run = srv.runs().get(run_id, project=project)
        if run["status"] in runstore.TERMINAL_STATUSES:
            return run
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} never settled")


# --- codex review round 1 regressions --------------------------------------- #


def test_a_canvas_cannot_import_another_projects_run_outputs(srv) -> None:
    """codex review round 1: reconciliation looked the run id up GLOBALLY, so a
    canvas naming another project's run pulled that project's lifecycle fields —
    `outputs` included — into this document. Isolation has to hold on every path
    that copies data, not only on the read API (contract §5.5)."""
    store = srv.runs()
    theirs = store.create(
        kind="skill", task_type="skill.x", executor="manual", project_id="OTHER"
    )
    store.await_input(theirs["runId"], project="OTHER")
    store.submit_input(theirs["runId"], {"secret": "their result"}, project="OTHER")
    doc = {
        "skillRuns": [{"runId": theirs["runId"], "status": "running", "outputs": None}]
    }
    srv._reconcile_skill_runs(doc, project="MINE")
    # another project's results stay put
    assert doc["skillRuns"][0]["outputs"] is None
    assert doc["skillRuns"][0]["status"] == "running", "and its status is not copied"
    # …while the OWNING project still reconciles normally
    srv._reconcile_skill_runs(doc, project="OTHER")
    assert doc["skillRuns"][0]["outputs"] == {"secret": "their result"}


def test_a_generic_executor_failure_does_not_leak_cli_output(
    srv, stub_executor
) -> None:
    """codex review round 2: `_run_executor` embeds the CLI's merged
    stdout/stderr in its OSError, and that text can carry local absolute paths.
    It goes into a durable record AND an HTTP response, so only the exception
    TYPE travels."""
    app = srv._App(None, None)
    secret = r"C:\Users\someone\.secret\token=abc123"
    stub_executor["raise"] = lambda: (_ for _ in ()).throw(OSError(secret))
    status, j = _post(app, "/api/agent/shots-draft", {"script": "s", "project": "P1"})
    stub_executor["raise"] = None
    assert status == 502
    blob = json.dumps(j, ensure_ascii=False)
    assert "token=abc123" not in blob
    assert ".secret" not in blob
    assert "OSError" in j["error"]["detail"], "the KIND of failure is still said"
    # …and the durable record does not carry it either
    run = srv.runs().get(j["error"]["run_id"], project="P1")
    assert "token=abc123" not in json.dumps(run, ensure_ascii=False)


def test_a_bad_output_error_keeps_its_raw_excerpt_field(srv, stub_executor) -> None:
    """codex review round 1: `raw_excerpt` is an EXISTING field of this response
    and callers show it to the creator. Folding it into `detail` took away the
    only clue about what the model actually said."""
    app = srv._App(None, None)
    stub_executor["answer"] = "没有 JSON 的解释性文字"
    status, j = _post(app, "/api/agent/shots-draft", {"script": "s"})
    assert status == 502
    assert j["error"]["category"] == "agent_bad_output"
    assert j["error"]["raw_excerpt"] == "没有 JSON 的解释性文字"
    # …and the excerpt is no longer duplicated inside `detail`
    assert "没有 JSON 的解释性文字" not in j["error"]["detail"]


def test_an_explicit_manual_executor_returns_the_fallback_not_a_hang(
    srv, stub_executor
) -> None:
    """codex review round 4: an explicit `manual` parked the run in
    `awaiting_input` and then blocked the request on `_await_run`, which never
    times out for that state — the HTTP call hung forever. Manual work is done by
    a person; there is nothing to wait for."""
    app = srv._App(None, None)
    status, j = _post(
        app,
        "/api/agent/story-develop",
        {"idea": "x", "project": "P1", "executor": "manual"},
    )
    assert status == 503
    assert j["error"]["manual_fallback"]["prompt"]
    run = srv.runs().get(j["error"]["manual_fallback"]["run_id"], project="P1")
    assert run["status"] == "awaiting_input"


def test_an_empty_manual_submission_is_refused_not_stored_as_success(srv) -> None:
    """codex review round 4: coercing a missing/malformed payload to `{}` turned
    a bad request into a durable, permanent success carrying nothing — the exact
    opposite of the fail-closed rule the local path applies."""
    app = srv._App(None, None)
    store = srv.runs()
    run = store.create(
        kind="skill",
        task_type="skill.story-development",
        executor="manual",
        project_id="P1",
    )
    for bad in ({}, None, "text", []):
        status, j = _post(
            app,
            f"/api/runs/{run['runId']}/submit",
            {"project": "P1", "outputs": bad},
            _RUNTIME_HEADERS,
        )
        assert status == 400, bad
        assert j["error"]["category"] == "bad_request"
    assert store.get(run["runId"], project="P1")["status"] == "awaiting_input"
    # …a non-empty object that MISSES the task's product key is refused too:
    # the manual route goes through the same output contract (ADR-0065 决策 2)
    status, j = _post(
        app,
        f"/api/runs/{run['runId']}/submit",
        {"project": "P1", "outputs": {"something-else": 1}},
        _RUNTIME_HEADERS,
    )
    assert status == 400
    assert "outline" in j["error"]["detail"]
    # …and a present-but-MALFORMED value goes through the same parser the local
    # path uses, so `{"outline": 1}` is refused too (codex review round 7)
    status, j = _post(
        app,
        f"/api/runs/{run['runId']}/submit",
        {"project": "P1", "outputs": {"outline": 1}},
        _RUNTIME_HEADERS,
    )
    assert status == 400
    assert "输出契约" in j["error"]["detail"]
    # …and a real answer still lands
    status, _ = _post(
        app,
        f"/api/runs/{run['runId']}/submit",
        {
            "project": "P1",
            "outputs": {
                "outline": {
                    "premise": "p",
                    "logline": "l",
                    "centralConflict": "c",
                    "storyArc": "a",
                    "climax": "x",
                    "ending": "e",
                }
            },
        },
        _RUNTIME_HEADERS,
    )
    assert status == 200


def test_reconciliation_never_writes_a_canvas_state_the_validator_rejects(srv) -> None:
    """codex review round 5: v15 requires `succeeded` to carry a proposal. The
    proposal is the FRONT END's to write, so copying a backend `succeeded` onto a
    record that has none produced a document that could no longer be saved."""
    store = srv.runs()
    run = store.create(
        kind="skill", task_type="skill.x", executor="manual", project_id="P1"
    )
    store.submit_input(
        run["runId"],
        {
            "outline": {
                "premise": "p",
                "logline": "l",
                "centralConflict": "c",
                "storyArc": "a",
                "climax": "x",
                "ending": "e",
            }
        },
        project="P1",
    )
    doc = {
        "skillRuns": [{"runId": run["runId"], "status": "running", "proposal": None}]
    }
    srv._reconcile_skill_runs(doc, project="P1")
    rec = doc["skillRuns"][0]
    # the status waits for the page to land the proposal
    assert rec["status"] == "running"
    # …everything that does NOT threaten the invariant is still reconciled
    assert rec["outputs"] == {
        "outline": {
            "premise": "p",
            "logline": "l",
            "centralConflict": "c",
            "storyArc": "a",
            "climax": "x",
            "ending": "e",
        }
    }
    assert rec["progress"] == 100
    # …and once the page HAS a proposal, the transition is copied
    rec["proposal"] = {"disposition": "pending"}
    srv._reconcile_skill_runs(doc, project="P1")
    assert rec["status"] == "succeeded"


def test_a_failed_persist_rolls_back_the_in_memory_state(srv, tmp_path) -> None:
    """codex review rounds 4-5: a caller told the change failed while memory
    carried on as if it worked is how a paid run happens without authorisation."""
    store = srv.runs()
    run = store.create(
        kind="skill",
        task_type="skill.x",
        executor="claude-code",
        project_id="P1",
        needs_confirmation=True,
    )
    original = store._persist_locked

    def boom():
        raise runstore.PersistFailed("disk full")

    store._persist_locked = boom
    try:
        with pytest.raises(runstore.PersistFailed):
            store.confirm(run["runId"], project="P1")
    finally:
        store._persist_locked = original
    assert store.get(run["runId"], project="P1")["status"] == "awaiting_confirmation", (
        "a confirmation that could not be written down did not happen"
    )


def test_reconciliation_never_resurrects_a_terminal_canvas_run(srv) -> None:
    """codex review round 13: the creator abandoning a manual run settles it on
    the canvas side. Copying the backend's still-open `awaiting_input` back over
    it would resurrect a run they explicitly stopped."""
    store = srv.runs()
    run = store.create(
        kind="skill", task_type="skill.x", executor="manual", project_id="P1"
    )
    assert store.get(run["runId"], project="P1")["status"] == "awaiting_input"
    doc = {"skillRuns": [{"runId": run["runId"], "status": "cancelled"}]}
    srv._reconcile_skill_runs(doc, project="P1")
    assert doc["skillRuns"][0]["status"] == "cancelled", "terminal is terminal"


def test_a_paid_run_never_defaults_to_zero_cost(srv) -> None:
    """codex review round 13: defaulting to a 0 subscription cost put "this was
    free" into the budget record for an execution that will be billed."""
    store = srv.runs()
    paid = store.create(
        kind="image-gen",
        task_type="generation.image.minimax",
        executor="provider:minimax",
        project_id="P1",
        idempotency_key="k",
    )
    assert paid["cost"]["amount"] is None
    assert paid["cost"]["basis"] == "provider-pending"
    free = store.create(
        kind="skill", task_type="skill.x", executor="manual", project_id="P1"
    )
    assert free["cost"] == {"currency": "USD", "amount": 0, "basis": "subscription"}


def test_a_manual_text_product_is_accepted_as_text(srv) -> None:
    """codex review round 18: `_parse_script_text` exists to pull a script out of
    a MODEL'S reply and needs the `<剧本输出>` wrapper only a model emits. Running
    it on a manual submission rejected exactly the correct payload."""
    app = srv._App(None, None)
    store = srv.runs()
    run = store.create(
        kind="skill",
        task_type="skill.script-writer",
        executor="manual",
        project_id="P1",
    )
    status, _ = _post(
        app,
        f"/api/runs/{run['runId']}/submit",
        {"project": "P1", "outputs": {"script": _SCRIPT_TEXT}},
        _RUNTIME_HEADERS,
    )
    assert status == 200
    got = store.get(run["runId"], project="P1")
    assert got["outputs"]["script"] == _SCRIPT_TEXT


def test_a_string_valued_structural_product_still_goes_through_its_parser(
    srv,
) -> None:
    """codex review round 19: exempting EVERY string let a string-valued
    `outline` skip its parser entirely and be stored as a durable success."""
    app = srv._App(None, None)
    store = srv.runs()
    run = store.create(
        kind="skill",
        task_type="skill.story-development",
        executor="manual",
        project_id="P1",
    )
    status, j = _post(
        app,
        f"/api/runs/{run['runId']}/submit",
        {"project": "P1", "outputs": {"outline": "just some prose"}},
        _RUNTIME_HEADERS,
    )
    assert status == 400
    assert "输出契约" in j["error"]["detail"]


def test_a_whitespace_only_text_product_is_refused(srv) -> None:
    """codex review round 19: stripping AFTER the emptiness check let a
    whitespace-only submission become an empty successful result."""
    app = srv._App(None, None)
    store = srv.runs()
    run = store.create(
        kind="skill",
        task_type="skill.script-writer",
        executor="manual",
        project_id="P1",
    )
    status, j = _post(
        app,
        f"/api/runs/{run['runId']}/submit",
        {"project": "P1", "outputs": {"script": "   \n  "}},
        _RUNTIME_HEADERS,
    )
    assert status == 400
    assert store.get(run["runId"], project="P1")["status"] == "awaiting_input"
