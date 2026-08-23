#!/usr/bin/env bash
#
# run-review.sh — hand the current diff to a read-only reviewer and print a
# structured verdict. Single responsibility: produce ONE review report.
#
# Reviewer selection:
#   1. codex  — preferred, cross-model independent reviewer.
#   2. claude — automatic fallback when codex is unavailable for ANY reason
#               (not installed / not authenticated / quota exhausted / rate
#               limited / subcommand missing / no VERDICT produced).
#
# Environment problems (no codex AND no claude, not a git repo, no changes)
# are reported on stdout and ALWAYS exit 0 — never a non-zero code — so the
# caller cannot mistake an environment issue for a code problem.
#
# Usage:
#   run-review.sh                # review uncommitted changes (staged+unstaged)
#   run-review.sh <base-branch>  # review current branch vs <base-branch>
#
set -euo pipefail

BASE="${1:-}"

# --- token-saving knobs (override via env) ----------------------------------
# Fewer context lines and a hard size cap keep the number of tokens shipped to
# the reviewer (and, on the claude fallback, your quota) bounded.
CTX="${REVIEW_DIFF_CONTEXT:-1}"              # unified context lines (default 1, vs git's 3)
MAX_LINES="${REVIEW_MAX_DIFF_LINES:-4000}"   # refuse to review a diff larger than this
# Hard wall-clock cap on EACH reviewer invocation so a hung/stalled reviewer can
# never block for hours. On timeout the reviewer is treated as failed (codex ->
# falls back to claude; claude -> ENV_ERROR). Override via REVIEW_TIMEOUT (secs).
# NOTE: a real review of a 1-2k line diff takes 6-10 minutes on either reviewer
# (measured 2026-08-02: codex rollouts killed at 7m43s/8m11s still mid-reasoning,
# claude fallback >5m). 300s killed healthy reviews and was misread as an API
# error, so the default is 900s. This script MUST therefore be launched as a
# background task (see SKILL.md), never in a foreground Bash call (600s cap).
# 1800s: reviews measure 6-10 min; a premature kill wastes the whole review
# AND burns a claude-fallback run, while a hung reviewer (rare) merely waits
# longer in the background. The asymmetry favours a generous cap.
REVIEW_TIMEOUT="${REVIEW_TIMEOUT:-1800}"
# Paths whose diffs are noise for a correctness/security review — kept out of
# the diff so they never cost tokens. Extend via REVIEW_EXTRA_EXCLUDES (space
# separated pathspecs).
EXCLUDES=(
  ':(exclude).claude/tmp/**'
  ':(exclude)**/*.lock'
  ':(exclude)**/package-lock.json'
  ':(exclude)**/*.min.js'
)
# shellcheck disable=SC2206
[ -n "${REVIEW_EXTRA_EXCLUDES:-}" ] && EXCLUDES+=(${REVIEW_EXTRA_EXCLUDES})

# --- temp files -------------------------------------------------------------
ERRFILE="$(mktemp)"
# The untracked-file list needs a FILE, not a variable: `git ls-files -z`
# separates paths with NUL, and bash command substitution silently discards NUL
# bytes ("ignored null byte in input"), which would fuse several paths into one
# unopenable name and drop every one of them from the review.
LISTFILE="$(mktemp)"

# --- persist all output ------------------------------------------------------
# Mirror everything printed to a file so the verdict survives even if the
# calling session is interrupted (e.g. an API/stream error) while waiting.
OUT_FILE="${REVIEW_OUT_FILE:-.claude/tmp/last-review-output.txt}"
TEE_PID=""
if mkdir -p "$(dirname "$OUT_FILE")" 2>/dev/null; then
  exec > >(tee "$OUT_FILE")
  TEE_PID=$!
fi

