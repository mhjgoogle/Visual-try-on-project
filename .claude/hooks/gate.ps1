#Requires -Version 5.1
<#
.SYNOPSIS
  gate.ps1 -- PreToolUse(Bash) commit gate, native Windows PowerShell port of
  gate.sh (ADR-0050).

.DESCRIPTION
  Reads the hook input JSON on stdin. It acts ONLY when the intercepted command
  contains `git commit`: it runs every configured quality check and, if all
  pass, exits 0 (commit allowed). If any check fails, it prints the failing
  output to stderr and exits 2 (commit blocked). For any non-commit command it
  exits 0 immediately and does nothing.

  Behavioural parity with gate.sh is deliberate: same checks, same order, same
  exit codes, same "one bounded timeout per check" design. Only the mechanics
  are Windows-native (no bash, no coreutils `timeout`, no `/bin/sh`).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Process helpers (kept self-contained on purpose: a hook must not depend on
# dot-sourcing a sibling file. run-review.ps1 carries the same helpers.)
# ---------------------------------------------------------------------------

# Quote one argument the way CommandLineToArgvW parses it back. Start-Process
# does NOT quote arguments containing spaces, and ProcessStartInfo.Arguments is
# a single raw string, so quoting is our job.
function ConvertTo-CommandLineArg {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
    if ($Value -ne '' -and $Value -notmatch '[ \t"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * ($backslashes * 2 + 1))
            [void]$sb.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$sb.Append('\' * $backslashes); $backslashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($backslashes -gt 0) { [void]$sb.Append('\' * ($backslashes * 2)) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# Kill the whole process tree -- pytest and ruff spawn children that would
# otherwise survive the parent and keep holding the repo.
function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
        & $taskkill.Source /T /F /PID $ProcessId 2>&1 | Out-Null
    }
    else {
        try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop } catch { }
    }
}

# Run one external command with a bounded wall-clock timeout and return
# @{ExitCode; Output; TimedOut}. ExitCode is 124 on timeout, mirroring the
# coreutils `timeout` convention gate.sh relied on.
#
# stdout and stderr are drained by async tasks started BEFORE the wait, so a
# chatty child (pytest) can never deadlock against a full pipe buffer.
# Start-Process is deliberately avoided: the Process object it returns does not
# expose ExitCode reliably (the cmdlet drops the handle), and a gate that
# cannot read an exit code is worthless.
function Invoke-Bounded {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-CommandLineArg $_ }) -join ' ')
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8

    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()

        $timedOut = $false
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            Stop-ProcessTree -ProcessId $proc.Id
            [void]$proc.WaitForExit(10000)
        }
        # The no-arg overload also waits for the redirected streams to close --
        # but only call it once the process is really gone, or a failed tree
        # kill would hang the whole hook here with no timeout at all.
        if ($proc.HasExited) { $proc.WaitForExit() }

        # Bounded reads for the same reason: a surviving grandchild still holds
        # the pipe's write end, and .Result would wait on it forever.
        $out = if ($outTask.Wait(10000)) { $outTask.Result } else { '' }
        $err = if ($errTask.Wait(10000)) { $errTask.Result } else { '' }
        $combined = (@($out, $err) | Where-Object { $_ -and $_.Trim() }) -join "`n"

        $code = if ($timedOut -or -not $proc.HasExited) { 124 } else { $proc.ExitCode }
        return [pscustomobject]@{ ExitCode = $code; Output = $combined; TimedOut = $timedOut }
    }
    finally {
        $proc.Dispose()
    }
}

