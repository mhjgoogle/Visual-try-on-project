"""Classify changed paths for the local commit gate.

The policy intentionally grants a fast lane only to an explicit, small
allowlist.  Everything else is a full Python regression run.  Both hook
implementations invoke this file so their risk decisions cannot drift.
"""

from __future__ import annotations

import ast
import json
import re
import shlex
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
    "tests/backend/test_workspace_action_query.py",
    "tests/backend/test_workspace_cli.py",
    "tests/backend/test_workspace_evaluation_query.py",
    "tests/backend/test_workspace_multimedia.py",
    "tests/backend/test_workspace_queries.py",
    "tests/backend/test_workspace_shell.py",
    "tests/backend/test_workspace_write.py",
    "tests/e2e/test_workspace_wfm1_acceptance.py",
)
_FRONTEND_PREFIX = "mockups/motv-workspace/"
_FRONTEND_SUFFIXES = (".css", ".html", ".js", ".mjs")

# ---------------------------------------------------------------------------
# OWNERSHIP MAPPING (ADR-0080, supersedes ADR-0060's risk tiers).
#
# 产品负责人 2026-08-22: 「我不要每次都全量测试。」 Daily commits run the test
# domain that OWNS the changed path (Test Scope = Change Impact Scope); the
# whole-suite run remains the INTEGRATION CHECKPOINT (CI, chain end, pre-merge,
# release/handover) plus the fail-closed answer for paths nothing owns.
#
# Consequences of being wrong stay asymmetric on purpose: an entry missing from
# this table can only fall through to the FULL suite (over-testing); an entry
# wrongly present runs that owner's tests instead of everything, so every row
# below names the domain that genuinely owns the path per ADR-0080 decision 1.
# ---------------------------------------------------------------------------

#: The Studio's Python backend (server.py, runstore.py, skillpkg.py, serve.py,
#: rootadmit.py, stage_evidence.py). Owned by tests/studio; the py<->js skill
#: prompt parity contract also exercises skillpkg, so contract rides along.
_STUDIO_PY_TARGETS = ("tests/contract", "tests/studio")

#: Core shared modules of the backend package impact both the library's own
#: tests and the Studio backend that imports it. e2e and the frontend suite
#: stay at the integration checkpoint.
_BACKEND_CORE_TARGETS = ("tests/backend", "tests/studio")

#: The one test file that must run OUTSIDE xdist (real OS process trees).
_SERIAL_TEST_FILES = frozenset({"tests/e2e/test_motv_run_lifecycle_task072.py"})

#: Every test-domain directory, usable as a directory-level pytest target.
#:
#: tests/e2e IS here, and its earlier absence was over-caution: both shells run
#: the targeted tier as `pytest -n 8 -m "not serial" <targets>`, so the one
#: serial file is deselected by the marker no matter what the target is — and
#: when the serial file is itself the change, it arrives through
#: `serial_targets` and runs outside xdist. Excluding e2e only meant that
#: helpers shared with e2e (media_fakes, wfm1_scenario, gateway_scenario) fell
#: back to the whole suite for no benefit.
_TEST_DOMAIN_DIRS = (
    "tests/backend/",
    "tests/studio/",
    "tests/contract/",
    "tests/e2e/",
    "tests/tooling/",
)

#: Files whose impact scope genuinely IS every pytest domain. Both take effect
#: WITHOUT being imported -- pytest loads them itself (ini options, markers,
#: the tmpfs basetemp hook) -- so no import graph can narrow them down.
#:
#: Every OTHER file in the tests/ root (scenario builders, fakes, _scan,
#: symlink_support) reaches its consumers through an `import`, so its scope is
#: DERIVED from that graph by `_domains_importing` instead of assumed to be
#: everything: `_scan` is used by tests/studio alone, so editing it used to run
#: 3358 tests to cover 385 (产品负责人 2026-08-22: 解耦之后不该还按「保守起见跑
#: 全量」办事 —— Test Scope = Change Impact Scope 就是这一条的全部内容).
_FULL_PYTEST_FILES = {"pyproject.toml", "tests/conftest.py"}

#: THE IMPORT GRAPH IS READ WITH `ast`, NOT WITH REGEXES.
#:
#: Two regex generations were tried and both leaked, in the one direction that
#: matters -- a MISSED consumer narrows the test selection, i.e. it runs too
#: little (codex review, TASK-102, twice):
#:
#:   1. substring test          `tests.foo` matched `tests.foo_extra`, and
#:                              matched the name in comments and strings
#:   2. anchored form matching  `from tests import (\n    foo,\n)` matches
#:                              neither the dotted form nor the single-line
#:                              `from tests import …` form -> silently omitted
#:
#: The second one is the lesson: a parenthesised, multi-line, or aliased import
#: is ordinary Python, and no line-oriented pattern sees all of them. The
#: grammar is the fact, so parse the grammar. `ast` is stdlib, the files are
#: already being read, and every import spelling collapses to the same three
#: node shapes handled in `_imports_support_module`.
#:
#: A file that does not parse is treated as "cannot prove it does NOT import
#: this" -> the whole derivation fails closed to the full run.
_TESTS_PACKAGE = "tests"

_EXAMPLES_TARGETS = (
    "tests/backend/test_example_project.py",
    "tests/backend/test_wfm1_demo_example.py",
    "tests/backend/test_wfm1_profile.py",
    "tests/backend/test_wfm1_reuse.py",
)
_PROVIDER_CONFIG_TARGETS = (
    "tests/backend/test_config_catalog.py",
    "tests/contract/test_motv_refset_adr0071.py",
)
_SKILL_PACKAGE_TARGETS = ("tests/contract", "tests/studio")
_TOOLING_TARGETS = ("tests/tooling",)
_LAYOUT_TARGETS = ("tests/tooling/test_repository_layout.py",)

