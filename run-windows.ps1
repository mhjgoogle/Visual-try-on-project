# run-windows.ps1 — native-Windows launcher for the V1 baseline (ADR-0049).
#
# Sets up the project venv + package (so the CLI, connected backend and tests
# work) and then opens the motv creative studio in DEMO mode (backend-less,
# needs nothing but Python). Run from the repository root in PowerShell:
#
#     ./run-windows.ps1                # setup + open the demo studio
#     ./run-windows.ps1 -Connected     # setup + run the connected backend (server.py)
#     ./run-windows.ps1 -SetupOnly     # just create the venv + install deps
#
# In connected mode the backend's --account-root is where projects and their
# assets live; it defaults to the folder CONTAINING this repository. Override
# it with -AssetRoot. The studio's "新建项目" dialog pre-fills that same value.
#
# FFmpeg/ffprobe (for render) and Piper (optional TTS) must be installed and on
# PATH separately; see README "原生 Windows" section. NTFS is required (ADR-0049).
#
# CLAUDE CODE: every AI capability in this app runs on your own Claude Code
# SUBSCRIPTION via the `claude` CLI. The recommended install is the standalone CLI
# (`npm i -g @anthropic-ai/claude-code`), which puts it on PATH for good. If it is
# not there, this launcher falls back to the copy bundled inside the VS Code
# extension — see Resolve-ClaudeOnPath below for why that is a fallback and not the
# primary route.
param(
    [switch]$Connected,
    [switch]$SetupOnly,
    # Enable codex as the INDEPENDENT REVIEWER. Off by default on purpose — see
    # Resolve-CodexOnPath for what you are agreeing to.
    [switch]$AllowCodexReview,
    [int]$Port = 8000,
    # Where projects (and their assets) live. Defaults to the folder that
    # CONTAINS this repository, so generated media never lands inside the repo
    # (AGENTS.md §23). Override for another location:
    #     ./run-windows.ps1 -Connected -AssetRoot "E:\media\projects"
    [string]$AssetRoot
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Prefer the py launcher, fall back to python on PATH.
$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py -3" } else { "python" }

# ---------------------------------------------------------------------------
# Make the Claude Code SUBSCRIPTION reachable to the backend.
#
# WHY THIS EXISTS. `server.py` resolves the CLI with `shutil.which("claude")` and
# fail-closes when it is absent (ADR-0049 §6: resolve, never invoke by bare name,
# never guess a path in product code). That rule is right and stays — but it means
# a machine where Claude Code is installed ONLY as the VS Code extension reports
# every AI capability as unavailable, because the extension bundles its binary at
#   ~/.vscode/extensions/anthropic.claude-code-<ver>-<plat>/resources/native-binary/
# and never puts that directory on PATH.
#
# So the fix belongs HERE, in the launcher: this is environment setup, not
# resolution. `server.py` still does the resolving, and still fail-closes.
#
# THE STANDALONE CLI IS THE PRIMARY ROUTE. The extension directory carries a
# version number that changes on every update, so it is matched by WILDCARD and
# only ever used when `claude` is not already on PATH. Installing the standalone
# CLI makes this whole block a no-op, which is the intended end state.
function Resolve-ClaudeOnPath {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Host "claude: on PATH (standalone CLI) - AI capabilities available."
        return
    }
    # newest extension wins: LastWriteTime rather than a version parse, because the
    # directory name's version format is not ours to depend on
    $candidates = @(
        "$env:USERPROFILE\.vscode\extensions",
        "$env:USERPROFILE\.vscode-insiders\extensions",
        "$env:USERPROFILE\.cursor\extensions"
    ) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue
    } | ForEach-Object {
        Join-Path $_.FullName 'resources\native-binary\claude.exe'
    } | Where-Object { Test-Path -LiteralPath $_ }

    $exe = $candidates | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending | Select-Object -First 1
    if (-not $exe) {
        # HONEST, and actionable. Not an error: the studio runs fine without AI, and
        # every capability reports itself unavailable rather than pretending.
        Write-Host "claude: NOT FOUND - AI capabilities will report themselves unavailable." -ForegroundColor Yellow
        Write-Host "  Install the CLI:  npm i -g @anthropic-ai/claude-code" -ForegroundColor Yellow
        Write-Host "  (then restart this launcher - a process started before the install cannot see the new PATH)" -ForegroundColor Yellow
        return
    }
    $env:PATH = (Split-Path -Parent $exe) + [IO.Path]::PathSeparator + $env:PATH
    Write-Host "claude: using the VS Code extension's bundled CLI (fallback)."
    Write-Host "  $exe"
    Write-Host "  For a permanent fix install the standalone CLI: npm i -g @anthropic-ai/claude-code"
}

