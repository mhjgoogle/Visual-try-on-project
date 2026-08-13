#Requires -Version 5.1
<#
.SYNOPSIS
  run-review.ps1 -- hand the current diff to a read-only reviewer and print a
  structured verdict. Native Windows PowerShell port of run-review.sh
  (ADR-0050). Single responsibility: produce ONE review report.

.DESCRIPTION
  Reviewer selection:
    1. codex  -- preferred, cross-model independent reviewer.
    2. claude -- automatic fallback when codex is unavailable for ANY reason
                (not installed / not authenticated / quota exhausted / rate
                limited / subcommand missing / no VERDICT produced).

  Environment problems (no codex AND no claude, not a git repo, no changes)
  are reported on stdout and ALWAYS exit 0 -- never a non-zero code -- so the
  caller cannot mistake an environment issue for a code problem.

.EXAMPLE
  run-review.ps1                # review uncommitted changes (staged+unstaged)

.EXAMPLE
  run-review.ps1 main           # review current branch vs main
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Base = ''
)

$ErrorActionPreference = 'Stop'

# An unexpected internal failure must still leave the caller with a readable
# line on stdout and exit 0, never a bare non-zero code it would misread as a
# code problem (see .DESCRIPTION).
trap {
    Write-Output "ENV_ERROR: run-review.ps1 internal error: $($_.Exception.Message)"
    exit 0
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-EnvOrDefault {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Default
    )
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

# --- token-saving knobs (override via env) ----------------------------------
# Fewer context lines and a hard size cap keep the number of tokens shipped to
# the reviewer (and, on the claude fallback, your quota) bounded.
$Ctx = [int](Get-EnvOrDefault 'REVIEW_DIFF_CONTEXT' '1')      # unified context lines (default 1, vs git's 3)
$MaxLines = [int](Get-EnvOrDefault 'REVIEW_MAX_DIFF_LINES' '4000')  # refuse to review a diff larger than this
# Hard wall-clock cap on EACH reviewer invocation so a hung/stalled reviewer can
# never block for hours. On timeout the reviewer is treated as failed (codex ->
# falls back to claude; claude -> ENV_ERROR). Override via REVIEW_TIMEOUT (secs).
# NOTE: a real review of a 1-2k line diff takes 6-10 minutes on either reviewer.
# 1800s: a premature kill wastes the whole review AND burns a claude-fallback
# run, while a hung reviewer (rare) merely waits longer in the background. The
# asymmetry favours a generous cap. This script MUST therefore be launched as a
# background task (see SKILL.md), never in a foreground Bash call (600s cap).
$ReviewTimeout = [int](Get-EnvOrDefault 'REVIEW_TIMEOUT' '1800')
# Local git plumbing is fast; cap it anyway so a hung git can never wedge a
# background review.
$GitTimeout = 120

# Paths whose diffs are noise for a correctness/security review -- kept out of
# the diff so they never cost tokens. Extend via REVIEW_EXTRA_EXCLUDES (space
# separated pathspecs).
$Excludes = @(
    ':(exclude).claude/tmp/**'
    ':(exclude)**/*.lock'
    ':(exclude)**/package-lock.json'
    ':(exclude)**/*.min.js'
)
$extra = [Environment]::GetEnvironmentVariable('REVIEW_EXTRA_EXCLUDES')
if (-not [string]::IsNullOrWhiteSpace($extra)) {
    $Excludes += ($extra -split '\s+' | Where-Object { $_ })
}

# ---------------------------------------------------------------------------
# Process helpers (kept self-contained on purpose, mirroring .claude/hooks/
# gate.ps1: these scripts must run standalone without dot-sourcing a sibling.)
# ---------------------------------------------------------------------------

# Quote one argument the way CommandLineToArgvW parses it back.
# ProcessStartInfo.Arguments is a single raw string, so quoting is our job.
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
# @{ExitCode; StdOut; StdErr; TimedOut}. ExitCode is 124 on timeout, mirroring
# the coreutils `timeout` convention run-review.sh relied on.
#
# stdout and stderr are drained by async tasks started BEFORE stdin is written
# and before the wait, so a large prompt in / large review out can never
# deadlock against a full pipe buffer. StdinText is written as raw UTF-8 bytes
# because .NET Framework has no StandardInputEncoding.
function Invoke-Bounded {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [string]$StdinText
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-CommandLineArg $_ }) -join ' ')
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $Utf8NoBom
    $psi.StandardErrorEncoding = $Utf8NoBom
    $useStdin = $PSBoundParameters.ContainsKey('StdinText')
    if ($useStdin) { $psi.RedirectStandardInput = $true }

    $proc = [System.Diagnostics.Process]::Start($psi)
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $limitMs = [double]$TimeoutSeconds * 1000
    try {
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()

        $timedOut = $false
        if ($useStdin) {
            # WriteAsync plus a bounded wait, NOT a plain Write: the prompt is
            # far larger than the ~64 KB pipe buffer, so a reviewer that starts
            # but never drains stdin would block a synchronous write forever --
            # before the timeout below ever begins, defeating it entirely.
            $bytes = $Utf8NoBom.GetBytes($StdinText)
            try {
                $writeTask = $proc.StandardInput.BaseStream.WriteAsync($bytes, 0, $bytes.Length)
                if ($writeTask.Wait([int][Math]::Max(0, $limitMs - $clock.ElapsedMilliseconds))) {
                    $proc.StandardInput.BaseStream.Flush()
                    $proc.StandardInput.Close()
                }
                else {
                    $timedOut = $true
                }
            }
            catch {
                # The child died before reading the prompt (broken pipe). Its
                # exit code and stderr are the real signal; close and continue.
                try { $proc.StandardInput.Close() } catch { }
            }
        }

        if (-not $timedOut) {
            $remainingMs = [int][Math]::Max(0, $limitMs - $clock.ElapsedMilliseconds)
            if (-not $proc.WaitForExit($remainingMs)) { $timedOut = $true }
        }
        if ($timedOut) {
            Stop-ProcessTree -ProcessId $proc.Id
            [void]$proc.WaitForExit(10000)
        }
        # The no-arg overload also waits for the redirected streams to close --
        # but only call it once the process is really gone, or a failed tree
        # kill would hang here with no timeout at all.
        if ($proc.HasExited) { $proc.WaitForExit() }

        # Bounded reads for the same reason: a surviving grandchild still holds
        # the pipe's write end, and .Result would wait on it forever.
        $stdout = if ($outTask.Wait(10000)) { [string]$outTask.Result } else { '' }
        $stderr = if ($errTask.Wait(10000)) { [string]$errTask.Result } else { '' }

        $code = if ($timedOut -or -not $proc.HasExited) { 124 } else { $proc.ExitCode }
        return [pscustomobject]@{
            ExitCode = $code
            StdOut   = $stdout
            StdErr   = $stderr
            TimedOut = $timedOut
        }
    }
    finally {
        $proc.Dispose()
    }
}