#: Paths with no local test owner where the lint stage is the honest answer:
#: CI config proves itself on push, and the git metadata files change behavior
#: only inside git itself.
_LINT_ONLY_PREFIXES = (".github/",)
_LINT_ONLY_FILES = {".gitattributes", ".gitignore"}


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
#: had never run (independent review, round 3).
#:
#: The verb list is five wide, not two: 决策 6 is about 「把提交带出去或把别人的
#: 整合进来」, and `pull` / `rebase` / `cherry-pick` all do that (codex 跨模型
#: 复审 2026-08-16).
#:
#: TASK-085 moved the SCAN off the command text and onto tokens. The old regex
#: had to strip quote characters to catch `git "push"`, and paid for it by
#: over-blocking any commit MESSAGE containing the word — the comment here used
#: to argue that was the right side to be wrong on, which was true only while
#: the alternative was another regex. On tokens neither trade is needed: `push`
#: is recognised as a git SUBCOMMAND, so `git "push"` is caught and
#: `git commit -m "say push here"` is not.
_CHAIN_CONFLICT_VERBS = frozenset({"push", "merge", "pull", "rebase", "cherry-pick"})

#: ASCII first line, for the same reason the notice has one: this text goes to
#: stderr, gate.ps1 writes stderr through [Console]::OutputEncoding, and on a
#: Shift-JIS console every character of a Chinese-only message became an
#: IRREVERSIBLE `?` (independent review, round 4, measured on this host). A block
#: whose reason cannot be read is a block nobody can act on.
_CHAIN_CONFLICT_REASON = (
    "[chain-conflict] the continuous-chain token and a push/merge are in "
    "the SAME command. A middle commit has not run the full suites, so it "
    "must not be pushed. See ADR-0068.\n"
    "ADR-0068 决策 6: 这条命令同时带着连续修改链令牌和 push / merge。"
    "链的中间提交没有跑全量，push / merge / 交接 / 人工验收之前必须先跑完"
    "链尾全量。请拆成两步：先不带令牌跑完全量再 push，或去掉 push/merge。"
)

#: Reasons are constants so the fail-closed set below cannot drift out of sync
#: with the strings `_classify` actually produces (independent review, round 2).
_REASON_NO_PATHS = "no changed paths were available"
_REASON_NO_MAPPING = "path has no conservative targeted-test mapping"
#: TASK-085 决策 4: 「this is not a commit」 and 「I could not tell WHETHER this is
#: a commit」 are different answers, and only the first one may skip the checks.
_REASON_UNPARSEABLE = "the command could not be parsed - cannot tell what it runs"

#: Tiers whose whole point is a WHOLE-SUITE run. Those are what ADR-0068 defers
#: to the end of the chain; the targeted tiers stay, because they ARE the
#: 「定向测试」 the chain requires and they cost seconds.
_WHOLE_SUITE_TIERS = frozenset({"full", "frontend"})

#: Reasons that mean "the classifier could not work out what this is", not
#: "this is a genuine whole-suite change". They are fail-closed fallbacks, and
#: deferring them would turn an UNKNOWN change into an untested one — the exact
#: inversion of what a fail-closed default is for.
_UNCLASSIFIED_REASONS = frozenset(
    {_REASON_NO_PATHS, _REASON_NO_MAPPING, _REASON_UNPARSEABLE}
)


# ===========================================================================
# Intent detection (TASK-085): is this command a `git commit`, and which one?
# ===========================================================================
#
# WHY THIS IS NOT A REGEX ANY MORE.
#
# Both gates used to answer 「is this a commit」 by matching the command TEXT.
# That is unfixable by construction: widen it and a commit MESSAGE mentioning
# `push` blocks a legitimate commit, narrow it and ONE PAIR OF QUOTES walks
# straight through. Two live bypasses were found this way (待复审清单 第 3 项):
#
#     git "commit" -m x          -> the `commit` token test missed -> gate never
#                                   ran, and the commit passed with ZERO checks
#     git "-C" other commit      -> the redirect test missed -> this repo's
#                                   checks vouched for a commit into ANOTHER one
#
# Each fix only moved the boundary out by one notch; the same lesson as TASK-077
# (two spellings patched before anyone changed the KIND of test). The gate's own
# comment had already conceded 「a regex cannot reliably parse a shell command
# line」 — correct, and the wrong conclusion drawn from it. A regex cannot, but
# THE SHELL ITSELF CAN, and the hook payload names which shell (`tool_name`).
#
# So the input to every judgement below is a list of SIMPLE COMMANDS, each a
# list of already-dequoted tokens:
#
#     tool_name == "Bash"        -> tokenised here, by `shlex` (stdlib, POSIX)
#     tool_name == "PowerShell"  -> split by gate.ps1 using PowerShell's OWN
#                                   parser (System.Management.Automation.
#                                   Language.Parser) and handed over as JSON;
#                                   that shell SPLITS, it never JUDGES
#     anything else / no argv    -> fail closed (决策 4)
#
# POSIX splitting lives HERE rather than in gate.sh for the reason ADR-0062
# 决策 3 exists: one implementation cannot drift from itself. Two shells each
# matching their own tokens is exactly how they came to disagree before
# (`-like` is case-insensitive, `grep -F` is not).
#
# ---------------------------------------------------------------------------
# KNOWN BYPASSES THAT REMAIN. THIS LIST IS HONEST ON PURPOSE - DO NOT DELETE IT.
# ---------------------------------------------------------------------------
# A parser solves QUOTING AND ESCAPING. It does not solve INDIRECTION: the hook
# receives the text that is ABOUT to be handed to a shell, so any form whose
# behaviour is not decidable from that text is not decidable here either.
#
#   eval "git commit -m x"        the tokens are ['eval', 'git commit -m x'] --
#                                 the commit is inside a string argument
#   bash -c '...' / pwsh -c '...' same, one nested grammar deeper
#   $G commit, $(echo git) commit variables and command substitution expand at
#                                 RUN time; the hook runs before that
#                                 (note: in PowerShell `$G commit` happens to be
#                                 a PARSE error, so that one fails closed here --
#                                 by luck, not by design; the Bash form does not)
#   make commit / ./do-commit.sh  the commit happens in a child process the gate
#                                 never sees
#   shell functions, aliases,     the mapping from name to action is not in this
#   ~/.gitconfig aliases          text at all
#
# `xargs git commit` and `sudo git commit` USED to be on this list. They are
# caught now (see _WRAPPER_COMMANDS) - not because a parser could see through
# them, but because the wrapper's own argv still contains the real command, and
# dropping coverage that the old regex HAD would have made this change a net
# loss for `sudo git commit`.
#
# What this change actually buys: 「one pair of quotes bypasses the gate」 is
# gone, and that was the dangerous class because it fires BY ACCIDENT on
# ordinary typing. What is left requires DELIBERATE circumvention. The bar moved
# from 「bypassed without meaning to」 to 「must mean to」 -- it did NOT move to
# 「cannot」, and nothing here should be read as claiming it did.
#
# The layer that really closes it is a repository-side `pre-commit` git hook,
# which runs inside the git process no matter who invoked it. That is a separate
# card; this module does not pretend to cover it.
# ---------------------------------------------------------------------------

