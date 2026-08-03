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

Run these commands from the repository root in WSL2 Ubuntu:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
python -c "import ai_video_workflow; print(ai_video_workflow.__name__)"
python -m ruff format --check .
python -m ruff check .
python -m pytest
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
