"""Regression coverage for the local commit-gate risk classifier."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_POLICY_PATH = Path(__file__).parents[2] / ".claude" / "hooks" / "commit_gate_policy.py"
_SPEC = importlib.util.spec_from_file_location("commit_gate_policy", _POLICY_PATH)
assert _SPEC and _SPEC.loader
_POLICY = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _POLICY
_SPEC.loader.exec_module(_POLICY)


def test_docs_only_change_skips_test_execution() -> None:
    decision = _POLICY.classify(
        ["docs/tasks/done/TASK-063-risk-based-commit-gate.md", "README.md"]
    )

    assert decision.tier == "lint"


def test_workspace_change_runs_the_conservative_workspace_regression_set() -> None:
    decision = _POLICY.classify(
        [
            "src/ai_video_workflow/workspace/queries.py",
            "tests/backend/test_workspace_queries.py",
        ]
    )

    assert decision.tier == "pytest-targeted"
    assert "tests/e2e/test_workspace_wfm1_acceptance.py" in decision.pytest_targets
    assert "tests/backend/test_workspace_write.py" in decision.pytest_targets


def test_frontend_only_change_runs_frontend_suite() -> None:
    decision = _POLICY.classify(["mockups/motv-workspace/assets/app.js"])

    assert decision.tier == "frontend"


def test_test_only_change_runs_its_changed_test_file() -> None:
    decision = _POLICY.classify(["tests/backend/test_validation.py"])

    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/backend/test_validation.py",)


def test_conventional_source_runs_its_matching_test_file() -> None:
    # Inside a subpackage the conventional per-module test wins…
    decision = _POLICY.classify(["src/ai_video_workflow/budget/ledger.py"])

    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/backend/test_budget_ledger.py",)

    # …but a TOP-LEVEL module is the package's common layer (20+ subpackages
    # import it), so even with a conventional test present the impact scope is
    # backend + studio (ADR-0080).
    top = _POLICY.classify(["src/ai_video_workflow/validation.py"])
    assert top.pytest_targets == ("tests/backend", "tests/studio")


def test_core_modules_map_to_backend_and_studio_owners() -> None:
    """ADR-0080：核心共享模块的影响域 = 库自己的测试 + import 它的 Studio 后端。

    产品负责人 2026-08-22（「我不要每次都全量测试。」）之后，「高风险标签→全量」
    被归属映射取代；全量是集成检查点（CI / 链尾 / merge 前），不是日常提交税。
    """
    decision = _POLICY.classify(["src/ai_video_workflow/persistence.py"])
    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/backend", "tests/studio")

    # 根测试支撑层（conftest / scenario / 假件）托着每个 pytest 域，
    # 它的影响域就是整个 pytest 运行。
    assert _POLICY.classify(["tests/conftest.py"]).tier == "full"

    mixed = _POLICY.classify(
        ["src/workspace_shell/server.py", "mockups/motv-workspace/assets/app.js"]
    )
    assert mixed.tier == "pytest-targeted"
    assert mixed.frontend is True
    assert "tests/backend/test_workspace_shell.py" in mixed.pytest_targets


def test_the_motv_backend_maps_to_studio_and_contract_owners() -> None:
    """`server.py` 是 Studio 后端：tests/studio 是它的归属域，tests/contract
    钉住它与前端共享的合同（skill prompt parity 等）。

    历史：它先有专属 `motv-server` tier，后并入全量（2026-08-15 的耗时论证）；
    ADR-0080（产品负责人 2026-08-22 裁决）把它改为归属映射——变化的是
    「全量在哪里跑」（集成检查点），不是「它要不要被测」。
    """
    decision = _POLICY.classify(["mockups/motv-workspace/server.py"])

    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/contract", "tests/studio")


def test_deleted_support_layer_path_is_not_hidden_from_full_validation() -> None:
    decision = _POLICY.classify(
        [
            "docs/adr/ADR-0060-risk-based-local-commit-gate.md",
            "tests/conftest.py",
        ]
    )

    assert decision.tier == "full"


# --- ADR-0068 连续修改链（TASK-076） ------------------------------------- #


def test_without_the_opt_in_the_original_gate_is_unchanged() -> None:
    """The chain mode is opt-in per commit. Nothing about the mapping moves."""
    decision = _POLICY.classify(["tests/conftest.py"], chain_mode=False)
    assert decision.tier == "full"
    assert decision.notice == ""


def test_the_opt_in_defers_the_whole_suite_but_keeps_the_reason_honest() -> None:
    """ADR-0068 决策 3: whole-suite runs move to the end of the chain. The change
    still owns the whole suite — only the place that run happens changes."""
    decision = _POLICY.classify(["tests/conftest.py"], chain_mode=True)
    assert decision.tier == "continuous-chain"
    assert decision.pytest_targets == ()
    # the ORIGINAL classification is still stated, so the record does not
    # pretend the change was narrowly scoped
    assert "whole pytest suite" in decision.reason
    assert "ADR-0068" in decision.notice


def test_the_full_frontend_suite_is_deferred_too() -> None:
    decision = _POLICY.classify(
        ["mockups/motv-workspace/assets/app.js"], chain_mode=True
    )
    assert decision.tier == "continuous-chain"


def test_targeted_tiers_still_run_under_the_opt_in() -> None:
    """The targeted tiers ARE the 定向测试 the chain requires, and they cost
    seconds — deferring them would leave the middle commits with no tests at
    all, which is not what ADR-0068 traded away."""
    for paths, tier in (
        (["src/ai_video_workflow/validation.py"], "pytest-targeted"),
        (["tests/backend/test_validation.py"], "pytest-targeted"),
        (["src/workspace_shell/app.py"], "pytest-targeted"),
    ):
        decision = _POLICY.classify(paths, chain_mode=True)
        assert decision.tier == tier, paths
        assert decision.pytest_targets, paths
        assert decision.notice == "", paths


def test_a_docs_only_change_is_unaffected_by_the_opt_in() -> None:
    decision = _POLICY.classify(["docs/adr/ADR-0068.md"], chain_mode=True)
    assert decision.tier == "lint"
    assert decision.notice == ""


def test_the_opt_in_comes_from_the_commit_command_not_the_environment() -> None:
    """The gate is a PreToolUse hook, NOT a child of the intercepted commit.

    An inline `MOTV_CONTINUOUS_CHAIN=1 git commit …` can never reach the hook's
    own environment, so an env-based opt-in would only ever work via a session
    or settings variable — i.e. exactly the persistent switch 决策 7 forbids
    (independent review, round 1). Reading the token out of the COMMAND gives
    what the ADR asked for: retyped every commit, visible, nowhere to persist.
    """
    assert _POLICY.chain_mode_from_command('MOTV_CONTINUOUS_CHAIN=1 git commit -m "x"')
    assert _POLICY.chain_mode_from_command("  MOTV_CONTINUOUS_CHAIN=1 git commit")
    for cmd in (
        'git commit -m "x"',
        "MOTV_CONTINUOUS_CHAIN=0 git commit",
        "MOTV_CONTINUOUS_CHAIN=true git commit",
        "MOTV_CONTINUOUS_CHAIN= git commit",
        "MOTV_CONTINUOUS_CHAIN=10 git commit",
        # The case must match. PowerShell's `-like` is case-INSENSITIVE while
        # gate.sh's `grep -F` is not, so a shell-side match made Windows accept
        # what Bash refused — the divergence ADR-0062 决策 3 forbids
        # (independent review, round 2).
        "motv_continuous_chain=1 git commit",
        "Motv_Continuous_Chain=1 git commit",
        # …and it must be the LEADING token, or the commit MESSAGE turns the
        # gate off (independent review, round 2). Leading position is also what
        # makes it a real shell env-assignment prefix rather than a substring.
        'git commit -m "document MOTV_CONTINUOUS_CHAIN=1 opt-in"',
        'git commit -m "MOTV_CONTINUOUS_CHAIN=1"',
        "",
    ):
        assert not _POLICY.chain_mode_from_command(cmd), cmd


def test_the_authoritative_platform_can_actually_type_the_opt_in() -> None:
    """`NAME=value cmd` is Bash grammar. PowerShell 5.1 has no inline
    assignment and answers it with CommandNotFoundException — so on Windows,
    the platform ADR-0062 makes AUTHORITATIVE, the documented invocation could
    not be run at all (independent review, round 3). A leading comment line is
    valid in both shells and keeps every property 决策 7 asked for.
    """
    assert _POLICY.chain_mode_from_command(
        '# MOTV_CONTINUOUS_CHAIN=1\ngit commit -m "x"'
    )
    assert _POLICY.chain_mode_from_command("#MOTV_CONTINUOUS_CHAIN=1\ngit commit")
    # still anchored: a comment further down the command does NOT enable it
    assert not _POLICY.chain_mode_from_command(
        'git commit -m "x"\n# MOTV_CONTINUOUS_CHAIN=1'
    )
    assert not _POLICY.chain_mode_from_command("git commit # MOTV_CONTINUOUS_CHAIN=1")


def test_the_opt_in_cannot_ride_along_with_a_push_or_merge() -> None:
    """ADR-0068 决策 6 is the one invariant the ADR marks non-negotiable, and a
    single `&&` defeated it: the chain's own escape hatch pushed a commit whose
    full suite had never run (independent review, round 3)."""
    whole_suite = ["tests/conftest.py"]
    for cmd in (
        'MOTV_CONTINUOUS_CHAIN=1 git commit -m "batch 2" && git push',
        "MOTV_CONTINUOUS_CHAIN=1 git commit -m x; git push origin main",
        "MOTV_CONTINUOUS_CHAIN=1 git commit -m x && git merge --ff-only main",
        "# MOTV_CONTINUOUS_CHAIN=1\ngit commit -m x\ngit push",
    ):
        decision = _POLICY.decide(whole_suite, cmd, tool_name="Bash")
        assert decision.tier == "chain-conflict", cmd
        assert "ADR-0068" in decision.reason
        assert decision.notice == "", cmd
        # ASCII FIRST LINE, like the notice. This text goes to stderr, gate.ps1
        # writes stderr through [Console]::OutputEncoding, and on a Shift-JIS
        # console a Chinese-only message became irreversible `?` bytes — a block
        # whose reason cannot be read is a block nobody can act on. Every other
        # encoding fix in the policy got a guard; this one did not, and deleting
        # the ASCII line left all 24 tests green (independent review, round 5).
        assert decision.reason.splitlines()[0].isascii(), cmd

    # …and WITHOUT the opt-in the compound is none of this policy's business:
    # that commit ran its full suite, so pushing it is legitimate.
    assert (
        _POLICY.decide(
            whole_suite, "git commit -m x && git push", tool_name="Bash"
        ).tier
        == "full"
    )


def test_classify_never_consults_the_environment() -> None:
    """Making the classifier environment-dependent changed the behaviour of
    every existing caller — including the gate's own pytest run, which inherits
    the variable (independent review, round 1)."""
    import os

    body = (
        Path(_POLICY.__file__)
        .read_text("utf-8")
        .split("def classify(", 1)[1]
        .split("\ndef _classify", 1)[0]
    )
    # the docstring legitimately says the word "environment"; what must not
    # appear is a READ of it
    for forbidden in ("os.environ", "getenv", "environ["):
        assert forbidden not in body, (
            f"classify() must be a pure function of its args ({forbidden})"
        )

    old = os.environ.get("MOTV_CONTINUOUS_CHAIN")
    os.environ["MOTV_CONTINUOUS_CHAIN"] = "1"
    try:
        assert _POLICY.classify(["tests/conftest.py"]).tier == "full"
    finally:
        if old is None:
            os.environ.pop("MOTV_CONTINUOUS_CHAIN", None)
        else:
            os.environ["MOTV_CONTINUOUS_CHAIN"] = old


def test_an_unclassifiable_change_is_never_deferred() -> None:
    """A fail-closed fallback means "we could not work out what this is".
    Deferring it turns an UNKNOWN change into an untested one — the exact
    inversion of what the default exists for (independent review, round 1)."""
    for paths in ([], ["src/ai_video_workflow/no_such_module.py", "Makefile"]):
        decision = _POLICY.classify(paths, chain_mode=True)
        assert decision.tier == "full", paths
        assert decision.notice == "", paths


def test_the_skip_is_announced_and_survives_a_non_utf8_console() -> None:
    """An invisible skip is how a temporary exception becomes permanent — and a
    Chinese-only warning on a cp936/cp932 console is invisible."""
    decision = _POLICY.classify(["tests/conftest.py"], chain_mode=True)
    first = decision.notice.splitlines()[0]
    assert first.isascii(), "the critical line must stay legible everywhere"
    assert "FULL TESTS SKIPPED" in first
    assert "ADR-0068" in first
    # …and a tier that skipped nothing stays silent, so the notice cannot be
    # read as boilerplate
    assert _POLICY.classify(["tests/conftest.py"]).notice == ""


def test_the_cli_both_shells_actually_invoke_behaves_end_to_end() -> None:
    """The tests above call the policy in-process; the gates call a SUBPROCESS.

    Everything between those two — argument parsing, the `--` separator, JSON
    encoding of a notice containing Chinese — was untested (independent review,
    rounds 2 and 3).

    TASK-085 replaced `--command <cmd>` with a resolved `--chain-mode 0|1`. The
    command text no longer travels on this command line at all: it goes to the
    `--intent` call ON A PIPE, which is what removed the 32767-char Windows
    budget failure that let a long commit message spawn-fail the classifier into
    a NON-BLOCKING hook error (i.e. zero checks run).
    """
    import json
    import subprocess

    whole_suite = "tests/conftest.py"

    def run(chain_mode: str, *paths: str) -> dict:
        result = subprocess.run(
            [
                sys.executable,
                str(_POLICY_PATH),
                "--chain-mode",
                chain_mode,
                "--",
                *paths,
            ],
            capture_output=True,
            cwd=_POLICY_PATH.parents[2],
            check=True,
        )
        # decoded as UTF-8 REGARDLESS of console encoding: the hook contract is
        # UTF-8 JSON and a cp932 console does not get a vote (round 3)
        answer = json.loads(result.stdout.decode("utf-8"))
        # …and it must be a DECISION, not an Intent. Asserting on `tier` alone
        # could not tell them apart, because Intent carries a `tier` too — so a
        # classifier call that silently ran in INTENT mode still looked right
        # (变异验证 2026-08-16: that mutation survived until this line existed).
        assert set(answer) == {
            "tier",
            "reason",
            "pytest_targets",
            "serial_targets",
            "frontend",
            # 体检的开关（2026-08-31）：动了 mockups/motv-workspace/ 就为真，
            # 两个 shell 各自读它去跑 `.claude/tools/motv_doctor.py`。
            #
            # **这条守卫当场拦住了加它的那次提交** —— 字段集就是两个 shell 的合同，
            # 加字段而不更新这里，等于让一个 shell 读到一个它不认识的答案。
            "doctor",
            "notice",
        }, answer
        return answer

    assert run("1", whole_suite)["tier"] == "continuous-chain"
    assert run("0", whole_suite)["tier"] == "full"
    # EXACT "1": a switch that can be turned on vaguely gets turned on vaguely
    for vague in ("true", "yes", "on", "01", ""):
        assert run(vague, whole_suite)["tier"] == "full", vague
    # targeted tiers survive the opt-in; docs stay lint; unknown paths stay full
    assert run("1", "src/ai_video_workflow/validation.py")["tier"] == "pytest-targeted"
    assert run("1", "docs/x.md")["tier"] == "lint"
    assert run("1", "Makefile")["tier"] == "full"
    # a changed file literally NAMED like a flag stays a path, because of `--`.
    # `--intent` was NOT covered by this and used to be matched by a membership
    # test over the whole argv, ignoring the separator its sibling honours: the
    # CLASSIFIER call then answered with an Intent object, the shell found no
    # `tier` on it, and the commit was blocked with a nonsense message (codex
    # review round 2). Fail-closed, but a guard existing for one flag and not the
    # one beside it is how the gap survived.
    for staged_path in ("--chain-mode", "--intent", "--"):
        assert run("1", staged_path)["tier"] == "full", staged_path
    # the notice survives the round trip intact, Chinese lines included
    notice = run("1", whole_suite)["notice"]
    assert notice.splitlines()[0].isascii()
    assert "链尾" in notice


def test_the_intent_cli_reads_the_hook_payload_off_the_pipe() -> None:
    """The other half of the CLI contract: the gates pipe the PreToolUse payload
    in and read one JSON object back.

    gate.sh forwards the payload UNTOUCHED (so `tool_name` arrives intact);
    gate.ps1 enriches it with the argv PowerShell's own parser produced.
    """
    import json
    import subprocess

    def run(payload) -> dict:
        result = subprocess.run(
            [sys.executable, str(_POLICY_PATH), "--intent"],
            input=payload
            if isinstance(payload, bytes)
            else json.dumps(payload).encode(),
            capture_output=True,
            cwd=_POLICY_PATH.parents[2],
            check=True,
        )
        return json.loads(result.stdout.decode("utf-8"))

    # gate.sh's shape: the raw payload, forwarded verbatim
    raw = {"tool_name": "Bash", "tool_input": {"command": 'git "commit" -m x'}}
    assert run(raw)["gate"] == "check"
    assert run({"tool_name": "Bash", "tool_input": {"command": "ls -la"}})["gate"] == (
        "skip"
    )

    # gate.ps1's shape: command + the argv its splitter produced
    assert (
        run(
            {
                "tool_name": "PowerShell",
                "command": "git commit -m x",
                "argv": [["git", "commit", "-m", "x"]],
            }
        )["gate"]
        == "check"
    )
    # a parse failure hands over argv=null, and that must FAIL CLOSED rather than
    # read as "no commands, so not a commit"
    failed = run(
        {"tool_name": "PowerShell", "command": "git commit && git push", "argv": None}
    )
    assert failed["gate"] == "check" and failed["force_full"]

    # …and so must a MALFORMED hand-over. This crosses a process boundary, so the
    # argv is untrusted input like any other: a shape the judgements would trip
    # over must fail closed, not raise inside a judgement and take the gate's
    # `exit 0` path with it. (变异验证 2026-08-16: without this case, dropping
    # the element-type check survived the whole suite.)
    for malformed in (
        "not-a-list",
        [["git", "commit"], "flat"],
        [["git", "commit"], ["bad", 1]],
        [["git", "commit"], [None]],
        {"not": "a list"},
    ):
        answer = run(
            {"tool_name": "PowerShell", "command": "git commit -m x", "argv": malformed}
        )
        assert answer["gate"] == "check" and answer["force_full"], malformed

    # an unreadable payload is "I cannot tell", never "not a commit". Matching the
    # RAW payload text with regexes was the old fallback and is the very class
    # this card removed.
    for broken in (b"not json at all", b"[]", b"\xff\xfe\x00garbage"):
        answer = run(broken)
        assert answer["gate"] == "check" and answer["force_full"], broken


def test_neither_shell_decides_the_opt_in_it_hands_the_command_over() -> None:
    """TASK-076 §1.2: the判定 lives in the policy module, and the shells must not
    each implement it.

    Both shells DID match the token themselves, and that is precisely how they
    came to disagree — case-sensitivity and anchoring differ between `-like` and
    `grep -F` (independent review, round 2). A parity test that only compares
    behaviour would have to re-discover every such difference; forbidding the
    duplicate implementation removes the class.
    """
    hooks = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    sh = (hooks / "gate.sh").read_text("utf-8")
    ps1 = (hooks / "gate.ps1").read_text("utf-8")

    # 1. each hands the intercepted command to the policy…
    assert "--intent" in sh and "--intent" in ps1
    assert "--chain-mode" in sh and "--chain-mode" in ps1
    # …and neither contains the token at all, in code or in a comment: a comment
    # today is the template for a re-implementation tomorrow.
    for name, text in (("gate.sh", sh), ("gate.ps1", ps1)):
        assert "MOTV_CONTINUOUS_CHAIN" not in text, (
            f"{name} must not re-implement the opt-in match"
        )

    # 2. the new tiers run NO suite in either, and reach neither "unsupported"
    sh_branch = sh.split("continuous-chain)", 1)[1].split(";;", 1)[0]
    assert "pytest" not in sh_branch and "node" not in sh_branch
    ps1_branch = ps1.split("'continuous-chain' {", 1)[1].split("}", 1)[0]
    assert "pytest" not in ps1_branch and "node" not in ps1_branch
    #    …and both refuse the chain/push conflict. TASK-085 moved that refusal
    #    from a TIER (reached after ruff in one shell, before it in the other)
    #    to the intent call, so both now block before anything runs.
    for name, text in (("gate.sh", sh), ("gate.ps1", ps1)):
        assert "block" in text, f"{name} must act on an intent of `block`"

    # 3. both announce the skip as JSON `systemMessage` — plain stdout from a
    #    PreToolUse hook that exits 0 is DISCARDED, so an `echo` announced the
    #    skip to nobody (round 3). And neither may make a permission decision:
    #    `permissionDecision` would either auto-approve the commit or force a
    #    prompt where the user had allowlisted it.
    for name, text in (("gate.sh", sh), ("gate.ps1", ps1)):
        assert "systemMessage" in text, name
        assert "permissionDecision" not in text, (
            f"{name} must not touch the permission flow"
        )

    # 4. …and only AFTER every check passed. Announcing "full tests skipped" on
    #    a commit that ruff just blocked describes a state that never happened.
    #    Anchor on the EMITTING STATEMENTS: `index("systemMessage")` matched the
    #    explanatory comment above them, so moving the emitter up while leaving
    #    the comment behind satisfied it (independent review, round 4).
    assert sh.index("printf '%s\\n' \"$NOTICE_JSON\"") > sh.rindex(
        "=== commit blocked by gate.sh"
    )
    assert ps1.index("[Console]::Out.WriteLine($payload)") > ps1.rindex(
        "foreach ($check in $checks)"
    )

    # 5. gate.ps1 stays pure ASCII. PowerShell 5.1 decodes a BOM-less script with
    #    the ANSI codepage, and one non-ASCII character that lands inside a
    #    quoted literal is a PARSE error — which exits 1, which PreToolUse treats
    #    as non-blocking, i.e. the gate fails OPEN (independent review, round 4).
    assert ps1.isascii(), "a BOM-less .ps1 must stay ASCII or it can fail open"

    # 5. both force UTF-8 on their python children. Without it the notice died
    #    on one Chinese character under a non-UTF-8 locale, the failure was
    #    swallowed, and the warning vanished — on ONE platform only (round 3).
    assert "PYTHONIOENCODING" in sh and "PYTHONUTF8" in sh
    assert "PYTHONIOENCODING" in ps1 and "PYTHONUTF8" in ps1


def test_the_notice_gate_sh_actually_emits_is_valid_ascii_json() -> None:
    """Runs gate.sh's OWN inline emitter, not a copy of it.

    Everything else here asserts on source text, which is why the previous
    rounds' encoding bug (a Chinese character killing the whole notice on a
    non-UTF-8 stdout) was invisible to the suite. This executes the snippet with
    a real policy payload and checks the bytes that would reach the harness.
    """
    import json
    import subprocess

    hooks = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    sh = (hooks / "gate.sh").read_text("utf-8")
    snippet = sh.split('"$PY" -c \'')[-1].split("')\"; then")[0]
    assert "systemMessage" in snippet, "extracted the wrong snippet from gate.sh"

    policy = json.dumps(
        {"notice": "[continuous-chain] FULL TESTS SKIPPED. ADR-0068.\n  链尾统一跑一次"}
    )
    emitted = subprocess.run(
        [sys.executable, "-c", snippet],
        input=policy.encode("utf-8"),
        capture_output=True,
        check=True,
    ).stdout

    # pure ASCII bytes: the harness parses UTF-8, and a cp932/GB18030 console
    # must not get to decide what those bytes are
    assert emitted.decode("ascii")
    parsed = json.loads(emitted)
    # the ONLY key: `permissionDecision` would either auto-approve the commit or
    # force a prompt on a command the user had allowlisted
    assert list(parsed) == ["systemMessage"]
    assert "FULL TESTS SKIPPED" in parsed["systemMessage"]
    assert "链尾统一跑一次" in parsed["systemMessage"]

    # …and an empty notice emits NOTHING, so the JSON path cannot become noise
    # on every ordinary commit
    assert (
        subprocess.run(
            [sys.executable, "-c", snippet],
            input=b'{"notice": ""}',
            capture_output=True,
            check=True,
        ).stdout
        == b""
    )


def test_gate_ps1_forces_the_same_ascii_escaping() -> None:
    """PowerShell 5.1's ConvertTo-Json does NOT escape non-ASCII (measured), so
    without this the notice would leave gate.ps1 in the console codepage and the
    harness's UTF-8 parse would fail — a hook error instead of the warning."""
    hooks = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    ps1 = (hooks / "gate.ps1").read_text("utf-8")
    emitter = ps1.split("$policy.notice", 1)[1]
    assert "ConvertTo-Json" in emitter
    assert r"'[^\x20-\x7E]'" in emitter
    assert r"'\u{0:x4}' -f" in emitter


