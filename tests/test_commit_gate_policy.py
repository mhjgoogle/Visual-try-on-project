"""Regression coverage for the local commit-gate risk classifier."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_POLICY_PATH = Path(__file__).parents[1] / ".claude" / "hooks" / "commit_gate_policy.py"
_SPEC = importlib.util.spec_from_file_location("commit_gate_policy", _POLICY_PATH)
assert _SPEC and _SPEC.loader
_POLICY = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _POLICY
_SPEC.loader.exec_module(_POLICY)


def test_docs_only_change_skips_test_execution() -> None:
    decision = _POLICY.classify(
        ["docs/tasks/TASK-063-risk-based-commit-gate.md", "README.md"]
    )

    assert decision.tier == "lint"


def test_workspace_change_runs_the_conservative_workspace_regression_set() -> None:
    decision = _POLICY.classify(
        [
            "src/ai_video_workflow/workspace/queries.py",
            "tests/test_workspace_queries.py",
        ]
    )

    assert decision.tier == "workspace"
    assert "tests/test_workspace_wfm1_acceptance.py" in decision.pytest_targets
    assert "tests/test_workspace_write.py" in decision.pytest_targets


def test_frontend_only_change_runs_frontend_suite() -> None:
    decision = _POLICY.classify(["mockups/motv-workspace/assets/app.js"])

    assert decision.tier == "frontend"


def test_test_only_change_runs_its_changed_test_file() -> None:
    decision = _POLICY.classify(["tests/test_validation.py"])

    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/test_validation.py",)


def test_conventional_source_runs_its_matching_test_file() -> None:
    decision = _POLICY.classify(["src/ai_video_workflow/validation.py"])

    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/test_validation.py",)


def test_persistence_and_mixed_surfaces_are_never_fast_laned() -> None:
    assert _POLICY.classify(["src/ai_video_workflow/persistence.py"]).tier == "full"
    assert (
        _POLICY.classify(
            ["src/workspace_shell/server.py", "mockups/motv-workspace/assets/app.js"]
        ).tier
        == "full"
    )


def test_the_motv_backend_gets_the_whole_suite_not_its_own_tier() -> None:
    """`server.py` 是 motv 后端的持久化 / schema 迁移 / 身份 / 付费路径所在。

    它曾有一个专属的 `motv-server` tier（只跑 33 个 `test_motv_*.py`），理由纯粹
    是当时全量太贵。2026-08-15 实测：那个 tier 121s（458 项），全量两阶段 179s
    （3142 项）——58 秒换 2684 个测试，豁免不再划算，且 AGENTS.md 第 20 条本来
    就把持久化 / schema 放在全量档。

    这条守卫钉的是**分档结果**，不是当时的耗时数字：谁要把它改回定向档，
    得先解释为什么持久化和 schema 迁移可以不跑全量。
    """
    decision = _POLICY.classify(["mockups/motv-workspace/server.py"])

    assert decision.tier == "full"
    assert decision.pytest_targets == ()


def test_deleted_high_risk_path_is_not_hidden_from_full_validation() -> None:
    decision = _POLICY.classify(
        [
            "docs/adr/ADR-0060-risk-based-local-commit-gate.md",
            "src/ai_video_workflow/persistence.py",
        ]
    )

    assert decision.tier == "full"


# --- ADR-0068 连续修改链（TASK-076） ------------------------------------- #


def test_without_the_opt_in_the_original_gate_is_unchanged() -> None:
    """The chain mode is opt-in per commit. Nothing about the risk table moves."""
    decision = _POLICY.classify(
        ["src/ai_video_workflow/persistence.py"], chain_mode=False
    )
    assert decision.tier == "full"
    assert decision.notice == ""


def test_the_opt_in_defers_the_whole_suite_but_keeps_the_risk_honest() -> None:
    """ADR-0068 决策 3: whole-suite runs move to the end of the chain. The change
    is still high-risk — only the place that run happens changes."""
    decision = _POLICY.classify(
        ["src/ai_video_workflow/persistence.py"], chain_mode=True
    )
    assert decision.tier == "continuous-chain"
    assert decision.pytest_targets == ()
    # the ORIGINAL classification is still stated, so the record does not
    # pretend the change was low-risk
    assert "high-risk" in decision.reason
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
        (["tests/test_validation.py"], "pytest-targeted"),
        (["src/workspace_shell/app.py"], "workspace"),
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
    high_risk = ["src/ai_video_workflow/persistence.py"]
    for cmd in (
        'MOTV_CONTINUOUS_CHAIN=1 git commit -m "batch 2" && git push',
        "MOTV_CONTINUOUS_CHAIN=1 git commit -m x; git push origin main",
        "MOTV_CONTINUOUS_CHAIN=1 git commit -m x && git merge --ff-only main",
        "# MOTV_CONTINUOUS_CHAIN=1\ngit commit -m x\ngit push",
    ):
        decision = _POLICY.decide(high_risk, cmd, tool_name="Bash")
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
        _POLICY.decide(high_risk, "git commit -m x && git push", tool_name="Bash").tier
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
        assert _POLICY.classify(["src/ai_video_workflow/persistence.py"]).tier == "full"
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
    decision = _POLICY.classify(["conftest.py"], chain_mode=True)
    first = decision.notice.splitlines()[0]
    assert first.isascii(), "the critical line must stay legible everywhere"
    assert "FULL TESTS SKIPPED" in first
    assert "ADR-0068" in first
    # …and a tier that skipped nothing stays silent, so the notice cannot be
    # read as boilerplate
    assert _POLICY.classify(["conftest.py"]).notice == ""


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

    high_risk = "src/ai_video_workflow/persistence.py"

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
        assert set(answer) == {"tier", "reason", "pytest_targets", "notice"}, answer
        return answer

    assert run("1", high_risk)["tier"] == "continuous-chain"
    assert run("0", high_risk)["tier"] == "full"
    # EXACT "1": a switch that can be turned on vaguely gets turned on vaguely
    for vague in ("true", "yes", "on", "01", ""):
        assert run(vague, high_risk)["tier"] == "full", vague
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
    notice = run("1", high_risk)["notice"]
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
    hooks = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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

    hooks = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
    hooks = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
    hooks = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
    root = Path(__file__).resolve().parents[1]
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
    root = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
    decision = _POLICY.decide(
        ["src/ai_video_workflow/persistence.py"], cmd, tool_name="Bash"
    )
    assert decision.tier == "chain-conflict", (
        tail + " 必须被拒绝，实为 " + decision.tier
    )


def test_the_token_must_not_be_triggered_from_the_commit_message() -> None:
    """同一轮里 codex 还报了「提交信息里的令牌能开减档」——**实测不成立**，
    锚定是有效的。这条留作反向守卫：它一旦真的成立，减档就成了任何人打一句
    话就能打开的开关。"""
    decision = _POLICY.decide(
        ["src/ai_video_workflow/persistence.py"],
        'git commit -m "note: MOTV_CONTINUOUS_CHAIN=1 was used earlier"',
        tool_name="Bash",
    )
    assert decision.tier == "full", "提交信息里的令牌不得启用减档"


def test_a_normal_chain_commit_still_gets_the_reduced_tier() -> None:
    """扩大拒绝面不能把连续修改链本身也堵死。"""
    decision = _POLICY.decide(
        ["src/ai_video_workflow/persistence.py"],
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
    high_risk = ["src/ai_video_workflow/persistence.py"]

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

    hooks = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
    root = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
    hooks = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
    root = Path(__file__).resolve().parents[1] / ".claude" / "hooks"
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