#: Separator tokens produced by `shlex(punctuation_chars=...)`. A run of these
#: characters comes back as ONE token (`&&`, `||`, `;;`, `>&`), and newline is
#: forced into this set too (see `_tokenise_posix`) -- without it
#: `git commit -m x\ngit push` collapses into a single command and the ADR-0068
#: 决策 6 scan stops seeing the push.
_SEPARATOR_CHARS = frozenset(";&|()<>\n")

#: `NAME=value` prefixes (Bash env assignments). `MOTV_CONTINUOUS_CHAIN=1 git
#: commit` must still resolve to the command `git`.
_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

#: Commands that RUN another command, whose argv therefore still holds the real
#: one. Unwrapping them is not parser cleverness; it keeps coverage the text
#: regex already had. `sudo git commit` matched 「names git」+「names commit」
#: before this change, and losing it would have been a REGRESSION dressed up as
#: a rewrite.
_WRAPPER_COMMANDS = frozenset(
    {"sudo", "doas", "env", "nice", "nohup", "time", "command", "xargs", "stdbuf"}
)

#: git's own name, after basename + `.exe` stripping. Compared case-INSENSITIVELY
#: so both shells agree on `Git.exe` (ADR-0062 决策 3); over-matching costs one
#: check run, under-matching costs an unchecked commit.
_GIT_COMMAND_NAME = "git"

#: git GLOBAL options that swallow the NEXT token as their value. Needed to find
#: the subcommand: in `git -C /other commit` the first non-option token is
#: `/other`, not `commit`, and without this table the commit is invisible.
#:
#: Being wrong here is not symmetric. An option MISSING from this list can only
#: make an extra token look like the subcommand (over-gating, one wasted check
#: run). An option wrongly IN it could swallow a real `commit` token -- so every
#: entry below is a documented value-taking git global option, and the three
#: that also redirect the repository are blocked outright anyway.
_GIT_VALUE_OPTIONS = frozenset(
    {
        "-C",
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--exec-path",
        "--super-prefix",
        "--config-env",
        "--attr-source",
    }
)

#: Options that point git at a DIFFERENT repository. Every check this gate runs
#: covers THIS one, so a commit carrying them would be vouched for by a tree the
#: gate never inspected.
#:
#: Exact token comparison, which is what finally separates `-C` from `-c`: the
#: old regex needed a case-SENSITIVE match to tell git's directory switch from
#: its harmless `-c key=value` config override, and that trick is why the two
#: shells' matchers had to agree on case-sensitivity in the first place.
#:
#: Scoped to GLOBAL options (before the subcommand) on purpose: `git commit -C
#: HEAD` reuses another commit's MESSAGE and redirects nothing. The text regex
#: blocked it; this does not.
_GIT_REDIRECT_OPTIONS = frozenset({"-C", "--git-dir", "--work-tree"})

_COMMIT_SUBCOMMAND = "commit"


@dataclass(frozen=True)
class Intent:
    """What the intercepted command is, decided from tokens rather than text.

    ``gate`` is the whole contract with both shells:

    ``skip``   not a commit -> exit 0, run nothing (the common case).
    ``block``  a commit this gate must refuse before running anything.
    ``check``  a commit -> run the quality checks.
    """

    gate: str
    reason: str = ""
    #: Names WHY a `block` was issued. The shells never read it -- they only need
    #: `gate` and `reason` -- but `decide()` reports it as the tier, so the two
    #: kinds of refusal stay distinguishable in tests and in the record.
    tier: str = ""
    #: Which diff describes what this commit will WRITE. `git commit -a/--all`
    #: stages tracked worktree changes as part of the commit itself, so that
    #: form must be classified against HEAD rather than the index.
    diff: str = "index"
    #: ADR-0068 opt-in, already resolved so neither shell has to look at it.
    chain_mode: bool = False
    #: 决策 4: the command could not be parsed, so the paths cannot be trusted to
    #: describe it either. The shells skip the diff entirely and run everything.
    force_full: bool = False


def _basename(token: str) -> str:
    """Last path segment of *token*, lowercased, without a `.exe` suffix.

    Splits on BOTH separators. On Linux a backslash is a legal filename
    character, so `foo\\git` is one file and splitting it is technically wrong --
    but it is wrong towards MORE gating, and a Windows-shaped path reaching the
    POSIX side is far likelier than a file genuinely named that way.
    """
    tail = token.replace("\\", "/").rsplit("/", 1)[-1]
    return tail.lower().removesuffix(".exe")


