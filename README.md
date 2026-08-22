# AI Video Workflow

Python foundations for the file-based AI video production workflow.

The completed M1 CLI remains the stable minimal loop. WFM1 incrementally builds
the reusable short-film workflow described in
[`docs/ai_shortfilm_pipeline_workflow.md`](docs/ai_shortfilm_pipeline_workflow.md).
A cross-project Creation Workspace is a separately planned product track. Its
requirements are in
[`docs/ai_video_creation_workspace_requirements.md`](docs/ai_video_creation_workspace_requirements.md);
the staged ADR/task roadmap is in
[`docs/design/creation-workspace-implementation-roadmap.md`](docs/design/creation-workspace-implementation-roadmap.md).
It remains outside WFM1 implementation and acceptance. The complete route from
M1/WFM1 through WFM2/WFM3 and the final Workspace gate is tracked in
[`docs/design/end-to-end-requirements-traceability.md`](docs/design/end-to-end-requirements-traceability.md).
The logical input/output contract for every Project/L0/S1-S7 step is in
[`docs/design/workflow-stage-step-io-contract.md`](docs/design/workflow-stage-step-io-contract.md).

## Development Setup

Since [ADR-0062](docs/adr/ADR-0062-windows-authoritative-environment.md),
**native Windows on NTFS is the authoritative development/build/CI/agent
environment**; Ubuntu / WSL2 is a **supported target**, verified by the
`ubuntu-latest` CI job. A local WSL install is optional convenience, not a
requirement — nothing in daily development needs it.

"Authoritative" means *tie-breaker*: when the two disagree, Windows decides. A
failure on Ubuntu is still a defect — and its CI job matters **more** than it
did before, because Linux is no longer automatically punishing Windows-only
assumptions (AGENTS.md §3).