def test_ruff_and_diff_checks_still_run_under_the_opt_in() -> None:
    """Deliverable 1.1's other half: the opt-in defers TESTS, nothing else.

    Source-ORDER alone proved nothing — wrapping the ruff entries in
    `if ($policy.tier -ne 'continuous-chain')` leaves the text order untouched
    and this test would still pass while ruff no longer ran (independent review,
    round 3). So also assert the tier is never mentioned in the same region as
    the checks that must be unconditional.
    """
    hooks = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    for name in ("gate.sh", "gate.ps1"):
        text = (hooks / name).read_text("utf-8")
        assert text.index("ruff format") < text.index("continuous-chain"), name
        assert text.index("ruff check") < text.index("continuous-chain"), name
        assert text.index("continuous-chain") < text.rindex("diff --cached"), name

    # Order alone was not enough even after round 3: the region between the two
    # ruff entries spans 116 characters in gate.ps1, so appending
    # `if ($policy.tier -eq 'continuous-chain') { $checks = @() }` AFTER the list
    # literal stopped ruff and both diff checks from running while every
    # assertion above still passed (independent review, round 4). Assert the
    # structural invariant instead: the check list is built ONCE and only ever
    # appended to, so nothing can empty or replace it.
    # Matched as a PATTERN, not a literal: dropping the spaces around `=`
    # (`$checks=@()`) was enough to slip a tier guard past a literal comparison
    # and stop ruff AND both diff checks under the opt-in, with the whole file
    # still green (independent review, round 5). `\s*` also spans a line break,
    # so splitting the assignment over two lines does not help either.
    # `$checks +=` is not matched: `+` is not whitespace.
    import re as _re

    ps1 = (hooks / "gate.ps1").read_text("utf-8")
    assignments = _re.findall(r"\$checks\s*=", ps1)
    assert len(assignments) == 1, "the check list must be assigned exactly once"
    assert not _re.search(r"\$checks\s*=\s*@\(\s*\)", ps1)

    # gate.sh's equivalent. Checking only the text BEFORE the ruff run missed the
    # real insertion point: the tier was consulted AFTER it, on the line that
    # chains the diff checks. So assert the tier is not consulted anywhere from
    # the policy parse to the end of the check sequence — the ONLY place it may
    # appear in that span is the `case` that selects the test suite.
    sh = (hooks / "gate.sh").read_text("utf-8")
    # anchored to the END OF THE TIER SWITCH, not to the first `esac` in the
    # file: adding any earlier case block would otherwise move the anchor above
    # the switch and fail this test on a perfectly legitimate edit
    after_switch = sh.index("esac", sh.index('case "$POLICY_TIER" in'))
    for start, end in (
        # nothing may guard the ruff runs…
        (sh.index("POLICY_PYTEST_TARGETS"), sh.rindex('run_check "ruff format')),
        # …and nothing may guard the diff checks either. Checking only the text
        # BEFORE the ruff run missed the real insertion point, which is the line
        # that chains the diff checks, AFTER the suite-selecting case.
        (after_switch, sh.rindex('run_check "git diff --cached')),
    ):
        assert "POLICY_TIER" not in sh[start:end], (start, end)


