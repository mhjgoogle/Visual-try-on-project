"""motv Local AI Runtime + Film Skills — TASK-059 / ADR-0056.

STRICTLY OFFLINE, no spend, no executor is launched. Runs the frontend units via
``node --test`` and guards the SAFETY and LAYERING contract:

- a Film AI Runtime is a TEXT executor, not a code-modification agent: tools are
  disabled / the sandbox is read-only, argv arrays (never a shell), a NEUTRAL
  cwd, bounded output, a timeout watchdog (决策 2);
- NO path ever crosses the boundary — the domain context is inlined as data,
  which is why there is nothing to translate between Windows and WSL paths;
- the runtime never writes canon: `/api/skill/run` takes no project and writes
  no file, and a Proposal becomes project data only after an explicit accept;
- Role ≠ Skill ≠ Runtime ≠ Executor ≠ Model — no Skill hard-wires an executor
  (决策 1);
- executor resolution is env-var → shutil.which → honest `unavailable`
  (决策 3, ADR-0049 规则 6: resolve, never invoke by bare name);
- Skill definitions are immutable constants; runs record them, never write them
  (决策 6 — no automatic self-learning).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


def _server() -> str:
    return (_MOCKUP_DIR / "server.py").read_text("utf-8")


def _server_code() -> str:
    """server.py with comments stripped — these tests assert about what the code
    DOES, and a comment explaining why a directory is NOT used must not read as
    a use of it."""
    out = []
    for ln in _server().splitlines():
        stripped = ln.lstrip()
        if stripped.startswith("#"):
            continue
        out.append(ln)
    return "\n".join(out)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_skill_units_via_node() -> None:
    """CP3 能力层 / 运行留痕 / v11→v12 迁移 / v12 校验 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/skills.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_runtime_is_a_text_executor_not_a_code_agent() -> None:
    """决策 2 — the safety posture, enforced in the launch code itself."""
    src = _server()
    code = _server_code()
    body = code.split("def _run_executor", 1)[1].split("\ndef _probe_executor")[0]
    # no shell, ever
    assert "shell=True" not in body
    # a genuinely NEUTRAL cwd — an EMPTY temp folder, not the repository.
    # codex review, TASK-059 round 1: MOCKUP_DIR sits inside the repo, so a
    # prompt-injected executor could read and echo back source from it.
    assert "tempfile.mkdtemp(" in body
    assert "shutil.rmtree(workdir" in body
    for forbidden in ("MOCKUP_DIR", "_project_root", "account_root", "REPO_ROOT"):
        assert forbidden not in body, (
            f"the executor's cwd must not come from {forbidden}"
        )
    # bounded output + a timeout watchdog that actually kills the child
    assert "_SKILL_OUTPUT_CAP" in body
    assert "threading.Timer" in body
    assert "proc.kill()" in body
    # THE PROMPT NEVER TRAVELS ON ARGV (codex review, round 2): a real skill
    # prompt inlines the episode script and would blow past the ~32 KB Windows
    # command-line cap.
    assert "proc.stdin.write(prompt.encode" in body
    assert "[*argv, prompt]" not in body
    # tools are disabled / the sandbox is read-only in the launch arguments
    table = src.split("_EXECUTORS: dict[str, dict] = {", 1)[1].split("\n}\n", 1)[0]
    assert '"--tools", ""' in table.replace("'", '"'), "claude must run with tools off"
    assert '"read-only"' in table, "codex must run in a read-only sandbox"


def test_executors_that_can_read_the_filesystem_are_OFF_by_default() -> None:
    """codex review, TASK-059 round 3: `--sandbox read-only` blocks WRITES only.
    A read-capable agent plus a prompt that inlines user-authored script text is
    a live exfiltration path, so such an executor is fail-closed."""
    src = _server()
    assert "reads_filesystem" in src
    assert "MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS" in src
    argv_body = src.split("def _executor_argv", 1)[1].split("\ndef _run_executor")[0]
    assert 'spec.get("reads_filesystem")' in argv_body
    assert "not _fs_readers_allowed()" in argv_body

    sys.path.insert(0, str(_MOCKUP_DIR))
    import os  # noqa: PLC0415

    import server as srv  # noqa: PLC0415 - path injected above

    old = os.environ.pop("MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS", None)
    try:
        argv, why = srv._executor_argv("codex-cli")
        assert argv is None, "a read-capable executor must be off by default"
        assert "MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS" in why
        assert srv._probe_executor("codex-cli")["state"] == "unavailable"
        # …and an explicit, informed opt-in re-enables it
        os.environ["MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS"] = "1"
        assert srv._fs_readers_allowed() is True
    finally:
        if old is None:
            os.environ.pop("MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS", None)
        else:
            os.environ["MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS"] = old


