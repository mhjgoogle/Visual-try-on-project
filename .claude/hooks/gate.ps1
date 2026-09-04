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
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [AllowEmptyString()][string]$StdinText = $null
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
    if ($null -ne $StdinText) { $psi.RedirectStandardInput = $true }

    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()

        # Raw UTF-8 BYTES onto the base stream, not through the StreamWriter.
        # ProcessStartInfo.StandardInputEncoding does not exist on the .NET
        # Framework that PowerShell 5.1 runs on, so the writer would encode with
        # the console codepage -- and this pipe carries the intercepted command,
        # commit message included. On a cp932 host a Chinese message would reach
        # the classifier as mojibake or die on encode. The hook contract is
        # UTF-8; the console gets no vote (same rule as the notice on the way
        # out). Drain tasks are started FIRST so a child that answers before it
        # has read everything cannot deadlock against a full stdout buffer.
        if ($null -ne $StdinText) {
            $stdinBytes = [System.Text.Encoding]::UTF8.GetBytes($StdinText)
            $proc.StandardInput.BaseStream.Write($stdinBytes, 0, $stdinBytes.Length)
            $proc.StandardInput.BaseStream.Flush()
            $proc.StandardInput.Close()
        }

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

# --- BEGIN GATE-ARGV-SPLITTER ----------------------------------------------
# Split a PowerShell command line into simple commands of already-dequoted
# tokens, using PowerShell's OWN parser -- the same one that will execute the
# command, not a second approximation of it.
#
# THIS FUNCTION SPLITS. IT NEVER JUDGES. It contains no notion of `git`, of
# `commit`, of `-C`, or of the chain token: every verdict is reached in
# commit_gate_policy.py, because two shells each matching their own tokens is
# precisely how the two platforms came to disagree before (ADR-0062 decision 3).
# The POSIX side needs no equivalent -- Python's `shlex` tokenises it inside the
# policy, so that half is literally one implementation.
#
# Element kinds, all four measured 2026-08-16 on PowerShell 5.1.26100:
#   StringConstantExpressionAst    `git`, `"commit"`, `g""it`, and ALSO `"-C"`
#                                  and `--all` -- a quoted or double-dashed
#                                  option arrives as a constant, not a parameter
#   CommandParameterAst            `-m`, `-C`, `-am`; it has no .Value, and its
#                                  .Extent.Text is the raw token we want
#   ExpandableStringExpressionAst  `"fix $name"`; .Value keeps `$name` literal,
#                                  which is right -- the expansion happens after
#                                  this hook has already run
#   anything else                  variables, sub-expressions, script blocks:
#                                  the extent text, which can never equal a bare
#                                  command name. That is the documented
#                                  indirection hole, not an accident.
#
# A PARSE ERROR RETURNS $null, and the policy turns that into a full run
# (decision 4). Note PowerShell 5.1 has no `&&`/`||`, so `git commit && git push`
# IS a parse error here: it fails closed to the full suite rather than to a
# chain skip, which keeps ADR-0068 decision 6's invariant intact by a different
# route. Returned inside a PSCustomObject because PowerShell unwraps a
# single-element array on return and the nesting is the whole point.
function ConvertTo-GateArgv {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$CommandText)

    $parseTokens = $null
    $parseErrors = $null
    $tree = [System.Management.Automation.Language.Parser]::ParseInput(
        $CommandText, [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        return [pscustomobject]@{ Parsed = $false; Commands = $null }
    }

    $simpleCommands = @()
    $found = $tree.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.CommandAst]
        }, $true)
    foreach ($simple in $found) {
        $words = @()
        foreach ($element in $simple.CommandElements) {
            if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
                $words += [string]$element.Extent.Text
            }
            elseif ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
                $words += [string]$element.Value
            }
            else {
                $words += [string]$element.Extent.Text
            }
        }
        $simpleCommands += , ([string[]]$words)
    }
    return [pscustomobject]@{ Parsed = $true; Commands = $simpleCommands }
}
# --- END GATE-ARGV-SPLITTER ------------------------------------------------