def test_no_persistent_switch_exists_anywhere_in_the_repo() -> None:
    """ADR-0068 决策 7: the token is typed per commit. Anything that STORES it —
    including a gitignored local settings file — makes the skip the default.

    Scans the repo rather than three hardcoded paths (independent review, round
    1): the previous version skipped `.claude/settings.local.json` entirely when
    it did not exist, which is the single most likely home for such a switch.

    Round 3 closed three blind spots in that scan, each of them at a LIKELY
    hiding place rather than an exotic one:

    - it excluded everything directly under `.claude/hooks/`, so a new
      `chain.json` next to the gate was invisible to this test AND to its
      companion, which reads only `gate.sh` / `gate.ps1`;
    - it filtered by SUFFIX, and `Path(".env").suffix` / `Path(".bashrc").suffix`
      are both `""` — every dotfile, the classic home for an exported switch,
      was unreachable, as were `Makefile`, `.bat`, `.cmd`, `.ini`, `.cfg`;
    - TASK-076 验收 #6 claimed 「全仓扫描」 while the scan covered neither rc nor
      profile.

    So: scan EVERY file and allowlist the three places the token legitimately
    lives. An allowlist cannot develop a new blind spot when someone adds a file
    type; a denylist of suffixes did.
    """
    root = Path(__file__).resolve().parents[2]
    allowed = {
        # the one implementation
        root / ".claude" / "hooks" / "commit_gate_policy.py",
        # this test
        Path(__file__).resolve(),
    }
    offenders = []
    for path in root.rglob("*"):
        if not path.is_file() or ".git" in path.parts:
            continue
        # transient reviewer/CI artifacts, not repo state — they quote the token
        # because they discuss it
        if ".claude/tmp" in path.as_posix():
            continue
        if path in allowed or path.suffix.lower() == ".md":
            continue
        try:
            text = path.read_text("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if "MOTV_CONTINUOUS_CHAIN" in text:
            offenders.append(str(path.relative_to(root)))
    assert offenders == [], f"a persistent opt-in is stored in: {offenders}"


def test_a_literal_backslash_in_a_path_forces_the_full_tier() -> None:
    r"""codex 跨模型复审 2026-08-16。

    `_normalise` 把每个 `\` 换成 `/`，好让 Windows 写法与 git 写法分到同一类。
    但在 Linux 上反斜杠是**文件名里的合法字符**，于是一个真名叫
    `docs\payload.py` 的单个文件被规范化成 `docs/payload.py`，拿到「仅文档」
    档位——一个 Python 文件就这样整个跳过了 pytest。

    gate.sh 传 `-z`，这种名字会原样、不加引号地送进来，所以这条路是**可达的**，
    不是理论问题。fail-closed：不去猜它到底想表达斜杠的哪一边，直接给全量。
    """
    decision = _POLICY.classify([r"docs\payload.py"])
    assert decision.tier == "full", "带字面反斜杠的路径不得取便宜档"
    assert "backslash" in decision.reason

    # 同一条对高风险伪装成文档同样有效
    assert (
        _POLICY.classify([r"docs\..\src\ai_video_workflow\persistence.py"]).tier
        == "full"
    )

    # …而真正的文档改动仍然走轻档（这条修复不是把所有东西都推到 full）
    assert _POLICY.classify(["docs/adr/ADR-0001-foo.md"]).tier == "lint"
    assert _POLICY.classify(["AGENTS.md", "CLAUDE.md"]).tier == "lint"


def test_both_shells_ask_git_for_NUL_separated_paths() -> None:
    """codex 跨模型复审：gate.sh 一直传 `-z`，gate.ps1 没传。

    不传 `-z` 时 git 会把含非 ASCII 或特殊字符的路径**加引号并转义**输出
    （`"docs/\344\270\255\346\226\207.md"`），分类器读到的就不是那个路径了
    ——单是开头那个引号就让所有前缀判断落空，于是高风险文件可能拿到便宜档。

    仓库今天没有非 ASCII 路径，这正是它一直看不见的原因：第一个中文文件名就会
    掀翻一道没人盯着的闸。
    """
    root = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    sh = (root / "gate.sh").read_text("utf-8")
    ps1 = (root / "gate.ps1").read_text("utf-8")

    assert "--no-renames -z)" in sh or " -z)" in sh or " -z " in sh
    # ps1 的两条**分类用** diff（--cached 与 -a/--all 两种形态）都必须带 -z。
    # 只看 `$diffArgs =` 那两行：`git diff --check` 是另一回事，它不解析路径。
    diff_lines = [ln for ln in ps1.splitlines() if ln.strip().startswith("$diffArgs =")]
    assert len(diff_lines) == 2, f"两种 diff 形态都要检查，找到 {len(diff_lines)} 条"
    for ln in diff_lines:
        assert "'-z'" in ln, f"缺少 -z: {ln.strip()}"
    # …而且真的按 NUL 切，不是按换行（否则 -z 等于没加）
    assert '-split "`0"' in ps1, "有 -z 就必须按 NUL 切"
    assert '-split "`r?`n"' not in ps1.split("$changedPaths", 1)[1][:200]


@pytest.mark.parametrize(
    "tail",
    [
        "git push",
        'git "push"',
        "git 'push'",
        "git merge main",
        "git pull",
        "git rebase main",
        "git cherry-pick abc123",
    ],
)
def test_the_chain_token_refuses_every_way_of_moving_commits(tail) -> None:
    """codex 跨模型复审 2026-08-16，两条都用分类器实跑确认过。

    ADR-0068 决策 6：链尾全量跑完之前，不得把提交带出去或把别人的整合进来。
    原来的扫描漏了两类，而且是**漏**不是过度阻塞——那段注释自己说过，漏掉一次
    真实 push 的代价是「一个全量从未跑过的提交进了别人的视野」：

    · 加一对引号，那个词就不再落在分隔符上，扫描直接跳过它；
    · 动词表里只有两个，另外三种把提交带出去/整合进来的方式全部放行。
    """
    cmd = "MOTV_CONTINUOUS_CHAIN=1 git commit -m x && " + tail
    decision = _POLICY.decide(["tests/conftest.py"], cmd, tool_name="Bash")
    assert decision.tier == "chain-conflict", (
        tail + " 必须被拒绝，实为 " + decision.tier
    )


def test_the_token_must_not_be_triggered_from_the_commit_message() -> None:
    """同一轮里 codex 还报了「提交信息里的令牌能开减档」——**实测不成立**，
    锚定是有效的。这条留作反向守卫：它一旦真的成立，减档就成了任何人打一句
    话就能打开的开关。"""
    decision = _POLICY.decide(
        ["tests/conftest.py"],
        'git commit -m "note: MOTV_CONTINUOUS_CHAIN=1 was used earlier"',
        tool_name="Bash",
    )
    assert decision.tier == "full", "提交信息里的令牌不得启用减档"


def test_a_normal_chain_commit_still_gets_the_reduced_tier() -> None:
    """扩大拒绝面不能把连续修改链本身也堵死。"""
    decision = _POLICY.decide(
        ["tests/conftest.py"],
        "MOTV_CONTINUOUS_CHAIN=1 git commit -m x",
        tool_name="Bash",
    )
    assert decision.tier == "continuous-chain"


# --- TASK-085 意图判定：不再从命令文本猜，改用每个 shell 自己的解析器 ------- #
#
# 这一段守卫的是**闸门自己**。判定错一次的代价不是一个小 bug，是一次零检查的提交。


#: 待复审清单第 3 项列出的四条已知绕过。今天它们让 gate **整个不跑**。
#: 任务卡把第四条简写成 `c""ommit`，指的是被拆开的**子命令**写法，
#: 即 `git c""ommit`——单独一个 `c""ommit` 根本不是 git 命令，不该被 gate 拦。
_KNOWN_BYPASSES = (
    'git "commit" -m x',
    'git "-C" /other commit -m y',
    'g""it commit -m x',
    'git c""ommit -m x',
)


def test_the_four_known_bypasses_are_no_longer_invisible() -> None:
    """一对引号就能让 gate 静默不跑——这是本卡要消除的那一类。

    这四条今天全部**逃过整个闸门**（`exit 0`，零检查通过）。它们不是四个拼写
    遗漏，是「用正则读命令文本判断意图」这件事本身的必然结果：宽了误伤，窄了
    漏掉，而 `g""it` 能骗过任何写得出来的 substring 预筛——**引号是 shell 的，
    不是文本的**。
    """
    for command in _KNOWN_BYPASSES:
        intent = _POLICY.inspect_command("Bash", command)
        assert intent.gate != "skip", f"{command} 又一次静默绕过了闸门"

    # 前三条走完整检查，第二条（重定向到别的仓库）必须直接拒绝：本仓库的检查
    # 结论不能为另一个仓库的提交背书。
    assert _POLICY.inspect_command("Bash", _KNOWN_BYPASSES[1]).gate == "block"
    for command in (_KNOWN_BYPASSES[0], _KNOWN_BYPASSES[2], _KNOWN_BYPASSES[3]):
        assert _POLICY.inspect_command("Bash", command).gate == "check", command


def test_lowercase_c_is_a_config_override_not_a_repository_redirect() -> None:
    """`-c key=value` 是无害的配置覆盖，`-C path` 才是换仓库。

    旧实现靠**大小写敏感的正则**区分这两个，于是「两个 shell 的匹配必须在
    大小写敏感性上一致」成了一条隐性约束——而 PowerShell 的 `-like` 天生
    大小写不敏感，这正是两侧当初分叉的根。精确 token 比较把这条约束整个删掉。
    """
    assert _POLICY.inspect_command("Bash", "git -c core.hooksPath=x commit").gate == (
        "check"
    )
    assert _POLICY.inspect_command("Bash", "git -C /other commit").gate == "block"

    # …而 `git commit -C HEAD` 是**复用另一条提交的信息**，没有换任何仓库。
    # 旧正则在整串文本上找 `-C`，把它误拦了；限定在**子命令之前的全局选项**
    # 才是 git 真正的语法。
    assert _POLICY.inspect_command("Bash", "git commit -C HEAD").gate == "check"


def test_a_command_that_cannot_be_parsed_runs_everything() -> None:
    """决策 4：「这不是 commit」和「我判断不出这是不是 commit」是两个答案。

    旧实现 Phase A 任何异常一律 `exit 0`，理由是「坏掉的探测器不能拦住无关
    命令」。听起来稳妥，实际后果是**探测器一坏，闸门就静默消失**。
    """
    unparseable = "echo don't"  # 引号不配对：bash 自己也跑不了
    intent = _POLICY.inspect_command("Bash", unparseable)
    assert intent.gate == "check", "判断不出来时必须当成可能是 commit"
    assert intent.force_full, "而且不能相信暂存路径能描述它——直接跑全量"

    # 关键的一半：**带着链令牌**的读不懂命令。令牌是文本位置判定（决策 3），
    # 所以它照样匹配得上；如果 fail-closed 不把它压掉，就出现了最坏的组合——
    # 一条读不懂的命令拿到了跳过全量的授权。fail-closed 必须能复合，否则
    # 它不是 fail-closed。
    # （变异验证 2026-08-16：只用不带令牌的命令测，这条会漏——那次变异存活。）
    with_token = "MOTV_CONTINUOUS_CHAIN=1 git commit -m x && echo don't"
    assert _POLICY.chain_mode_from_command(with_token), "前提：令牌本身是匹配的"
    poisoned = _POLICY.inspect_command("Bash", with_token)
    assert poisoned.force_full, with_token
    assert not poisoned.chain_mode, "读不懂的命令绝不能顺带拿到跳过全量的令牌"


def test_a_hash_inside_a_word_cannot_swallow_a_trailing_push() -> None:
    """tokenizer 关掉了 `#` 的注释语义，这条钉住那个选择。

    shlex 默认会把 `#` 之后的整行丢掉，**包括词中间的 `#`**（bash 那里它是普通
    字符）。凡是被丢掉的东西，ADR-0068 决策 6 的扫描就再也看不见——一个
    `-m x#1 && git push` 就能让真实的 push 隐形。

    代价是反向的过度阻塞：真正写成注释的 `# ...` 里若出现 push 也会被拦。
    那一侧只多花一次重打，另一侧是把没跑过全量的提交推给别人。
    """
    conflict = "MOTV_CONTINUOUS_CHAIN=1 git commit -m x#1 && git push"
    assert (
        _POLICY.decide(
            ["src/ai_video_workflow/persistence.py"], conflict, tool_name="Bash"
        ).tier
        == "chain-conflict"
    )


@pytest.mark.parametrize("tool_name", [None, "", "PowerShell", "Write", "bash "])
def test_an_unknown_tool_name_fails_closed(tool_name) -> None:
    """`tool_name` 是本方案新增的那个输入：同一段文本在两种 grammar 下含义不同，
    不知道用哪一种就等于判断不出来。

    `PowerShell` 也在这张表里：只有 gate.ps1 能切分 PowerShell 语法，所以带着
    PowerShell 文本却**没有** argv 的调用（例如 gate.sh 真的收到一份），只能
    fail-closed。
    """
    intent = _POLICY.inspect_command(tool_name, "git commit -m x")
    assert intent.gate == "check" and intent.force_full, tool_name


@pytest.mark.parametrize(
    "command",
    [
        'eval "git commit -m x"',
        "bash -c 'git commit -m x'",
        "$G commit -m x",
        "$(echo git) commit -m x",
        "make commit",
        "./scripts/do-commit.sh",
    ],
)
def test_the_documented_bypasses_really_do_still_bypass(command) -> None:
    """**这条测试断言的是一个漏洞仍然存在**，而且这是故意的。

    解析器解决的是**引号与转义**，解决不了**间接**：hook 拿到的是「将要交给
    shell 的一段文本」，凡是文本本身不足以决定行为的写法，任何静态判定都得不出
    结论。方案 §6 诚实列了这张表，这条测试把那张表**钉成可执行的**——将来谁
    以为自己顺手堵死了其中一条，会先在这里看到红色，然后才去改文档，而不是
    留下一份说「已覆盖」而其实没有的注释。

    这个仓库已经四次栽在「守卫看起来加了，其实没接上」。反过来的守卫同样重要：
    **不要假装堵死**。真正堵死要靠仓库自己的 `pre-commit` git hook（它在 git
    进程内，无论谁怎么调起来都会跑），那是另一张卡。
    """
    assert _POLICY.inspect_command("Bash", command).gate == "skip", (
        f"{command} 现在被抓到了——这是好事，但方案 §6 与源码里那张"
        f"「已知漏洞边界」表必须同步更新，否则文档就在撒谎"
    )


def test_the_known_bypass_table_is_still_written_down_in_the_source() -> None:
    """验收第 2 条：间接形式仍然绕过，**且这一点写在代码注释里**。

    删掉这张表比删掉代码容易得多，而一旦删掉，下一个人读到的就是一个看起来
    密不透风的闸门。
    """
    source = Path(_POLICY.__file__).read_text("utf-8")
    table = source.split("KNOWN BYPASSES THAT REMAIN", 1)
    assert len(table) == 2, "源码里必须留着那张「已知漏洞边界」表"
    table = table[1].split("def ", 1)[0]
    for form in ("eval", "-c '", "$(echo git)", "alias", "child process"):
        assert form in table, f"漏洞表里少了 {form} 这一类"
    assert "cannot" in table, "必须写明安全边界没有抬到「不可绕过」"


def test_wrappers_keep_the_coverage_the_old_regex_already_had() -> None:
    """`sudo git commit` 旧正则是**抓得到**的（文本里同时有 git 和 commit）。

    换成 token 判定后，如果只看第一个 token，它会变成「命令名是 sudo，不是
    git」——一次伪装成重写的**倒退**。包装器把真正的命令留在自己的 argv 里，
    所以拆开它不是解析器的聪明，是不丢已有覆盖面。
    """
    for command in (
        "sudo git commit -m x",
        "env FOO=1 git commit -m x",
        "nice git commit -m x",
        "xargs git commit",
        "xargs -n1 git commit",
        "command git commit -m x",
        # 包装器的选项可能**带独立的值**，只跳过 `-` 开头的 token 会把那个**值**
        # 当成命令名：`sudo -u builder git commit` 曾解析成命令 `builder` 并回答
        # 「不是 commit」——一个绕过，而且是**旧文本正则没有的**绕过
        # （codex 审查轮 1，实跑分类器确认）。逐个包装器建选项表是一张迟早写错
        # 的表，所以改成在包装器拿到的 token 里**找 git**。
        "sudo -u builder git commit -m x",
        "sudo -H -u builder git commit -m x",
        "nice -n 10 git commit -m x",
        "env -u FOO git commit -m x",
        "xargs -I{} git commit -m x",
        "/usr/bin/sudo -u builder /usr/bin/git commit -m x",
    ):
        assert _POLICY.inspect_command("Bash", command).gate == "check", command

    # …而「更多 gating」那一侧不会把无关命令拖进来：末尾那个 git 后面没有子命令
    for command in (
        "sudo -u builder apt install git",
        "sudo -u builder ls",
        "nice -n 10 make all",
    ):
        assert _POLICY.inspect_command("Bash", command).gate == "skip", command


def test_an_attached_dash_C_value_is_not_valid_git_and_is_not_a_bypass() -> None:
    """codex 审查轮 1 报 `git -C/path commit` 是重定向绕过——**实测不成立**。

    git 的全局选项由 `git.c` 的 `handle_options` 手工解析，`-C` 是**整 token
    比较**，不接受贴着写的值：

        $ git -C/nonexistent-xyz status
        unknown option: -C/nonexistent-xyz          (exit 129)
        $ git -Z/nonexistent-xyz status
        unknown option: -Z/nonexistent-xyz          (exit 129)   # 完全同一个错

    两者报错一致，说明 `-C/path` 对 git 而言就是个**未知选项**，命令在做任何事
    之前就失败了——没有提交发生在任何仓库里，也就没有可绕过的东西。

    这条留作反向守卫：如果哪天 git 真的接受了贴着写的形式，本条会变红，届时
    `_redirects_the_repository` 需要加前缀匹配（且必须大小写敏感，别把
    `-c key=val` 一起吃进去）。
    """
    # 它仍然被认成一条 commit（走完整检查），只是不再被当成重定向
    assert _POLICY.inspect_command("Bash", "git -C/other commit").gate == "check"
    # 分隔写法才是真的重定向，照旧拒绝
    assert _POLICY.inspect_command("Bash", "git -C /other commit").gate == "block"


def test_dash_am_is_a_worktree_commit_and_must_be_diffed_against_HEAD() -> None:
    """`git commit -am "x"` 是完全普通的写法，旧正则只认 `-a` 和 `--all`。

    于是它按 **index** 分类，而这条提交实际写的是 **worktree**：分类器看的是
    一份不描述这次提交的路径清单。选错方向只会让 diff 变窄——也就是档位变低。
    """
    assert _POLICY.inspect_command("Bash", "git commit -am x").diff == "head"
    assert _POLICY.inspect_command("Bash", "git commit -a -m x").diff == "head"
    assert _POLICY.inspect_command("Bash", "git commit --all -m x").diff == "head"
    assert _POLICY.inspect_command("Bash", "git commit -m x").diff == "index"
    # `--amend` 不是 `--all`，`-m` 里没有 a
    assert _POLICY.inspect_command("Bash", "git commit --amend -m x").diff == "index"

    # 簇里**取值的那个选项之后全是它的值**，不是更多 flag（codex 审查轮 2）：
    # `-Salpha` 是签名密钥 `-S alpha`，不是 `-S -a -l -p -h -a`；把值当 flag 读
    # 会找到一个根本不存在的 `a`，于是拿 HEAD 去 diff，把无关的未暂存改动一起
    # 拖进档位判定——只暂存了干净路径的提交会被工作区里坏掉的东西拦下。
    for token in ("-Salpha", "-mall", "-uall", "-Fa", "-ma", "-Cabc", "-tall"):
        assert _POLICY.inspect_command("Bash", f"git commit {token}").diff == "index", (
            token
        )
    # …而取值选项**之前**的 a 仍然算数
    for token in ("-am", "-aS", "-qam"):
        assert (
            _POLICY.inspect_command("Bash", f"git commit {token} x").diff == "head"
        ), token


def test_a_dash_a_that_is_an_option_value_or_a_pathspec_is_not_the_all_flag() -> None:
    """簇内不再过度匹配之后，**调用点**还在对每个 token 做成员测试（codex 补审）。

    同一个错误类型只是上移了一层：选项的值和 `--` 之后的 pathspec 都被当成 flag。
    下面每一条的 git 真实语义都实测过（git 2.55.0.windows.4）：

    - `git commit -qm -a` / `--message -a` → `no changes added to commit`，
      也就是 `-a` 是**消息**，这次提交只写 index；
    - `git commit -m msg -- -a` → `error: pathspec '-a' did not match`，
      也就是 `-a` 是**路径**；
    - `git commit -mmsg -a` → `Changes to be committed`，值是贴着写的，
      后面那个 `-a` 是真的 `--all`。

    方向是过度匹配 → 拿 HEAD 去 diff → 档位偏高：只暂存了干净路径的提交，会被
    工作区里无关的坏改动拦下。`_selects_all_tracked` 的 docstring 正是为了这个
    代价才不肯过度匹配，那么调用点也不该把它退回去。
    """
    for command in (
        "git commit -qm -a",
        "git commit --message -a",
        "git commit -m msg -- -a",
        "git commit --file -a",
        "git commit --template -a",
        "git commit --unified -a",
        # `--` 之后全是路径，哪怕长得像 `--all`
        "git commit -m msg -- --all",
    ):
        assert _POLICY.inspect_command("Bash", command).diff == "index", command

    for command in (
        # 值贴着写，后面那个才是真 flag
        "git commit -mmsg -a",
        "git commit --message=msg -a",
        # 布尔选项**不吃**下一个 token，否则真的 `-a` 会被当成它的值而漏掉
        "git commit --amend -a",
        "git commit --no-verify -a",
        "git commit -q -a",
        # 取值选项吃掉的是它自己的值，`-a` 在那之后仍然算数
        "git commit -m msg -a",
        "git commit --author x -a",
        # **可选**值的选项只接受贴着写的值，所以下一个 token 不是它的：
        # `git commit -S -a` 实测 `Changes to be committed`（`-a` 就是 `--all`），
        # 而 `git commit -u all` 实测 `pathspec 'all' did not match`。
        # 把它当成吃下一个 token，会把这里的 `-a` 藏掉、答成 index ——
        # **漏检**方向：diff 变窄、档位变低（codex 补审轮 2 的 blocking）。
        "git commit -S -a",
        "git commit -u -a",
        "git commit --gpg-sign -a",
        "git commit --untracked-files -a",
        "git commit -qS -a",
        # `--` 之前的 `-a` 照旧算数
        "git commit -a -- src/x.py",
    ):
        assert _POLICY.inspect_command("Bash", command).diff == "head", command


def test_a_commit_message_mentioning_push_is_no_longer_a_chain_conflict() -> None:
    """方案 §3 表里那条**误伤**：旧扫描去掉引号后在整串文本里找五个动词，
    于是提交信息里写了 push 就被当成真的 push 拦下。

    token 判定同时解决了漏和误伤两侧——`push` 是不是 git 的**子命令**，
    和它有没有出现在某条信息里，是两个不同的问题。
    """
    token = "MOTV_CONTINUOUS_CHAIN=1"
    high_risk = ["tests/conftest.py"]

    allowed = _POLICY.decide(
        high_risk, f'{token} git commit -m "say push here"', tool_name="Bash"
    )
    assert allowed.tier == "continuous-chain", "信息里提到 push 不该拦住链提交"

    # …而真的 push 仍然拦，引号也救不了它
    for tail in ("&& git push", '&& git "push"', "&& git cherry-pick abc"):
        blocked = _POLICY.decide(
            high_risk, f"{token} git commit -m x {tail}", tool_name="Bash"
        )
        assert blocked.tier == "chain-conflict", tail


def test_the_two_cli_modes_together_reproduce_decide() -> None:
    """`decide()` 是这份合同的**规格**，两个 CLI 模式合起来是它的**实现**。

    分成两次调用是有原因的：意图必须在 `git diff` **之前**知道（它决定问 git
    要哪一份 diff）。但那样一来 `decide()` 就成了一个没人实现的规格——本仓库
    反复栽的正是这种「守卫看起来接上了其实没有」。这条测试是那根接线。
    """
    import json
    import subprocess

    token = "MOTV_CONTINUOUS_CHAIN=1"
    high_risk = "src/ai_video_workflow/persistence.py"

    def through_the_cli(command: str, *paths: str) -> str:
        intent = json.loads(
            subprocess.run(
                [sys.executable, str(_POLICY_PATH), "--intent"],
                input=json.dumps(
                    {"tool_name": "Bash", "tool_input": {"command": command}}
                ).encode("utf-8"),
                capture_output=True,
                cwd=_POLICY_PATH.parents[2],
                check=True,
            ).stdout.decode("utf-8")
        )
        if intent["gate"] == "skip":
            return "skip"
        if intent["gate"] == "block":
            return intent["tier"]
        if intent["force_full"]:
            return "full"
        return json.loads(
            subprocess.run(
                [
                    sys.executable,
                    str(_POLICY_PATH),
                    "--chain-mode",
                    "1" if intent["chain_mode"] else "0",
                    "--",
                    *paths,
                ],
                capture_output=True,
                cwd=_POLICY_PATH.parents[2],
                check=True,
            ).stdout.decode("utf-8")
        )["tier"]

    for command, paths in (
        ("git commit -m x", (high_risk,)),
        (f"{token} git commit -m x", (high_risk,)),
        (f"{token} git commit -m x && git push", (high_risk,)),
        ("git -C /other commit", (high_risk,)),
        ("ls -la", ()),
        ("echo don't", (high_risk,)),
        (f"{token} git commit", ("docs/x.md",)),
        (f"{token} git commit", ("src/ai_video_workflow/validation.py",)),
        # 一个真名叫 `--chain-mode` 的改动文件仍然是路径，因为有 `--`
        ("git commit", ("--chain-mode",)),
    ):
        expected = _POLICY.decide(list(paths), command, tool_name="Bash")
        assert through_the_cli(command, *paths) == expected.tier, command


def test_gate_ps1_splits_powershell_with_powershells_own_parser() -> None:
    """跨 shell 一致性（ADR-0062 决策 3），**实跑 gate.ps1 自己那段切分**。

    这条测试把 gate.ps1 里 BEGIN/END 之间的函数抠出来真的执行，而不是对源码
    做字符串断言——本仓库此前的编码 bug 之所以能躲过整套测试，正是因为测试
    只断言了源码文本。

    只在有 powershell 的主机上跑。Windows 是权威环境（ADR-0062），而 Linux 上
    根本不存在 PowerShell 工具，所以那半边由 fail-closed 覆盖，见下一条。
    """
    import json
    import shutil
    import subprocess
    import tempfile

    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if powershell is None:
        pytest.skip(
            "no powershell on this host (Ubuntu target: PowerShell tool 不存在)"
        )

    hooks = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    ps1 = (hooks / "gate.ps1").read_text("utf-8")
    body = ps1.split("# --- BEGIN GATE-ARGV-SPLITTER", 1)
    assert len(body) == 2, "gate.ps1 里的切分函数必须留着可抠出的标记"
    body = body[1].split("# --- END GATE-ARGV-SPLITTER", 1)[0]
    body = body.split("\n", 1)[1]

    driver = (
        body
        + """
$reader = New-Object System.IO.StreamReader(
    [Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$text = $reader.ReadToEnd()
$split = ConvertTo-GateArgv -CommandText $text
$payload = if ($split.Parsed) {
    @{ commands = $split.Commands } | ConvertTo-Json -Depth 6 -Compress
} else { '{"commands":null}' }
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
"""
    )

    with tempfile.TemporaryDirectory() as workdir:
        script = Path(workdir) / "split.ps1"
        script.write_text(driver, encoding="utf-8")

        def split(command: str):
            result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script),
                ],
                input=command.encode("utf-8"),
                capture_output=True,
                check=True,
            )
            return json.loads(result.stdout.decode("utf-8"))["commands"]

        # 引号形式在 PowerShell 侧同样必须被解开
        for command in ('git "commit" -m x', 'g""it commit -m x', 'git c""ommit -m x'):
            assert _POLICY.inspect_command(
                "PowerShell", command, split(command)
            ).gate == ("check"), command
        assert (
            _POLICY.inspect_command(
                "PowerShell", 'git "-C" other commit', split('git "-C" other commit')
            ).gate
            == "block"
        )
        # `-c` 仍然不是 `-C`
        assert (
            _POLICY.inspect_command(
                "PowerShell", "git -c core.x=1 commit", split("git -c core.x=1 commit")
            ).gate
            == "check"
        )
        # 非 commit 不受影响
        assert (
            _POLICY.inspect_command(
                "PowerShell", "Get-ChildItem", split("Get-ChildItem")
            ).gate
            == "skip"
        )
        # 多条语句各自切开，链令牌 + push 仍然被拒
        chained = "# MOTV_CONTINUOUS_CHAIN=1\ngit commit -m x\ngit push"
        assert _POLICY.inspect_command("PowerShell", chained, split(chained)).gate == (
            "block"
        )
        # 解析失败 -> $null -> 由策略 fail-closed（PowerShell 5.1 没有 `&&`）
        assert split('git commit -m "x" && git push') is None


