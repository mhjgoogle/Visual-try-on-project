# ADR-0050: PowerShell-Native AI-Agent Dev Tooling on Windows

- Status: Accepted
- Date: 2026-08-10
- Scope: The AI-agent development harness only — the PreToolUse commit gate
  (`.claude/hooks/gate.sh`) and the `codex-review-loop` review script
  (`.claude/skills/codex-review-loop/scripts/run-review.sh`). Supersedes
  [ADR-0049](ADR-0049-native-windows-run-and-test-target.md) "Not Decided Here"
  item 1 and its matching Consequences bullet; extends the `AGENTS.md` rule 4
  carve-out. Product/pipeline code is **not** in scope and is unchanged.

## Context

[ADR-0049](ADR-0049-native-windows-run-and-test-target.md) made native Windows
a supported run+test target for the product, but deliberately left the bash
agent tooling Ubuntu-only ("they stay bash/coreutils-only"). That assumed the
agent itself keeps running on Ubuntu.

That assumption no longer holds: Claude Code now runs on the native Windows
host against this repo, and there the bash tooling is not merely awkward, it is
**silently wrong**:

- `bash .claude/hooks/gate.sh` resolves `bash` to whatever the Windows host
  provides (`C:\Windows\System32\bash.exe` = the WSL launcher, or Git Bash).
  Neither can execute the Windows virtualenv: `gate.sh` hardcodes
  `$ROOT/.venv/bin/python`, which on Windows is `.venv/Scripts/python.exe`.
  The gate therefore never runs a single check — it either exits 2 blaming a
  missing interpreter or, under a WSL bash whose `$ROOT` is a `/mnt/d` path,
  runs against a different Python entirely.
- Both scripts depend on coreutils (`timeout --kill-after`, `mktemp`, `date`,
  `wc`, `tr`, `sed`, `pkill`) and on bash process substitution (`tee` via
  `exec > >(…)`, `< <(…)`). Git Bash supplies some of these and not others;
  WSL bash supplies all of them but for the *Linux* filesystem view.

A commit gate that cannot run its checks is worse than no gate: it reports a
verdict that was never computed. The same applies to a review script whose
verdict the project's own discipline rules (`CLAUDE.md`) treat as mandatory.

Two options were considered. Option 1: keep bash and require Git Bash plus a
coreutils install on every Windows dev host, patching the venv path. Option 2:
add PowerShell-native equivalents beside the bash ones. **Option 2 is chosen**:
it removes the external toolchain dependency entirely (Windows PowerShell 5.1
is present on every Windows host by default), and it keeps the Ubuntu scripts
untouched and authoritative rather than making them conditionally correct on
two platforms.

## Decision

1. **Two implementations, one contract.** `.claude/hooks/gate.ps1` and
   `.claude/skills/codex-review-loop/scripts/run-review.ps1` are added as the
   native Windows equivalents of the `.sh` scripts. The `.sh` scripts remain
   and remain authoritative on Ubuntu. Both implementations MUST keep the same
   observable contract:

   | Contract | Value |
   |---|---|
   | gate: is this a commit? | two independent token tests (`git` named, bare `commit` token present) — NOT a parse of git's argument grammar, which cannot survive quoted paths and would fail OPEN |
   | gate: non-`git commit` command | exit 0, no output |
   | gate: all checks pass | exit 0 |
   | gate: a check fails or times out | exit 2, `=== commit blocked by … ===` block on stderr |
   | gate: commit redirected to another repo (`-C` / `--git-dir` / `--work-tree`) | exit 2 — the checks only cover this repo, so the gate refuses to vouch for a tree it never inspected |
   | gate: checks + order | `ruff format --check`, `ruff check`, `pytest`, `git diff --check`, `git diff --cached --check` |
   | review: exit code | ALWAYS 0, including every `ENV_ERROR` / `NO_CHANGES` / `DIFF_TOO_LARGE` |
   | review: reviewer order | codex, then claude fallback with an `INDEPENDENCE: degraded` line |
   | review: output markers | `REVIEWER:`, `VERDICT:`, `BLOCKING:`, `NON_BLOCKING:` |
   | review: env knobs | `REVIEW_TIMEOUT`, `REVIEW_MAX_DIFF_LINES`, `REVIEW_DIFF_CONTEXT`, `REVIEW_EXTRA_EXCLUDES`, `REVIEW_OUT_FILE`, `REVIEW_STATUS_FILE`, `REVIEW_TASK` |

   A behavioural change to one implementation is incomplete until the other
   matches.

2. **`AGENTS.md` rule 4 carve-out is extended.** PowerShell may be used for the
   AI-agent development harness (hook scripts, skill scripts, and their
   settings wiring) **when the agent host is Windows**. Rule 4 continues to
   forbid PowerShell, CMD, and Windows paths inside pipeline/product code and
   inside agent *workflows* expressed as pipeline steps. The pipeline itself
   gains nothing PowerShell-shaped from this ADR.