# --- persist all output ------------------------------------------------------
# Mirror everything printed to a file so the verdict survives even if the
# calling session is interrupted (e.g. an API/stream error) while waiting.
$OutFile = Get-EnvOrDefault 'REVIEW_OUT_FILE' '.claude/tmp/last-review-output.txt'
$OutReady = $false
try {
    $outDir = Split-Path -Parent $OutFile
    if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    }
    [System.IO.File]::WriteAllText($OutFile, '', $Utf8NoBom)   # truncate, like `tee`
    $OutReady = $true
}
catch {
    $OutReady = $false
}

function Write-Report {
    param([Parameter(ValueFromPipeline = $true)][AllowEmptyString()][string]$Text = '')
    process {
        Write-Output $Text
        if ($OutReady) {
            try { [System.IO.File]::AppendAllText($OutFile, $Text + "`n", $Utf8NoBom) } catch { }
        }
    }
}

# --- live status journal -----------------------------------------------------
# One timestamped line per lifecycle event, appended to a log the user can
# follow live (`Get-Content -Wait .claude/tmp/review-status.log`) to tell a
# slow-but-healthy review apart from a dead one. Never fails the script.
$StatusFile = Get-EnvOrDefault 'REVIEW_STATUS_FILE' '.claude/tmp/review-status.log'
# Optional task label (e.g. REVIEW_TASK=TASK-026) prefixed to every status line
# so the log says WHICH task each review run belongs to.
$ReviewTask = Get-EnvOrDefault 'REVIEW_TASK' ''

function Write-Status {
    param([Parameter(Mandatory = $true)][string]$Message)
    try {
        $statusDir = Split-Path -Parent $StatusFile
        if ($statusDir -and -not (Test-Path -LiteralPath $statusDir)) {
            New-Item -ItemType Directory -Force -Path $statusDir | Out-Null
        }
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        $line = if ($ReviewTask) { "[$stamp] [$ReviewTask] $Message" } else { "[$stamp] $Message" }
        [System.IO.File]::AppendAllText($StatusFile, $line + "`n", $Utf8NoBom)
    }
    catch { }
}

# --- environment: git -------------------------------------------------------
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Status 'ENV_ERROR: git not found on PATH'
    Write-Report 'ENV_ERROR: git not found on PATH; nothing to review.'
    exit 0
}
$GitExe = $gitCmd.Source