def test_gate_sh_is_never_less_careful_than_gate_ps1_on_the_same_payload() -> None:
    """ADR-0062 决策 3 要求同一输入同一判定。两侧唯一能不同的是 PowerShell
    文本：只有 gate.ps1 能切分它。

    诚实的表述不是「两边完全相同」，而是**能判定的地方完全相同，判定不了的
    那一侧只会更保守，绝不会更宽松**。POSIX 切分在 Python 里共用同一份代码，
    所以 Bash payload 两侧本就是同一次计算。
    """
    for command in ("git commit -m x", "ls -la", 'git "commit" -m x'):
        # gate.sh 若真的收到 PowerShell payload：没有 argv -> fail-closed
        as_gate_sh = _POLICY.inspect_command("PowerShell", command, None)
        assert as_gate_sh.gate == "check" and as_gate_sh.force_full, command
        # 而 fail-closed 永远是「跑得更多」，不是「跑得更少」
        assert not as_gate_sh.chain_mode, command


def test_both_shells_BOUND_the_intent_step_too() -> None:
    """意图判定现在跑在**每一次** Bash/PowerShell 工具调用上。

    它挂住而没有超时，触发的就是**外层 hook 超时**——PreToolUse 把那个读成
    **非阻塞**错误，于是命令照跑。这正是分类器那一步 2026-08-16 被报出来的
    同一个 fail-open，新加的一步不能重犯。
    """
    root = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    sh = (root / "gate.sh").read_text("utf-8")
    ps1 = (root / "gate.ps1").read_text("utf-8")

    sh_segment = sh.split("INTENT_JSON=", 1)[1].split("\nfi", 1)[0]
    assert "timeout --kill-after" in sh_segment, "gate.sh 的意图调用必须有超时"

    ps_segment = ps1.split("$intentResult = Invoke-Bounded", 1)[1].split("\n}", 1)[0]
    assert "-TimeoutSeconds 15" in ps_segment, "gate.ps1 的意图调用必须有超时"

    import re as _re

    assert {
        int(m) for m in _re.findall(r"timeout --kill-after=\d+ (\d+)", sh_segment)
    } == {15}


