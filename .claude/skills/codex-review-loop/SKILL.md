---
name: codex-review-loop
description: >-
  Run an automated read-only code review of the current diff and fix only the
  blocking findings. INVOKE after finishing any implementation task (feat, fix,
  refactor, perf, etc.) — i.e. once code has actually changed and the change is
  complete. The reviewer is codex when available, otherwise an independent
  claude session (fallback). DO NOT invoke for: answering questions, explaining
  code, pure documentation-only changes, or while an implementation is still in
  progress / incomplete.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(bash *), Bash(git diff *), Bash(git status *)
---

# codex-review-loop

Controller for an implement → review → fix loop. It calls
`scripts/run-review.sh`, grades the findings, fixes only what must be fixed, and
writes a report. It NEVER commits.

The review script picks the reviewer automatically: **codex first** (independent
cross-model review); if codex is unavailable for any reason (not installed, not
authenticated, quota exhausted, rate limited, no verdict produced) it **falls
back to an independent `claude -p` session**. Fallback loses cross-model
independence — when the report shows a `claude (fallback…)` reviewer, record
that independence was degraded.

## Phase 1 — review loop (until pass; no fixed round cap)

For each round:

1. Run the review script from the repo root, ALWAYS as a background task
   (Bash tool with `run_in_background: true`), and ALWAYS with
   `REVIEW_TASK=<task id>` (e.g. `TASK-026`; use the branch or feature name
   when there is no task card) so every status-log line names the task under
   review:
   - uncommitted changes: `REVIEW_TASK=TASK-0XX bash .claude/skills/codex-review-loop/scripts/run-review.sh`
   - branch vs a base: `REVIEW_TASK=TASK-0XX bash .claude/skills/codex-review-loop/scripts/run-review.sh <base-branch>`

   Background is mandatory, not optional: a real review takes 6–10+ minutes
   per reviewer, while a foreground Bash call is capped at 600 s — running it
   in the foreground WILL produce a "Command timed out" tool error that looks
   like an API failure. Do not poll while waiting; do other pending work or
   simply wait for the task-completion notification.

   The script also mirrors its full output to
   `.claude/tmp/last-review-output.txt`. If the session is interrupted while
   waiting (e.g. an "API Error: Response stalled mid-stream" in this session),
   do NOT relaunch the review — first read that file; if it already ends with
   a verdict, use it and continue the loop from there.

2. Read the script output and branch on it:
   - The Bash task itself failed or was killed (tool error, no script output
     at all) → this is an environment problem, NOT a review verdict. Check
     `.claude/tmp/last-review-output.txt` for a completed verdict first;
     otherwise retry the background launch ONCE. If it fails again, stop and
     go to Phase 2 reporting the tool error verbatim.
   - Output begins with `ENV_ERROR`, `NO_CHANGES`, or `DIFF_TOO_LARGE` →
     **change no code**. Stop the loop and go to Phase 2, reporting the message
     verbatim. For `DIFF_TOO_LARGE`, also relay its guidance (narrow the scope
     or raise `REVIEW_MAX_DIFF_LINES`) — do NOT try to review it another way.
   - No parseable `VERDICT:` line in the output → treat as `fail`, copy the
     **entire raw output** into the report, and never guess what the reviewer
     meant.
   - `VERDICT: pass` → stop the loop (success) and go to Phase 2.
   - `VERDICT: fail` → grade every finding (below), then decide whether to fix.

3. Grade each finding:
   - **P1** — correctness / bug / security → MUST fix.
   - **P2** — regression / edge case → SHOULD fix.
   - **P3** — suggested improvement → do NOT fix, record only.
   - **P4** — nitpick → do NOT fix, record only.

4. Act on the grades:
   - Any P1 or P2 present → fix them (minimally — see Ironclad rules), then run
     the next round to re-review.
   - Only P3/P4 present → do not fix anything; go to Phase 2.

### Converge fast — do NOT let the loop turn into round-by-round whack-a-mole

Extra rounds are expensive (each re-review is minutes + reviewer quota). Two
habits cut the round count hard; apply both every round:

- **Fix the whole CLASS, not the one instance.** When a finding points at a
  general problem class, fix the class in this round, not just the exact line
  cited. If the reviewer flags a symlink race on the write path, also close it
  on the read path and harden the whole file-open (non-regular files, hard
  links, TOCTOU) in the SAME round — do not wait for the reviewer to report
  each variant in a later round. Ask "what is the general defect here, and
  where else does it live in this diff?" and fix all of it at once. Classic
  classes: unsafe file open (symlink / FIFO / hard-link / dir-fd containment),
  bool-as-int / unhashable-value type checks, mutable-reference capture,
  fail-closed error wrapping, short-write / partial-IO loops.