$Root = ''
try {
    $probe = (& $GitExe rev-parse --show-toplevel 2>$null) | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and $probe) { $Root = ([string]$probe).Trim() }
}
catch { $Root = '' }
if (-not $Root) {
    Write-Status 'ENV_ERROR: not inside a git repository'
    Write-Report 'ENV_ERROR: not inside a git repository; nothing to review.'
    exit 0
}

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$GitArgs, [int]$TimeoutSeconds = $GitTimeout)
    return Invoke-Bounded -FilePath $GitExe -Arguments $GitArgs `
        -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $Root
}

# Same, but for the calls whose OUTPUT IS THE DIFF. A failed or timed-out git
# here returns empty stdout, which would silently degrade into "NO_CHANGES" or
# a review of a partial diff -- i.e. a clean bill of health for code nobody
# looked at. Fail closed instead.
function Invoke-GitDiffOrFail {
    param([Parameter(Mandatory = $true)][string[]]$GitArgs)
    $r = Invoke-Git $GitArgs
    if ($r.ExitCode -ne 0) {
        $why = if ($r.TimedOut) { "timed out after ${GitTimeout}s" } else { "exit $($r.ExitCode)" }
        $detail = ($r.StdErr -replace '\s+', ' ').Trim()
        if ($detail.Length -gt 200) { $detail = $detail.Substring(0, 200) }
        $shown = 'git ' + ($GitArgs -join ' ')
        Write-Status "ENV_ERROR: '$shown' failed ($why)"
        Write-Report "ENV_ERROR: '$shown' failed ($why); refusing to review a diff that may be incomplete. $detail"
        exit 0
    }
    return $r.StdOut
}

# --- compute the diff -------------------------------------------------------
# Untracked (never-committed) files are invisible to `git diff HEAD`, so a
# freshly implemented module would silently escape review. Emit each one as an
# added-file diff via --no-index. Respects .gitignore and the same $Excludes.
function Test-BinaryFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $buffer = New-Object byte[] 8000
            $read = $stream.Read($buffer, 0, $buffer.Length)
            for ($i = 0; $i -lt $read; $i++) {
                if ($buffer[$i] -eq 0) { return $true }
            }
            return $false
        }
        finally { $stream.Dispose() }
    }
    catch {
        return $true   # unreadable -> treat as binary and skip
    }
}

function Get-UntrackedDiff {
    # -z: NUL-separated and never C-quoted. Without it git quotes any path with
    # non-ASCII or special characters ("src/\346\226\207.py"), which then fails
    # Test-Path and drops a brand-new source file out of the review silently.
    $listedOut = Invoke-GitDiffOrFail (@('ls-files', '-z', '--others', '--exclude-standard', '--', '.') + $Excludes)
    $chunks = New-Object System.Collections.Generic.List[string]
    foreach ($rel in ($listedOut -split "`0")) {
        if (-not $rel) { continue }
        $full = Join-Path $Root $rel
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }   # skip dirs/specials
        $info = Get-Item -LiteralPath $full
        if ($info.Length -gt 0 -and (Test-BinaryFile $full)) { continue }      # non-empty binary -> skip
        # `git diff --no-index` exits 1 when the files differ -- that is the
        # normal case here. Anything above that is a real failure, and dropping
        # the file would remove a brand-new module from the review unnoticed.
        $d = Invoke-Git @('diff', "-U$Ctx", '--no-index', '--', '/dev/null', $rel)
        if ($d.ExitCode -gt 1 -or $d.TimedOut) {
            $why = if ($d.TimedOut) { "timed out after ${GitTimeout}s" } else { "exit $($d.ExitCode)" }
            Write-Status "ENV_ERROR: diffing untracked '$rel' failed ($why)"
            Write-Report "ENV_ERROR: diffing untracked file '$rel' failed ($why); refusing to review a diff that would silently omit it."
            exit 0
        }
        if ($d.StdOut) { $chunks.Add($d.StdOut) }
    }
    return ($chunks -join '')
}