def test_neither_shell_judges_intent_it_hands_the_payload_over() -> None:
    """TASK-085 的核心结构约束：**切分可以在 shell 里，判定不行。**

    gate.ps1 必须切 PowerShell 语法（只有 PowerShell 能），但它交出去的是
    token，不是结论。一旦某个 shell 自己认起 `commit` / `-C` / 五个动词，
    两侧就又有了各自漂移的空间——那正是它们上一次分叉的机制。
    """
    hooks = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    sh = (hooks / "gate.sh").read_text("utf-8")
    ps1 = (hooks / "gate.ps1").read_text("utf-8")

    # 1. 两侧都调用意图模式，且都把判定结果原样用掉
    for name, text in (("gate.sh", sh), ("gate.ps1", ps1)):
        assert "--intent" in text, f"{name} 必须把意图问题交给策略"
        assert "--chain-mode" in text, f"{name} 必须把已解析的链开关传下去"

    # 2. 判定用的字面量只许出现在策略模块里。这些是「结论」，不是「切分」。
    for name, text in (("gate.sh", sh), ("gate.ps1", ps1)):
        for literal in (
            "--git-dir",
            "--work-tree",
            "cherry-pick",
            "MOTV_CONTINUOUS_CHAIN",
        ):
            assert literal not in text, f"{name} 不得自己实现意图判定：{literal}"

    # 3. 旧的三处文本预筛必须真的删掉，而不是留在旁边
    for name, text in (("gate.sh", sh), ("gate.ps1", ps1)):
        assert "namesGit" not in text and "namesCommit" not in text, name
        assert "--command" not in text, f"{name} 仍在用旧的 --command 合同"

    # 4. gate.ps1 的切分函数只切分：它不认识任何一个判定词
    splitter = ps1.split("function ConvertTo-GateArgv", 1)[1].split(
        "# --- END GATE-ARGV-SPLITTER", 1
    )[0]
    for literal in ("git", "commit", "-C", "push"):
        assert literal not in splitter, (
            f"切分函数里出现了判定词 {literal!r}——它必须只认 AST 节点类型"
        )

    # 5. gate.ps1 依然是纯 ASCII：它没有 BOM，PowerShell 5.1 会用 ANSI 代码页
    #    解码，一个落在引号里的非 ASCII 字符就是**解析错误**，退出码 1，而
    #    PreToolUse 把 1 当成非阻塞错误——闸门 fail OPEN。
    assert ps1.isascii(), "a BOM-less .ps1 must stay ASCII or it can fail open"