# ---------------------------------------------------------------------------
# Phase A -- decide whether this invocation is a `git commit` at all.
# Any failure in this phase exits 0: a broken detector must never block
# unrelated Bash commands.
# ---------------------------------------------------------------------------
$gitExe = $null
$root = $null
try {
    # --- read hook input ---------------------------------------------------
    # Read stdin as raw UTF-8 bytes. Setting [Console]::InputEncoding throws
    # when stdin is a pipe, so decode the stream directly instead.
    $inputJson = ''
    if ([Console]::IsInputRedirected) {
        $stdin = [Console]::OpenStandardInput()
        $reader = New-Object System.IO.StreamReader($stdin, (New-Object System.Text.UTF8Encoding($false)))
        try { $inputJson = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }

    # Locate the repo root so relative tool paths (.venv, git checks) are
    # stable regardless of the caller's working directory.
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) { exit 0 }          # no git -> nothing to gate
    $gitExe = $gitCmd.Source
    $root = (& $gitExe rev-parse --show-toplevel) | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $root) {
        # Not in a git repo -> nothing to gate; never block.
        exit 0
    }
    $root = ([string]$root).Trim()

    # --- extract the intercepted command -----------------------------------
    # Prefer a proper JSON parse; fall back to the raw payload if it is not
    # JSON (mirrors gate.sh's grep fallback).
    $cmd = ''
    if ($inputJson) {
        try { $cmd = [string]($inputJson | ConvertFrom-Json).tool_input.command } catch { $cmd = '' }
        if (-not $cmd) { $cmd = $inputJson }
    }

    # --- only gate real `git commit` invocations ---------------------------
    # TWO INDEPENDENT TOKEN TESTS, deliberately NOT a parse of git's argument
    # grammar. A regex cannot reliably parse a shell command line -- quoted
    # paths with spaces (`git -C "D:\other repo" commit`), substitutions,
    # chained commands -- and every form the parse fails to recognise is a
    # commit that silently skips every check. So: does the command name git at
    # all, and does a bare `commit` token appear anywhere in it? Over-gating
    # costs one check run; a miss costs an unverified commit.
    $namesGit = $cmd -match '(^|[^A-Za-z0-9_-])git(\.exe)?(\s|$)'
    $namesCommit = $cmd -match '(^|\s)commit(\s|$)'
    if (-not ($namesGit -and $namesCommit)) { exit 0 }

    # ...but every check below runs in THIS repository. A commit redirected
    # elsewhere (`git -C other commit`, `--git-dir`, `--work-tree`) would get a
    # verdict computed from a tree the gate never inspected, so fail closed
    # rather than vouch for code it did not check.
    # -cmatch applies to the OPTION TOKEN ONLY, never to `git` itself (which
    # may be capitalised): git's `-c key=value` is a harmless config override
    # while `-C path` changes directory, and a case-insensitive test cannot
    # tell the two apart.
    $redirected = $cmd -cmatch '(^|\s)(-C(\s|$)|--git-dir(=|\s|$)|--work-tree(=|\s|$))'
}
catch {
    exit 0
}

if ($redirected) {
    [Console]::Error.WriteLine(
        'gate.ps1: this commit redirects git to another repository ' +
        '(-C / --git-dir / --work-tree), but the quality checks only cover ' +
        "'$root'. Run the commit from that repository's own working directory " +
        'so its gate can verify it.')
    exit 2
}

# ---------------------------------------------------------------------------
# Phase B -- this IS a commit: run every quality check. From here on the gate
# fails CLOSED: any unexpected error blocks the commit (exit 2) rather than
# letting an unverified commit through.
# ---------------------------------------------------------------------------
function Write-Block {
    param([string]$Label, [string]$Output)
    [Console]::Error.WriteLine("=== commit blocked by gate.ps1: '$Label' failed ===")
    if ($Output) { [Console]::Error.WriteLine($Output) }
    [Console]::Error.WriteLine('=== fix the above, then commit again ===')
    exit 2
}

$py = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py -PathType Leaf)) {
    [Console]::Error.WriteLine("gate.ps1: $py not found; cannot run quality checks.")
    exit 2
}

# --- run every configured quality check ------------------------------------
# Each check has a bounded timeout so a hung command cannot stall the commit.
# The per-check budget sums to 946s (15+15+900+8+8) and the hook cap in
# settings.json is 1000s. That 54s of slack is NOT cosmetic: it must cover the
# worst-case teardown of a hung check (up to 10s waiting on the tree kill plus
# 2x10s on the bounded stream drains) so this script always reaches its own
# `exit 2`. If the outer harness times the hook out first, the failure is
# reported as a NON-BLOCKING hook error and the commit proceeds unchecked --
# a hung check must never fail open. Raise the two numbers together.
#
# The pytest budget is much larger than gate.sh's 220s because native Windows
# has no /dev/shm: the repo-root conftest.py tmpfs route is a no-op here, so
# pytest's temp tree lands on NTFS and every persist fsyncs to disk. Measured
# 2026-08-10 on this host: 328s green for 2815 tests (WSL2 tmpfs: ~110-150s).
# 900s leaves headroom for current native-Windows suite growth. If the suite grows past
# ~850s, raise the pytest budget here AND the hook timeout in settings.json
# together (keep hook timeout ~ budget-sum + 4s).
#
# Force UTF-8 on Python's stdio so check output is decoded correctly on hosts
# whose ANSI codepage is not UTF-8 (e.g. cp936).
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$policyPath = Join-Path $root '.claude\hooks\commit_gate_policy.py'
if (-not (Test-Path -LiteralPath $policyPath -PathType Leaf)) {
    Write-Block -Label 'commit-risk-policy' -Output "policy file not found: $policyPath"
}