cleanup() {
  rm -f "$ERRFILE" "$LISTFILE"
  # Close stdout and wait for tee so the last line (often the VERDICT) is
  # fully flushed to $OUT_FILE before the script exits.
  if [ -n "$TEE_PID" ]; then
    exec 1>&2
    wait "$TEE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- live status journal -----------------------------------------------------
# One timestamped line per lifecycle event, appended to a log the user can
# follow live (`tail -f .claude/tmp/review-status.log`) to tell a slow-but-
# healthy review apart from a dead one. Never fails the script.
STATUS_FILE="${REVIEW_STATUS_FILE:-.claude/tmp/review-status.log}"
# Optional task label (e.g. REVIEW_TASK=TASK-026) prefixed to every status
# line so the log says WHICH task each review run belongs to.
REVIEW_TASK="${REVIEW_TASK:-}"
status() {
  if [ -n "$REVIEW_TASK" ]; then
    printf '[%s] [%s] %s\n' "$(date '+%F %T')" "$REVIEW_TASK" "$*" \
      >>"$STATUS_FILE" 2>/dev/null || true
  else
    printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$STATUS_FILE" 2>/dev/null || true
  fi
}

# --- environment: git repo --------------------------------------------------
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  status "ENV_ERROR: not inside a git repository"
  echo "ENV_ERROR: not inside a git repository; nothing to review."
  exit 0
fi

# --- compute the diff -------------------------------------------------------
DIFF=""

# Append `git "$@"` output to $DIFF, failing CLOSED. A failed git here returns
# empty output, which would silently degrade into "NO_CHANGES" or a review of a
# partial diff -- i.e. a clean bill of health for code nobody looked at.
#
# Both helpers run in the CURRENT shell and append to $DIFF rather than echoing
# into a command substitution: inside `$(...)` an `exit 0` would only end the
# subshell, and the caller would carry on with an empty diff -- reintroducing
# the very failure this guards against.
#
# Every append goes through append_chunk, which restores the trailing newline
# that `$(...)` strips. Without it the last line of one chunk and the first line
# of the next are glued into one bogus line ("+X = 1diff --git a/...") and the
# reviewer receives a malformed diff.
append_chunk() {
  [ -n "$1" ] || return 0
  DIFF="${DIFF}${1}
"
}

append_diff() {
  local out rc
  set +e
  out="$(git "$@" 2>"$ERRFILE")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    status "ENV_ERROR: 'git $*' failed (exit $rc)"
    echo "ENV_ERROR: 'git $*' failed (exit $rc); refusing to review a diff that may be incomplete. $(tr '\n' ' ' <"$ERRFILE" | cut -c1-200)"
    exit 0
  fi
  append_chunk "$out"
}

# Untracked (never-tracked) files are invisible to `git diff HEAD`, so a freshly
# implemented module would silently escape review. Emit each one as an
# added-file diff via --no-index. Respects .gitignore and the same EXCLUDES.
append_untracked_diff() {
  local f out rc
  # -z: NUL-separated and never C-quoted. Without it git quotes any path with
  # non-ASCII or special characters, which then fails the -f test and drops a
  # brand-new source file out of the review silently. The list goes to a FILE
  # because command substitution would eat the NUL separators (see $LISTFILE).
  set +e
  git ls-files -z --others --exclude-standard -- . "${EXCLUDES[@]}" \
    >"$LISTFILE" 2>"$ERRFILE"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    status "ENV_ERROR: 'git ls-files' failed (exit $rc)"
    echo "ENV_ERROR: 'git ls-files' failed (exit $rc); refusing to review a diff that may omit untracked files. $(tr '\n' ' ' <"$ERRFILE" | cut -c1-200)"
    exit 0
  fi
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue                          # skip dirs/sockets
    if [ -s "$f" ]; then
      # `grep -Iq` answers non-zero for BINARY *and* for UNREADABLE, so on its
      # own it skipped a locked/permission-denied source file as if it were
      # binary -- the round then came back `pass` without that file ever being
      # reviewed (TASK-052 §2.4). Separate the two: unreadable is an ENV_ERROR,
      # only genuinely binary is skipped. Same verdict as the .ps1 variant
      # (ADR-0050 决策 1).
      if ! head -c 1 -- "$f" >/dev/null 2>&1; then
        status "ENV_ERROR: cannot read untracked '$f'"
        echo "ENV_ERROR: cannot read untracked file '$f'; refusing to review a diff that would silently omit it."
        exit 0
      fi
      if ! grep -Iq '' "$f" 2>/dev/null; then
        # grep answered non-zero. That means BINARY only if the file is still
        # readable -- a failure that appeared after the probe above (file
        # replaced, ACL revoked, I/O error) would otherwise be skipped just
        # like binary, which is the very hole this section closes
        # (codex review round 2).
        # Read the WHOLE file, not just its first byte: `grep -Iq` reads to the
        # end, so the failure it reported may have happened anywhere in the
        # file. A one-byte probe would still call that "binary" and skip it
        # (codex review round 3).
        if ! cat -- "$f" >/dev/null 2>&1; then
          status "ENV_ERROR: cannot read untracked '$f'"
          echo "ENV_ERROR: cannot read untracked file '$f'; refusing to review a diff that would silently omit it."
          exit 0
        fi
        continue                                     # non-empty binary -> skip
      fi
    fi
    set +e
    out="$(git diff -U"$CTX" --no-index -- /dev/null "$f" 2>"$ERRFILE")"
    rc=$?
    set -e
    # exit 1 means "the files differ", the normal case here. Anything above
    # that is a real failure, and dropping the file would remove a brand-new
    # module from the review unnoticed.
    if [ "$rc" -gt 1 ]; then
      status "ENV_ERROR: diffing untracked '$f' failed (exit $rc)"
      echo "ENV_ERROR: diffing untracked file '$f' failed (exit $rc); refusing to review a diff that would silently omit it."
      exit 0
    fi
    append_chunk "$out"
  done <"$LISTFILE"
}

if [ -n "$BASE" ]; then
  if ! git rev-parse --verify -q "$BASE" >/dev/null 2>&1; then
    status "ENV_ERROR: base ref '$BASE' not found"
    echo "ENV_ERROR: base ref '$BASE' not found; cannot compute diff."
    exit 0
  fi
  # Changes introduced on HEAD since it diverged from BASE, plus untracked
  # working-tree files (they are part of the work under review either way).
  append_diff diff -U"$CTX" "$BASE"...HEAD -- . "${EXCLUDES[@]}"
  append_untracked_diff
else
  # Uncommitted changes vs HEAD: staged + unstaged + untracked.
  if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
    append_diff diff -U"$CTX" HEAD -- . "${EXCLUDES[@]}"
  else
    # No prior snapshot yet: combine unstaged, staged, and untracked.
    append_diff diff -U"$CTX" -- . "${EXCLUDES[@]}"
    append_diff diff -U"$CTX" --cached -- . "${EXCLUDES[@]}"
  fi
  append_untracked_diff
fi

if [ -z "${DIFF//[[:space:]]/}" ]; then
  status "NO_CHANGES: nothing to review"
  echo "NO_CHANGES: no diff to review (working tree clean or base is up to date)."
  exit 0
fi

# Token guard: refuse an oversized diff instead of burning tokens on it.
DIFF_LINES="$(printf '%s\n' "$DIFF" | wc -l | tr -d ' ')"
if [ "$DIFF_LINES" -gt "$MAX_LINES" ]; then
  status "DIFF_TOO_LARGE: ${DIFF_LINES} lines > ${MAX_LINES}"
  echo "DIFF_TOO_LARGE: diff is ${DIFF_LINES} lines (> ${MAX_LINES}); refusing to send it to the reviewer to save tokens."
  echo "Narrow scope: commit/stage a smaller subset, review a base branch (run-review.sh <base>), or raise REVIEW_MAX_DIFF_LINES."
  exit 0
fi

# --- build the review prompt (identical for both reviewers) -----------------
read -r -d '' INSTRUCTIONS <<'PROMPT_EOF' || true
You are a strict, read-only code reviewer. Review ONLY the unified diff given
below. Do not modify any files.

Review through EXACTLY these four lenses and nothing else:
  1. correctness / bug risk
  2. regression risk
  3. edge cases
  4. security

Rules:
- Every issue MUST cite a file path and line number, and explain WHY it is a
  problem (what breaks, under what input/condition).
- Mark anything you are not sure about with the literal tag (uncertain).
- DO NOT propose architecture changes or refactors of any kind. Architecture is
  decided by ADRs, not by this review. Such suggestions are out of scope and
  forbidden — they prevent the fix loop from ever converging.
- DO NOT report style nitpicks unless the style directly causes a bug.
- If you find no blocking issues, say so with VERDICT: pass.
- Be terse to save tokens: ONE line per finding, no preamble, no summary, and
  do NOT restate or quote the diff back.

Output STRICTLY in the following format, with NO extra text before or after it:

VERDICT: pass|fail
BLOCKING:
- [file:line] description -> impact
NON_BLOCKING:
- [file:line] description -> impact

If a section has no items, keep the header and write "- (none)" under it.

Here is the unified diff to review:
PROMPT_EOF

PROMPT="${INSTRUCTIONS}
${DIFF}"

# --- reviewer helpers -------------------------------------------------------
# A completed review is one that states a decision, anchored to line start so a
# quoted mention inside prose cannot satisfy it.
# The trailing check is whitespace-or-end, NOT "any non-alphanumeric": the
# latter accepts the literal template line 'VERDICT: pass|fail' (the '|' passes
# it), so an echoed or truncated prompt would count as a finished review.
VERDICT_PATTERN='^[[:space:]]*VERDICT:[[:space:]]*(pass|fail)([[:space:]]|$)'
have_codex=0
have_claude=0
command -v codex  >/dev/null 2>&1 && have_codex=1
command -v claude >/dev/null 2>&1 && have_claude=1

# Run codex; on success echoes its output and returns 0. Any failure returns 1
# and leaves a short reason in $ERRFILE.
run_codex() {
  local out rc
  set +e
  # Feed the prompt via stdin (`-`), not argv: a large argv prompt makes codex
  # 0.146 wait on / mis-handle stdin and fail with "Reading additional input
  # from stdin...". Piping the prompt in and closing it is the robust path.
  out="$(printf '%s' "$PROMPT" | timeout --kill-after=10 "$REVIEW_TIMEOUT" codex exec --sandbox read-only - 2>"$ERRFILE")"
  rc=$?
  set -e
  if [ "$rc" -eq 124 ]; then
    echo "codex timed out after ${REVIEW_TIMEOUT}s" >>"$ERRFILE"
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    return 1
  fi
  # A DECISION is required, not merely the word VERDICT: a refusal or a
  # truncated answer that echoes the template ("VERDICT: unknown") must count
  # as a failed review and fall through, never be reported as a completed one.
  if ! printf '%s' "$out" | grep -qE "$VERDICT_PATTERN"; then
    echo "codex produced no 'VERDICT: pass|fail' line" >>"$ERRFILE"
    return 1
  fi
  printf '%s\n' "$out"
  return 0
}

# Run claude in headless mode as the fallback reviewer. The diff is embedded in
# the prompt, so no repository tools and no permission prompts are needed.
run_claude() {
  local out rc
  set +e
  out="$(printf '%s' "$PROMPT" | timeout --kill-after=10 "$REVIEW_TIMEOUT" claude -p 2>>"$ERRFILE")"
  rc=$?
  set -e
  if [ "$rc" -eq 124 ]; then
    echo "claude timed out after ${REVIEW_TIMEOUT}s" >>"$ERRFILE"
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    return 1
  fi
  if ! printf '%s' "$out" | grep -qE "$VERDICT_PATTERN"; then
    echo "claude produced no 'VERDICT: pass|fail' line" >>"$ERRFILE"
    return 1
  fi
  printf '%s\n' "$out"
  return 0
}

# --- reviewer selection: codex first, claude fallback -----------------------
status "review started: ${DIFF_LINES}-line diff (${BASE:-uncommitted}); per-reviewer cap ${REVIEW_TIMEOUT}s"

verdict_of() { printf '%s' "$1" | grep -m1 -E "$VERDICT_PATTERN" || echo 'VERDICT: (none)'; }

if [ "$have_codex" -eq 1 ]; then
  status "codex reviewing… (normal duration 6-10 min; this is NOT hung)"
  if OUT="$(run_codex)"; then
    status "codex done: $(verdict_of "$OUT")"
    echo "REVIEWER: codex"
    printf '%s\n' "$OUT"
    exit 0
  fi
  REASON="$(tr '\n' ' ' <"$ERRFILE" | sed 's/  */ /g' | cut -c1-300)"
  [ -z "${REASON// /}" ] && REASON="codex unavailable or failed"
  if [ "$have_claude" -eq 1 ]; then
    status "codex failed (${REASON}); falling back to claude"
    if OUT="$(run_claude)"; then
      status "claude (fallback) done: $(verdict_of "$OUT")"
      echo "REVIEWER: claude (fallback; codex unavailable: ${REASON})"
      echo "INDEPENDENCE: degraded — reviewer and implementer are the same model."
      printf '%s\n' "$OUT"
      exit 0
    fi
    status "ENV_ERROR: both reviewers failed"
    echo "ENV_ERROR: codex failed (${REASON}) and claude fallback also failed: $(tr '\n' ' ' <"$ERRFILE" | cut -c1-300)"
    exit 0
  fi
  status "ENV_ERROR: codex failed and no claude fallback"
  echo "ENV_ERROR: codex unavailable (${REASON}) and claude fallback is not installed."
  exit 0
fi

# codex not installed at all -> go straight to claude fallback.
if [ "$have_claude" -eq 1 ]; then
  status "codex not installed; claude (fallback) reviewing… (normal duration 5-10 min)"
  if OUT="$(run_claude)"; then
    status "claude (fallback) done: $(verdict_of "$OUT")"
    echo "REVIEWER: claude (fallback; codex not installed)"
    echo "INDEPENDENCE: degraded — reviewer and implementer are the same model."
    printf '%s\n' "$OUT"
    exit 0
  fi
  status "ENV_ERROR: claude fallback failed (codex not installed)"
  echo "ENV_ERROR: codex not installed and claude fallback failed: $(tr '\n' ' ' <"$ERRFILE" | cut -c1-300)"
  exit 0
fi

status "ENV_ERROR: no reviewer installed"
echo "ENV_ERROR: neither codex nor claude is installed; cannot run a review."
exit 0