def test_both_shells_BOUND_the_classifier_step() -> None:
    """跨模型复审 2026-08-16：只有这一步没有超时。

    gate.ps1 用 `Invoke-Bounded -TimeoutSeconds 15` 跑分类器，gate.sh 是**裸调用**。
    这里挂住永远到不了它下面那句 `exit 2`——先触发的是**外层 hook 超时**，而
    PreToolUse 把那个读成**非阻塞**错误，于是提交在**零检查**的情况下通过。

    这正是 gate.sh 自己那段预算注释说「a hung check must never fail open」要防的
    事，而分类器是唯一漏掉的一步。两侧同为 15 秒，判定才不会分叉（ADR-0062 决策 3）。
    """
    root = Path(__file__).resolve().parents[2] / ".claude" / "hooks"
    sh = (root / "gate.sh").read_text("utf-8")
    ps1 = (root / "gate.ps1").read_text("utf-8")

    # sh: 分类器那一段必须被 timeout 包住（两半都包，pipefail 才兜得住）
    seg = sh.split("POLICY_JSON=", 1)[1].split("\nfi", 1)[0]
    assert seg.count("timeout --kill-after") >= 2, (
        "分类器管道的两半都要有超时，否则任一半挂住都会 fail open"
    )

    # ps1: 同一步必须走有界调用
    # 锚到那次调用本身，不要用 "catch"——注释里就有这个词，切片会在它上面截断
    seg2 = ps1.split("$policyArgs = @(", 1)[1].split("$policyResult.ExitCode", 1)[0]
    assert "Invoke-Bounded" in seg2 and "-TimeoutSeconds" in seg2

    # 两侧的秒数必须一致
    import re as _re

    sh_secs = {int(m) for m in _re.findall(r"timeout --kill-after=\d+ (\d+)", seg)}
    ps_secs = {int(m) for m in _re.findall(r"-TimeoutSeconds (\d+)", seg2)}
    assert sh_secs == ps_secs, (
        f"两个 shell 的分类器超时必须相同：sh={sh_secs} ps1={ps_secs}"
    )