$diffParts = New-Object System.Collections.Generic.List[string]
if ($Base) {
    $verify = Invoke-Git @('rev-parse', '--verify', '-q', $Base)
    if ($verify.ExitCode -ne 0) {
        Write-Status "ENV_ERROR: base ref '$Base' not found"
        Write-Report "ENV_ERROR: base ref '$Base' not found; cannot compute diff."
        exit 0
    }
    # Changes introduced on HEAD since it diverged from BASE, plus untracked
    # working-tree files (they are part of the work under review either way).
    $diffParts.Add((Invoke-GitDiffOrFail (@('diff', "-U$Ctx", "$Base...HEAD", '--', '.') + $Excludes)))
    $diffParts.Add((Get-UntrackedDiff))
}
else {
    # Uncommitted changes vs HEAD: staged + unstaged + untracked.
    $hasHead = (Invoke-Git @('rev-parse', '--verify', '-q', 'HEAD')).ExitCode -eq 0
    if ($hasHead) {
        $diffParts.Add((Invoke-GitDiffOrFail (@('diff', "-U$Ctx", 'HEAD', '--', '.') + $Excludes)))
    }
    else {
        # No commits yet: combine unstaged, staged, and untracked.
        $diffParts.Add((Invoke-GitDiffOrFail (@('diff', "-U$Ctx", '--', '.') + $Excludes)))
        $diffParts.Add((Invoke-GitDiffOrFail (@('diff', "-U$Ctx", '--cached', '--', '.') + $Excludes)))
    }
    $diffParts.Add((Get-UntrackedDiff))
}
$Diff = ($diffParts | Where-Object { $_ }) -join ''

if ([string]::IsNullOrWhiteSpace($Diff)) {
    Write-Status 'NO_CHANGES: nothing to review'
    Write-Report 'NO_CHANGES: no diff to review (working tree clean or base is up to date).'
    exit 0
}

# Token guard: refuse an oversized diff instead of burning tokens on it.
$DiffLines = ($Diff.TrimEnd("`n") -split "`n").Count
if ($DiffLines -gt $MaxLines) {
    Write-Status "DIFF_TOO_LARGE: $DiffLines lines > $MaxLines"
    Write-Report "DIFF_TOO_LARGE: diff is $DiffLines lines (> $MaxLines); refusing to send it to the reviewer to save tokens."
    Write-Report 'Narrow scope: commit/stage a smaller subset, review a base branch (run-review.ps1 <base>), or raise REVIEW_MAX_DIFF_LINES.'
    exit 0
}

# --- build the review prompt (identical for both reviewers) -----------------
$Instructions = @'
You are a strict, read-only code reviewer. Review ONLY the unified diff given
below. Do not modify any files.

Review through EXACTLY these four lenses and nothing else:
  1. correctness / bug risk
  2. regression risk
  3. edge cases
  4. security

Rules:
- Every issue MUST cite a file path and line number, and explain WHY it is a
  problem (what breaks, under what input/condition).
- Mark anything you are not sure about with the literal tag (uncertain).
- DO NOT propose architecture changes or refactors of any kind. Architecture is
  decided by ADRs, not by this review. Such suggestions are out of scope and
  forbidden -- they prevent the fix loop from ever converging.
- DO NOT report style nitpicks unless the style directly causes a bug.
- If you find no blocking issues, say so with VERDICT: pass.
- Be terse to save tokens: ONE line per finding, no preamble, no summary, and
  do NOT restate or quote the diff back.

Output STRICTLY in the following format, with NO extra text before or after it:

VERDICT: pass|fail
BLOCKING:
- [file:line] description -> impact
NON_BLOCKING:
- [file:line] description -> impact

If a section has no items, keep the header and write "- (none)" under it.

Here is the unified diff to review:
'@

$Prompt = $Instructions + "`n" + $Diff

# --- reviewer helpers -------------------------------------------------------
# Resolved by name (never bare-name Popen), per ADR-0049 decision 3. The env
# overrides exist because both CLIs ship inside per-user installs that are
# frequently NOT on PATH on Windows; point them at the executable directly.
function Resolve-Reviewer {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$EnvVar)
    $override = [Environment]::GetEnvironmentVariable($EnvVar)
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        if (Test-Path -LiteralPath $override -PathType Leaf) { return $override }
        return $null
    }
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

# A completed review is one that states a decision. `(^|\n)` anchors it to the
# start of a line so a quoted mention inside prose cannot satisfy it, and the
# trailing `(\s|$)` is deliberately NOT `\b`: `\b` accepts the literal template
# line 'VERDICT: pass|fail', so an echoed or truncated prompt would count as a
# finished review.
$VERDICT_PATTERN = '(^|\n)\s*VERDICT:\s*(pass|fail)(\s|$)'

$CodexExe = Resolve-Reviewer -Name 'codex' -EnvVar 'REVIEW_CODEX_BIN'
$ClaudeExe = Resolve-Reviewer -Name 'claude' -EnvVar 'REVIEW_CLAUDE_BIN'

$script:LastError = ''

function Get-ShortReason {
    param([string]$Text, [string]$Fallback)
    $flat = ($Text -replace '\s+', ' ').Trim()
    if (-not $flat) { return $Fallback }
    if ($flat.Length -gt 300) { $flat = $flat.Substring(0, 300) }
    return $flat
}