def test_a_timeout_kills_the_whole_process_TREE() -> None:
    """codex review, TASK-059 round 4: `proc.kill()` reaches only the direct
    child. The documented WSL bridge is wsl → bash → CLI, so killing the
    launcher would leave the CLI running past the 504, still burning local
    resources and subscription capacity."""
    src = _server()
    assert "def _kill_tree" in src
    tree = src.split("def _kill_tree", 1)[1].split("\ndef _looks_unauthenticated")[0]
    assert 'shutil.which("taskkill")' in tree, "Windows needs a tree walk"
    assert "os.killpg" in tree, "POSIX signals the whole session"
    run = src.split("def _run_executor", 1)[1].split("\ndef _kill_tree")[0]
    assert "start_new_session" in run, "POSIX children need their own session"
    assert "_kill_tree(proc)" in run
    # the timeout path must use the tree kill, not a bare proc.kill()
    on_timeout = run.split("def _on_timeout", 1)[1].split("timer =")[0]
    assert "_kill_tree(proc)" in on_timeout
    assert "proc.kill()" not in on_timeout


def test_concurrent_skill_runs_are_capped_and_the_slot_is_always_released() -> None:
    """codex review, TASK-059 round 4: each run launches a real local CLI.

    TASK-072 批次一 moved the pool into the Run registry so that the synchronous
    route, the async route and the five agent endpoints all draw from ONE pool —
    a second semaphore beside it let mixed traffic run twice the configured
    number of CLIs (codex review, round 11). The CAP is unchanged; only its owner
    moved, and the synchronous route still refuses rather than queueing.
    """
    src = _server()
    assert "_SKILL_RUN_MAX_CONCURRENT" in src
    body = src.split("def _skill_run", 1)[1].split("\n    def _agent_shots_draft")[0]
    assert "runs().try_acquire_slot()" in body
    assert "429" in body, "a busy runtime says so instead of queueing invisibly"
    # released on EVERY path — a leaked slot permanently shrinks capacity
    assert "finally:" in body
    assert "runs().release_slot()" in body
    # …and the pool itself is the registry's, counted alongside running runs
    store = (_MOCKUP_DIR / "runstore.py").read_text("utf-8")
    assert "def try_acquire_slot" in store
    assert "self._external_slots" in store


def test_the_skill_run_route_needs_a_header_a_hostile_page_cannot_set() -> None:
    """codex review, TASK-059 round 7: `_guard_origin` lets a request with NO
    Origin through — right for the read-only API, too weak for a route that
    starts a real local CLI. A custom header forces a CORS preflight that this
    server never answers."""
    src = _server()
    assert "_SKILL_RUN_HEADER" in src
    assert '"X-Motv-Runtime"' in src
    body = src.split("def _skill_run", 1)[1].split("\n    def _agent_shots_draft")[0]
    assert "(headers or {}).get(_SKILL_RUN_HEADER)" in body
    assert '"category": "forbidden"' in body
    # the PROBE route needs it too (codex review, round 8): it spawns
    # `--version` subprocesses, so a cross-origin page must not reach it either
    probe_route = src.split('if path == "/api/runtimes":', 1)[1].split("if path ==", 1)[
        0
    ]
    assert "_SKILL_RUN_HEADER" in probe_route
    # …and probe results are cached, bounding the cost for legitimate callers
    assert "_PROBE_CACHE" in src
    assert "_PROBE_TTL_SECONDS" in src
    assert "def _probe_executor_cached" in src
    # …and the client actually sends it on BOTH routes
    client = _read("services", "runtime.js")
    assert client.count('"X-Motv-Runtime": "1"') >= 2