# --- TASK-102 codex 审查的三条 P1（每条都是「fail-closed 分支上有个洞」） ---- #


def test_an_unmapped_path_does_not_swallow_the_frontend_claim() -> None:
    """P1（codex, TASK-102）：无归属路径原先**立即 return**，于是同一次提交里的
    frontend 声明连同默认 `frontend=False` 一起被丢掉 —— 混合提交走了 full 档却
    **跳过前端套件**。fail-closed 分支不该比它替代的那条跑得更少。"""
    mixed = _POLICY.classify(["Makefile", "mockups/motv-workspace/src/ui/shell.js"])
    assert mixed.tier == "full"
    assert mixed.frontend is True, "无归属 + 前端的混合提交必须仍跑前端套件"

    # 纯无归属仍然是 full 且不假装有前端改动
    plain = _POLICY.classify(["Makefile"])
    assert plain.tier == "full"
    assert plain.frontend is False

    # 而且 fail-closed 永不被链模式推迟（既有不变量，一并钉住）
    assert _POLICY.classify(["Makefile"], chain_mode=True).tier == "full"


def test_the_forced_full_fallback_includes_the_frontend_suite_in_both_shells() -> None:
    """P1（codex, TASK-102）：命令解析不出来时两个 shell 都自造 policy 走 full，
    但都把 `frontend` 写成 false —— 于是「读不懂的命令」跑了除前端以外的一切。
    ADR-0080 的 full 合同包含前端套件；ADR-0062 决策 3 还要求两壳答案一致。"""
    root = _POLICY_PATH.parent
    ps1 = (root / "gate.ps1").read_text("utf-8")
    sh = (root / "gate.sh").read_text("utf-8")

    # 只看**代码行**，不看整段分支文本。第一版按分支文本断言，结果被这段代码
    # 自己的注释骗过去了（注释里就写着 frontend = 那个值），把 $false 的变异判成
    # 绿 —— 变异验证当场抓到。这正是 TASK-087 §7「断言性质，别断言写法」的同一个
    # 坑：一个只会读注释的守卫，等于没有守卫。
    def code_lines(text: str, start_at: str, end_at: str) -> list[str]:
        branch = text.split(start_at, 1)[1].split(end_at, 1)[0]
        return [
            s
            for s in (ln.strip() for ln in branch.splitlines())
            if s and not s.startswith("#")
        ]

    ps_code = code_lines(ps1, "if ($intent.force_full)", "else")
    ps_policy = [ln for ln in ps_code if ln.startswith("$policy =")]
    assert ps_policy, "找不到 gate.ps1 forced-full 分支里自造 policy 的那一行"
    assert "frontend = $true" in ps_policy[0], (
        f"gate.ps1 的 forced-full 必须带前端套件，实为：{ps_policy[0]}"
    )

    sh_code = code_lines(sh, 'if [ "$INTENT_FORCE_FULL" = "1" ]', "\nelse")
    sh_policy = [ln for ln in sh_code if ln.startswith("POLICY_JSON=")]
    assert sh_policy, "找不到 gate.sh forced-full 分支里自造 policy 的那一行"
    assert '"frontend": true' in sh_policy[0], (
        f"gate.sh 的 forced-full 必须带前端套件，实为：{sh_policy[0]}"
    )


def test_gate_sh_never_hands_pytest_an_empty_string_target() -> None:
    """P1（codex, TASK-102）：`print(*(), sep="\n")` 仍然输出那个换行，于是空
    target 列表经 `mapfile` 变成**一个空元素**，`pytest ""` 是 usage error ——
    受支持目标（Ubuntu）上每个普通定向提交都会被闸门拦死。

    钉的是性质：两个 target 数组的提取都不得使用会为空列表产出一行的写法。
    """
    sh = (_POLICY_PATH.parent / "gate.sh").read_text("utf-8")
    for name in ("POLICY_PYTEST_TARGETS", "POLICY_SERIAL_TARGETS"):
        # 切到该 mapfile 的收尾 `\n)\n` —— 不能按第一个 `)` 切：内嵌的那段
        # python 自己就含 `)`（`or ()`），按它切会把要断言的循环切掉。
        after = sh.split(f"mapfile -t {name} < <(", 1)[1]
        block = after.split("\n)\n", 1)[0]
        assert "print(*" not in block, (
            f"{name}: `print(*seq, sep=...)` 对空 seq 仍输出一行，"
            "mapfile 会得到一个空元素"
        )
        assert "for target in targets:" in block, (
            f"{name}: 必须逐个 print，空列表就什么都不输出"
        )


# --- TASK-102 收尾：支撑层的影响范围是**派生**的，不是「保守起见跑全量」 ---- #


def test_a_support_module_runs_only_the_domains_that_import_it() -> None:
    """产品负责人 2026-08-22：「解耦之后就不需要分风险等级之后全测试了。」

    `tests/` 根的支撑模块此前一律触发全量。但它们的影响范围是**可知的** ——
    就是 import 它们的那些域。`_scan` 只有 tests/studio 用（12 个使用者），
    改它一行注释却要跑 3358 项来覆盖 385 项：那不是谨慎，那是没算过。

    钉的是**派生这件事**，不是某一份名单：断言结果与现场 import 图一致，
    所以新增一个使用者会自动被算进去，而不是等谁想起来改表。
    """
    root = _POLICY_PATH.parents[2]

    def domains_importing(stem: str) -> set[str]:
        found = set()
        for domain in ("backend", "studio", "contract", "e2e", "tooling"):
            directory = root / "tests" / domain
            for path in sorted(directory.glob("*.py")):
                if f"tests.{stem}" in path.read_text("utf-8"):
                    found.add(f"tests/{domain}")
                    break
        return found

    for stem in ("_scan", "paid_scenario", "symlink_support", "media_fakes"):
        expected = domains_importing(stem)
        assert expected, f"tests/{stem}.py 没有任何使用者？断言前提已变"
        decision = _POLICY.classify([f"tests/{stem}.py"])
        assert decision.tier == "pytest-targeted", (
            f"tests/{stem}.py 的影响范围是可知的，不该退回全量"
        )
        assert set(decision.pytest_targets) == expected, (
            f"tests/{stem}.py: 应跑 {sorted(expected)}，实为 "
            f"{sorted(decision.pytest_targets)}"
        )


def test_an_unknown_support_module_still_fails_closed_to_the_full_run() -> None:
    """派生的另一半：**推导不出来就跑全量。** 一个还没有使用者的新 helper，
    或一种这里不认识的 import 写法，都必须落到全量 —— 派生用来收窄已知的东西，
    不用来给未知的东西发通行证。"""
    assert _POLICY.classify(["tests/no_such_helper_xyz.py"]).tier == "full"
    # pytest 自己加载、不经 import 生效的那两个，永远是全量
    assert _POLICY.classify(["tests/conftest.py"]).tier == "full"
    assert _POLICY.classify(["pyproject.toml"]).tier == "full"


def test_the_serial_test_never_arrives_as_a_directory_target() -> None:
    """tests/e2e 现在是合法的目录 target（两个 shell 的定向档都带
    `-m "not serial"`）。但那个真进程树测试自己被改动时，**必须**走
    `serial_targets` 走串行通道 —— 否则它会被 marker 过滤掉，等于没跑。"""
    serial_file = "tests/e2e/test_motv_run_lifecycle_task072.py"
    decision = _POLICY.classify([serial_file])
    assert decision.serial_targets == (serial_file,)
    assert serial_file not in decision.pytest_targets

    # 而 e2e 里普通的那些，走并行通道
    parallel = _POLICY.classify(["tests/e2e/test_wfm1_e2e.py"])
    assert parallel.pytest_targets == ("tests/e2e/test_wfm1_e2e.py",)
    assert parallel.serial_targets == ()


