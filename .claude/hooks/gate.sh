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
if ! printf '%s' "$CMD" | grep -qE '(^|[^[:alnum:]_-])git[[:space:]]+commit([[:space:]]|$)'; then
  exit 0
fi

if [ ! -x "$PY" ]; then
  echo "gate.sh: $PY not found or not executable; cannot run quality checks." >&2
  exit 2
fi

# --- run every configured quality check ------------------------------------
# Each check has a bounded timeout so a hung command cannot stall the commit.
# The per-check budget sums to <170s (15+15+120+8+8 = 166s) so it stays inside
# the PreToolUse hook cap (settings.json timeout=170s): a genuinely hung check
# is killed by ITS OWN timeout with a clear message, before the outer harness
# kills the whole hook ambiguously.
#
# The full suite runs in ~110-150s (2719 tests) because the repo-root
# conftest.py routes pytest's tmp tree onto tmpfs (/dev/shm) — without that it
# is ~39 min of fsync wait on the WSL2 disk and CANNOT gate a commit. The 220s
# pytest budget leaves ~47% headroom for CPU contention and growth. If the
# suite grows past ~200s, raise the pytest budget here AND the hook timeout in
# settings.json together (keep hook timeout ≈ budget-sum + 4s).
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
# 3. pytest
# 4. git diff --check          (whitespace / conflict markers in working tree)
# 5. git diff --cached --check (whitespace / conflict markers in staged content)
run_check "ruff format --check"   15 "$PY" -m ruff format --check . \
  && run_check "ruff check"         15 "$PY" -m ruff check . \
  && run_check "pytest"            220 "$PY" -m pytest \
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

exit 0