def _tokenise_posix(command: str) -> list[list[str]] | None:
    """Split a POSIX command line into simple commands of dequoted tokens.

    Returns ``None`` when the text cannot be tokenised at all (an unbalanced
    quote), which the caller turns into a fail-closed run. Such a command would
    not run in bash either, so the cost is a wasted check run on something that
    was already broken.
    """
    lexer = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    # Newline must be a SEPARATOR, not whitespace: `git commit -m x\ngit push`
    # is two commands, and shlex's default whitespace set swallows the boundary.
    # Quoted newlines are unaffected -- they are consumed inside the quote state,
    # which is what keeps multi-line commit messages in one token.
    lexer.whitespace = " \t\r"
    # `#` is NOT a comment introducer here. shlex would drop the rest of the line
    # at any `#`, including one inside an unquoted word, and anything dropped is
    # something the ADR-0068 决策 6 scan can no longer see. Treating it as an
    # ordinary character can only ever ADD tokens.
    lexer.commenters = ""
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return None

    commands: list[list[str]] = [[]]
    for token in tokens:
        if token and all(char in _SEPARATOR_CHARS for char in token):
            commands.append([])
            continue
        commands[-1].append(token)
    return [command for command in commands if command]


def _tokenise(
    tool_name: str | None, command: str, argv: object = None
) -> list[list[str]] | None:
    """Simple commands for *command*, or ``None`` when it cannot be split."""

    if argv is not None:
        # Already split by the shell that owns the grammar (gate.ps1). Validated
        # rather than trusted: a malformed hand-over must fail closed, not
        # explode inside a judgement and take the whole gate's `exit 0` path.
        if not isinstance(argv, list):
            return None
        commands = []
        for entry in argv:
            if not isinstance(entry, list) or not all(
                isinstance(token, str) for token in entry
            ):
                return None
            if entry:
                commands.append(list(entry))
        return commands
    if isinstance(tool_name, str) and tool_name.lower() == "bash":
        return _tokenise_posix(command)
    # Unknown tool, or PowerShell text with no argv to go with it. 决策 4: not
    # 「this is not a commit」 but 「I cannot tell」, and those must differ.
    return None


def _resolve_command_name(argv: list[str]) -> tuple[str | None, list[str]]:
    """Return (command name, that command's own tokens) for one simple command.

    Strips `NAME=value` prefixes and unwraps `sudo`/`env`/`xargs`-style runners.
    """

    tokens = list(argv)
    while tokens:
        head = tokens[0]
        if _ASSIGNMENT_RE.match(head):
            tokens.pop(0)
            continue
        name = _basename(head)
        if name in _WRAPPER_COMMANDS:
            tokens.pop(0)
            # A wrapper option may take a SEPARATE value -- `sudo -u user`,
            # `nice -n 10`, `env -u NAME`, `xargs -n 1` -- and skipping only the
            # dash-tokens then leaves the VALUE looking like the command name.
            # `sudo -u builder git commit` resolved to the command `builder` and
            # returned "not a commit": a bypass, and worse, one the text regex
            # this card replaced did NOT have (codex review round 1, confirmed by
            # running the classifier).
            #
            # Modelling each wrapper's option grammar would be a table to get
            # wrong. Instead look for git ANYWHERE in what the wrapper was handed:
            # one of those tokens IS the command it runs. Wrong towards MORE
            # gating costs a check run (`sudo -u x apt install git` finds a
            # trailing `git` with no subcommand after it -> still "not a commit");
            # wrong the other way costs an unchecked commit.
            for index, token in enumerate(tokens):
                if _basename(token) == _GIT_COMMAND_NAME:
                    return _GIT_COMMAND_NAME, tokens[index:]
            while tokens and tokens[0].startswith("-"):
                tokens.pop(0)
            continue
        return name, tokens
    return None, []


def _git_subcommand(tokens: list[str]) -> tuple[str | None, list[str], list[str]]:
    """Split a git invocation into (subcommand, global options, later args)."""

    args = tokens[1:]
    options: list[str] = []
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--":
            index += 1
            break
        if not token.startswith("-"):
            break
        options.append(token)
        if "=" not in token and token in _GIT_VALUE_OPTIONS:
            index += 2  # this option eats its value
        else:
            index += 1
    if index >= len(args):
        return None, options, []
    return args[index], options, args[index + 1 :]


def _redirects_the_repository(options: list[str]) -> bool:
    return any(option.split("=", 1)[0] in _GIT_REDIRECT_OPTIONS for option in options)


#: `git commit` short options that consume the REST of their cluster as a VALUE.
#: `-Salpha` is `-S alpha` (a signing key id), not the flags `-S -a -l -p -h -a`,
#: and reading its value as flags found an `a` that is not there (codex review
#: round 2). Same for `-mall` (a message) and `-uall` (untracked-files mode).
#: `U` is `-U, --unified <n>`, which git's own `git commit` usage does list; no
#: VALID invocation changes answer because of it (`-Ua` and `-U2a` are both
#: rejected outright: 「switch `U' expects an integer value」), so it is here for
#: completeness of the set, not to fix a behaviour (codex 补审, non-blocking).
#:
#: Split in two because 「ends the cluster」 and 「eats the NEXT token」 are not the
#: same question, and answering them with one set was a real defect: `-S` and `-u`
#: take their value only ATTACHED, so `git commit -S -a` stages the WORKTREE
#: (measured: 「Changes to be committed」, while `git commit -u all` answers
#: 「pathspec 'all' did not match」). Treating the following token as their value
#: hid that `-a` and answered `index` -- the UNDER-matching direction, i.e. a
#: narrower diff and a LOWER tier (codex 补审 round 2, blocking).
_COMMIT_NEXT_TOKEN_SHORT_OPTIONS = frozenset("mFcCtU")
_COMMIT_ATTACHED_VALUE_SHORT_OPTIONS = frozenset("Su")
_COMMIT_VALUE_SHORT_OPTIONS = (
    _COMMIT_NEXT_TOKEN_SHORT_OPTIONS | _COMMIT_ATTACHED_VALUE_SHORT_OPTIONS
)