# Classify exactly what this commit writes.  A normal commit writes the index,
# so unrelated experiments in the worktree cannot turn a docs commit into a
# full suite.  `git commit -a/--all` stages tracked worktree changes during the
# commit itself, so use HEAD for that form.  Deletions stay in either input.
$diffArgs = @('diff', '--cached', '--name-only', '--no-renames')
if ($cmd -match '(^|\s)(-a|--all)(\s|$)') {
    $diffArgs = @('diff', '--name-only', '--no-renames', 'HEAD')
}
$pathsResult = Invoke-Bounded -FilePath $gitExe -Arguments $diffArgs `
    -TimeoutSeconds 15 -WorkingDirectory $root
if ($pathsResult.ExitCode -ne 0) {
    $out = $pathsResult.Output
    if ($pathsResult.TimedOut) { $out = "$out`n[timed out after 15s]" }
    Write-Block -Label 'commit-risk-policy' -Output "could not list changed paths:`n$out"
}
$changedPaths = @(
    $pathsResult.Output -split "`r?`n" | Where-Object { $_ -and $_.Trim() }
)
$policyResult = Invoke-Bounded -FilePath $py -Arguments (@($policyPath) + $changedPaths) `
    -TimeoutSeconds 15 -WorkingDirectory $root
if ($policyResult.ExitCode -ne 0) {
    $out = $policyResult.Output
    if ($policyResult.TimedOut) { $out = "$out`n[timed out after 15s]" }
    Write-Block -Label 'commit-risk-policy' -Output "could not classify changed paths:`n$out"
}
try {
    $policy = $policyResult.Output | ConvertFrom-Json -ErrorAction Stop
}
catch {
    Write-Block -Label 'commit-risk-policy' -Output "invalid policy output: $($_.Exception.Message)"
}

$checks = @(
    @{ Label = 'ruff format --check'; Timeout = 15; File = $py; Args = @('-m', 'ruff', 'format', '--check', '.') },
    @{ Label = 'ruff check'; Timeout = 15; File = $py; Args = @('-m', 'ruff', 'check', '.') }
)

switch ($policy.tier) {
    'full' {
        $checks += @{ Label = 'pytest (full)'; Timeout = 900; File = $py; Args = @('-m', 'pytest') }
    }
    'workspace' {
        $checks += @{ Label = 'pytest (workspace)'; Timeout = 120; File = $py; Args = @('-m', 'pytest') + @($policy.pytest_targets) }
    }
    'pytest-targeted' {
        $checks += @{ Label = 'pytest (targeted)'; Timeout = 120; File = $py; Args = @('-m', 'pytest') + @($policy.pytest_targets) }
    }
    'motv-server' {
        $checks += @{ Label = 'pytest (motv-server)'; Timeout = 180; File = $py; Args = @('-m', 'pytest') + @($policy.pytest_targets) }
    }
    'frontend' {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            Write-Block -Label 'frontend tests' -Output 'node was not found on PATH.'
        }
        $nodeTests = @(
            Get-ChildItem -LiteralPath (Join-Path $root 'mockups\motv-workspace\tests') -Filter '*.test.mjs' |
                Sort-Object Name |
                ForEach-Object FullName
        )
        if ($nodeTests.Count -eq 0) {
            Write-Block -Label 'frontend tests' -Output 'no frontend test files were found.'
        }
        $checks += @{ Label = 'frontend tests'; Timeout = 90; File = $node.Source; Args = @('--test') + $nodeTests }
    }
    'lint' { }
    default {
        Write-Block -Label 'commit-risk-policy' -Output "unsupported risk tier: $($policy.tier)"
    }
}

$checks += @(
    @{ Label = 'git diff --check'; Timeout = 8; File = $gitExe; Args = @('diff', '--check') },
    @{ Label = 'git diff --cached --check'; Timeout = 8; File = $gitExe; Args = @('diff', '--cached', '--check') }
)

foreach ($check in $checks) {
    $result = $null
    try {
        $result = Invoke-Bounded -FilePath $check.File -Arguments $check.Args `
            -TimeoutSeconds $check.Timeout -WorkingDirectory $root
    }
    catch {
        Write-Block -Label $check.Label -Output "gate.ps1 could not run this check: $($_.Exception.Message)"
    }
    if ($result.ExitCode -ne 0) {
        $out = $result.Output
        if ($result.TimedOut) { $out = "$out`n[timed out after $($check.Timeout)s]" }
        Write-Block -Label $check.Label -Output $out
    }
}

exit 0
