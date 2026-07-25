# AI Video Workflow

Python foundations for the file-based AI video production workflow.

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