In PowerShell from the repository root:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
python -c "import ai_video_workflow; print(ai_video_workflow.__name__)"
python -m ruff format --check .
python -m ruff check .
python -m pytest
node --test mockups/motv-workspace/tests/*.test.mjs
```

Node (for the motv frontend units) and FFmpeg/ffprobe (for render) must be on
`PATH`. Every external tool is resolved through `shutil.which` and fails closed,
so a missing one is reported rather than guessed at — note that a process started
*before* an installer changed `PATH` will not see the new entry, and the fix is to
restart the shell, not to hard-code a path (AGENTS.md §6).

### Ubuntu / WSL2 (supported target)

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
python -m ruff check .
python -m pytest
```

Running `git` against this NTFS checkout **from inside WSL** must align the
line-ending semantics, or every text file reads as wholly modified (measured:
149,986 diff lines instead of 1,918):

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=true git diff
```

`wsl --shutdown` releases its memory when you are done (measured 1.05 GB → 0.03 GB).

### Windows specifics (ADR-0049)

The V1 baseline runs natively on **NTFS**, same volume. In PowerShell from the
repository root:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
# run each on its own line — PowerShell's ';' does not fail-fast, so a
# one-liner could mask a failing check behind a later passing one
ruff check .
ruff format --check .
python -m pytest
```

Or use the launcher (creates the venv, installs deps, opens the demo studio):

```powershell
.\scripts\launch\studio.ps1              # setup + demo studio
.\scripts\launch\studio.ps1 -Connected   # setup + connected backend
.\scripts\launch\studio.ps1 -SetupOnly   # just venv + deps
```

On Ubuntu / WSL2, use `./scripts/launch/studio.sh` with the equivalent
`--connected` / `--setup-only` options; `scripts\launch\studio.bat` is a
double-click/CMD adapter that delegates to `studio.ps1`. All launchers resolve
the repository root from their own location, so they may be invoked from any
working directory. Repository-level executable entry
points live under [`scripts/launch/`](scripts/launch/); the repository root is
reserved for project metadata and governance files.

FFmpeg/ffprobe (real render/probe) and, optionally, Piper (local TTS) must be
installed and on `PATH` (e.g. `choco install ffmpeg`); there is no `apt`.
Windows CI (`.github/workflows/ci.yml`) is the verification of record for this
target.

The AI-agent dev tooling (commit-gate hook, codex-review-loop) has
PowerShell-native equivalents for a Windows agent host —
[`.claude/hooks/gate.ps1`](.claude/hooks/gate.ps1) and
[`run-review.ps1`](.claude/skills/codex-review-loop/scripts/run-review.ps1),
per [ADR-0050](docs/adr/ADR-0050-powershell-native-agent-dev-tooling.md). Since
[ADR-0062](docs/adr/ADR-0062-windows-authoritative-environment.md) **the `.ps1`
side is the authoritative implementation** and the `.sh` side serves the Ubuntu
target; both share one behaviour contract and must reach the same verdict. Both
are registered as hooks and each stands down off its own platform, so a fresh
checkout is gated either way.

Tests whose fixture needs a real symlink skip on a Windows host without
symlink-creation privilege; enable **Developer Mode** (Settings → System → For
developers) to run them locally. They always run on Linux and in Windows CI,
which stays the verification of record for those guards.

## Creator Studio (motv-workspace)

[`mockups/motv-workspace`](mockups/motv-workspace/) is the creator-studio UX
prototype (non-production; read-only against real data). ES modules must load
over http, so it cannot be opened via `file://`. Two ways to run it:

```powershell
# demo mode — static fixtures, zero dependencies. Use serve.py, not
# `python -m http.server`: native Windows serves .js with a wrong MIME type.
py -3 mockups\motv-workspace\serve.py --port 8000     # http://localhost:8000/

# connected mode — same-origin loopback backend reading real projects
.\.venv\Scripts\Activate.ps1
python mockups\motv-workspace\server.py --account-root examples\projects
# http://127.0.0.1:8770/
```

On Ubuntu / WSL2 the same commands run with `python3` and forward slashes.
`scripts\launch\studio.ps1` (above) wraps setup plus either mode.

## Example Project (wfm1-demo)

[`examples/projects/wfm1-demo`](examples/projects/wfm1-demo/) is the read-only
WFM1 acceptance fixture (one character, 8 shots, ~48s; JSON inputs only — no
media, no credentials). Its offline end-to-end acceptance (real CLI + fake
provider, zero cost) runs as:

```powershell
python -m pytest tests/e2e/test_wfm1_e2e.py -q
```

## Minimal Loop (M1)

The first-phase minimal loop takes a project's story/shot records to a
composed MP4 without any paid API. FFmpeg and ffprobe are system-level
runtime dependencies for the real media steps (`apt install ffmpeg`);
the test suite runs against fakes and does not require them.

Given a project data root that already contains `project.json` and the
`records/` (scenes, shots) inputs, the lifecycle is:

```bash
ROOT=projects/my-project

# 1. create a GenerationTask + generation manifest per shot
ai-video-workflow --project-root "$ROOT" init-tasks

# 2. per task: render the manual instruction, mark it submitted
ai-video-workflow --project-root "$ROOT" prepare  task-shot-1-1
ai-video-workflow --project-root "$ROOT" submit   task-shot-1-1
ai-video-workflow --project-root "$ROOT" show-instruction task-shot-1-1

# 3. generate the video in your web tool and place it at the staging path
#    printed in the instruction: staging/shots/<task-id>.mp4
ai-video-workflow --project-root "$ROOT" report-artifact task-shot-1-1
ai-video-workflow --project-root "$ROOT" collect         task-shot-1-1

# 4. validate + register the asset, then compose the final MP4
ai-video-workflow --project-root "$ROOT" validate task-shot-1-1
ai-video-workflow --project-root "$ROOT" compose

# inspect status or the generated instruction at any time
ai-video-workflow --project-root "$ROOT" status task-shot-1-1
```

`run` executes the same order end to end once every shot's staged media
is in place:

```bash
ai-video-workflow --project-root "$ROOT" run
```

Every step is independently runnable and resumable; re-running is a
no-op when nothing changed and never silently overwrites. A new attempt
for a shot is explicit:

```bash
ai-video-workflow --project-root "$ROOT" create-redo-task shot-1
```