# CODEX — the INDEPENDENT REVIEWER, never the creative director (ADR-0056 决策 1,
# TASK-067 §14). Two separate things have to be true before it can run:
#
#   1. the binary resolves (npm i -g @openai/codex)
#   2. the operator has opted IN, because codex has no tool-free mode
#
# On (2): `codex exec --sandbox read-only` blocks WRITES but the agent can still
# READ local files and echo them into its answer — and a Film Skill prompt inlines
# user-authored script text, which is an injection surface. The backend is therefore
# fail-closed and reports codex `unavailable` unless
# MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS is set. That default is deliberate and
# this launcher does NOT flip it silently: pass -AllowCodexReview to make the
# decision explicit and on the record.
function Resolve-CodexOnPath {
    param([bool]$OptIn)
    # CLEAR IT FIRST, ALWAYS.
    #
    # `$env:` writes live for the whole PowerShell session, and this process also
    # inherits whatever the parent set. Merely *not* setting the flag therefore did
    # not disable anything: a value left over from an earlier `-AllowCodexReview`
    # run (or exported by the caller) stayed set and was inherited by the server,
    # while this launcher printed "NOT enabled (fail-closed by default)" - the one
    # kind of wrong a security default must never be (codex review round 6).
    #
    # Absence of the switch is now an ACTIVE "off", and an inherited value is
    # reported rather than silently discarded.
    if ($env:MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS -and -not $OptIn) {
        Write-Host "codex: clearing an inherited MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS - you did not pass -AllowCodexReview." -ForegroundColor Yellow
    }
    if (-not $OptIn) { $env:MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS = $null }

    $have = [bool](Get-Command codex -ErrorAction SilentlyContinue)
    if (-not $have) {
        Write-Host "codex: not installed - the independent-review capabilities will report themselves unavailable."
        Write-Host "  Install it with:  npm i -g @openai/codex"
        return
    }
    if (-not $OptIn) {
        Write-Host "codex: installed but NOT enabled (fail-closed by default)." -ForegroundColor Yellow
        Write-Host "  codex has no tool-free mode: --sandbox read-only blocks writes, but it can still READ" -ForegroundColor Yellow
        Write-Host "  local files and quote them back, and skill prompts inline your own script text." -ForegroundColor Yellow
        Write-Host "  Enable it deliberately with:  ./run-windows.ps1 -Connected -AllowCodexReview" -ForegroundColor Yellow
        return
    }
    $env:MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS = "1"
    Write-Host "codex: ENABLED for independent review (you passed -AllowCodexReview)."
    Write-Host "  It stays a REVIEWER: no capability is bound to it, and creative work defaults to Claude Code."
}

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
    if (-not $AssetRoot) { $AssetRoot = Split-Path -Parent $root }
    if (-not (Test-Path -LiteralPath $AssetRoot)) {
        New-Item -ItemType Directory -Force -Path $AssetRoot | Out-Null
    }
    $AssetRoot = (Resolve-Path -LiteralPath $AssetRoot).Path
    # The AI runtimes are resolved for the BACKEND's environment, so they must be
    # settled before it is started — a process cannot pick up a PATH change made
    # after it launched (AGENTS.md §6, and the reason "restart the server" is the
    # right advice rather than making product code guess a path).
    Write-Host ""
    Resolve-ClaudeOnPath
    Resolve-CodexOnPath -OptIn:$AllowCodexReview.IsPresent
    Write-Host ""
    Write-Host "Starting the connected backend (server.py) on http://127.0.0.1:8770/ ..."
    Write-Host "  asset root (--account-root): $AssetRoot"
    Start-Process "http://127.0.0.1:8770/"
    & $venvPython "mockups\motv-workspace\server.py" --account-root $AssetRoot
} else {
    Write-Host "Opening the motv demo studio on http://127.0.0.1:$Port/ ..."
    Start-Process "http://127.0.0.1:$Port/"
    & $venvPython "mockups\motv-workspace\serve.py" --port $Port
}