def test_a_configured_executor_is_really_probed() -> None:
    """codex review, TASK-059 round 7: reporting `installed` without trying
    presents a typo'd path as runnable until the first run fails."""
    body = _server().split("def _probe_executor", 1)[1].split("\ndef _parse_shots")[0]
    assert "probe_argv" in body
    assert 'spec["probe"]' in body
    # the configured branch drops OUR run arguments and substitutes --version
    assert 'argv[: -len(spec["args"])]' in body


def test_skill_run_route_takes_no_project_and_writes_nothing() -> None:
    """The runtime is never a data owner (决策 2)."""
    src = _server()
    body = src.split("def _skill_run", 1)[1].split("\n    def _agent_shots_draft")[0]
    # it accepts exactly a prompt + an executor + a timeout
    assert 'payload.get("prompt")' in body
    assert 'payload.get("executor")' in body
    # TASK-072 §1.3a: the async path DOES take a project — but only as the run's
    # OWNER, never as a path. Cross-project isolation is impossible without it
    # (creator-system-contract §5.5), and a backend that guessed "the current
    # project" would file runs under whoever happened to be active.
    #
    # 决策 2 is unchanged and is what this test still guards: the project name
    # never becomes a filesystem path, and the route writes nothing.
    assert 'project_id=payload.get("project")' in body, (
        "the async path records the run's owner"
    )
    for forbidden in ("_project_root", "_canvas_path", "Path(", "/ project"):
        assert forbidden not in body, (
            f"the skill route must never turn a project name into a path ({forbidden})"
        )
    # and it writes nothing at all
    for forbidden in ("open(", "write_text", "write_bytes", "mkdir", "os.replace"):
        assert forbidden not in body, f"the skill route must not {forbidden}"


def test_the_skill_body_is_capped_at_transport_not_after_parsing() -> None:
    """codex review, TASK-059 round 9: the in-handler prompt-length check runs
    AFTER the body has been buffered and JSON-parsed, which is too late to
    protect memory."""
    src = _server()
    assert "_SKILL_BODY_MAX" in src
    cap = src.split("def _route_body_cap", 1)[1].split("\n    def do_PUT")[0]
    assert '"/api/skill/run"' in cap
    assert "_SKILL_BODY_MAX" in cap


def test_an_object_shaped_nothing_is_still_a_missing_input() -> None:
    """codex review, TASK-059 round 9: the default Brief is a full object of
    empty strings; counting it as present let a skill run on a blank input."""
    dom = _code("workflow", "skills.js")
    assert "function hasContent" in dom
    assert "v.some(hasContent)" in dom
    # …and an IDENTITY field is not content either (codex review, round 10): a
    # freshly created scene is an id plus empty fields, and storyboarding it
    # would be storyboarding nothing
    assert "IDENTITY_KEY" in dom
    assert "!IDENTITY_KEY.test(k) && hasContent(v[k])" in dom


def test_no_path_crosses_the_runtime_boundary() -> None:
    """决策 2 — context is inlined as DATA, so no Windows/WSL path translation
    problem exists to get wrong."""
    client = _code("services", "runtime.js")
    assert "prompt" in client
    for forbidden in ("project", "path", "cwd", "file://"):
        assert f'"{forbidden}"' not in client.split("runOnExecutor", 1)[1], (
            f"runOnExecutor must not send {forbidden}"
        )
    compiled = _code("workflow", "skills.js")
    assert "compilePrompt" in compiled
    # the prompt builder inlines values; it never reads or names a filesystem
    for forbidden in ("readFile", "fetch(", "process.", "require("):
        assert forbidden not in compiled


