# run-windows.ps1 — native-Windows launcher for the V1 baseline (ADR-0049).
#
# Sets up the project venv + package (so the CLI, connected backend and tests
# work) and then opens the motv creative studio in DEMO mode (backend-less,
# needs nothing but Python). Run from the repository root in PowerShell:
#
#     ./run-windows.ps1                # setup + open the demo studio
#     ./run-windows.ps1 -Connected     # setup + run the connected backend (server.py)
#     ./run-windows.ps1 -SetupOnly      # just create the venv + install deps
#
# FFmpeg/ffprobe (for render) and Piper (optional TTS) must be installed and on
# PATH separately; see README "原生 Windows" section. NTFS is required (ADR-0049).
param(
    [switch]$Connected,
    [switch]$SetupOnly,
    [int]$Port = 8000
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Prefer the py launcher, fall back to python on PATH.
$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py -3" } else { "python" }

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment (.venv)..."
    Invoke-Expression "$py -m venv .venv"
}
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
Write-Host "Installing the project (editable) + dev deps..."
& $venvPython -m pip install --upgrade pip | Out-Null
& $venvPython -m pip install -e ".[dev]"

if ($SetupOnly) {
    Write-Host "Setup complete. Activate with: .\.venv\Scripts\Activate.ps1"
    exit 0
}

if ($Connected) {
    Write-Host "Starting the connected backend (server.py) on http://127.0.0.1:8770/ ..."
    & $venvPython "mockups\motv-workspace\server.py" --account-root "examples\projects"
} else {
    Write-Host "Opening the motv demo studio on http://127.0.0.1:$Port/ ..."
    Start-Process "http://127.0.0.1:$Port/"
    & $venvPython "mockups\motv-workspace\serve.py" --port $Port
}
