"""Classify changed paths for the local commit gate.

The policy intentionally grants a fast lane only to an explicit, small
allowlist.  Everything else is a full Python regression run.  Both hook
implementations invoke this file so their risk decisions cannot drift.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath

_DOC_PREFIXES = ("docs/",)
#: CLAUDE.md was missing here, so every edit to it fell through to the
#: no-mapping fallback and ran the WHOLE suite -- a pure-prose governance file
#: costing a full pytest + full frontend run (measured 2026-08-14).
_DOC_FILES = {"AGENTS.md", "CLAUDE.md", "README.md", "LICENSE"}
#: Agent tooling under .claude/ is prose ONLY when it is Markdown: SKILL.md and
#: friends are instructions for an agent, covered by no test. Everything else
#: there (gate.ps1/.sh, commit_gate_policy.py, the review scripts) is executable
#: and must NOT be reclassified as documentation.
_AGENT_DOC_PREFIX = ".claude/"
_AGENT_DOC_SUFFIX = ".md"
_WORKSPACE_PREFIXES = (
    "src/ai_video_workflow/workspace/",
    "src/workspace_shell/",
)
_WORKSPACE_TESTS = (
    "tests/test_workspace_action_query.py",
    "tests/test_workspace_cli.py",
    "tests/test_workspace_evaluation_query.py",
    "tests/test_workspace_multimedia.py",
    "tests/test_workspace_queries.py",
    "tests/test_workspace_shell.py",
    "tests/test_workspace_wfm1_acceptance.py",
    "tests/test_workspace_write.py",
)
_FRONTEND_PREFIX = "mockups/motv-workspace/"
_FRONTEND_SUFFIXES = (".css", ".html", ".js", ".mjs")
_HIGH_RISK_PREFIXES = (
    "src/ai_video_workflow/security/",
    "src/ai_video_workflow/config/",
    "src/ai_video_workflow/assets/registration.py",
    "src/ai_video_workflow/audio/registration.py",
    "src/ai_video_workflow/composition/",
    "src/ai_video_workflow/media/",
    "src/ai_video_workflow/orchestration/",
)
_HIGH_RISK_FILES = {
    "src/ai_video_workflow/appendlog.py",
    "src/ai_video_workflow/persistence.py",
    "src/ai_video_workflow/models.py",
    "src/ai_video_workflow/serialization.py",
    "conftest.py",
    "pyproject.toml",
    # The motv backend: persistence, schema migrations, identity and the paid
    # paths all live in this one 6700-line file, which AGENTS.md rule 20 puts
    # squarely in the whole-suite tier. It used to get its own `motv-server`
    # tier (the 33 `tests/test_motv_*.py` files) purely because the full suite
    # was too expensive to run on every edit. Measured 2026-08-15, after the
    # two-phase parallel split (ADR-0069 decision 7): that tier is 121s (458
    # tests) against 179s for the WHOLE suite (3142 tests) -- 58 seconds buys
    # 2684 more tests, so the exemption no longer pays for itself.
    "mockups/motv-workspace/server.py",
}


#: The continuous-modification-chain opt-in (ADR-0068 决策 7).
#
#: IT LIVES IN THE COMMIT COMMAND ITSELF, not in the environment.
#:
#: The gate is a PreToolUse hook: Claude Code spawns it, and it is NOT a child
#: of the intercepted `git commit`. So an inline `MOTV_CONTINUOUS_CHAIN=1 git
#: commit …` could never reach the hook's own environment, and the only channel
#: that WOULD work is a session- or settings-level variable — i.e. exactly the
#: persistent switch 决策 7 forbids, silently applying to every later commit.
#:
#: Reading the token out of the intercepted command instead gives what the ADR
#: actually asked for: it must be typed again for every single commit, it is
#: visible in the command line and in the transcript, and there is nowhere to
#: persist it. The assignment is inert to git itself.
#: It must be the LEADING token of the command, and the case must match.
#:
#: Matching the bare string anywhere let the commit MESSAGE enable the skip —
#: `git commit -m "document MOTV_CONTINUOUS_CHAIN=1"` turned the gate off
#: (independent review, round 2). And PowerShell's `-like` is case-insensitive,
#: so `motv_continuous_chain=1` enabled it on Windows while Bash's `grep -F`
#: refused it: the two platforms disagreed, which ADR-0062 决策 3 forbids.
#:
#: Anchoring to the front is also what makes it a real shell env-assignment
#: prefix rather than an arbitrary substring: it is the position the shell
#: itself gives that meaning to.
#:
#: TWO SPELLINGS, because the authoritative platform cannot type the first one.
#: `NAME=value cmd` is Bash grammar; PowerShell 5.1 has no inline assignment and
#: answers `MOTV_CONTINUOUS_CHAIN=1 git commit …` with CommandNotFoundException
#: (independent review, round 3) — so on Windows, the platform ADR-0062 makes
#: authoritative, the documented invocation simply could not be run. A leading
#: COMMENT line is valid in both shells and keeps every property 决策 7 wanted:
#:
#:     MOTV_CONTINUOUS_CHAIN=1 git commit -m "…"     # Bash
#:     # MOTV_CONTINUOUS_CHAIN=1
#:     git commit -m "…"                             # PowerShell (and Bash)
_CHAIN_RE = re.compile(r"^[ \t]*#?[ \t]*MOTV_CONTINUOUS_CHAIN=1(?=\s)")

#: ADR-0068 决策 6: push / merge / 交接 / 人工验收 之前必须完成最终全量.
#:
#: Nothing stopped `MOTV_CONTINUOUS_CHAIN=1 git commit -m "x" && git push` —
#: one `&&` and the chain's own escape hatch pushed a commit whose full suite
#: had never run (independent review, round 3). The token scan is deliberately
#: crude, exactly like the `git` / `commit` / `-C` scans this gate already does:
#: a regex cannot parse a shell command line, so a commit MESSAGE containing the
#: word "push" over-blocks. That costs one retype without the opt-in token;
#: missing a real push costs an unverified push into someone else's view.
_CHAIN_CONFLICT_RE = re.compile(r"(^|[\s;&|(])(push|merge)([\s;&|)]|$)")

#: Reasons are constants so the fail-closed set below cannot drift out of sync
#: with the strings `_classify` actually produces (independent review, round 2).
_REASON_NO_PATHS = "no changed paths were available"
_REASON_NO_MAPPING = "path has no conservative targeted-test mapping"

#: Tiers whose whole point is a WHOLE-SUITE run. Those are what ADR-0068 defers
#: to the end of the chain; the targeted tiers stay, because they ARE the
#: 「定向测试」 the chain requires and they cost seconds.
_WHOLE_SUITE_TIERS = frozenset({"full", "frontend"})

#: Reasons that mean "the classifier could not work out what this is", not
#: "this is a genuine whole-suite change". They are fail-closed fallbacks, and
#: deferring them would turn an UNKNOWN change into an untested one — the exact
#: inversion of what a fail-closed default is for.
_UNCLASSIFIED_REASONS = frozenset({_REASON_NO_PATHS, _REASON_NO_MAPPING})


@dataclass(frozen=True)
class Decision:
    """The checks the gate must run for one candidate commit."""

    tier: str
    reason: str
    pytest_targets: tuple[str, ...] = ()
    #: Shown verbatim by both gates. Non-empty ONLY when a check was skipped —
    #: an invisible skip is how a temporary exception becomes permanent.
    notice: str = ""


def _normalise(path: str) -> str:
    # `lstrip("./")` strips a CHARACTER SET, not a prefix: it turned
    # `.claude/skills/x.md` into `claude/skills/x.md` and `../evil` into `evil`,
    # silently eating dot-directories and path-traversal markers alike. Only the
    # single leading `./` that git can emit should go.
    return path.replace("\\", "/").removeprefix("./")


def _is_docs(path: str) -> bool:
    # A path containing `..` never takes a cheap tier. `git diff --name-only`
    # does not emit one today, so this is unreachable through the normal entry
    # point -- but the whole point of the `_normalise` fix above is to STOP
    # eating traversal markers, and a prefix+suffix test that accepts
    # `.claude/../../x.md` as documentation would hand that back on the docs
    # path (independent review, 2026-08-15).
    if ".." in PurePosixPath(path).parts:
        return False
    if path in _DOC_FILES or path.startswith(_DOC_PREFIXES):
        return True
    return path.startswith(_AGENT_DOC_PREFIX) and path.endswith(_AGENT_DOC_SUFFIX)


def _is_workspace_path(path: str) -> bool:
    return path.startswith(_WORKSPACE_PREFIXES) or path in _WORKSPACE_TESTS


def _is_frontend_path(path: str) -> bool:
    return path.startswith(_FRONTEND_PREFIX) and path.endswith(_FRONTEND_SUFFIXES)


def _is_pytest_file(path: str) -> bool:
    return (
        path.startswith("tests/")
        and path.rsplit("/", 1)[-1].startswith("test_")
        and path.endswith(".py")
    )


def _is_high_risk(path: str) -> bool:
    return path in _HIGH_RISK_FILES or path.startswith(_HIGH_RISK_PREFIXES)


def _test_for_source(path: str) -> str | None:
    """Return a conventional, existing unit-test counterpart when available."""

    if not (path.startswith("src/") and path.endswith(".py")):
        return None
    target = f"tests/test_{Path(path).stem}.py"
    return target if Path(target).is_file() else None


def chain_mode_from_command(command: str) -> bool:
    """Is the continuous-modification chain opt-in present in THIS commit command?

    Exact-token match on purpose (ADR-0068 决策 7): `true` / `yes` / `on` are not
    accepted, because a switch that can be turned on vaguely gets turned on
    vaguely — and this one removes a real check.
    """
    return isinstance(command, str) and bool(_CHAIN_RE.match(command))


def decide(paths: list[str], command: str = "") -> Decision:
    """The gates' single decision point: what must run for THIS commit command.

    Everything derived from the command text is decided here, so `gate.sh` and
    `gate.ps1` only transport it (TASK-076 §1.2). Each shell matching the token
    itself is how the two platforms came to disagree.
    """

    if not chain_mode_from_command(command):
        return classify(paths, chain_mode=False)
    if _CHAIN_CONFLICT_RE.search(command):
        return Decision(
            "chain-conflict",
            # ASCII first line, for the same reason the notice has one: this text
            # goes to stderr, gate.ps1 writes stderr through
            # [Console]::OutputEncoding, and on a Shift-JIS console every
            # character of a Chinese-only message became an IRREVERSIBLE `?`
            # (independent review, round 4, measured on this host). A block whose
            # reason cannot be read is a block nobody can act on.
            "[chain-conflict] the continuous-chain token and a push/merge are in "
            "the SAME command. A middle commit has not run the full suites, so it "
            "must not be pushed. See ADR-0068.\n"
            "ADR-0068 决策 6: 这条命令同时带着连续修改链令牌和 push / merge。"
            "链的中间提交没有跑全量，push / merge / 交接 / 人工验收之前必须先跑完"
            "链尾全量。请拆成两步：先不带令牌跑完全量再 push，或去掉 push/merge。"
            "（若这只是提交信息里出现了 push/merge 字样：去掉令牌重提交即可，"
            "本闸门不解析 shell 引号，宁可多拦一次。）",
        )
    return classify(paths, chain_mode=True)


def classify(paths: list[str], *, chain_mode: bool = False) -> Decision:
    """Return the conservative validation tier for *paths*.

    A fast lane is valid only when every non-document path is explicitly
    bounded and has a known test target.  High-risk and unknown changes stay
    full by default.

    ``chain_mode`` (ADR-0068) defers the WHOLE-SUITE tiers to the end of an
    authorised chain.  It never changes the risk classification itself — the
    change is still high-risk, and the final checkpoint still runs everything.
    It only moves where that run happens.

    It is an EXPLICIT ARGUMENT, never read from the environment here: making
    the classifier environment-dependent would mean its own tests (and every
    other caller) silently change behaviour based on an inherited variable.
    """

    decision = _classify(paths)
    if decision.reason in _UNCLASSIFIED_REASONS:
        # Never defer a fail-closed fallback: "we could not classify this" must
        # not become "so we ran nothing".
        return decision
    if not chain_mode or decision.tier not in _WHOLE_SUITE_TIERS:
        return decision
    return Decision(
        "continuous-chain",
        f"{decision.reason} — 全量按 ADR-0068 推迟到链尾",
        (),
        # The first line is deliberately ASCII: this is the one message that
        # MUST stay legible, and a non-UTF-8 console (cp936/cp932) would turn a
        # Chinese-only warning into mojibake — an unreadable warning is an
        # invisible one.
        notice=(
            f"[continuous-chain] FULL TESTS SKIPPED (risk tier was: {decision.tier}). "
            "ruff + diff checks are NOT skipped. Run the full suites at the end "
            "of the chain, "
            "before any push/merge/handover. See ADR-0068.\n"
            "  本次提交按连续修改链跳过了全量测试；全量 pytest + 全量前端 + 最终验收\n"
            "  必须在链尾统一跑一次，且 push / merge / 交接 / 人工验收之前完成。"
        ),
    )


def _classify(paths: list[str]) -> Decision:
    raw = tuple(path for path in paths if path.strip())
    changed = tuple(sorted({_normalise(path) for path in raw}))
    if not changed:
        return Decision("full", _REASON_NO_PATHS)

    # A LITERAL BACKSLASH IN A PATH FORCES THE FULL TIER (codex 跨模型复审,
    # 2026-08-16). `_normalise` turns every `\` into `/` so that a Windows-style
    # path classifies the same as its git form — but on Linux a backslash is a
    # legal character IN A FILENAME, so a single file literally named
    # `docs\payload.py` normalised to `docs/payload.py` and took the
    # documentation-only tier: a Python file that skipped pytest entirely.
    #
    # gate.sh passes `-z`, so such a name arrives raw and unquoted — this was
    # reachable, not theoretical. Refusing the cheap tier (rather than trying to
    # decide which side of the slash it meant) is the fail-closed answer: git
    # itself never emits a backslash as a SEPARATOR, so a path containing one is
    # either an odd filename or a non-git caller, and both deserve the full run.
    if any("\\" in path for path in raw):
        return Decision(
            "full",
            "a path contains a literal backslash — cannot be classified safely",
        )

    non_docs = tuple(path for path in changed if not _is_docs(path))
    if not non_docs:
        return Decision("lint", "documentation-only change")

    if any(_is_high_risk(path) for path in non_docs):
        return Decision(
            "full", "high-risk persistence, security, schema, or render path"
        )

    if all(_is_workspace_path(path) for path in non_docs):
        return Decision(
            "workspace", "bounded workspace read-model surface", _WORKSPACE_TESTS
        )

    if all(_is_frontend_path(path) for path in non_docs):
        return Decision("frontend", "bounded frontend-only surface")

    if all(_is_pytest_file(path) for path in non_docs):
        return Decision("pytest-targeted", "test-only change", tuple(non_docs))

    targets = tuple(
        sorted({target for path in non_docs if (target := _test_for_source(path))})
    )
    if len(targets) == len(non_docs):
        return Decision(
            "pytest-targeted", "conventional source-to-test mapping", targets
        )

    return Decision("full", _REASON_NO_MAPPING)


def main() -> int:
    # Git supplies NUL-separated names on Bash.  PowerShell normalises its
    # pipeline input to newlines; accepting both formats is safe on supported
    # Windows filenames and keeps the two hook runners on one policy.
    # THE GATES DO NOT DECIDE — they hand over the intercepted command and this
    # module decides (TASK-076 1.2). Each shell re-implementing the match is how
    # the two platforms came to disagree (independent review, round 2).
    #
    # `--` ends the flags, so a changed file literally named `--command` is a
    # path and not a flag.
    argv = sys.argv[1:]
    command = ""
    rest: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--":
            rest.extend(argv[index + 1 :])
            break
        if arg == "--command" and index + 1 < len(argv):
            command = argv[index + 1]
            index += 2
            continue
        rest.append(arg)
        index += 1
    if rest:
        paths = rest
    else:
        raw = sys.stdin.buffer.read()
        separator = b"\0" if b"\0" in raw else b"\n"
        paths = [
            part.decode("utf-8", "surrogateescape") for part in raw.split(separator)
        ]
    payload = json.dumps(asdict(decide(paths, command)), sort_keys=True)
    # Write bytes, not `print`. `print` encodes the WHOLE string at once, so on a
    # non-UTF-8 stdout (cp932/cp936, or a zh_CN.GB18030 locale on the Ubuntu
    # target) one Chinese character in the notice raised UnicodeEncodeError, the
    # gate swallowed the failure, and the skip warning vanished entirely —
    # taking the deliberately-ASCII first line down with it (independent review,
    # round 3). The hook contract is UTF-8 JSON; the console encoding is not
    # allowed a vote.
    sys.stdout.buffer.write(payload.encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
