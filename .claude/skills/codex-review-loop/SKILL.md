---
name: codex-review-loop
description: >-
  Run an automated read-only code review of the current diff and fix only the
  blocking findings: ONE round by default, plus one more round to re-review a P1
  fix (ADR-0081). INVOKE after finishing an implementation task whose change
  touches behavior, a contract, persistence, identity, registration, render or
  file operations, paid paths, concurrency, security, Windows portability, or
  more than one domain — i.e. once code has actually changed and the change is
  complete. The reviewer is codex when available, otherwise an independent
  claude session (fallback). DO NOT invoke for: purely presentational changes
  (CSS, layout, spacing, copy), documentation-only changes, answering questions,
  explaining code, or while an implementation is still in progress / incomplete.
  Judge by WHAT the change touches, never by how small or how obvious it is;
  when unsure whether a change needs review, review it.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(bash *), Bash(git diff *), Bash(git status *), PowerShell(powershell *), PowerShell(git diff *), PowerShell(git status *)
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

## Phase 0 — decide whether to review, then set the round budget

Do this BEFORE launching any review. There are **no risk tiers** (ADR-0081,
产品负责人 2026-08-22: 「不要保留风险分集」). Two questions only.

**1. Does this change need a review at all?** Judge by WHAT it touches, never by
diff size or how obvious the cause is:

| Change touches | Review |
| --- | --- |
| documentation only, or purely presentational surface (CSS, layout, spacing, copy) | **no — do not run this skill.** Targeted tests + ship. |
| behavior, contracts, persistence, schema/migration, identity, asset or generation registration, timeline, render/file operations, storage lifecycle, paid operations, concurrency/async state, security, Windows portability, cross-layer contract, or more than one domain | **yes** |

When you cannot tell, review it. "Obvious cause" and "small diff" describe how
fast the FIX is, not what it can break.

**2. Budget: ONE round by default.** Then:

- **P1 found → fix the P1s alone and spend ONE more round re-reviewing just
  that fix.** An outstanding P1 always buys the round it needs; a P1 can never
  dead-end the workflow.
- **A re-review that reports a NEW P1 buys its own round** (ADR-0081 §2a — not
  a hard ceiling of two). Stop after **one** clean round; never run another
  "just to be sure" after a pass. Two independent samples: TASK-098 found new
  P1s in rounds 2 AND 3 (one of them: an explicitly forbidden camera move still
  rendered), TASK-102 in rounds 3 AND 4 (one of them: the gate silently running
  one test domain too few). A two-round ceiling would have shipped all of them —
  they existed *because* the first fix was incomplete, which is the single most
  common case.
- **But a narrower variant of an already-fixed / already-rebutted / already-
  recorded finding is NOT a new P1** (§2b). When the same theme keeps returning
  in narrower spellings, make the scope call and record it — do not buy another
  round. That is the other half of the 13-round / 10-round disease (TASK-097
  §2.5d spent six rounds on SSRF spellings: scheme → decimal/hex/octal →
  dotted-hex → trailing root dot → CGNAT).
- **"Same theme" is judged by FAILURE MECHANISM, never by code location**
  (§2c). TASK-098's round-2 and round-3 P1s sat in the same endpoint fewer than
  30 lines apart yet were different mechanisms (a missing duration bound vs a
  geometry distortion) — merging them by location would have shipped the
  distortion. The converse holds too: one theme can span files.
- **When you cannot tell, buy the round** (§2d). The asymmetry: mis-judging a
  finding as "a variant" costs **a shipped P1**; mis-judging it as "new" costs
  **one round**. §2b applies only when you can already articulate the shared
  mechanism.
