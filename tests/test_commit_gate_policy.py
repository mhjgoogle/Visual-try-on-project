"""Regression coverage for the local commit-gate risk classifier."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

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
        decision = _POLICY.decide(high_risk, cmd)
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
    assert _POLICY.decide(high_risk, "git commit -m x && git push").tier == "full"


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
    """The tests above call `decide()` in-process; the gates call a SUBPROCESS
    with `--command <cmd> -- <paths>`. Everything between those two — argument
    parsing, the `--` separator, JSON encoding of a notice containing Chinese —
    was untested (independent review, rounds 2 and 3)."""
    import json
    import subprocess

    token = "MOTV_CONTINUOUS_CHAIN=1"
    high_risk = "src/ai_video_workflow/persistence.py"

    def run(command: str, *paths: str) -> dict:
        result = subprocess.run(
            [sys.executable, str(_POLICY_PATH), "--command", command, "--", *paths],
            capture_output=True,
            cwd=_POLICY_PATH.parents[2],
            check=True,
        )
        # decoded as UTF-8 REGARDLESS of console encoding: the hook contract is
        # UTF-8 JSON and a cp932 console does not get a vote (round 3)
        return json.loads(result.stdout.decode("utf-8"))

    assert run(f"{token} git commit -m x", high_risk)["tier"] == "continuous-chain"
    assert run("git commit -m x", high_risk)["tier"] == "full"
    # the token inside the MESSAGE, and the wrong case, are both refused
    assert run(f'git commit -m "see {token}"', high_risk)["tier"] == "full"
    assert run(f"{token.lower()} git commit", high_risk)["tier"] == "full"
    # a push riding along is refused
    assert run(f"{token} git commit -m x && git push", high_risk)["tier"] == (
        "chain-conflict"
    )
    # targeted tiers survive the opt-in; docs stay lint; unknown paths stay full
    assert run(f"{token} git commit", "src/ai_video_workflow/validation.py")[
        "tier"
    ] == ("pytest-targeted")
    assert run(f"{token} git commit", "docs/x.md")["tier"] == "lint"
    assert run(f"{token} git commit", "Makefile")["tier"] == "full"
    # a changed file literally NAMED like the flag stays a path, because of `--`
    assert run(f"{token} git commit", "--command")["tier"] == "full"
    # the notice survives the round trip intact, Chinese lines included
    notice = run(f"{token} git commit -m x", high_risk)["notice"]
    assert notice.splitlines()[0].isascii()
    assert "链尾" in notice


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
    assert '--command "$CMD"' in sh
    assert "'--command', $cmd" in ps1
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
    #    …and both BLOCK on chain-conflict rather than falling through
    assert "chain-conflict)" in sh and "'chain-conflict'" in ps1

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