- **Make the threat-model / scope call EARLY, not at round 9.** Before fixing,
  ask whether the finding is in scope for THIS component's real threat model
  and consistent with existing project convention (e.g. is this a local
  single-user tool? do sibling modules like `qcd/log.py` already accept this
  pattern?). If a finding requires an attacker who already has the access that
  would make the whole system moot, or if fixing only here while identical
  exposure lives across the codebase gives no net benefit, that is an
  out-of-scope rebuttal (hard-stop a) — record it and a shared-fix follow-up,
  do NOT chase progressively narrower variants of it across many rounds. Make
  this judgment the first time the theme appears, not after several rounds.

### Hard stop conditions (hit any one → stop immediately, state why)

The loop runs **until the verdict is pass** (or only P3/P4 remain). There is
NO fixed round cap — an unreviewed fix must never be the loop's final state.
What bounds the loop instead is **progress**:

a. A finding is a false positive or does not apply → do NOT fix it; record the
   rebuttal (why it is wrong/inapplicable) and continue grading the rest.
b. **No progress**: this round surfaced no new fixable P1/P2 — every finding
   is one already fixed, already rebutted, or previously recorded as P3/P4 at
   the same severity → the loop is spinning; do NOT fix again; stop and
   report the unresolved findings honestly. (A previously recorded
   non-blocking finding that the reviewer NEWLY escalates to blocking counts
   as new — grade it fresh.)
c. The reviewer becomes unavailable mid-loop (quota exhausted with no
   fallback, ENV_ERROR) → stop and report which fixes remain unreviewed.

Every continuing round must therefore fix at least one new P1/P2 — the loop
always terminates, bounded by real progress rather than an arbitrary count.

## Status journal (user-visible progress)

The script logs its own lifecycle to `.claude/tmp/review-status.log`; the user
watches that file to tell normal slow progress from a failure. The controller
MUST add its loop-level events to the same file, one line each, and every
line MUST carry the same task id passed as `REVIEW_TASK` — the log is useless
to the user if it does not say which task the work belongs to. Format:
`bash -c "echo \"[$(date '+%F %T')] [TASK-0XX] <message>\" >> .claude/tmp/review-status.log"`:

- when a round starts: `round N launched`
- after grading: `round N verdict=<pass|fail>: X P1, X P2, X P3, X P4`
- before each fix: `fixing P1 <file:line> — <short title>`
- on any early exit: the reason (no progress / false positive / reviewer unavailable / env)
- when Phase 2 finishes: `done — report written to .claude/tmp/last-review.md`

Keep each line short; this journal is for the user, not a data store.

For a LONG background run (test suite, review), launch it with a heartbeat so
the journal shows liveness instead of a silent gap — wrap the command like:

```
( while sleep 300; do echo "[$(date '+%F %T')] [TASK-0XX] <step> still running…" \
    >> .claude/tmp/review-status.log; done ) & HB=$!
<long command>; RC=$?
kill "$HB" 2>/dev/null
echo "[$(date '+%F %T')] [TASK-0XX] <step> finished (exit $RC)" >> .claude/tmp/review-status.log
exit $RC
```

## Phase 2 — report

Print a summary AND overwrite `.claude/tmp/last-review.md` with it. The report
must contain:

- number of iterations run
- final verdict (pass / fail / ENV_ERROR / NO_CHANGES)
- which reviewer produced the final verdict, and whether independence was
  degraded (claude fallback)
- P1/P2 findings that were fixed (with file:line)
- P3/P4 findings recorded but not fixed
- any early-exit reason (false positive, no progress, reviewer unavailable, ENV/NO_CHANGES)

## Ironclad rules

- Inside the loop, fix **only P1 and P2**. Never fix P3/P4.
- Never run `git commit` or `git push` at any point. Leave all changes
  uncommitted for the user to review.
- Never end the loop with a fixed-but-unreviewed P1/P2 while the reviewer is
  still available — a fix only counts as done after a re-review round sees it.
- Fixes must be **minimal**: touch only the code the finding points at. Do not
  refactor, tidy, rename, or change anything nearby "while you are there".
- If the reviewer proposes architecture/refactor changes, ignore them — those
  are out of scope and decided by ADRs, not by this loop.

## Token frugality

The review call ships the whole diff to a model (and on the claude fallback it
spends the user's quota), so keep every round cheap:

- **Stop as early as the rules allow.** Do not run "one more round to be sure"
  after a pass, after only P3/P4 remain, or after a hard-stop condition fires.
- **Re-run the script only after an actual P1/P2 fix.** Never re-review an
  unchanged diff.
- **Fix from the finding alone.** Open only the file:line each finding names;
  do not re-read files already in context or explore unrelated code.
- **Keep the report compact.** Record findings as one line each; never paste the
  diff or full file contents into `.claude/tmp/last-review.md`.
- **Respect the size guard.** On `DIFF_TOO_LARGE`, narrow scope rather than
  splitting the diff into many smaller review calls.