# ---------------------------------------------------------------------------
# Phase A -- work out what this invocation IS, by asking the policy.
#
# There is no text pre-filter here any more, and that removal is the point of
# TASK-085. Two regexes used to decide whether to go on, and every form they
# failed to recognise was a commit that ran ZERO checks -- `git "commit"` walked
# straight through, and no pre-filter can be written that `g""it` cannot fool.
# So the tokens go to the policy and the policy decides.
#
# The cost is one interpreter start (~126 ms, measured) on EVERY Bash/PowerShell
# tool call, not just on commits. That is the accepted price; the thing it buys
# back is a gate that cannot silently fail to run. If it ever needs reducing,
# the direction is a resident classifier, NOT a pre-filter -- a pre-filter
# reintroduces exactly the hole this removed.
#
# Failures split in two. "Not in a git repo / no git at all" still exits 0:
# there is nothing to gate. "I could not reach the classifier" BLOCKS: that is
# not knowing whether this was a commit, and the old blanket `exit 0` on any
# Phase A error is how a broken detector silently became a disabled gate.
# ---------------------------------------------------------------------------
$gitExe = $null
$root = $null
$inputJson = ''
try {
    # --- read hook input ---------------------------------------------------
    # Read stdin as raw UTF-8 bytes. Setting [Console]::InputEncoding throws
    # when stdin is a pipe, so decode the stream directly instead.
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
}
catch {
    exit 0
}

# Force UTF-8 on every python child's stdio, BEFORE the first one is started.
# The classifier now runs in Phase A too, and it carries the commit message.
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

function Write-Block {
    param([string]$Label, [string]$Output)
    [Console]::Error.WriteLine("=== commit blocked by gate.ps1: '$Label' failed ===")
    if ($Output) { [Console]::Error.WriteLine($Output) }
    [Console]::Error.WriteLine('=== fix the above, then commit again ===')
    exit 2
}

$py = Join-Path $root '.venv\Scripts\python.exe'
$policyPath = Join-Path $root '.claude\hooks\commit_gate_policy.py'

# The classifier is stdlib-only, so ANY interpreter can answer the intent
# question. Preferring the venv but falling back to PATH keeps a repo whose
# .venv is not built yet from blocking every unrelated command -- only real
# commits hit the venv requirement, in Phase B, exactly as before.
$intentPy = $py
if (-not (Test-Path -LiteralPath $intentPy -PathType Leaf)) {
    $fallbackPy = Get-Command python -ErrorAction SilentlyContinue
    $intentPy = if ($fallbackPy) { $fallbackPy.Source } else { $null }
}
if (-not $intentPy -or -not (Test-Path -LiteralPath $policyPath -PathType Leaf)) {
    Write-Block -Label 'commit-intent' -Output @"
gate.ps1 could not reach the risk classifier, so it cannot tell whether this
command is a commit.
  interpreter: $(if ($intentPy) { $intentPy } else { '<none found>' })
  policy     : $policyPath
Fail-closed on purpose (TASK-085): the alternative is a gate that silently stops
running. Restore .claude/hooks/commit_gate_policy.py, or put a python on PATH.
"@
}

# --- ask the policy what this command is ------------------------------------
# PowerShell text can only be split by PowerShell, so THAT part happens here --
# splitting only. `argv` stays null when the parse failed, which the policy
# reads as "cannot tell" and answers with a full run.
$toolName = ''
$commandText = ''
if ($inputJson) {
    try {
        $hookPayload = $inputJson | ConvertFrom-Json
        $toolName = [string]$hookPayload.tool_name
        $commandText = [string]$hookPayload.tool_input.command
    }
    catch {
        # Leave both empty: an unreadable payload is "cannot tell", and the
        # policy fails closed on it. Matching the RAW payload text with regexes
        # was the old fallback and is the very thing this card removed.
        $toolName = ''
        $commandText = ''
    }
}

$argvForPolicy = $null
if ($toolName -eq 'PowerShell') {
    try {
        $split = ConvertTo-GateArgv -CommandText $commandText
        if ($split.Parsed) { $argvForPolicy = $split.Commands }
    }
    catch {
        $argvForPolicy = $null
    }
}