- **P2 found → fix them, run the owning test domain, close.** Do NOT open
  another round for P2s: a reviewer can always find a narrower P2 variant, so
  P2-triggered re-review does not converge (TASK-061 spent 13 rounds, TASK-062
  spent 10 — and round B4 reverted round A4's fix, a net negative).
- **P3/P4 → record as Follow-up.** They never block delivery.

Going beyond this protocol requires an explicit, stated choice
(ship / fix P1 only / escalate) — never a silent extra round.

The budget counts **review rounds**, not findings. Reaching it is a normal,
expected outcome — not a failure.

## Phase 1 — review loop (bounded by the Phase 0 round budget)

For each round:

1. Run the review script from the repo root, ALWAYS as a background task, and
   ALWAYS with `REVIEW_TASK=<task id>` (e.g. `TASK-026`; use the branch or
   feature name when there is no task card) so every status-log line names the
   task under review.

   Pick the script for the host you are running on (ADR-0050 — both have the
   same contract; never run the `.sh` one on Windows, its `.venv/bin/python`
   path does not exist there):

   - Ubuntu/WSL2 — Bash tool, `run_in_background: true`:
     - uncommitted changes: `REVIEW_TASK=TASK-0XX bash .claude/skills/codex-review-loop/scripts/run-review.sh`
     - branch vs a base: `REVIEW_TASK=TASK-0XX bash .claude/skills/codex-review-loop/scripts/run-review.sh <base-branch>`
   - Native Windows — PowerShell tool, `run_in_background: true`:
     - uncommitted changes: `$env:REVIEW_TASK='TASK-0XX'; powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/codex-review-loop/scripts/run-review.ps1`
     - branch vs a base: `$env:REVIEW_TASK='TASK-0XX'; powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/codex-review-loop/scripts/run-review.ps1 <base-branch>`

     On Windows, `codex` and `claude` are often installed per-user and NOT on
     `PATH`. If the script reports `ENV_ERROR: neither codex nor claude is
     installed`, point it at the executables directly with
     `$env:REVIEW_CODEX_BIN` / `$env:REVIEW_CLAUDE_BIN` before launching.

   Background is mandatory, not optional: a real review takes 6–10+ minutes
   per reviewer, while a foreground Bash/PowerShell call is capped at 600 s —
   running it in the foreground WILL produce a "Command timed out" tool error
   that looks like an API failure. Do not poll while waiting; do other pending work or
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

4. Act on the grades — **only P1 buys another round**:
   - **P1 present** → fix (minimally — see Ironclad rules). If the round budget
     still has a round left, run the next round to re-review. If not, see
     budget exhaustion below.
   - **P2 present, no P1** → fix the P2s minimally, run the **owning test
     domain** (ADR-0080), and go to Phase 2. Do **NOT** spend a round
     re-reviewing a P2 fix (ADR-0081 — the tier-dependent exception is gone).
     Note the fixes in the report as reviewed-once.
   - **Only P3/P4** → do not fix anything; record them as follow-ups; go to
     Phase 2.

   Rationale: re-reviewing every P2 is what turned TASK-061 into 13 rounds and
   TASK-062 into 10 rounds, including a round-B4 revert of a round-A4 fix. A
   reviewer can always find a narrower P2 variant, so P2-triggered re-review
   does not converge. P1 (correctness / bug / security) is the only severity
   worth the cost of another full round.

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

The loop is bounded by **both** the Phase 0 round budget and by progress.
Whichever binds first, stops it:

a. A finding is a false positive or does not apply → do NOT fix it; record the
   rebuttal (why it is wrong/inapplicable) and continue grading the rest.
b. **No progress**: this round surfaced no new fixable P1 — every finding
   is one already fixed, already rebutted, or previously recorded as P2/P3/P4
   at the same severity → the loop is spinning; do NOT fix again; stop and
   report the unresolved findings honestly. (A previously recorded
   non-blocking finding that the reviewer NEWLY escalates to P1 counts as new
   — grade it fresh.)
c. The reviewer becomes unavailable mid-loop (quota exhausted with no
   fallback, ENV_ERROR) → stop and report which fixes remain unreviewed.
d. **Budget exhausted** — the Phase 0 round budget is spent. Do NOT silently
   start another round. Choose exactly one and state it in the report:
   - **ship** — no P1 outstanding → done, with any P2/P3/P4 recorded as
     follow-ups.
   - **fix P1 only** — a P1 is outstanding → fix the P1s (nothing else) and
     spend ONE extra round re-reviewing just that fix. Hard ceiling:
     **default round + 1 = 2 rounds** (ADR-0081). An outstanding P1 always buys
     the round it needs — the budget bounds polishing, never the closing of a
     real defect.
   - **escalate** — a P1 is outstanding and the fix would exceed the task's
     scope, or the same P1 theme survived the extra round → stop, do not
     widen scope, and report it to the user as a blocking finding with a
     follow-up task.

**`VERDICT: pass` is not the release gate.** The gate is: user acceptance
criteria satisfied + relevant tests pass + no outstanding P1. Chasing a
zero-findings verdict past the budget is explicitly out of policy.

An unreviewed **P1 fix** must never be the loop's final state. An unreviewed
P2 fix, covered by targeted tests, is an accepted outcome.

## Status journal (user-visible progress)

The script logs its own lifecycle to `.claude/tmp/review-status.log`; the user
watches that file to tell normal slow progress from a failure. The controller
MUST add its loop-level events to the same file, one line each, and every
line MUST carry the same task id passed as `REVIEW_TASK` — the log is useless
to the user if it does not say which task the work belongs to. Format:

- Ubuntu/WSL2:
  `bash -c "echo \"[$(date '+%F %T')] [TASK-0XX] <message>\" >> .claude/tmp/review-status.log"`
- Native Windows:
  `Add-Content -Encoding utf8 .claude/tmp/review-status.log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [TASK-0XX] <message>"`

- when a round starts: `round N launched`
- after grading: `round N verdict=<pass|fail>: X P1, X P2, X P3, X P4`
- before each fix: `fixing P1 <file:line> — <short title>`
- on any early exit: the reason (no progress / false positive / reviewer unavailable / env)
- when Phase 2 finishes: `done — report written to .claude/tmp/last-review.md`

Keep each line short; this journal is for the user, not a data store.

For a LONG background run (test suite, review), launch it with a heartbeat so
the journal shows liveness instead of a silent gap — wrap the command like:

Ubuntu/WSL2:

```
( while sleep 300; do echo "[$(date '+%F %T')] [TASK-0XX] <step> still running…" \
    >> .claude/tmp/review-status.log; done ) & HB=$!
<long command>; RC=$?
kill "$HB" 2>/dev/null
echo "[$(date '+%F %T')] [TASK-0XX] <step> finished (exit $RC)" >> .claude/tmp/review-status.log
exit $RC
```

Native Windows (`&&`/`||` do not exist in PowerShell 5.1; use `;`):

```
$log = '.claude/tmp/review-status.log'
$hb = Start-Job { while ($true) { Start-Sleep 300
    Add-Content -Encoding utf8 $using:log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [TASK-0XX] <step> still running..." } }
<long command>; $rc = $LASTEXITCODE
Stop-Job $hb; Remove-Job $hb
Add-Content -Encoding utf8 $log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [TASK-0XX] <step> finished (exit $rc)"
exit $rc
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