def test_executor_resolution_is_env_then_which_then_honest_unavailable() -> None:
    """决策 3 + ADR-0049 规则 6."""
    src = _server()
    body = src.split("def _executor_argv", 1)[1].split("\ndef _run_executor")[0]
    assert 'os.environ.get(spec["launcher_env"]' in body
    assert 'os.environ.get(spec["bin_env"]' in body
    assert "shutil.which(" in body
    assert "not on PATH" in body
    # a bare-name invocation is exactly what ADR-0049 forbids
    assert 'subprocess.Popen([spec["bin"]' not in body
    # codex review, rounds 5-6: a FREE-FORM launcher cannot be validated — a
    # substring check both false-accepts (`--sandbox danger-full-access
    # --config x=read-only`) and false-rejects (a prefix ending in `"$@"`). The
    # contract is STRUCTURED instead: a pure-transport prefix + an absolute
    # binary path, and WE own every argument after it.
    assert '*spec["args"]' in body, "the mandatory flags are ours to append"
    assert "_launcher_error(launcher)" in body
    assert "必须是绝对路径" in body
    # a shell in the prefix would swallow the arguments we append
    guard = src.split("def _launcher_error", 1)[1].split("\ndef _executor_argv")[0]
    assert "_SHELLS" in guard
    assert "_SHELL_FLAGS" in guard


def test_probe_never_fabricates_ready() -> None:
    """codex review, TASK-059 round 1: `--version` succeeds on an installed but
    LOGGED-OUT CLI, so a probe may never report `ready` from it."""
    src = _server()
    body = src.split("def _probe_executor", 1)[1].split("\ndef _parse_shots")[0]
    assert '"unavailable"' in body
    assert '"unauthenticated"' in body
    assert '"error"' in body
    assert '"installed"' in body
    assert '"state": "ready"' not in body, (
        "a version probe does not prove a login — it may only report `installed`"
    )
    # an auth-shaped RUN failure is its own state, distinct from a crash
    run = src.split("def _run_executor", 1)[1].split("\ndef _looks_unauthenticated")[0]
    assert "PermissionError" in run
    route = src.split("def _skill_run", 1)[1].split("\n    def _agent_shots_draft")[0]
    assert '"category": "unauthenticated"' in route
    # the client's backend-less fallback is unavailable, never ready
    client = _read("services", "runtime.js")
    assert "没有后端：无法探测本机执行器" in client


def test_no_skill_hardwires_an_executor() -> None:
    """决策 1 — Role ≠ Skill ≠ Runtime ≠ Executor ≠ Model."""
    catalog = _read("workflow", "skills.js")
    for executor in ("claude-code", "codex-cli", "claude_code", "codex_cli"):
        # the module header explains the separation; the DEFINITIONS must not
        # name an executor
        body = catalog.split("export const SKILLS = [", 1)[1]
        assert executor not in body, f"a Skill definition hard-wires {executor}"
    assert "recommendedRuntime" in catalog


def test_skill_definitions_are_immutable_constants() -> None:
    """决策 6 — improving a Skill is an explicit revision, never a side effect."""
    catalog = _code("workflow", "skills.js")
    assert "Object.freeze" in catalog
    runs = _code("workflow", "skillrun.js")
    # the run registry records the skill id + version; it never writes a skill
    assert "skillVersion" in runs
    for forbidden in ("SKILLS", "findSkill", "instruction =", "outputSchema ="):
        assert forbidden not in runs, f"skillrun.js must not touch {forbidden}"


def test_a_proposal_is_not_a_canonical_write() -> None:
    """Domain context → Skill → Runtime → Proposal → review → ACCEPT → write."""
    runs = _code("workflow", "skillrun.js")
    # v15: the two questions have their own fields. 「the run finished」 is
    # `succeeded`; 「I took the answer」 is `disposition: accepted` (ADR-0066 决策 8).
    assert "succeeded" in runs and "accepted" in runs
    assert "PROPOSAL_DISPOSITIONS" in runs
    # the module has no access to any canonical document
    for forbidden in (
        "productionDoc",
        "storyDoc",
        "assetRegistry",
        "proddoc",
        "storydoc",
    ):
        assert forbidden not in runs
    app = _code("app.js")
    # bounded at the NEXT controller, not at assetRegistryView: later
    # checkpoints add controllers in between, and they legitimately READ the
    # canonical documents to build their own view models.
    #
    # `\n  shot: {` was the wrong boundary — it is not the next controller, so
    # every controller added between skills and shot fell inside the window.
    # TASK-064's refInterp / locks / frames / shotAudio / subtitles controllers
    # legitimately READ proddoc to build their view models, and that tripped a
    # guard about what ACCEPTING A PROPOSAL may WRITE. The rule is unchanged; the
    # slice now names the boundary it always meant.
    section = app.split("skills: {", 1)[1].split("\n  prompt: {", 1)[0]
    section = section.split("\n  assetRegistryView", 1)[0]
    assert "skillrun.acceptRun" in section
    # Accepting MARKS the run; applying the proposal to canon is the caller's,
    # through the normal domain controllers. (Reading the canonical documents to
    # BUILD the prompt context is expected and fine — it is writing that must
    # not happen here, so the assertion is scoped to accept/reject.)
    decide = section.split("accept: (skillRunId)", 1)[1]
    for forbidden in (
        "proddoc.",
        "bibledoc.",
        "canondoc.",
        "storydoc.",
        "assetreg.declare",
        "mediaref.addVersion",
    ):
        assert forbidden not in decide, (
            f"accepting a proposal must not call {forbidden}"
        )