try {
    $intentJson = @{
        tool_name = $toolName
        command   = $commandText
        argv      = $argvForPolicy
    } | ConvertTo-Json -Depth 6 -Compress
    $intentResult = Invoke-Bounded -FilePath $intentPy `
        -Arguments @($policyPath, '--intent') -TimeoutSeconds 15 `
        -WorkingDirectory $root -StdinText $intentJson
}
catch {
    Write-Block -Label 'commit-intent' -Output "could not run the intent classifier: $($_.Exception.Message)"
}
if ($intentResult.ExitCode -ne 0) {
    $out = $intentResult.Output
    if ($intentResult.TimedOut) { $out = "$out`n[timed out after 15s]" }
    Write-Block -Label 'commit-intent' -Output "could not classify this command:`n$out"
}
try {
    $intent = $intentResult.Output | ConvertFrom-Json -ErrorAction Stop
}
catch {
    Write-Block -Label 'commit-intent' -Output "invalid intent output: $($_.Exception.Message)"
}

if ($intent.gate -eq 'skip') { exit 0 }      # not a commit -> do nothing
if ($intent.gate -eq 'block') {
    [Console]::Error.WriteLine("gate.ps1: $($intent.reason)")
    [Console]::Error.WriteLine("(the quality checks cover '$root')")
    exit 2
}
if ($intent.gate -ne 'check') {
    Write-Block -Label 'commit-intent' -Output "unsupported intent: $($intent.gate)"
}

# ---------------------------------------------------------------------------
# Phase B -- this IS a commit: run every quality check. From here on the gate
# fails CLOSED: any unexpected error blocks the commit (exit 2) rather than
# letting an unverified commit through.
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $py -PathType Leaf)) {
    [Console]::Error.WriteLine("gate.ps1: $py not found; cannot run quality checks.")
    exit 2
}

# --- run every configured quality check ------------------------------------
# Each check has a bounded timeout so a hung command cannot stall the commit.
# The per-check budget's worst case is the full tier with the frontend flag:
# 916s (15+15+600+180+90+8+8); the ownership-mapped targeted tier peaks at 736s
# (15+15+480+120+90+8+8). The hook cap in settings.json is 1000s. The remaining
# slack is NOT cosmetic: it must cover the
# worst-case teardown of a hung check (up to 10s waiting on the tree kill plus
# 2x10s on the bounded stream drains) so this script always reaches its own
# `exit 2`. If the outer harness times the hook out first, the failure is
# reported as a NON-BLOCKING hook error and the commit proceeds unchecked --
# a hung check must never fail open. Raise the two numbers together.
#
# The pytest budget is much larger than gate.sh's 220s because native Windows
# has no /dev/shm: the tests/conftest.py tmpfs route is a no-op here, so
# pytest's temp tree lands on NTFS and every persist fsyncs to disk. Measured
# 2026-08-10 on this host: 328s green for 2815 tests (WSL2 tmpfs: ~110-150s).
# 900s leaves headroom for current native-Windows suite growth. If the suite grows past
# ~850s, raise the pytest budget here AND the hook timeout in settings.json
# together (keep hook timeout ~ budget-sum + 4s).
#
# (PYTHONIOENCODING / PYTHONUTF8 are set in Phase A, before the first python
# child of all -- the intent classifier -- is started.)