#: `git commit` options whose value is the NEXT token, taken verbatim even when it
#: starts with `-` (measured: `git commit -qm -a` and `git commit --message -a`
#: both report 「no changes added to commit」 -- the `-a` was the MESSAGE).
#:
#: Optional-value options are deliberately ABSENT (`-S`/`--gpg-sign`,
#: `-u`/`--untracked-files`): git only accepts their value ATTACHED, so the token
#: after them is not theirs. Long-option ABBREVIATIONS are absent too, and that is
#: safe in one direction only: an option we fail to recognise is not skipped, so
#: its value is still examined -- which can only ADD an `-a` we did not need
#: (wider diff, higher tier), never hide one.
_COMMIT_VALUE_LONG_OPTIONS = frozenset(
    {
        "--file",
        "--author",
        "--date",
        "--message",
        "--reedit-message",
        "--reuse-message",
        "--fixup",
        "--squash",
        "--trailer",
        "--template",
        "--cleanup",
        "--unified",
        "--inter-hunk-context",
        "--pathspec-from-file",
    }
)


def _selects_all_tracked(token: str) -> bool:
    """Is *token* `git commit`'s `-a` / `--all`, including inside a cluster?

    The text regex matched `-a` and `--all` only, so `git commit -am "x"` -- an
    ordinary way to write it -- was classified against the INDEX while the commit
    actually wrote the worktree.

    A cluster is scanned LEFT TO RIGHT and stops at the first option that takes a
    value, because everything after it belongs to that option: `-ma` is `-m a`
    (message "a"), NOT `-m -a`. Over-matching only widens the diff, which can
    only raise the tier -- but it can still make a commit that stages clean paths
    run the whole suite against unrelated broken worktree changes, so being right
    is worth these six lines.
    """
    if token == "--all":
        return True
    if token.startswith("--") or not token.startswith("-"):
        return False
    for char in token[1:]:
        if char == "a":
            return True
        if char in _COMMIT_VALUE_SHORT_OPTIONS or not char.isalpha():
            return False
    return False


def inspect_command(
    tool_name: str | None = None, command: str = "", argv: object = None
) -> Intent:
    """Decide what the intercepted command IS. The gates' Phase A, in one place.

    This is the whole of TASK-085: every judgement below reads TOKENS, and the
    only text-position test left is the continuous-chain opt-in -- deliberately,
    see `_CHAIN_RE`. That token is an env-assignment prefix in Bash and a leading
    COMMENT in PowerShell, and PowerShell's parser discards comments, so tokens
    are the one representation in which it cannot be seen at all.
    """

    command = command if isinstance(command, str) else ""
    commands = _tokenise(tool_name, command, argv)
    if commands is None:
        # 决策 4. Note chain_mode is forced OFF: a command we could not read must
        # never be handed the opt-in that SKIPS the full suite. Fail-closed has
        # to compose, or it is not fail-closed.
        return Intent("check", _REASON_UNPARSEABLE, tier="full", force_full=True)

    chain_mode = chain_mode_from_command(command)

    commits: list[tuple[list[str], list[str]]] = []
    conflicts = False
    for argv_tokens in commands:
        name, tokens = _resolve_command_name(argv_tokens)
        if name is None:
            continue
        if name == _GIT_COMMAND_NAME:
            subcommand, options, rest = _git_subcommand(tokens)
            folded = subcommand.lower() if subcommand else ""
            if folded == _COMMIT_SUBCOMMAND:
                commits.append((options, rest))
            elif folded in _CHAIN_CONFLICT_VERBS:
                conflicts = True
        elif name in _CHAIN_CONFLICT_VERBS:
            # Fallback kept from the text scan: a bare `push` may well be a
            # script or an alias that does exactly what 决策 6 forbids.
            conflicts = True

    if not commits:
        return Intent("skip", "not a git commit")

    if any(_redirects_the_repository(options) for options, _ in commits):
        return Intent(
            "block",
            "this commit redirects git to another repository "
            "(-C / --git-dir / --work-tree), but the quality checks only cover "
            "this one. Run the commit from that repository's own working "
            "directory so its gate can verify it.",
            tier="redirected",
        )

    if chain_mode and conflicts:
        return Intent(
            "block", _CHAIN_CONFLICT_REASON, tier="chain-conflict", chain_mode=True
        )

    return Intent(
        "check",
        "git commit",
        diff="head" if _commit_stages_the_worktree(commits) else "index",
        chain_mode=chain_mode,
    )


def _takes_the_next_token(token: str) -> bool:
    """Does *token* eat the FOLLOWING token as its value?

    A cluster only eats it when a REQUIRED-value option is the cluster's LAST
    character: `-qm x` is `-q -m x`, while `-mmsg` already carries its value
    attached and `-S x` / `-u x` never take `x` at all (optional values must be
    attached, so `x` is a pathspec).
    """
    if token.startswith("--"):
        # `--message=x` is not in the set, so an attached value is handled by the
        # membership test alone.
        return token in _COMMIT_VALUE_LONG_OPTIONS
    if len(token) < 2 or not token.startswith("-"):
        return False
    for position, char in enumerate(token[1:], start=2):
        if char in _COMMIT_ATTACHED_VALUE_SHORT_OPTIONS:
            return False
        if char in _COMMIT_NEXT_TOKEN_SHORT_OPTIONS:
            return position == len(token)
        if not char.isalpha():
            return False
    return False