3. **One dispatcher selects exactly one native gate.** `.claude/settings.json`
   registers `python .claude/hooks/gate_dispatch.py` under matcher
   `Bash|PowerShell`. The dispatcher calls `gate.ps1` on Windows and `gate.sh`
   on POSIX. A fresh checkout is therefore gated on either platform without
   starting a foreign shell. In particular, `C:\Windows\System32\bash.exe`
   is a WSL launcher: registering it from a Windows PowerShell hook wakes the
   WSL VM even when `gate.sh` immediately exits. The Python dispatcher avoids
   that unintended VM start while keeping the two native implementations.

   The matcher covers `PowerShell` as well as `Bash` because on a Windows host
   the agent runs git through the PowerShell tool; a `Bash`-only matcher would
   leave the commit path ungated.

4. **Windows gets its own timeout budget.** Native Windows has no `/dev/shm`,
   so the repo-root `conftest.py` tmpfs route is a no-op and pytest's temp tree
   lands on NTFS with a real fsync per persist. Measured 2026-08-10 on the
   reference host: **328s** for a green run of 2815 collected tests (425s when
   34 were failing, tracebacks included), versus ~110–150s on WSL2
  tmpfs.
   `gate.ps1` therefore budgets pytest 900s (sum 946s) with the hook timeout at
   1000s, against `gate.sh`'s 300s (sum 346s) at 380s. The two budgets are
   independent and are each raised together with their own hook timeout.

   The gap between budget-sum and hook timeout is a **fail-open guard**, not
   padding: it must cover the worst-case teardown of a hung check (tree kill
   plus bounded stream drains) so the script always reaches its own `exit 2`.
   If the harness times the hook out first, that is a non-blocking error by
   Decision 3's semantics — and the unchecked commit would proceed.

5. **External tools are resolved, never assumed.** `git`, `codex`, and `claude`
   are resolved with `Get-Command` (the PowerShell equivalent of ADR-0049
   decision 3's `shutil.which`) and fail closed. Because both reviewer CLIs
   commonly ship inside per-user installs that are **not** on `PATH` on Windows
   (VS Code extension binaries, hashed install dirs), `run-review.ps1` also
   accepts `REVIEW_CODEX_BIN` / `REVIEW_CLAUDE_BIN` pointing at the executable
   directly. An override that does not exist is treated as "not installed",
   never as a hard error.

6. **The PowerShell scripts are ASCII-only and self-contained.** Windows
   PowerShell 5.1 decodes a BOM-less file using the host ANSI codepage (cp936
   here), so any non-ASCII byte in a script would silently corrupt — including
   inside the reviewer prompt. Both scripts are pure ASCII and neither
   dot-sources the other: each carries its own process-runner so a hook can
   never fail because a sibling file moved.

7. **Process control is explicit.** Child processes run through
   `System.Diagnostics.Process` with both output streams drained asynchronously
   before the wait (no pipe-buffer deadlock on a chatty pytest or a large
   review), stdin written as raw UTF-8 bytes (.NET Framework has no
   `StandardInputEncoding`), a bounded `WaitForExit`, and `taskkill /T /F` on
   timeout so no child survives. `Start-Process` is deliberately NOT used: the
   process object it returns does not reliably expose `ExitCode`, and a gate
   that cannot read an exit code is worthless.

## Consequences

- Two implementations of the same contract must be kept in sync; the contract
  table in Decision 1 is the reference, and the skill README documents both
  invocations.
- ADR-0049 "Not Decided Here" item 1 and the Consequences bullet stating the
  bash tooling "is **not** ported" are superseded by this ADR. Every other
  ADR-0049 decision stands unchanged.
- `AGENTS.md` rule 4 carries the extended carve-out; README's Windows section
  no longer claims the dev tooling is unavailable on Windows.
- A commit on Windows now costs ~6 minutes of gate time (the pytest budget is
  the floor). This is the honest cost of running the same suite without tmpfs.
- Standing up the gate on Windows exposed three real gaps in the product test
  suite that only a green-suite requirement would have surfaced: 33 tests whose
  symlink FIXTURE cannot be built without Developer Mode, a tamper/restore that
  corrupted a file through Windows newline translation
  (`tests/test_wfm1_e2e.py::test_fault_matrix`), and two `grep` subprocess calls
  TASK-049 missed. All are fixed under TASK-049; the gate found them because it
  refuses to pass on a red suite.

## Not Decided Here

- Whether the symlink-fixture guards should instead be replaced by real
  coverage on a developer host (i.e. requiring Developer Mode). ADR-0049
  already names Windows CI the verification of record for those guards, and
  the guards still execute there and on Linux.
- PowerShell 7 (`pwsh`) support. The scripts target Windows PowerShell 5.1
  because it is guaranteed present; they avoid 5.1-incompatible syntax and are
  expected to run under 7 as well, but that is not verified or claimed.
- Running the agent tooling in CI. It is a development harness, not product
  code; CI verifies the product suite only.
- Deduplicating the bash and PowerShell implementations into one runtime, and
  macOS support.