# Classify exactly what this commit writes.  A normal commit writes the index,
# so unrelated experiments in the worktree cannot turn a docs commit into a
# full suite.  `git commit -a/--all` stages tracked worktree changes during the
# commit itself, so use HEAD for that form.  Deletions stay in either input.
# `-z`: NUL-separated and NEVER C-quoted, matching gate.sh (cross-model review,
# 2026-08-16 -- gate.sh already passed it, this shell did not). Without it git
# wraps any path holding non-ASCII or special characters in quotes and escapes
# it ("docs/\344\270\255\346\226\207.md"), and the classifier then reads a
# string that is not the path: the leading quote alone makes every prefix test
# miss, so a high-risk file could take a cheap tier. The repository has no
# non-ASCII tracked path TODAY, which is exactly why this stayed invisible --
# the first non-ASCII filename would have flipped a gate nobody was watching.
# Same defect class run-review.ps1's Get-UntrackedDiff already documents.
#
# (This file must stay ASCII: it has no BOM, so a non-ASCII byte can be decoded
# wrongly and make the gate fail OPEN. A guard test pins that.)
#
# WHICH diff comes from the intent, not from a second look at the command text.
# Re-deriving `-a/--all` here with a regex is what let `git commit -am "x"` --
# an entirely ordinary spelling -- be classified against the INDEX while the
# commit actually wrote the WORKTREE.
if ($intent.force_full) {
    # The command could not be parsed, so the staged paths cannot be trusted to
    # describe it either (decision 4). Skip the diff and run everything: asking
    # git what is staged would answer a question about THIS repo that the
    # unreadable command may not even have been about.
    # frontend = $true: this is the fail-closed path (the command could not be
    # parsed), and under ADR-0080 the full contract INCLUDES the frontend suite.
    # Leaving it $false meant an unreadable commit command ran everything
    # EXCEPT the frontend tests -- a fail-closed branch with a hole in it
    # (codex review, TASK-102).
    $policy = [pscustomobject]@{ tier = 'full'; pytest_targets = @(); serial_targets = @(); frontend = $true; notice = '' }
}
else {
    $diffArgs = @('diff', '--cached', '--name-only', '--no-renames', '-z')
    if ($intent.diff -eq 'head') {
        $diffArgs = @('diff', '--name-only', '--no-renames', '-z', 'HEAD')
    }
    try {
        $pathsResult = Invoke-Bounded -FilePath $gitExe -Arguments $diffArgs `
            -TimeoutSeconds 15 -WorkingDirectory $root
    }
    catch {
        Write-Block -Label 'commit-risk-policy' -Output "could not list changed paths: $($_.Exception.Message)"
    }
    if ($pathsResult.ExitCode -ne 0) {
        $out = $pathsResult.Output
        if ($pathsResult.TimedOut) { $out = "$out`n[timed out after 15s]" }
        Write-Block -Label 'commit-risk-policy' -Output "could not list changed paths:`n$out"
    }
    # Split on NUL, not on newlines: with `-z` above that is the record separator,
    # and it is also what makes a path CONTAINING a newline stay one path.
    $changedPaths = @(
        $pathsResult.Output -split "`0" | Where-Object { $_ -and $_.Trim() }
    )
    # ADR-0068 opt-in, ALREADY RESOLVED by the intent call. Deriving it a second
    # time is how two implementations of one rule appear -- and matching it here
    # was wrong twice over before: PowerShell's -like is case-INSENSITIVE while
    # gate.sh's grep -F is not (so the platforms disagreed), and an unanchored
    # match let a commit MESSAGE switch the gate off.
    # `--` ends the flags so a changed file named like one stays a path.
    $chainFlag = if ($intent.chain_mode) { '1' } else { '0' }
    $policyArgs = @($policyPath, '--chain-mode', $chainFlag, '--')
    # FAIL CLOSED on a spawn that never starts. The intercepted command no longer
    # travels on this command line -- it goes to the intent call on a PIPE -- so
    # the 32767-char budget is spent on changed paths alone now. It used to carry
    # the commit MESSAGE as well, and a long message plus a wide change set pushed
    # Process.Start over the limit; with $ErrorActionPreference='Stop' and no
    # catch, that terminating error exited the SCRIPT with 1, which PreToolUse
    # reads as a NON-BLOCKING hook error, so the commit proceeded with ZERO checks
    # run (independent review, round 3; measured OK at 30125 chars, Win32Exception
    # at 40125). The catch stays regardless: a change set can still be wide.
    try {
        $policyResult = Invoke-Bounded -FilePath $py -Arguments ($policyArgs + $changedPaths) `
            -TimeoutSeconds 15 -WorkingDirectory $root
    }
    catch {
        Write-Block -Label 'commit-risk-policy' -Output @"
could not run the risk classifier: $($_.Exception.Message)

If this says the filename or extension is too long, the changed-path list is too
long to hand over (32767-char command-line budget). Stage fewer paths per commit.
The gate refuses to vouch for code it could not classify.
"@
    }
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
}

$checks = @(
    @{ Label = 'ruff format --check'; Timeout = 15; File = $py; Args = @('-m', 'ruff', 'format', '--check', '.') },
    @{ Label = 'ruff check'; Timeout = 15; File = $py; Args = @('-m', 'ruff', 'check', '.') }
)

# Frontend suite assembly, shared by the `frontend` tier and the `frontend`
# FLAG a python+frontend mixed change carries (ADR-0080). FAIL CLOSED, like
# every other spawn in Phase B. With $ErrorActionPreference='Stop' a missing
# test directory is a TERMINATING error, and an unhandled one exits the script
# with 1 -- which PreToolUse reads as a non-blocking hook error, so the commit
# lands with ZERO checks run (not even ruff, since tier assembly runs before
# the check loop). A commit that MOVES mockups/motv-workspace/tests/ classifies
# as `frontend` and hits exactly this (independent review, round 4); the
# `-eq 0` guard below is dead in that case because the throw comes first.
function Get-FrontendSuiteCheck {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Block -Label 'frontend tests' -Output 'node was not found on PATH.'
    }
    try {
        $nodeTests = @(
            Get-ChildItem -LiteralPath (Join-Path $root 'mockups\motv-workspace\tests') -Filter '*.test.mjs' |
                Sort-Object Name |
                ForEach-Object FullName
        )
    }
    catch {
        Write-Block -Label 'frontend tests' -Output "could not list frontend test files: $($_.Exception.Message)"
    }
    if ($nodeTests.Count -eq 0) {
        Write-Block -Label 'frontend tests' -Output 'no frontend test files were found.'
    }
    return @{ Label = 'frontend tests'; Timeout = 90; File = $node.Source; Args = @('--test') + $nodeTests }
}

switch ($policy.tier) {
    'full' {
        # Two phases (see pyproject.toml [tool.pytest.ini_options].markers):
        # everything parallel under xdist, then the serial process-tree tests.
        # Measured 2026-08-14 on this host, SAME 3191 tests both ways:
        # serial 469s -> two-phase 179s (132s parallel + 47s serial), 2.6x.
        # Do NOT compare against the older 328s/2815-tests figure elsewhere in
        # this file's history -- that ran FEWER tests, so mixing the two reads a
        # suite that grew as a performance regression (AGENTS.md keeps both
        # numbers with their test counts for exactly this reason).
        # The win is I/O overlap: native Windows has no /dev/shm, so the
        # tests/conftest.py tmpfs route is a no-op here and every persist
        # fsyncs to NTFS. -n 8 (not `auto`=12) is the measured setting; more
        # workers stop paying once fsync dominates.
        $checks += @{ Label = 'pytest (full, parallel)'; Timeout = 600; File = $py; Args = @('-m', 'pytest', '-n', '8', '-m', 'not serial') }
        $checks += @{ Label = 'pytest (full, serial)';   Timeout = 180; File = $py; Args = @('-m', 'pytest', '-m', 'serial') }
        if ($policy.frontend) {
            $checks += Get-FrontendSuiteCheck
        }
    }
    'pytest-targeted' {
        # Ownership-mapped selection (ADR-0080). Directory-level targets can be
        # most of a pytest domain, so the parallel run uses the same xdist
        # setting as the full tier and excludes the serial marker; the
        # real-process-tree tests arrive separately in serial_targets and must
        # never go through xdist.
        if (@($policy.pytest_targets).Count -gt 0) {
            $checks += @{ Label = 'pytest (targeted)'; Timeout = 480; File = $py; Args = @('-m', 'pytest', '-n', '8', '-m', 'not serial') + @($policy.pytest_targets) }
        }
        if (@($policy.serial_targets).Count -gt 0) {
            $checks += @{ Label = 'pytest (targeted, serial)'; Timeout = 120; File = $py; Args = @('-m', 'pytest') + @($policy.serial_targets) }
        }
        if ($policy.frontend) {
            $checks += Get-FrontendSuiteCheck
        }
    }
    'frontend' {
        $checks += Get-FrontendSuiteCheck
    }
    'lint' { }
    'continuous-chain' {
        # ADR-0068: the whole-suite run is deferred to the end of an authorised
        # chain. Announced below, never silent.
    }
    default {
        # ADR-0068 decision 6 (opt-in riding along with a push/merge) used to be a
        # tier here. It is decided in Phase A now, because the intent call already
        # has the tokens and blocking before the checks -- rather than after ruff,
        # which is where gate.sh reached it -- makes the two shells agree on WHEN
        # as well as on WHAT. Anything unexpected reaching this branch blocks.
        Write-Block -Label 'commit-risk-policy' -Output "unsupported risk tier: $($policy.tier)"
    }
}

# The doctor (.claude/tools/motv_doctor.py) runs whenever this app changed.
# Rationale (2026-08-31): the six defects of 08-30..08-31 were all found by the
# product owner while 2039 frontend tests stayed green -- those tests guard code
# SHAPE, the doctor checks what he actually sees on screen. It hangs off the gate
# rather than off my memory: a check that depends on remembering is not a check.
# It runs against the real projects; a machine without any passes (not fails), so
# CI and other machines are never blocked by it.
if ($policy.doctor) {
    $doctorScript = Join-Path $root (Join-Path '.claude' (Join-Path 'tools' 'motv_doctor.py'))
    # SEGMENTS, NEVER ONE LITERAL. This line once held the whole relative path in a
    # single-quoted string; a tool that writes PowerShell expanded its backslash-t
    # into a real TAB, so the gate looked for a file whose name began with a tab and
    # EVERY app commit on Windows failed with [Errno 22] -- while the .sh twin, which
    # never had the escape, kept passing. Two implementations, two verdicts: exactly
    # what ADR-0062 decision 3 forbids. A guard in tests/tooling/ now refuses any
    # literal tab here. (ASCII only in this file -- see the isascii guard.)
    $checks += @{ Label = 'motv doctor'; Timeout = 60; File = $py; Args = @($doctorScript) }
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

# --- announce a deferred whole-suite run (ADR-0068) --------------------------
# ONLY on the allow path, and only via JSON. PLAIN stdout from a PreToolUse hook
# that exits 0 is DISCARDED: not shown to the user, not given to the model -- so
# the previous [Console]::Out.WriteLine announced the skip to nobody, and the
# comment that justified the stream choice had it backwards (independent review,
# round 3, confirmed against the hooks documentation).
#
# `systemMessage` alone is the documented pass-through: shown to the user, and
# with `hookSpecificOutput` omitted NO permission decision is made -- an
# allowlisted commit stays allowlisted and nothing is auto-approved.
# The payload is forced to pure ASCII before it is written. PowerShell 5.1's
# ConvertTo-Json does NOT escape non-ASCII (measured: 308 chars, 308 != UTF-8
# byte count), so the notice's Chinese lines would be emitted in the CONSOLE's
# codepage -- cp932 bytes that the harness, which reads UTF-8, cannot parse. The
# result would be an unparseable-JSON hook error instead of the warning. Python's
# json.dumps escapes by default, which is why gate.sh needs no equivalent; this
# is the same output, reached the other way.
# Trim BEFORE the test, like gate.sh's `.strip()` before its `if notice:`.
# Testing first and trimming second differs only for an all-whitespace notice --
# gate.ps1 would announce an empty message where gate.sh stays silent. Equivalent
# today, divergent tomorrow, which is the whole reason this block is keyed on the
# notice in both shells.
$noticeText = "$($policy.notice)".Trim()
if ($noticeText) {
    try {
        $payload = @{ systemMessage = "gate.ps1: $noticeText" } | ConvertTo-Json -Compress
        $payload = [regex]::Replace(
            $payload, '[^\x20-\x7E]',
            { param($m) '\u{0:x4}' -f [int][char]$m.Value })
        # INSIDE the try, or the one statement that does the announcing is the
        # one statement whose failure is not caught -- and this block's own
        # comment says an unannounceable skip must be refused, not granted.
        [Console]::Out.WriteLine($payload)
    }
    catch {
        # A skip that cannot be announced is the invisible skip ADR-0068 decision 7
        # exists to prevent: refuse it rather than grant it silently.
        Write-Block -Label 'continuous-chain' -Output "could not emit the skip notice: $($_.Exception.Message)"
    }
}

exit 0