# Run one reviewer. On success returns its output; on any failure returns $null
# and leaves a short reason in $script:LastError.
function Invoke-Reviewer {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ReviewerArgs
    )
    $script:LastError = ''
    try {
        # Feed the prompt via stdin, not argv: a large argv prompt overflows the
        # 32k command-line limit and makes codex mis-handle stdin.
        $r = Invoke-Bounded -FilePath $FilePath -Arguments $ReviewerArgs `
            -TimeoutSeconds $ReviewTimeout -WorkingDirectory $Root -StdinText $Prompt
    }
    catch {
        $script:LastError = "$Name could not be started: $($_.Exception.Message)"
        return $null
    }
    if ($r.TimedOut) {
        $script:LastError = "$Name timed out after ${ReviewTimeout}s"
        return $null
    }
    if ($r.ExitCode -ne 0) {
        $script:LastError = Get-ShortReason -Text $r.StdErr -Fallback "$Name exited with code $($r.ExitCode)"
        return $null
    }
    # A DECISION is required, not merely the word VERDICT: a refusal or a
    # truncated answer that happens to echo the template ("VERDICT: unknown",
    # "output VERDICT: pass|fail") must count as a failed review and fall
    # through to the next reviewer, never be reported as a completed one.
    if ($r.StdOut -notmatch $VERDICT_PATTERN) {
        $script:LastError = "$Name produced no 'VERDICT: pass|fail' line"
        return $null
    }
    return $r.StdOut
}

function Get-VerdictLine {
    param([string]$Text)
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match $VERDICT_PATTERN) { return $line.Trim() }
    }
    return 'VERDICT: (none)'
}

# --- reviewer selection: codex first, claude fallback -----------------------
$scope = if ($Base) { $Base } else { 'uncommitted' }
Write-Status "review started: $DiffLines-line diff ($scope); per-reviewer cap ${ReviewTimeout}s"

if ($CodexExe) {
    Write-Status 'codex reviewing... (normal duration 6-10 min; this is NOT hung)'
    $out = Invoke-Reviewer -Name 'codex' -FilePath $CodexExe -ReviewerArgs @('exec', '--sandbox', 'read-only', '-')
    if ($out) {
        Write-Status "codex done: $(Get-VerdictLine $out)"
        Write-Report 'REVIEWER: codex'
        Write-Report $out
        exit 0
    }
    $reason = Get-ShortReason -Text $script:LastError -Fallback 'codex unavailable or failed'
    if ($ClaudeExe) {
        Write-Status "codex failed ($reason); falling back to claude"
        $out = Invoke-Reviewer -Name 'claude' -FilePath $ClaudeExe -ReviewerArgs @('-p')
        if ($out) {
            Write-Status "claude (fallback) done: $(Get-VerdictLine $out)"
            Write-Report "REVIEWER: claude (fallback; codex unavailable: $reason)"
            Write-Report 'INDEPENDENCE: degraded - reviewer and implementer are the same model.'
            Write-Report $out
            exit 0
        }
        Write-Status 'ENV_ERROR: both reviewers failed'
        Write-Report "ENV_ERROR: codex failed ($reason) and claude fallback also failed: $(Get-ShortReason -Text $script:LastError -Fallback 'unknown error')"
        exit 0
    }
    Write-Status 'ENV_ERROR: codex failed and no claude fallback'
    Write-Report "ENV_ERROR: codex unavailable ($reason) and claude fallback is not installed."
    exit 0
}

# codex not installed at all -> go straight to claude fallback.
if ($ClaudeExe) {
    Write-Status 'codex not installed; claude (fallback) reviewing... (normal duration 5-10 min)'
    $out = Invoke-Reviewer -Name 'claude' -FilePath $ClaudeExe -ReviewerArgs @('-p')
    if ($out) {
        Write-Status "claude (fallback) done: $(Get-VerdictLine $out)"
        Write-Report 'REVIEWER: claude (fallback; codex not installed)'
        Write-Report 'INDEPENDENCE: degraded - reviewer and implementer are the same model.'
        Write-Report $out
        exit 0
    }
    Write-Status 'ENV_ERROR: claude fallback failed (codex not installed)'
    Write-Report "ENV_ERROR: codex not installed and claude fallback failed: $(Get-ShortReason -Text $script:LastError -Fallback 'unknown error')"
    exit 0
}

Write-Status 'ENV_ERROR: no reviewer installed'
Write-Report 'ENV_ERROR: neither codex nor claude is installed; cannot run a review.'
exit 0