def test_failure_is_recorded_as_failure_never_as_content() -> None:
    runs = _code("workflow", "skillrun.js")
    body = runs.split("export function failRun", 1)[1].split(
        "export function reviewRun"
    )[0]
    assert "r.proposal = null" in body
    # the four/five distinct kinds survive to the client
    for kind in ("unavailable", "unauthenticated", "timeout", "invalid_output"):
        assert f'"{kind}"' in runs
    src = _server()
    body = src.split("def _skill_run", 1)[1].split("\n    def _agent_shots_draft")[0]
    for category in ("unavailable", "timeout", "execution_error"):
        assert f'"category": "{category}"' in body


def test_schema_v12_registry_is_additive_and_empty() -> None:
    """Pins the v11→v12 STEP, not the current version: later checkpoints add
    v13, v14… and must not break this."""
    schema = _read("services", "canvasschema.js")
    match = re.search(r"CANVAS_SCHEMA_VERSION = (\d+)", schema)
    assert match is not None
    assert int(match.group(1)) >= 12, "v12 (TASK-059) must not be renumbered away"
    assert "function migrateV11ToV12" in schema
    assert "11: migrateV11ToV12" in schema
    # bounded by the NEXT migration function, not by MIGRATIONS: a later
    # v12→v13 step legitimately sits between them and is not ours to police
    step = schema.split("function migrateV11ToV12", 1)[1]
    end = step.find("\n/**", 1)  # the next migration's doc comment starts here
    body = step[: end if end != -1 else len(step)]
    assert "doc.skillRuns = []" in body
    # the step touches nothing else
    for forbidden in ("assets", "generations", "production", "story", "timelines"):
        assert forbidden not in body, f"the v12 step must not touch {forbidden}"
    # and the validator reuses the domain's status list rather than forking it
    assert "new Set(RUN_STATUSES)" in schema


def test_the_persisted_registry_is_owned_by_the_serializer() -> None:
    """The serializer emits the registry on every save, and the loader hydrates
    it from the same field — so a reload returns the recorded runs."""
    app = _code("app.js")
    assert "skillRuns: skillRunRegistry" in app, "serializeGraph must emit skillRuns"
    assert "createSkillRunRegistry((data && data.skillRuns)" in app, (
        "restoreGraph must hydrate skillRuns from the save"
    )


def test_core_contracts_untouched_by_cp3() -> None:
    core = _REPO / "src" / "ai_video_workflow"
    hits = [
        p.name
        for p in core.rglob("*.py")
        if "skillRun" in p.read_text("utf-8", errors="ignore")
    ]
    assert hits == [], f"core modules must not know about the mockup skills: {hits}"


