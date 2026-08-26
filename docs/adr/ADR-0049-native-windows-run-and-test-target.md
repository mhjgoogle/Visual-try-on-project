# ADR-0049: Native Windows as a Supported Run and Test Target

- Status: Accepted
- Date: 2026-08-10
- Supersedes: [ADR-0001](ADR-0001-project-data-directory-contract.md) 的
  WSL2-only 平台支持声明（见下方 Scope 与 Decision 2）；ADR-0001 的其余决策不变

> **Superseded in part by
> [ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md) (2026-08-10):**
> the statement that the bash AI-agent dev tooling is *not* ported (Consequences
> bullet 4 and Not Decided Here item 1) no longer holds. PowerShell-native
> equivalents of `gate.sh` and `run-review.sh` now exist beside the bash ones.
> Every other decision in this ADR is unchanged.
- Scope: Host-platform support for running and testing the pipeline, CLI, the
  motv-workspace prototype, and FFmpeg composition; supersedes the WSL2-only
  platform scope in ADR-0001 and amends the environment constraints in
  `AGENTS.md` §2.

## Context

M3–M11 plus the V1 acceptance pass are complete on the authoritative WSL2
Ubuntu environment (see `AGENTS.md` §2 and ADR-0001). The accepted V1 baseline
now needs to be **reproducibly runnable on native Windows** (Windows Python,
no WSL), so a Windows creator can install the tool and produce videos without a
Linux subsystem.

`AGENTS.md` §2 (rules 2–6) and ADR-0001 currently forbid this: rule 2 fixes the
runtime to WSL2 Ubuntu, rules 3–4 forbid Windows paths and PowerShell/CMD, and
ADR-0001 (its platform-support statements) declares "The supported and tested
environment is WSL2 Ubuntu / Linux; Windows path and replace semantics are out
of scope." Per ADR-0007's Document Authority rule, a later ADR must explicitly
supersede those decisions before implementation may contradict them. This ADR
is that supersession.

An audit of the whole repository found the native-Windows blocker surface small
and concentrated: the core package has **zero third-party runtime dependencies**
(pure stdlib) and its text I/O is already UTF-8 throughout. The blockers are a
handful of POSIX-only mechanisms — `fcntl` advisory locking (4 modules), the
symlink-hardened `O_NOFOLLOW`/`dir_fd` directory traversal in the append-log
opener, one `/proc/self/fd` re-containment check, and a bare-name `claude`
subprocess in the prototype backend — plus WSL-only run docs and a test suite
that shells out to `grep`/`/bin/sh`.

## Decision

1. **Ubuntu remains authoritative; Windows becomes a supported run+test
   target.** WSL2 Ubuntu stays the authoritative environment for development,
   build, CI-of-record, and the AI-agent tooling. Native Windows is now a
   **supported target for running and testing** the pipeline, the CLI, the
   motv-workspace prototype (demo, connected, and FFmpeg render modes), and the
   automated test suite. "Supported" means: cross-platform code paths, Windows
   setup/run documentation, and a Windows CI job that must stay green.

2. **Filesystem scope: NTFS, same volume.** Windows support requires NTFS (the
   default). The create-only "no silent overwrite" publish primitive
   (`AGENTS.md` rule 13) uses `os.link`, which on Windows works on NTFS and
   raises `FileExistsError` identically; the atomic temp file always lives in
   the destination directory (same volume). FAT/exFAT and network shares are
   **out of scope** and may be addressed in a later ADR if needed.

3. **External tools resolved by name.** `ffmpeg`, `ffprobe`, `piper`, and
   `claude` must be resolved via `shutil.which` (never bare-name `Popen`,
   which does not resolve `.cmd`/`.bat` under `shell=False`) and fail closed
   with an install hint when absent. Windows users install FFmpeg and place it
   on `PATH`; there is no `apt`.

4. **Path/lock/symlink hardening degrades explicitly, never silently.** Where a
   POSIX-only hardening cannot be reproduced on Windows (the `O_NOFOLLOW` +
   `dir_fd` TOCTOU-closed traversal, `st_nlink` hard-link refusal, `/proc`
   re-containment), the Windows path falls back to the existing
   `resolve_within_root` containment check plus an `is_symlink()` /
   `S_ISREG` guard. The residual symlink-TOCTOU window on Windows is accepted
   because creating a symlink on Windows requires elevation or Developer Mode
   (single-user local model). This reduced guarantee is documented at each site.

5. **Windows launchers and docs are permitted (carve-out to rule 4).** A
   `.ps1`/`.bat` double-click launcher and PowerShell/CMD run instructions may
   exist **for Windows users to run the product**. `AGENTS.md` rule 4 continues
   to forbid PowerShell/CMD/Windows paths **inside pipeline code and agent
   workflows**; it does not forbid a documented Windows entry point.

6. **Verification of record is Windows CI.** Because development happens on
   Ubuntu, native-Windows correctness is verified by a Windows CI job
   (windows-latest, project Python, FFmpeg on PATH) that runs the full test
   suite. A change claiming Windows support is accepted only when that job is
   green; the Linux suite must stay green in parallel (no POSIX regression).

## Consequences

- `AGENTS.md` §2 is amended: rules 2–6 are reworded to name Ubuntu the
  authoritative dev/build/agent environment and native Windows a supported
  run+test target under this ADR; the goal statement (line 10) is annotated.
- ADR-0001's platform-support statements are **superseded** by this ADR to the
  extent stated in Decision 2; ADR-0001 carries a superseded-by note. All other
  ADR-0001 contracts (project data directory layout, atomic-write semantics)
  are unchanged.
- README (repo + motv-workspace) gains native-Windows setup/run sections
  alongside the existing WSL2 instructions.
- ~~The bash AI-agent dev tooling (`.claude/hooks/gate.sh`, the
  `codex-review-loop` skill scripts) is **not** ported; it remains part of the
  authoritative Ubuntu dev environment (see Not Decided Here).~~ Superseded by
  [ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md): the bash scripts
  stay authoritative on Ubuntu, and PowerShell-native equivalents
  (`gate.ps1`, `run-review.ps1`) serve a Windows agent host.

## Not Decided Here

- ~~Porting the bash AI-agent dev tooling (commit-gate hook, codex-review-loop)
  to native Windows. These are the Ubuntu-authoritative development harness, not
  the product; they stay bash/coreutils-only.~~ **Decided by
  [ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md)**: PowerShell-native
  equivalents are added beside the bash scripts, which stay authoritative on
  Ubuntu.
- FAT/exFAT/network-share support for the create-only publish primitive
  (Decision 2 keeps these out of scope).
- macOS support (not requested; much of the cross-platform work would also
  benefit it, but it is neither implemented nor claimed).