def _commit_stages_the_worktree(commits: list[tuple[list[str], list[str]]]) -> bool:
    return any(_stages_the_worktree(rest) for _, rest in commits)


def _stages_the_worktree(rest: list[str]) -> bool:
    """Is `-a` / `--all` present as a FLAG among one commit's arguments?

    Not a membership scan over every token: that was the very error class the
    cluster scan in `_selects_all_tracked` removed one level down, still live one
    level up (codex 补审 2026-08-17). `git commit -qm -a` and `git commit -- -a`
    were both read as worktree commits -- measured, the first writes only the
    INDEX (`-a` is the message) and the second commits a pathspec NAMED `-a`. That
    errs toward the wider HEAD diff, i.e. a commit staging only clean paths judged
    against whatever unrelated breakage sits in the worktree: fail-closed, but the
    docstring below argues precisely that widening is not free.
    """
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--":
            break  # everything after is a pathspec, not a flag
        if _selects_all_tracked(token):
            return True
        index += 2 if _takes_the_next_token(token) else 1
    return False


@dataclass(frozen=True)
class Decision:
    """The checks the gate must run for one candidate commit."""

    tier: str
    reason: str
    pytest_targets: tuple[str, ...] = ()
    #: Shown verbatim by both gates. Non-empty ONLY when a check was skipped —
    #: an invisible skip is how a temporary exception becomes permanent.
    notice: str = ""
    #: Targets that must run OUTSIDE xdist (the real-process-tree tests). The
    #: shells run `pytest_targets` under `-n 8 -m "not serial"` and these plain;
    #: folding both into one list would either break the serial tests (xdist)
    #: or fail with exit 5 (a serial-only selection filtered to nothing).
    serial_targets: tuple[str, ...] = ()
    #: A python+frontend MIXED change runs the frontend suite AS WELL as its
    #: pytest targets. A dedicated flag rather than a pseudo pytest target, so
    #: neither shell ever hands a node suite to pytest.
    frontend: bool = False


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


def _is_lint_only(path: str) -> bool:
    # Same `..` guard as `_is_docs`: a traversal-marked path never takes the
    # cheap stage.
    if ".." in PurePosixPath(path).parts:
        return False
    return path in _LINT_ONLY_FILES or path.startswith(_LINT_ONLY_PREFIXES)


def _is_pytest_file(path: str) -> bool:
    return (
        path.startswith("tests/")
        and path.rsplit("/", 1)[-1].startswith("test_")
        and path.endswith(".py")
    )


#: A claim is (kind, targets): kind in {"frontend", "pytest", "serial", "full"}.
_Claim = tuple[str, tuple[str, ...]]


def _domains_importing(stem: str, root: Path | None = None) -> tuple[str, ...]:
    """Test domains that import the tests/ root support module *stem*.

    DERIVED, never hand-written: a hand-kept table drifts the moment someone
    adds a consumer, and it drifts SILENTLY towards running too little. The
    import graph is the fact, so read it (TASK-087 §7: 守卫的键集要派生).

    Returns () when nothing imports it — a brand-new helper, or an import form
    this does not recognise. The caller turns that into the full run, so the
    unknown case stays fail-closed rather than testing nothing.

    Cost: reading the ~150 test files once, only for a commit that actually
    touches the tests/ root (rare). A `tests/` directory that cannot be read is
    reported as no domains, i.e. the full run.
    """
    # `root` exists ONLY so tests can point the scan at a throwaway tree.
    # Without it, a test that plants a probe file in the real tests/ tree
    # changes the answer for every OTHER derivation running at the same time --
    # under `-n 8` that is a genuine flake, observed 2 runs in 4 (codex review,
    # TASK-102, second round). Production always passes None: both gates run the
    # classifier with the repo root as the working directory.
    base = Path() if root is None else root
    domains: set[str] = set()
    for domain_dir in _TEST_DOMAIN_DIRS:
        try:
            # RECURSIVE: a consumer in a nested directory (tests/backend/sub/)
            # was invisible to `glob("*.py")`, and missing it NARROWED the
            # answer rather than widening it (codex review, TASK-102).
            candidates = sorted((base / domain_dir).rglob("*.py"))
        except OSError:
            return ()
        for candidate in candidates:
            try:
                tree = ast.parse(candidate.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, SyntaxError, ValueError):
                # Cannot prove this file does NOT import the module, so widen
                # to the full run rather than guess.
                return ()
            if _imports_support_module(tree, stem):
                domains.add(domain_dir.rstrip("/"))
                break
    return tuple(sorted(domains))


def _imports_support_module(tree: ast.AST, stem: str) -> bool:
    """Does this parsed module import ``tests.<stem>``, in ANY spelling?

    Three node shapes cover every form, parenthesised and aliased included:
      ``from tests.<stem> import x``  -> ImportFrom(module="tests.<stem>")
      ``from tests import <stem>``    -> ImportFrom(module="tests", names=[…])
      ``import tests.<stem>``         -> Import(names=["tests.<stem>"])
    A relative ``from .<stem> import x`` (level > 0) inside a domain package
    counts too, since that is the same module by another route.
    """
    dotted = f"{_TESTS_PACKAGE}.{stem}"
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.module == dotted:
                return True
            if node.module == _TESTS_PACKAGE and any(
                alias.name == stem for alias in node.names
            ):
                return True
            if node.level and node.module in (None, stem):
                # `from . import <stem>` / `from .<stem> import x`
                if node.module == stem or any(
                    alias.name == stem for alias in node.names
                ):
                    return True
        elif isinstance(node, ast.Import):
            if any(
                alias.name == dotted or alias.name.startswith(f"{dotted}.")
                for alias in node.names
            ):
                return True
    return False