def test_probe_reports_unavailable_without_configuration() -> None:
    """On a host where the CLIs are not on PATH (this one), the probe says so —
    honestly, with the env var that would wire them."""
    sys.path.insert(0, str(_MOCKUP_DIR))
    import os  # noqa: PLC0415

    import server as srv  # noqa: PLC0415 - path injected above

    old_gate = os.environ.get("MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS")
    try:
        # codex is fail-closed by default (it can read the filesystem); this test
        # is about the PROBE's honesty, so the gate is opened explicitly.
        os.environ["MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS"] = "1"
        for name, env in (
            ("claude-code", "MOTV_RUNTIME_CLAUDE_BIN"),
            ("codex-cli", "MOTV_RUNTIME_CODEX_BIN"),
        ):
            # only assert the SHAPE — a developer machine may legitimately have one
            res = srv._probe_executor(name)
            assert res["state"] in {
                "installed",
                "unavailable",
                "unauthenticated",
                "error",
            }, "a probe never claims `ready` — a version call does not prove a login"
            if res["state"] == "unavailable":
                assert env in res["detail"], (
                    "an unavailable executor must name its env var"
                )
    finally:
        if old_gate is None:
            os.environ.pop("MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS", None)
        else:
            os.environ["MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS"] = old_gate


def test_a_configured_launch_command_must_be_a_json_argv_array() -> None:
    sys.path.insert(0, str(_MOCKUP_DIR))
    import os

    import server as srv  # noqa: PLC0415 - path injected above

    old = os.environ.get("MOTV_RUNTIME_CODEX_LAUNCHER")
    old_bin = os.environ.get("MOTV_RUNTIME_CODEX_BIN")
    old_gate = os.environ.get("MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS")
    try:
        # codex is fail-closed by default; this test is about argv PARSING, so
        # the read-capable gate is opened explicitly for it
        os.environ["MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS"] = "1"
        os.environ["MOTV_RUNTIME_CODEX_LAUNCHER"] = "wsl -e"  # not JSON
        argv, why = srv._executor_argv("codex-cli")
        assert argv is None and "JSON" in why
        # a SHELL in the transport prefix is refused (round 6): it would turn
        # our appended safety flags into a script's positional parameters
        os.environ["MOTV_RUNTIME_CODEX_LAUNCHER"] = '["wsl","-e","bash","-lc"]'
        os.environ["MOTV_RUNTIME_CODEX_BIN"] = "/opt/codex"
        argv, why = srv._executor_argv("codex-cli")
        assert argv is None and "shell" in why
        # a RELATIVE binary is refused — it must be absolute in ITS environment
        os.environ["MOTV_RUNTIME_CODEX_LAUNCHER"] = '["wsl","-e","/usr/bin/node"]'
        os.environ["MOTV_RUNTIME_CODEX_BIN"] = "codex"
        argv, why = srv._executor_argv("codex-cli")
        assert argv is None and "绝对路径" in why
        # …and a pure-transport prefix + absolute binary resolves, with the
        # mandatory safety flags appended BY US after the binary
        os.environ["MOTV_RUNTIME_CODEX_BIN"] = "/opt/codex"
        argv, why = srv._executor_argv("codex-cli")
        assert why == "configured"
        assert argv[:3] == ["wsl", "-e", "/usr/bin/node"]
        assert argv[3] == "/opt/codex"
        assert argv[4:] == srv._EXECUTORS["codex-cli"]["args"]
        assert "read-only" in argv
        # an EMPTY launcher array is fine (no transport needed); an empty
        # binary falls back to PATH resolution, which is the documented order
        os.environ["MOTV_RUNTIME_CODEX_LAUNCHER"] = "[]"
        os.environ["MOTV_RUNTIME_CODEX_BIN"] = "/opt/codex"
        argv, why = srv._executor_argv("codex-cli")
        assert argv[0] == "/opt/codex"
        # a launcher WITHOUT a binary cannot resolve — a prefix alone says only
        # "how to get there", never "what to run"
        os.environ["MOTV_RUNTIME_CODEX_LAUNCHER"] = '["wsl","-e"]'
        os.environ.pop("MOTV_RUNTIME_CODEX_BIN", None)
        argv, why = srv._executor_argv("codex-cli")
        assert argv is None and "MOTV_RUNTIME_CODEX_BIN" in why
    finally:
        for var, val in (
            ("MOTV_RUNTIME_CODEX_LAUNCHER", old),
            ("MOTV_RUNTIME_CODEX_BIN", old_bin),
        ):
            if val is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = val
        if old_gate is None:
            os.environ.pop("MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS", None)
        else:
            os.environ["MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS"] = old_gate
