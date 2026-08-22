#!/usr/bin/env bash
#
# gate.sh — PreToolUse(Bash) commit gate.
#
# Reads the hook input JSON on stdin. It acts ONLY when the intercepted command
# contains `git commit`: it runs every configured quality check and, if all pass,
# exits 0 (commit allowed). If any check fails, it prints the failing output to
# stderr and exits 2 (commit blocked). For any non-commit command it exits 0
# immediately and does nothing.
#
set -uo pipefail

# --- read hook input --------------------------------------------------------
INPUT="$(cat)"

# Locate the repo root so relative tool paths (.venv, git checks) are stable
# regardless of the caller's working directory.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  # Not in a git repo -> nothing to gate; never block.
  exit 0
fi
PY="$ROOT/.venv/bin/python"

# Force UTF-8 on every python child's stdio, exactly as gate.ps1 does before its
# own checks. Without this, a non-UTF-8 locale (zh_CN.GB18030, ja_JP.eucJP, any
# ISO-8859-*) made the notice extraction die on one Chinese character; the
# failure was swallowed by `set -uo pipefail` (no `-e`), the notice came back
# EMPTY, and the skip warning was never printed at all — while gate.ps1, which
# does set these, printed it. Same input, different output: the platform
# divergence ADR-0062 决策 3 forbids (independent review, round 3).
# PEP 540's automatic UTF-8 mode covers only the C/POSIX locale, so it does not
# cover this.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

# A Windows virtualenv means gate.ps1 owns this repo's gate (ADR-0050). Both
# hooks are registered in settings.json and run in parallel, so this one must
# stand down here: a bash on a Windows host (Git Bash, or WSL reaching in over
# /mnt) cannot run .venv/Scripts/python.exe and would otherwise block every
# commit on an interpreter it was never meant to use.
if [ ! -x "$PY" ] && [ -f "$ROOT/.venv/Scripts/python.exe" ]; then
  exit 0
fi

# --- work out what this command IS ------------------------------------------
# THERE IS NO TEXT PRE-FILTER HERE ANY MORE, and that removal is the point of
# TASK-085. Two regexes used to decide whether to go on -- 「does it name git」
# and 「is there a bare `commit` token」 -- and every form they failed to
# recognise was a commit that ran ZERO checks. `git "commit"` walked straight
# through, and `git "-C" other commit` made this repo's checks vouch for a
# commit into a different one. No pre-filter fixes that class: `g""it` fools any
# substring test ever written, because the QUOTES ARE THE SHELL'S, not the text's.
#
# So the payload goes to the policy verbatim and the policy decides, tokenising
# POSIX text with `shlex`. That is one implementation, shared with the Windows
# side, which is the only arrangement ADR-0062 决策 3 cannot be violated by:
# two shells each matching their own tokens is exactly how they diverged before.
#
# The cost is one interpreter start (~126 ms) per Bash tool call, commit or not.
# If it ever needs reducing the direction is a resident classifier, NEVER a
# pre-filter.
POLICY="$ROOT/.claude/hooks/commit_gate_policy.py"

# The classifier is stdlib-only, so any interpreter can answer the intent
# question. Preferring the venv but falling back to PATH keeps a repo whose
# .venv is not built yet from blocking every unrelated command -- only real
# commits hit the venv requirement, below, exactly as before.
PYX="$PY"
if [ ! -x "$PYX" ]; then
  PYX="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
fi
if [ -z "$PYX" ] || [ ! -f "$POLICY" ]; then
  # FAIL CLOSED, not `exit 0`. Not knowing whether this was a commit is not the
  # same as knowing it was not, and a blanket `exit 0` on a broken detector is
  # how a gate stops running without anyone noticing. This is unreachable in the
  # wired setup -- gate_dispatch.py is itself a python program, so an
  # interpreter demonstrably exists whenever this hook runs at all.
  echo "gate.sh: cannot reach the risk classifier (interpreter='${PYX:-<none>}', policy='$POLICY'), so it cannot tell whether this command is a commit. Failing closed (TASK-085): restore the policy file or put a python on PATH." >&2
  exit 2
fi

# The payload is forwarded UNTOUCHED: `tool_name` is what tells the policy which
# grammar the text is in, and this shell no longer looks at the command at all.
if ! INTENT_JSON="$(printf '%s' "$INPUT" \
  | timeout --kill-after=10 15 "$PYX" "$POLICY" --intent)"; then
  echo "gate.sh: the intent classifier failed; refusing to guess whether this was a commit." >&2
  exit 2