def _claim(path: str) -> _Claim | None:
    """Which test domain OWNS *path* (ADR-0080 decision 1). None = nobody -> full."""

    if path.startswith(_FRONTEND_PREFIX):
        if path.endswith(_FRONTEND_SUFFIXES):
            return ("frontend", ())
        if path.endswith(".py"):
            return ("pytest", _STUDIO_PY_TARGETS)
        return None  # runtime data / unknown asset under the Studio dir
    if path.startswith(_WORKSPACE_PREFIXES):
        return ("pytest", _WORKSPACE_TESTS)
    if path.startswith("src/") and path.endswith(".py"):
        # Top-level modules of the package (persistence, models, errors,
        # digests, ...) are the de-facto common layer -- 20+ subpackages import
        # them -- so their impact scope is backend AND the Studio backend even
        # when a conventional per-module test exists. Inside a subpackage the
        # conventional test wins; src/ui-gap-audit and anything else falls
        # through to full.
        if re.fullmatch(r"src/ai_video_workflow/[^/]+\.py", path):
            return ("pytest", _BACKEND_CORE_TARGETS)
        parts = PurePosixPath(path).parts
        stem = Path(path).stem
        candidates = [f"tests/backend/test_{stem}.py"]
        if len(parts) >= 4:
            # src/ai_video_workflow/<pkg>/<stem>.py -> test_<pkg>_<stem>.py is
            # the dominant naming for subpackage modules.
            candidates.insert(0, f"tests/backend/test_{parts[2]}_{stem}.py")
        for target in candidates:
            if Path(target).is_file():
                return ("pytest", (target,))
        if path.startswith(("src/ai_video_workflow/", "src/workspace_shell/")):
            return ("pytest", _BACKEND_CORE_TARGETS)
        return None
    if path in _FULL_PYTEST_FILES:
        return ("full", ())
    if path in _SERIAL_TEST_FILES:
        # A DELETED serial test cannot be handed to pytest as a target; its
        # domain dir would drag nothing serial anyway, so fall back to full.
        return ("serial", (path,)) if Path(path).is_file() else ("full", ())
    if _is_pytest_file(path):
        if Path(path).is_file():
            return ("pytest", (path,))
        # A deleted test file is still a change to its domain: run the OWNING
        # domain so the deletion cannot silently break a neighbour (imports,
        # shared helpers), instead of handing pytest a path that no longer
        # exists (usage error -> gate block).
        parts = path.split("/")
        if len(parts) > 2 and f"tests/{parts[1]}/" in _TEST_DOMAIN_DIRS:
            return ("pytest", (f"tests/{parts[1]}",))
        return ("full", ())
    if path.startswith("tests/"):
        parts = path.split("/")
        if len(parts) == 2:
            # Repo-root test-support layer. `_FULL_PYTEST_FILES` above already
            # took the two files pytest loads by itself; everything else here
            # reaches its consumers through an import, so DERIVE the scope from
            # that graph rather than assuming it is everything.
            if not path.endswith(".py"):
                return None
            domains = _domains_importing(Path(path).stem)
            return ("pytest", domains) if domains else ("full", ())
        domain = parts[1]
        if f"tests/{domain}/" in _TEST_DOMAIN_DIRS:
            # Domain fixtures and helpers: run the owning domain. tests/e2e is
            # deliberately absent (its dir target would drag the serial test
            # under xdist), so an e2e support file falls through to full.
            return ("pytest", (f"tests/{domain}",))
        return None
    if path.startswith(".claude/"):
        # Agent tooling (hooks, skill scripts, settings wiring). Markdown under
        # .claude/ is documentation and never reaches this function.
        return ("pytest", _TOOLING_TARGETS)
    if path.startswith("scripts/"):
        return ("pytest", _LAYOUT_TARGETS)
    if path.startswith("product-skills/"):
        return ("pytest", _SKILL_PACKAGE_TARGETS)
    if path.startswith("examples/"):
        return ("pytest", _EXAMPLES_TARGETS)
    if path.startswith("config/"):
        return ("pytest", _PROVIDER_CONFIG_TARGETS)
    return None


def chain_mode_from_command(command: str) -> bool:
    """Is the continuous-modification chain opt-in present in THIS commit command?

    Exact-token match on purpose (ADR-0068 决策 7): `true` / `yes` / `on` are not
    accepted, because a switch that can be turned on vaguely gets turned on
    vaguely — and this one removes a real check.
    """
    return isinstance(command, str) and bool(_CHAIN_RE.match(command))


