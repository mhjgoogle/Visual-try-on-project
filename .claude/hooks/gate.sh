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

# --- extract the intercepted command ---------------------------------------
# Prefer a proper JSON parse (python is guaranteed present in this project);
# fall back to a raw grep only if parsing fails.
CMD=""
if [ -x "$PY" ]; then
  CMD="$(printf '%s' "$INPUT" | "$PY" -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get("tool_input",{}).get("command",""))
except Exception:
    pass' 2>/dev/null || true)"
fi
if [ -z "$CMD" ]; then
  CMD="$INPUT"
fi

# --- only gate real `git commit` invocations --------------------------------
# TWO INDEPENDENT TOKEN TESTS, deliberately NOT a parse of git's argument
# grammar. A regex cannot reliably parse a shell command line -- quoted paths
# containing spaces, substitutions, chained commands -- and every form the
# parse fails to recognise is a commit that silently skips every check. So:
# does the command name git at all, and does a bare `commit` token appear
# anywhere in it? Over-gating costs one check run; a miss costs an unverified
# commit.
if ! printf '%s' "$CMD" | grep -qiE '(^|[^[:alnum:]_-])git(\.exe)?([[:space:]]|$)' \
  || ! printf '%s' "$CMD" | grep -qiE '(^|[[:space:]])commit([[:space:]]|$)'; then
  exit 0
fi

# ...but every check below runs in THIS repository. A commit redirected
# elsewhere by -C / --git-dir / --work-tree would get a verdict computed from a
# tree the gate never inspected, so fail closed rather than vouch for code it
# did not check. This match is case-SENSITIVE (no -i): git's `-c key=value` is
# a harmless config override while `-C path` changes directory, and a
# case-insensitive test cannot tell the two apart.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:]])(-C([[:space:]]|$)|--git-dir(=|[[:space:]]|$)|--work-tree(=|[[:space:]]|$))'; then
  echo "gate.sh: this commit redirects git to another repository (-C / --git-dir / --work-tree), but the quality checks only cover '$ROOT'. Run the commit from that repository's own working directory so its gate can verify it." >&2
  exit 2
fi

if [ ! -x "$PY" ]; then
  echo "gate.sh: $PY not found or not executable; cannot run quality checks." >&2
  exit 2
fi

POLICY="$ROOT/.claude/hooks/commit_gate_policy.py"
if [ ! -f "$POLICY" ]; then
  echo "gate.sh: $POLICY not found; cannot classify commit risk." >&2
  exit 2
fi

# Classify exactly what this commit writes.  A normal commit writes the index,
# so unrelated experiments in the worktree cannot turn a docs commit into a
# full suite.  `git commit -a/--all` stages tracked worktree changes during the
# commit itself, so use HEAD for that form.  Deletions stay in either input.
POLICY_DIFF_ARGS=(diff --cached --name-only --no-renames -z)
if printf '%s' "$CMD" | grep -qE '(^|[[:space:]])(-a|--all)([[:space:]]|$)'; then
  POLICY_DIFF_ARGS=(diff --name-only --no-renames -z HEAD)
fi
# ADR-0068 opt-in. The command is HANDED OVER; this script does not decide.
# Each shell matching the token itself is how the two platforms came to
# disagree (PowerShell's -like is case-insensitive, grep -F is not), and how a
# commit MESSAGE containing the token could switch the gate off.
if ! POLICY_JSON="$(cd "$ROOT" && git "${POLICY_DIFF_ARGS[@]}" | "$PY" "$POLICY" --command "$CMD")"; then
  echo "gate.sh: could not classify changed paths; refusing unchecked commit." >&2
  exit 2
fi
POLICY_TIER="$(printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["tier"])')"
if [ -z "$POLICY_TIER" ]; then
  echo "gate.sh: risk classifier returned no tier; refusing unchecked commit." >&2
  exit 2
fi
mapfile -t POLICY_PYTEST_TARGETS < <(
  printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys; print(*json.load(sys.stdin)["pytest_targets"], sep="\n")'
)

# --- run every configured quality check ------------------------------------
# Each check has a bounded timeout so a hung command cannot stall the commit.
# The per-check budget sums to 346s (15+15+300+8+8) and the hook cap in
# settings.json is 380s. That 34s of slack must cover the worst case where a
# hung check is only killed 10s after its own timeout (`--kill-after=10`), so
# this script always reaches its own `exit 2`. If the outer harness times the
# hook out first, the failure is reported as a NON-BLOCKING hook error and the
# commit proceeds unchecked -- a hung check must never fail open. Within that
# envelope a hung check is killed by ITS OWN timeout with a clear message,
# before the outer harness kills the whole hook ambiguously.
#
# The full suite runs in ~110-150s (2719 tests) because the repo-root
# conftest.py routes pytest's tmp tree onto tmpfs (/dev/shm) — without that it
# is ~39 min of fsync wait on the WSL2 disk and CANNOT gate a commit. The 300s
# pytest budget leaves headroom for suite growth. If the suite grows past
# ~270s, raise the pytest budget here AND the hook timeout in
# settings.json together (keep hook timeout ≥ budget-sum + 24s).
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
      run_check "pytest (full)" 300 "$PY" -m pytest
      ;;
    workspace|pytest-targeted|motv-server)
      run_check "pytest ($POLICY_TIER)" 120 "$PY" -m pytest "${POLICY_PYTEST_TARGETS[@]}"
      ;;
    frontend)
      run_check "frontend tests" 90 node --test "$ROOT"/mockups/motv-workspace/tests/*.test.mjs
      ;;
    lint)
      ;;
    continuous-chain)
      # ADR-0068: the whole-suite run is deferred to the end of an authorised
      # chain. Announced below, never silent.
      ;;
    chain-conflict)
      # ADR-0068 决策 6: the opt-in cannot ride along with a push/merge in the
      # same command. Decided in the policy module, like every other
      # command-derived verdict.
      FAIL_LABEL="continuous-chain"
      FAIL_OUT="$(printf '%s' "$POLICY_JSON" | "$PY" -c 'import json,sys; sys.stdout.buffer.write(json.load(sys.stdin)["reason"].encode("utf-8"))')"
      ;;
    *)
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
