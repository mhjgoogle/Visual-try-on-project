#!/usr/bin/env bash
# studio.sh — POSIX counterpart of scripts/launch/studio.ps1 (ADR-0049).
# Sets up the venv + package and opens the motv creative studio in DEMO mode.
#   ./scripts/launch/studio.sh              # setup + serve demo studio
#   ./scripts/launch/studio.sh --connected  # setup + connected backend
#   ./scripts/launch/studio.sh --setup-only # just venv + deps
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

if [ ! -d .venv ]; then
  echo "Creating virtual environment (.venv)..."
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
echo "Installing the project (editable) + dev deps..."
python -m pip install --upgrade pip >/dev/null
python -m pip install -e ".[dev]"

case "${1:-}" in
  --setup-only) echo "Setup complete. Activate with: source .venv/bin/activate"; exit 0 ;;
  --connected)  echo "Starting the connected backend on http://127.0.0.1:8770/ ..."
                exec python mockups/motv-workspace/server.py --account-root examples/projects ;;
  *)            echo "Opening the motv demo studio on http://127.0.0.1:8000/ ..."
                exec python mockups/motv-workspace/serve.py --port 8000 ;;
esac