def decide(
    paths: list[str],
    command: str = "",
    tool_name: str | None = None,
    argv: object = None,
) -> Decision:
    """End-to-end verdict for one intercepted command. THE SPECIFICATION.

    The gates do not call this: they call `inspect_command` first (before they
    know the changed paths, because the intent decides WHICH diff to ask git
    for) and `classify` second. This composes the same two steps in one place so
    the contract can be stated and tested as one thing, and
    `test_the_two_cli_modes_together_reproduce_decide` pins the CLI to it --
    otherwise this would be a spec nothing implements, which is how a guard ends
    up looking connected while it is not.
    """

    intent = inspect_command(tool_name, command, argv)
    if intent.gate == "skip":
        return Decision("skip", intent.reason)
    if intent.gate == "block":
        return Decision(intent.tier, intent.reason)
    if intent.force_full:
        return Decision("full", intent.reason)
    return classify(paths, chain_mode=intent.chain_mode)


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

    non_docs = tuple(
        path for path in changed if not (_is_docs(path) or _is_lint_only(path))
    )
    if not non_docs:
        return Decision("lint", "documentation-only change")

    pytest_targets: set[str] = set()
    serial_targets: set[str] = set()
    frontend = False
    needs_full_pytest = False
    unmapped = False
    for path in non_docs:
        claim = _claim(path)
        if claim is None:
            # Do NOT return here. An early return kept the default
            # `frontend=False`, so a commit mixing an unmapped path with a
            # FRONTEND path took the full tier and silently dropped the
            # frontend suite (codex review, TASK-102). Keep scanning so the
            # frontend claim survives into the decision below.
            unmapped = True
            continue
        kind, targets = claim
        if kind == "frontend":
            frontend = True
        elif kind == "serial":
            serial_targets.update(targets)
        elif kind == "full":
            needs_full_pytest = True
        else:
            pytest_targets.update(targets)

    if unmapped:
        return Decision("full", _REASON_NO_MAPPING, frontend=frontend)

    if needs_full_pytest:
        # The whole pytest run already contains every targeted selection; the
        # frontend flag still rides along for a mixed change.
        return Decision(
            "full", "path underpins the whole pytest suite", frontend=frontend
        )
    # Drop targets subsumed by a directory-level target of the same domain, so
    # one test does not run twice in the same gate invocation.
    dirs = {target for target in pytest_targets if not target.endswith(".py")}
    pytest_targets = {
        target
        for target in pytest_targets
        if target in dirs or not any(target.startswith(f"{d}/") for d in dirs)
    }
    if pytest_targets or serial_targets:
        return Decision(
            "pytest-targeted",
            "ownership-mapped test selection",
            tuple(sorted(pytest_targets)),
            serial_targets=tuple(sorted(serial_targets)),
            frontend=frontend,
        )
    return Decision("frontend", "bounded frontend-only surface")


def _run_intent_mode() -> Intent:
    """`--intent`: read the hook payload on stdin, answer 「what IS this?」.

    STDIN, not argv, and that is not a style choice. The old CLI passed the whole
    intercepted command as `--command <cmd>`, which put the commit MESSAGE into
    the same 32767-character Windows command-line budget as the changed-path
    list; a long message plus a wide change set made `Process.Start` throw, and
    that terminating error exited gate.ps1 with 1 -- which PreToolUse reads as a
    NON-BLOCKING hook error, i.e. the commit landed with ZERO checks run
    (independent review, round 3; measured OK at 30125 chars, Win32Exception at
    40125). Handing the payload over on a pipe removes the budget entirely, and
    the tier call below no longer needs the command text at all.

    Accepts the raw PreToolUse payload (`tool_name` + `tool_input.command`) so
    gate.sh can forward it untouched, or gate.ps1's enrichment of it, which adds
    the `argv` PowerShell's own parser produced.
    """

    raw = sys.stdin.buffer.read()
    try:
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("payload is not an object")
    except (UnicodeDecodeError, ValueError):
        # 决策 4 again: an unreadable payload is 「I cannot tell」, never 「not a
        # commit」. The gates' previous fallback -- match the RAW payload text
        # with the same regexes -- is exactly the class this card removed.
        return Intent("check", _REASON_UNPARSEABLE, tier="full", force_full=True)

    tool_input = payload.get("tool_input")
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    command = payload.get("command")
    if not isinstance(command, str):
        command = tool_input.get("command")
    tool_name = payload.get("tool_name")
    return inspect_command(
        tool_name if isinstance(tool_name, str) else None,
        command if isinstance(command, str) else "",
        payload.get("argv"),
    )


def main() -> int:
    # TWO MODES, because the gates need two answers at two different times:
    #
    #   --intent                 what IS this command?  (before any git runs --
    #                            the answer decides WHICH diff to ask git for)
    #   --chain-mode 0|1 -- ...  given these changed paths, what must run?
    #
    # The second mode takes the chain opt-in as a resolved BOOLEAN rather than
    # re-deriving it from the command text: deriving the same thing twice is how
    # two implementations of one rule appear, and this module exists to stop
    # that (TASK-076 §1.2). The gates never decide either answer.
    #
    # Git supplies NUL-separated names on Bash.  PowerShell normalises its
    # pipeline input to newlines; accepting both formats is safe on supported
    # Windows filenames and keeps the two hook runners on one policy.
    #
    # `--` ends the flags, so a changed file literally named `--chain-mode` is a
    # path and not a flag.
    argv = sys.argv[1:]
    intent_mode = False
    chain_mode = False
    rest: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--":
            rest.extend(argv[index + 1 :])
            break
        if arg == "--intent":
            # PARSED IN THIS LOOP, not by an `"--intent" in argv` membership test
            # over the whole list. That test ignored the `--` separator the very
            # next branch honours, so staging a file literally named `--intent`
            # switched the CLASSIFIER call into intent mode: it then answered
            # with an Intent object, the shell found no `tier` on it, and the
            # commit was blocked with a nonsense message (codex review round 2).
            # Fail-closed, but confusing -- and the `--chain-mode` case right
            # below already had a passing guard, so the invariant was known.
            intent_mode = True
            index += 1
            continue
        if arg == "--chain-mode" and index + 1 < len(argv):
            # EXACT "1". A switch that can be turned on vaguely gets turned on
            # vaguely, and this one removes a real check (ADR-0068 决策 7).
            chain_mode = argv[index + 1] == "1"
            index += 2
            continue
        rest.append(arg)
        index += 1

    if intent_mode:
        payload = json.dumps(asdict(_run_intent_mode()), sort_keys=True)
        sys.stdout.buffer.write(payload.encode("utf-8") + b"\n")
        sys.stdout.buffer.flush()
        return 0

    if rest:
        paths = rest
    else:
        raw = sys.stdin.buffer.read()
        separator = b"\0" if b"\0" in raw else b"\n"
        paths = [
            part.decode("utf-8", "surrogateescape") for part in raw.split(separator)
        ]
    payload = json.dumps(asdict(classify(paths, chain_mode=chain_mode)), sort_keys=True)
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
