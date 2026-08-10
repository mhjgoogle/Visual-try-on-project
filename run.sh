#!/usr/bin/env bash
# run.sh — POSIX (WSL2 Ubuntu) counterpart of run-windows.ps1 (ADR-0049).
# Sets up the venv + package and opens the motv creative studio in DEMO mode.
#   ./run.sh              # setup + serve the demo studio
#   ./run.sh --connected  # setup + run the connected backend (server.py)
#   ./run.sh --setup-only # just create the venv + install deps
set -euo pipefail
cd "$(dirname "$0")"

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