fi
# ONE python call for every field, not one per field: this runs on every Bash
# tool call now, and four interpreter starts would be four times the ~126 ms
# this card already spends. A MISSING field fails the whole extraction (KeyError
# -> non-zero -> the refusal below) rather than coming back as an empty string
# that a later `[ = "1" ]` would quietly read as "no".
if ! INTENT_FIELDS="$(printf '%s' "$INTENT_JSON" | "$PYX" -c 'import json,sys
d = json.load(sys.stdin)
print(d["gate"])
print(d["diff"])
print(int(bool(d["chain_mode"])))
print(int(bool(d["force_full"])))')"; then
  echo "gate.sh: the intent classifier returned unreadable output; refusing unchecked commit." >&2
  exit 2
fi
{
  read -r INTENT_GATE
  read -r INTENT_DIFF
  read -r INTENT_CHAIN
  read -r INTENT_FORCE_FULL
} <<EOF
$INTENT_FIELDS
EOF

case "$INTENT_GATE" in
  skip)
    exit 0 ;;                      # not a commit -> do nothing
  block)
    printf 'gate.sh: %s\n' "$(printf '%s' "$INTENT_JSON" | "$PYX" -c 'import json,sys; sys.stdout.buffer.write(json.load(sys.stdin)["reason"].encode("utf-8"))')" >&2
    printf "(the quality checks cover '%s')\n" "$ROOT" >&2
    exit 2 ;;
  check)
    ;;
  *)
    echo "gate.sh: unsupported intent '$INTENT_GATE'; refusing unchecked commit." >&2
    exit 2 ;;
esac

if [ ! -x "$PY" ]; then
  echo "gate.sh: $PY not found or not executable; cannot run quality checks." >&2
  exit 2
fi

# Classify exactly what this commit writes.  A normal commit writes the index,
# so unrelated experiments in the worktree cannot turn a docs commit into a
# full suite.  `git commit -a/--all` stages tracked worktree changes during the
# commit itself, so use HEAD for that form.  Deletions stay in either input.
#
# WHICH diff comes from the intent, not from a second look at the command text.
# Re-deriving `-a/--all` with a regex is what let `git commit -am "x"` -- an
# entirely ordinary spelling -- be classified against the INDEX while the commit
# actually wrote the WORKTREE.
if [ "$INTENT_FORCE_FULL" = "1" ]; then
  # The command could not be parsed, so the staged paths cannot be trusted to
  # describe it either (决策 4). Skip the diff and run everything: asking git
  # what is staged would answer a question about THIS repo that the unreadable
  # command may not even have been about.
  POLICY_JSON='{"tier": "full", "reason": "unreadable command", "pytest_targets": [], "serial_targets": [], "frontend": false, "notice": ""}'
else
  POLICY_DIFF_ARGS=(diff --cached --name-only --no-renames -z)
  if [ "$INTENT_DIFF" = "head" ]; then
    POLICY_DIFF_ARGS=(diff --name-only --no-renames -z HEAD)
  fi
  # ADR-0068 opt-in, ALREADY RESOLVED by the intent call above. Deriving it a
  # second time is how two implementations of one rule appear -- and each shell
  # matching the token itself is how the platforms came to disagree before
  # (PowerShell's -like is case-insensitive, grep -F is not), and how a commit
  # MESSAGE containing the token could switch the gate off.
  CHAIN_FLAG="$INTENT_CHAIN"
  # BOUNDED, like every other check in this file (cross-model review 2026-08-16).
  # This one step was not: gate.ps1 runs the classifier through `Invoke-Bounded
  # -TimeoutSeconds 15`, this shell ran it bare. A hang here never reaches the
  # `exit 2` below — the OUTER hook timeout fires first, PreToolUse reads that as
  # a NON-BLOCKING hook error, and the commit proceeds with ZERO checks. That is
  # precisely the fail-open this file's own budget comment says must never happen,
  # and it was the only step exempt from it. Same 15s as the other shell, so the
  # two still agree (ADR-0062 decision 3).
  #
  # `set -o pipefail` is on (line 11), so a timeout in EITHER half of the pipe
  # fails the whole thing and lands on the refusal below.
  if ! POLICY_JSON="$(cd "$ROOT" \
    && timeout --kill-after=10 15 git "${POLICY_DIFF_ARGS[@]}" \
    | timeout --kill-after=10 15 "$PY" "$POLICY" --chain-mode "$CHAIN_FLAG")"; then
    echo "gate.sh: could not classify changed paths; refusing unchecked commit." >&2
    exit 2
  fi