#: 换行字面量。写成 chr(10) 而不是转义序列：下面几条守卫要构造**多行**的
#: import 源码，而这份文件几经 shell/heredoc 生成，转义序列会被提前展开成
#: 真换行并破坏字符串字面量（本任务里踩过两次）。
NL = chr(10)


def _plant(root: Path, domain: str, name: str, body: str) -> None:
    """在一棵**一次性**的假仓库里放一个测试文件。

    这些守卫绝不往真实 tests/ 里写探针：派生读的是文件系统这份共享状态，
    一个探针会改变**同时**在跑的其它派生查询的答案 —— `-n 8` 下实测 4 次里
    翻 2 次（codex 第二轮 P1）。`_domains_importing` 的 `root` 参数就是为此存在。
    """
    directory = root / "tests" / domain
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(body, encoding="utf-8")


def _consumer(stem: str, symbol: str = "thing") -> str:
    return (
        f"from tests.{stem} import {symbol}{NL}{NL}{NL}"
        f"def test_probe() -> None:{NL}    assert {symbol}{NL}"
    )


def test_the_derivation_is_not_fooled_by_a_name_that_is_a_prefix(
    tmp_path: Path,
) -> None:
    """P1（codex, TASK-102）：子串匹配让 `tests.foo` 命中 `tests.foo_extra`,
    那是**另一个模块**。

    第一版守卫只断言「没人用的模块名 → 全量」，而带边界与不带边界在那个输入上
    **恰好都给出全量**（一个因为没使用者，一个因为误命中后 fail-closed），
    变异验证于是放过了它 —— 结果相同不等于机制正确。

    这一版造能区分的现场：短名的使用者在 studio，长名的使用者在 contract。
    正确实现下短名只得到 studio；把长名那个也算进来就是错的。
    """
    short, long_name = "probe_pref", "probe_pref_long"
    _plant(tmp_path, "studio", "test_short_user.py", _consumer(short))
    _plant(tmp_path, "contract", "test_long_user.py", _consumer(long_name, "other"))

    assert _POLICY._domains_importing(short, root=tmp_path) == ("tests/studio",)
    # 反向也成立：长名不会把短名的使用者算进来
    assert _POLICY._domains_importing(long_name, root=tmp_path) == ("tests/contract",)


def test_every_import_spelling_is_seen_including_parenthesised_ones() -> None:
    """P1（codex, TASK-102，第二次）：正则版看不见括号多行的
    ``from tests import (…)`` —— 那是普通 Python，而**漏看一个使用者会收窄
    测试范围**，正是要避免的方向。

    两代正则都在同一个方向漏，所以改成用 ``ast`` 读语法本身。这条守卫逐个
    spelling 过，钉的是「每种写法都算得出」。
    """
    import ast as _ast

    stem = "media_fakes"
    dotted = "tests" + "." + stem  # 拼接：不在本文件留下真实提及
    seen = [
        f"from {dotted} import FakeMediaInspector",
        f"import {dotted}",
        f"from tests import {stem}",
        f"from tests import {stem} as mf",
        f"from tests import ({NL}    {stem},{NL})",
        f"from tests import ({NL}    other,{NL}    {stem},{NL})",
    ]
    for source in seen:
        assert _POLICY._imports_support_module(_ast.parse(source), stem), (
            f"这种写法必须被算作使用者：{source!r}"
        )

    not_seen = [
        "from tests import other_thing",
        f"MODULE_NAME = {dotted!r}",  # 字符串不是依赖
        f"# {dotted}",  # 注释不是依赖
        f"from {dotted}_long import thing",  # 同前缀不同名，是另一个模块
    ]
    for source in not_seen:
        assert not _POLICY._imports_support_module(_ast.parse(source), stem), (
            f"这不该被算作使用者：{source!r}"
        )


def test_an_unparseable_consumer_fails_the_whole_derivation(tmp_path: Path) -> None:
    """派生的 fail-closed 那一半：**解析不了**的文件意味着「无法证明它没有
    import 这个模块」，于是整个派生退回全量 —— 绝不能给出「我认出来的那几个
    域」，部分域会跑得比该跑的少。"""
    stem = "probe_unparseable"
    _plant(tmp_path, "studio", "test_user.py", _consumer(stem))
    assert _POLICY._domains_importing(stem, root=tmp_path) == ("tests/studio",)

    _plant(tmp_path, "studio", "broken_helper.py", "def (:::")
    assert _POLICY._domains_importing(stem, root=tmp_path) == (), (
        "解析不了的文件必须让整个派生退回全量（空元组 → 调用方给 full）"
    )


def test_the_derivation_sees_consumers_in_nested_directories(tmp_path: Path) -> None:
    """P1（codex, TASK-102）：非递归 ``glob("*.py")`` 看不见
    ``tests/<domain>/<sub>/`` 里的使用者，而漏看一个使用者是**收窄**结果。"""
    stem = "probe_nested"
    nested = tmp_path / "tests" / "contract" / "sub" / "deeper"
    nested.mkdir(parents=True)
    (nested / "test_probe.py").write_text(_consumer(stem), encoding="utf-8")

    assert _POLICY._domains_importing(stem, root=tmp_path) == ("tests/contract",)


def test_a_dynamic_import_forces_the_full_run(tmp_path: Path) -> None:
    """P1（codex, TASK-102，第三轮）：``importlib.import_module("tests.foo")``
    与 ``__import__("tests.foo")`` 是**真的 import**，却不产生任何
    Import/ImportFrom 节点。改用 ast 之后我把原来的文本兜底删了，于是这类
    使用者被**静默漏掉** —— 又一次落在「跑得比该跑的少」这一侧。

    修法不是去实现完整的动态 import 分析（本仓库 tests/backend/
    test_orchestration_layout.py 已经有那套），而是把文本检查以正确的角色
    加回来：它不识别依赖（那是 ast 的活），它检测「ast 之外可能还有依赖」。
    两种动态写法都必须把模块名写成字符串，所以文本一定看得见。
    """
    stem = "probe_dynamic"
    _plant(tmp_path, "studio", "test_static_user.py", _consumer(stem))
    assert _POLICY._domains_importing(stem, root=tmp_path) == ("tests/studio",)

    for source in (
        f"import importlib{NL}{NL}{NL}def test_dyn() -> None:{NL}"
        f"    assert importlib.import_module('tests.{stem}'){NL}",
        f"def test_dyn() -> None:{NL}    assert __import__('tests.{stem}'){NL}",
    ):
        _plant(tmp_path, "contract", "test_dynamic_user.py", source)
        assert _POLICY._domains_importing(stem, root=tmp_path) == (), (
            "ast 看不见的引用形态必须让整个派生退回全量，而不是漏掉那个域"
        )
    (tmp_path / "tests" / "contract" / "test_dynamic_user.py").unlink()
    # 盲区消失后回到精确答案，证明它不是永久降级
    assert _POLICY._domains_importing(stem, root=tmp_path) == ("tests/studio",)


# --- TASK-104：heredoc 正文是数据，不该参与命令解析 ------------------------- #


def test_a_backtick_command_substitution_is_never_invisible() -> None:
    """`$(git commit ...)` was already caught because `(` is a separator,
    while the equivalent backtick form came back as one token and matched no
    command name (codex review, TASK-104). Backticks open a command
    substitution, so what follows IS a command; the separator set now says so.
    """
    backtick, newline = chr(96), chr(10)

    assert (
        _POLICY.inspect_command("Bash", f"{backtick}git commit -m x{backtick}").gate
        == "check"
    )
    # 也包括藏在未加引号 heredoc 正文里的那种（shell 会展开它）
    assert (
        _POLICY.inspect_command(
            "Bash",
            f"cat <<EOF{newline}{backtick}git commit -m y{backtick}{newline}EOF",
        ).gate
        == "check"
    )


def test_heredoc_bodies_are_scanned_and_that_limitation_is_deliberate() -> None:
    """TASK-104 试过在切词前摘掉 heredoc 正文，四轮审查each次都查出真绕过，
    最后**撤回**。这条守卫钉的是撤回后的诚实状态，以及「不要再用扫描器修它」。

    两个后果都还在，且都偏向过度检查（可接受的方向）：
      ① 正文里奇数个撇号 -> lex 失败 -> fail-closed 到全量（纯编辑也会中）；
      ② 正文里的 `git commit` 字面量会被当成那条命令。

    为什么不修：判定 heredoc 的范围需要 shell 自己的语法。最后一轮的两条
    finding 方向相反（补救路径要更保守 vs 合法正文不该当命令）—— 那就是
    「一个行/正则扫描器不可能同时满足」的证明。真正的解法是让 hook 拿到
    结构化解析结果（TASK-085 对 PowerShell 已经这么做：shell 负责切，本模块
    只负责判），那是另一张卡。
    """
    apostrophe, newline = chr(39), chr(10)

    # ① 正文里奇数撇号 -> fail-closed（如实钉住，不是期望值而是现状）
    odd = f"python - <<{apostrophe}PY{apostrophe}{newline}# don{apostrophe}t{newline}PY"
    intent = _POLICY.inspect_command("Bash", odd)
    assert intent.gate == "check"
    assert intent.force_full is True

    # ② 正文里的 git commit 字面量被当成命令（同样如实钉住）
    assert (
        _POLICY.inspect_command(
            "Bash", f"cat <<EOF{newline}git commit -m data{newline}EOF"
        ).gate
        == "check"
    )

    # 代码里必须留着那段「不要用扫描器修它」的说明 —— 它是三次绕过换来的
    source = _POLICY_PATH.read_text(encoding="utf-8")
    assert "KNOWN LIMITATION, RECORDED ON PURPOSE" in source
    assert "_strip_heredoc_bodies" not in source, (
        "摘 heredoc 正文的做法已在 TASK-104 撤回；重新引入前先读那段说明"
    )


def test_the_real_scans_still_work_on_ordinary_commands() -> None:
    """撤回之后，三道扫描在普通命令上照常工作。"""
    newline = chr(10)
    assert _POLICY.inspect_command("Bash", "git commit -m x").gate == "check"
    assert (
        _POLICY.inspect_command(
            "Bash", "MOTV_CONTINUOUS_CHAIN=1 git commit -m x && git push"
        ).gate
        == "block"
    )
    assert _POLICY.inspect_command("Bash", f"ls{newline}pwd").gate == "skip"
    assert (
        _POLICY.inspect_command("Bash", f"git commit -m a{newline}git push").gate
        == "check"
    )