fi
POLICY_TIER="$(printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["tier"])')"
if [ -z "$POLICY_TIER" ]; then
  echo "gate.sh: risk classifier returned no tier; refusing unchecked commit." >&2
  exit 2
fi
mapfile -t POLICY_PYTEST_TARGETS < <(
  printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys; print(*json.load(sys.stdin)["pytest_targets"], sep="\n")'
)
mapfile -t POLICY_SERIAL_TARGETS < <(
  printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys; print(*json.load(sys.stdin).get("serial_targets", ()), sep="\n")'
)
# The frontend FLAG a python+frontend mixed change carries (ADR-0080): the
# frontend suite runs IN ADDITION to the pytest targets. Read as exact "true"
# so a malformed value fails towards NOT skipping pytest rather than crashing.
POLICY_FRONTEND="$(printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys; print("true" if json.load(sys.stdin).get("frontend") is True else "false")')"

run_frontend_suite() {
  run_check "frontend tests" 90 node --test "$ROOT"/mockups/motv-workspace/tests/*.test.mjs
}

# --- run every configured quality check ------------------------------------
# Each check has a bounded timeout so a hung command cannot stall the commit.
# The per-check budget sums to 406s (15+15+240+120+8+8) and the hook cap in
# settings.json is 1000s. That slack must cover the worst case where a
# hung check is only killed 10s after its own timeout (`--kill-after=10`), so
# this script always reaches its own `exit 2`. If the outer harness times the
# hook out first, the failure is reported as a NON-BLOCKING hook error and the
# commit proceeds unchecked -- a hung check must never fail open. Within that
# envelope a hung check is killed by ITS OWN timeout with a clear message,
# before the outer harness kills the whole hook ambiguously.
#
# The full suite is TWO phases here too (ADR-0069 decision 7): parallel
# `-n 8 -m "not serial"` at 240s, then serial `-m serial` at 120s.
#
# The budgets are SMALLER than gate.ps1's 600+180 on purpose, and that asymmetry
# is not a portability bug: this shell has /dev/shm, so the repo-root
# conftest.py routes pytest's tmp tree onto tmpfs and the suite was already
# ~110-150s (2719 tests) even serially -- without that route it is ~39 min of
# fsync wait on the WSL2 disk and CANNOT gate a commit. Native Windows has no
# tmpfs, every persist fsyncs to NTFS, and the same suite needs far longer. The
# SPLIT is identical across both shells because ADR-0062 decision 3 requires the
# same verdict from the same input; the BUDGETS differ because the same work
# costs different wall-clock on each. Watch for the failure mode this creates:
# once the suite grows enough, Ubuntu hits 240s while Windows still passes at
# 600s -- a red/green disagreement whose cause is the budget, not the code.
#
# If either phase grows past ~80% of its budget, raise THAT phase here AND the
# hook timeout in settings.json together (keep hook timeout >= budget-sum + 24s;
# today that is 1000s against 406s, so there is ample room).
FAIL_LABEL=""
FAIL_OUT=""

run_check() {
  local label="$1"; shift
  local secs="$1"; shift
  local out rc
  out="$(cd "$ROOT" && timeout --kill-after=10 "$secs" "$@" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    FAIL_LABEL="$label"
    if [ "$rc" -eq 124 ]; then
      FAIL_OUT="$(printf '%s\n' "$out"; echo "[timed out after ${secs}s]")"
    else
      FAIL_OUT="$out"
    fi
    return 1
  fi
  return 0
}

# 1. ruff format --check
# 2. ruff check (lint / static analysis)
# 3. risk-selected test suite (or no test suite for docs-only commits)
# 4. git diff --check          (whitespace / conflict markers in working tree)
# 5. git diff --cached --check (whitespace / conflict markers in staged content)
run_check "ruff format --check"   15 "$PY" -m ruff format --check . \
  && run_check "ruff check"        15 "$PY" -m ruff check .

if [ -z "$FAIL_LABEL" ]; then
  case "$POLICY_TIER" in
    full)
      # Two phases, same split as gate.ps1 (ADR-0062 decision 3 -- both shells
      # must reach the same verdict). See pyproject.toml markers: the serial
      # phase is the real-process-tree suite, which cannot run under xdist.
      # Budgets stay well under the WSL2 serial baseline because /dev/shm
      # already makes this shell the fast one.
      run_check "pytest (full, parallel)" 240 "$PY" -m pytest -n 8 -m "not serial" \
        && run_check "pytest (full, serial)" 120 "$PY" -m pytest -m serial
      if [ -z "$FAIL_LABEL" ] && [ "$POLICY_FRONTEND" = "true" ]; then
        run_frontend_suite
      fi
      ;;
    pytest-targeted)
      # Ownership-mapped selection (ADR-0080). Directory-level targets can be
      # most of a pytest domain, so the parallel run uses the same xdist
      # setting as the full tier and excludes the serial marker; the
      # real-process-tree tests arrive separately in serial_targets and must
      # never go through xdist.
      if [ "${#POLICY_PYTEST_TARGETS[@]}" -gt 0 ]; then
        run_check "pytest (targeted)" 240 "$PY" -m pytest -n 8 -m "not serial" "${POLICY_PYTEST_TARGETS[@]}"
      fi
      if [ -z "$FAIL_LABEL" ] && [ "${#POLICY_SERIAL_TARGETS[@]}" -gt 0 ]; then
        run_check "pytest (targeted, serial)" 120 "$PY" -m pytest "${POLICY_SERIAL_TARGETS[@]}"
      fi
      if [ -z "$FAIL_LABEL" ] && [ "$POLICY_FRONTEND" = "true" ]; then
        run_frontend_suite
      fi
      ;;
    frontend)
      run_frontend_suite
      ;;
    lint)
      ;;
    continuous-chain)
      # ADR-0068: the whole-suite run is deferred to the end of an authorised
      # chain. Announced below, never silent.
      ;;
    *)
      # ADR-0068 决策 6 (the opt-in riding along with a push/merge) used to be a
      # tier here, reached AFTER ruff had already run. It is decided in the
      # intent call now, before anything runs, so the two shells agree on WHEN
      # as well as on WHAT. Anything unexpected reaching this branch blocks.
      FAIL_LABEL="commit-risk-policy"
      FAIL_OUT="unsupported risk tier: $POLICY_TIER"
      ;;
  esac
fi

[ -z "$FAIL_LABEL" ] \
  && run_check "git diff --check"    8 git diff --check \
  && run_check "git diff --cached --check" 8 git diff --cached --check

if [ -n "$FAIL_LABEL" ]; then
  {
    echo "=== commit blocked by gate.sh: '${FAIL_LABEL}' failed ==="
    printf '%s\n' "$FAIL_OUT"
    echo "=== fix the above, then commit again ==="
  } >&2
  exit 2
fi

# --- announce a deferred whole-suite run (ADR-0068) --------------------------
# ONLY on the allow path, and only via JSON. PLAIN stdout from a PreToolUse hook
# that exits 0 is DISCARDED: it is not shown to the user and not given to the
# model, so the previous `echo` announced the skip to nobody — while gate.ps1
# carried a comment claiming the opposite (independent review, round 3,
# confirmed against the hooks documentation).
#
# `systemMessage` alone is the documented pass-through: the message is shown to
# the user and, with `hookSpecificOutput` omitted, NO permission decision is
# made — an allowlisted commit stays allowlisted and nothing is auto-approved.
# `json.dumps` defaults to ensure_ascii, so what reaches the console is pure
# ASCII whatever its codepage.
#
# Keyed on the NOTICE, exactly like gate.ps1's `if ($policy.notice)`. Keying
# this side on the tier instead was equivalent today and divergent tomorrow: the
# first tier that carries a notice would be announced on Windows and silent on
# Ubuntu — the class ADR-0062 决策 3 forbids, and nothing would have caught it.
if ! NOTICE_JSON="$(printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys
notice = (json.load(sys.stdin).get("notice") or "").strip()
if notice:
    sys.stdout.write(json.dumps({"systemMessage": "gate.sh: " + notice}))')"; then
  # A skip that cannot be announced is exactly the invisible skip ADR-0068
  # 决策 7 exists to prevent, so refuse it rather than grant it silently. This
  # blocks a commit that passed every check, which is the correct trade: the
  # gate could not parse its own policy output.
  echo "gate.sh: could not emit the continuous-chain notice; refusing to grant a skip nobody would see." >&2
  exit 2
fi
if [ -n "$NOTICE_JSON" ]; then
  # newline-terminated, like gate.ps1's WriteLine
  printf '%s\n' "$NOTICE_JSON"
fi

exit 0
