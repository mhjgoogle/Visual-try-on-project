"""The Review Package must reach the reviewer, or the run must stop.

ADR-0088 决策 5. Gates 1–3 of a review (requirement fulfilment / architecture
conformance / verification sufficiency) can only be answered from material that
is IN the prompt. So the package is not decoration: if it was requested and
cannot be read, printing a normal verdict would claim coverage the run never had
-- the same hole `test_review_script_readability.py` closes for an unreadable
source file.

WHAT IS EXERCISED FOR REAL. The three package gates (missing / empty /
oversized) run before any reviewer is resolved, so both shells are executed for
real here and must produce the SAME message (ADR-0050 决策 1). The happy path is
executed on bash with a stub reviewer that captures the prompt; the PowerShell
prompt assembly is covered by the byte-for-byte instruction-parity assertion,
because .NET's ProcessStartInfo cannot launch a shell-script stub the way bash
can and a fake reviewer binary would be testing .NET, not this contract.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _ROOT / ".claude" / "skills" / "codex-review-loop" / "scripts"
_SH = _SCRIPTS / "run-review.sh"
_PS1 = _SCRIPTS / "run-review.ps1"


def _windows_bash() -> str | None:
    """一个**看得懂 Windows 路径**的 bash。

    `shutil.which("bash")` 拿到的是 PATH 上的第一个，而在这台机器上那要看是谁启动
    的 pytest：Git Bash 里跑拿到 `Git\\usr\\bin\\bash.exe`（能开 `D:/...`），
    PowerShell 里跑拿到 `System32\\bash.exe` —— **那是 WSL 的 bash**，它的根是
    `/`，`D:/…` 在它眼里根本不存在，于是每一条都以 127 「No such file or directory」
    倒下。

    **同一份代码，红不红取决于是哪个终端启动的 pytest。** 这一族失败被当成过
    「并发干扰」「机器负载」放过至少两次（2026-09-05 我自己就写过一次这样的结论），
    而真相是这一行 —— 一个结果取决于启动环境的测试，比没有测试更误导人。

    所以这里**显式挑**：先认 Git Bash（`msys`/`mingw` 布局），拿不到就返回 None
    让用例 skip 并说明白，而不是随手抓一个跑不通的。
    """
    candidates = []
    first = shutil.which("bash")
    if first:
        candidates.append(first)
    for extra in (
        os.environ.get("PROGRAMFILES", r"C:\Program Files") + r"\Git\usr\bin\bash.exe",
        os.environ.get("PROGRAMFILES", r"C:\Program Files") + r"\Git\bin\bash.exe",
    ):
        candidates.append(extra)
    for cand in candidates:
        if not cand or not Path(cand).is_file():
            continue
        # WSL 的 bash 住在 System32；它看不见 Windows 路径。
        if "system32" in cand.replace("/", "\\").lower():
            continue
        return cand
    return None


_BASH = _windows_bash()


def _bash_toolchain() -> str:
    """`run-review.sh` 要用的那套 Unix 工具（`mktemp` 等）住在哪。

    光挑对 bash 还不够 —— 子进程继承的是**启动 pytest 那个终端的 PATH**：
    Git Bash 里跑，`Git\\usr\\bin` 在 PATH 上，`mktemp` 找得到；PowerShell 里跑，
    它不在，脚本第 74 行就以 `mktemp: command not found` 倒下。

    **同一份代码，红不红取决于是哪个终端启动的 pytest。** 所以这里把工具目录
    显式补进子进程的 PATH，让这条合同测试与启动方式无关 —— 一个结果取决于启动
    环境的测试，比没有测试更误导人（2026-09-05 这一族被当成「并发干扰」放过两次）。
    """
    dirs = []
    if _BASH:
        bash_dir = Path(_BASH).parent  # …\Git\usr\bin 或 …\Git\bin
        dirs.append(str(bash_dir))
        git_root = bash_dir.parent.parent if bash_dir.name == "bin" else bash_dir.parent
        for sub in (("usr", "bin"), ("bin",), ("mingw64", "bin")):
            cand = git_root.joinpath(*sub)
            if cand.is_dir():
                dirs.append(str(cand))
    seen, out = set(), []
    for d in dirs:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return os.pathsep.join(out)


_BASH_TOOLS = _bash_toolchain()
_TIMEOUT = shutil.which("timeout")
_POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")
_GIT = shutil.which("git")

_needs_bash = pytest.mark.skipif(
    not (_BASH and _TIMEOUT and _GIT), reason="bash/timeout/git not available"
)
_needs_powershell = pytest.mark.skipif(
    not (_POWERSHELL and _GIT), reason="powershell/git not available"
)

_PACKAGE = """# Review Package — TASK-108

## Requirements claimed
- REQ-003 v1 判据 3：每条判据得到 PASS / PARTIAL / FAIL / NOT_EVIDENCED 之一

## Architecture constraints in force
- CA §4 测试归属：Agent 工装的测试住 tests/tooling/
"""


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A tiny git repo with exactly one uncommitted change to review."""
    subprocess.run([_GIT, "init", "-q"], cwd=tmp_path, check=True)
    src = tmp_path / "app.py"
    src.write_text("def f():\n    return 1\n", "utf-8")
    subprocess.run([_GIT, "add", "app.py"], cwd=tmp_path, check=True)
    subprocess.run(
        [
            _GIT,
            "-c",
            "user.email=t@e.st",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "init",
        ],
        cwd=tmp_path,
        check=True,
    )
    src.write_text("def f():\n    return 2\n", "utf-8")
    return tmp_path


_COMPLETE_ANSWER = (
    "VERDICT: pass\n"
    "REQUIREMENT:\n- [REQ-003 v1 判据 3] PASS -> graded per criterion\n"
    "ARCHITECTURE:\n- [CA §4] PASS -> stays in tests/tooling\n"
    "VERIFICATION:\n- SUFFICIENT -> the behaviour itself is exercised\n"
    "BLOCKING:\n- (none)\nNON_BLOCKING:\n- (none)\n"
)
_BARE_ANSWER = "VERDICT: pass\n"


def _stub_reviewer(repo: Path, answer: str = _COMPLETE_ANSWER) -> tuple[Path, Path]:
    """`codex` AND `claude` on PATH, capturing the prompt they are handed.

    Both are stubbed on purpose: if only codex were, a rejected codex answer
    would fall through to the REAL claude fallback -- a live model call inside a
    unit test.
    """
    bindir = repo / "stubbin"
    bindir.mkdir()
    dump = repo / "prompt.txt"
    body = f"#!/usr/bin/env bash\ncat > \"{dump.as_posix()}\"\nprintf '%b' '{answer}'\n"
    for name in ("codex", "claude"):
        stub = bindir / name
        stub.write_text(body, "utf-8")
        stub.chmod(0o755)
    return bindir, dump


def _run_sh(repo: Path, env_extra: dict[str, str]) -> str:
    env = dict(os.environ)
    env.pop("REVIEW_PACKAGE", None)
    env.update({"REVIEW_TASK": "TASK-108", **env_extra})
    # PATH 的顺序有三层，每一层都是被一次红教出来的：
    #
    #   1. 用例自己的桩目录（codex/claude 的假件）—— 必须最前，否则测的不是这条脚本；
    #   2. **Git 的 Unix 工具** —— 必须排在环境 PATH 之前。放在后面的话，
    #      `timeout` 会解析到 `System32\timeout.exe`（语法完全不同，脚本当场报
    #      「Invalid syntax」），`mktemp` 则干脆找不到；
    #   3. 启动环境自己的 PATH。
    #
    # 这三层合起来只说明一件事：**这条测试原本继承了「谁启动的 pytest」**。
    # 从 Git Bash 里跑全绿，从 PowerShell 里跑全红，而代码一个字没变 ——
    # 这一族失败被当成「并发干扰」「机器负载」放过至少两次（2026-09-05）。
    stub = env_extra.get("PATH", "").split(os.pathsep)[0] if "PATH" in env_extra else ""
    env["PATH"] = os.pathsep.join(
        p for p in (stub, _BASH_TOOLS, os.environ.get("PATH", "")) if p
    )
    proc = subprocess.run(
        [_BASH, _SH.as_posix()],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def _run_ps1(repo: Path, env_extra: dict[str, str]) -> str:
    env = dict(os.environ)
    env.pop("REVIEW_PACKAGE", None)
    env.update({"REVIEW_TASK": "TASK-108", **env_extra})
    proc = subprocess.run(
        [
            _POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(_PS1),
        ],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


# --- 1. a package that was requested but cannot be used stops the run ---------


@_needs_bash
def test_bash_refuses_when_the_package_file_is_missing(repo: Path) -> None:
    out = _run_sh(repo, {"REVIEW_PACKAGE": "does-not-exist.md"})
    assert out.startswith("ENV_ERROR: cannot read review package")
    assert "does-not-exist.md" in out


@_needs_bash
def test_bash_refuses_an_empty_package(repo: Path) -> None:
    (repo / "pkg.md").write_text("   \n\n", "utf-8")
    out = _run_sh(repo, {"REVIEW_PACKAGE": "pkg.md"})
    assert out.startswith("ENV_ERROR: review package")
    assert "empty" in out


@_needs_bash
def test_bash_refuses_an_oversized_package(repo: Path) -> None:
    """The package exists to keep the reviewer out of the repo; a repo dump in
    the package spends exactly the tokens it was meant to save."""
    (repo / "pkg.md").write_text("x\n" * 40, "utf-8")
    out = _run_sh(repo, {"REVIEW_PACKAGE": "pkg.md", "REVIEW_MAX_PACKAGE_LINES": "10"})
    assert out.startswith("PACKAGE_TOO_LARGE")
    assert "40 lines" in out


@_needs_powershell
@pytest.mark.parametrize(
    "case,expected",
    [
        ("missing", "ENV_ERROR: cannot read review package"),
        ("empty", "ENV_ERROR: review package"),
        ("oversized", "PACKAGE_TOO_LARGE"),
    ],
)
def test_powershell_reaches_the_same_verdict_as_bash(
    repo: Path, case: str, expected: str
) -> None:
    """ADR-0050 决策 1: the two hosts must decide the same way."""
    env = {"REVIEW_PACKAGE": "pkg.md"}
    if case == "missing":
        env["REVIEW_PACKAGE"] = "does-not-exist.md"
    elif case == "empty":
        (repo / "pkg.md").write_text("   \n\n", "utf-8")
    else:
        (repo / "pkg.md").write_text("x\n" * 40, "utf-8")
        env["REVIEW_MAX_PACKAGE_LINES"] = "10"
    assert _run_ps1(repo, env).startswith(expected)


@_needs_bash
def test_bash_refuses_a_blank_package_value(repo: Path) -> None:
    """A whitespace-only `REVIEW_PACKAGE` is an accident. Neither host may read it
    as "absent" and quietly review gate 4 only -- that is a host-dependent
    verdict (codex review, TASK-108 轮 2 / ADR-0062 决策 3)."""
    out = _run_sh(repo, {"REVIEW_PACKAGE": "   "})
    assert out.startswith("ENV_ERROR: REVIEW_PACKAGE is set but blank")


@_needs_powershell
def test_powershell_refuses_a_blank_package_value(repo: Path) -> None:
    out = _run_ps1(repo, {"REVIEW_PACKAGE": "   "})
    assert out.startswith("ENV_ERROR: REVIEW_PACKAGE is set but blank")


# --- 2. the package actually reaches the reviewer -----------------------------


@_needs_bash
def test_the_package_and_the_diff_both_reach_the_reviewer(repo: Path) -> None:
    bindir, dump = _stub_reviewer(repo)
    (repo / "pkg.md").write_text(_PACKAGE, "utf-8")
    out = _run_sh(
        repo,
        {
            "REVIEW_PACKAGE": "pkg.md",
            "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        },
    )
    assert "VERDICT: pass" in out
    prompt = dump.read_text("utf-8")
    # The requirement context is present, delimited, and ahead of the diff...
    assert "<<<REVIEW PACKAGE>>>" in prompt
    assert "REQ-003 v1 判据 3" in prompt
    assert "CA §4" in prompt
    assert prompt.index("<<<END REVIEW PACKAGE>>>") < prompt.index("return 2")
    # ...and the diff itself was not dropped by the new assembly.
    assert "Here is the unified diff to review:" in prompt
    assert "def f():" in prompt
    # The four gates are ordered requirement-first in the instructions.
    for header in ("REQUIREMENT:", "ARCHITECTURE:", "VERIFICATION:", "BLOCKING:"):
        assert header in prompt
    assert prompt.index("Requirement fulfilment") < prompt.index("Technical quality")
    assert "NOT_EVIDENCED" in prompt


@_needs_bash
def test_an_answer_missing_the_new_gates_is_not_a_completed_review(repo: Path) -> None:
    """The fail-open codex found in 轮 1: a reviewer that ignored (or never
    received) the package could close the loop with a bare `VERDICT: pass`, and
    the requirement question would never have been asked. With a package
    supplied, an answer without REQUIREMENT / ARCHITECTURE / VERIFICATION is an
    INCOMPLETE review, exactly like an answer with no VERDICT line."""
    bindir, _ = _stub_reviewer(repo, answer=_BARE_ANSWER)
    (repo / "pkg.md").write_text(_PACKAGE, "utf-8")
    out = _run_sh(
        repo,
        {
            "REVIEW_PACKAGE": "pkg.md",
            "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        },
    )
    assert out.startswith("ENV_ERROR")
    assert "no complete answer" in out
    assert "REVIEWER: codex" not in out


_OUT_OF_ORDER = (
    "VERDICT: pass\n"
    "ARCHITECTURE:\n- [CA §4] PASS -> ok\n"
    "REQUIREMENT:\n- [REQ-003 v1 判据 3] PASS -> ok\n"
    "VERIFICATION:\n- SUFFICIENT -> ok\n"
)
_EMPTY_GATES = (
    "VERDICT: pass\n"
    "REQUIREMENT:\n- (none)\n"
    "ARCHITECTURE:\n- (none)\n"
    "VERIFICATION:\n- (none)\n"
)
_CONTRADICTORY = (
    "VERDICT: pass\n"
    "REQUIREMENT:\n- [REQ-003 v1 判据 3] NOT_EVIDENCED -> no test covers it\n"
    "ARCHITECTURE:\n- [CA §4] PASS -> ok\n"
    "VERIFICATION:\n- SUFFICIENT -> ok\n"
    "BLOCKING:\n- (none)\nNON_BLOCKING:\n- (none)\n"
)
# Gate 4 is where correctness lives; an answer that drops its sections answered
# three of the four gates (codex review, TASK-108 轮 3).
_NO_TECHNICAL_SECTIONS = (
    "VERDICT: pass\n"
    "REQUIREMENT:\n- [REQ-003 v1 判据 3] PASS -> ok\n"
    "ARCHITECTURE:\n- [CA §4] PASS -> ok\n"
    "VERIFICATION:\n- SUFFICIENT -> ok\n"
)
# `pass` with a real blocking finding: the consistency scan used to stop AT the
# BLOCKING header, so this went out unflagged (codex review, TASK-108 轮 3).
_PASS_WITH_BLOCKING = (
    "VERDICT: pass\n"
    "REQUIREMENT:\n- [REQ-003 v1 判据 3] PASS -> ok\n"
    "ARCHITECTURE:\n- [CA §4] PASS -> ok\n"
    "VERIFICATION:\n- SUFFICIENT -> ok\n"
    "BLOCKING:\n- [a.py:1] real defect -> breaks on empty input\n"
    "NON_BLOCKING:\n- (none)\n"
)


@_needs_bash
@pytest.mark.parametrize(
    "answer,why",
    [
        (_OUT_OF_ORDER, "the gate ORDER is the rule, not just the headers"),
        (_EMPTY_GATES, "three empty headers grade nothing"),
        (_NO_TECHNICAL_SECTIONS, "gate 4 is part of the same answer"),
    ],
    ids=["out-of-order", "empty-gates", "no-technical-sections"],
)
def test_a_shaped_but_ungraded_answer_is_not_a_completed_review(
    repo: Path, answer: str, why: str
) -> None:
    """轮 2 的 P1：只查三个标题在不在，仍然 fail-open。"""
    bindir, _ = _stub_reviewer(repo, answer=answer)
    (repo / "pkg.md").write_text(_PACKAGE, "utf-8")
    out = _run_sh(
        repo,
        {
            "REVIEW_PACKAGE": "pkg.md",
            "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        },
    )
    assert out.startswith("ENV_ERROR"), why
    assert "no complete answer" in out


@_needs_bash
def test_a_pass_that_contradicts_its_own_gates_is_flagged(repo: Path) -> None:
    """`VERDICT: pass` above a `NOT_EVIDENCED` gate is self-contradictory, and the
    Merge Gate reads the verdict. The reviewer's words are not rewritten -- the
    contradiction is stated on its own line (ADR-0088 决策 6)."""
    bindir, _ = _stub_reviewer(repo, answer=_CONTRADICTORY)
    (repo / "pkg.md").write_text(_PACKAGE, "utf-8")
    out = _run_sh(
        repo,
        {
            "REVIEW_PACKAGE": "pkg.md",
            "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        },
    )
    assert "GATE_CONSISTENCY: inconsistent" in out
    assert "treat this review as fail" in out


@_needs_bash
def test_a_pass_next_to_a_blocking_finding_is_flagged(repo: Path) -> None:
    """The contradiction does not have to live in a gate line: a populated
    BLOCKING list under `VERDICT: pass` is the same lie."""
    bindir, _ = _stub_reviewer(repo, answer=_PASS_WITH_BLOCKING)
    (repo / "pkg.md").write_text(_PACKAGE, "utf-8")
    out = _run_sh(
        repo,
        {
            "REVIEW_PACKAGE": "pkg.md",
            "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        },
    )
    assert "GATE_CONSISTENCY: inconsistent" in out
    assert "BLOCKING lists findings" in out


@_needs_bash
def test_a_consistent_pass_is_not_flagged(repo: Path) -> None:
    bindir, _ = _stub_reviewer(repo)
    (repo / "pkg.md").write_text(_PACKAGE, "utf-8")
    out = _run_sh(
        repo,
        {
            "REVIEW_PACKAGE": "pkg.md",
            "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        },
    )
    assert "GATE_CONSISTENCY" not in out


@_needs_bash
def test_a_bare_verdict_still_completes_a_package_less_review(repo: Path) -> None:
    """Backwards compatibility: gate-4-only runs (pure tooling / cleanup) had no
    gate sections before this change and must keep working."""
    bindir, _ = _stub_reviewer(repo, answer=_BARE_ANSWER)
    out = _run_sh(repo, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", "")})
    assert "REVIEWER: codex" in out
    assert "VERDICT: pass" in out


@_needs_bash
def test_without_a_package_the_review_degrades_to_gate_four_only(repo: Path) -> None:
    """No package is a legitimate mode (pure tooling / technical cleanup), but it
    must be a DECLARED downgrade, not a silent one."""
    bindir, dump = _stub_reviewer(repo)
    out = _run_sh(repo, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", "")})
    assert "VERDICT: pass" in out
    prompt = dump.read_text("utf-8")
    assert "<<<REVIEW PACKAGE>>>" not in prompt
    assert "review gate 4 only" in prompt
    assert "Here is the unified diff to review:" in prompt


# --- 3. both hosts ship the same instructions --------------------------------


def _instructions(text: str, start: str, end: str) -> str:
    a = text.index(start) + len(start)
    return text[a : text.index(end, a)]


def test_both_shells_ship_a_byte_identical_prompt_body() -> None:
    """The prompt IS the contract of the four gates. If the two hosts drift, one
    of them silently reviews something else -- and nobody would see it, because
    each host only ever runs its own script."""
    sh = _instructions(
        _SH.read_text("utf-8"),
        "read -r -d '' INSTRUCTIONS <<'PROMPT_EOF' || true\n",
        "PROMPT_EOF\n",
    )
    ps1 = _instructions(_PS1.read_text("utf-8"), "$Instructions = @'\n", "'@\n")
    assert sh == ps1


@pytest.mark.parametrize("script", [_SH, _PS1], ids=["sh", "ps1"])
def test_both_shells_document_and_implement_the_package_knobs(script: Path) -> None:
    text = script.read_text("utf-8")
    assert "REVIEW_PACKAGE" in text
    assert "REVIEW_MAX_PACKAGE_LINES" in text
    assert "PACKAGE_TOO_LARGE" in text


@pytest.mark.parametrize("script", [_SH, _PS1], ids=["sh", "ps1"])
def test_both_shells_require_the_gate_sections_when_a_package_was_supplied(
    script: Path,
) -> None:
    """Both hosts must reject an incomplete answer, not just bash (ADR-0050 决策 1).
    The bash side is executed above; this pins the PowerShell side, whose stub
    cannot be launched through ProcessStartInfo."""
    text = script.read_text("utf-8")
    assert "no complete answer" in text
    for gate in ("REQUIREMENT", "ARCHITECTURE", "VERIFICATION"):
        assert gate in text


# --- 4. the PowerShell rule is executed, not only read -----------------------

# The harness lifts `Test-ReviewComplete` and `$VERDICT_PATTERN` out of the real
# script by AST and runs THEM, so this exercises the file's own logic without
# needing a launchable reviewer stub (codex review, TASK-108 轮 1: the .ps1 side
# of the incomplete-answer rule was asserted only as source text).
_PS_HARNESS = """
$ErrorActionPreference = 'Stop'
$errs = $null; $toks = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    '{script}', [ref]$toks, [ref]$errs)
if ($errs) {{ throw 'the script no longer parses' }}
$fns = $ast.FindAll({{ $args[0] -is
    [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $args[0].Name -in @('Test-ReviewComplete', 'Get-GateLine', 'Get-ConsistencyNote')
    }}, $true)
if ($fns.Count -ne 3) {{ throw 'a gate-shape function is gone' }}
$assign = $ast.FindAll({{ $args[0] -is
    [System.Management.Automation.Language.AssignmentStatementAst] -and
    $args[0].Left.Extent.Text -eq '$VERDICT_PATTERN' }}, $true) | Select-Object -First 1
if (-not $assign) {{ throw 'VERDICT_PATTERN is gone' }}
Invoke-Expression $assign.Extent.Text
foreach ($f in $fns) {{ Invoke-Expression $f.Extent.Text }}
$complete = @'
{complete}
'@
$bare = "VERDICT: pass`n"
$PackageBlock = '<<<REVIEW PACKAGE>>>x<<<END REVIEW PACKAGE>>>'
Write-Output ("package+complete=" + (Test-ReviewComplete -Text $complete))
Write-Output ("package+bare=" + (Test-ReviewComplete -Text $bare))
Write-Output ("package+noverdict=" + (Test-ReviewComplete -Text 'REQUIREMENT: x'))
$outOfOrder = @'
{out_of_order}
'@
$empty = @'
{empty_gates}
'@
$contradictory = @'
{contradictory}
'@
$noTechnical = @'
{no_technical}
'@
$passWithBlocking = @'
{pass_with_blocking}
'@
Write-Output ("package+outoforder=" + (Test-ReviewComplete -Text $outOfOrder))
Write-Output ("package+emptygates=" + (Test-ReviewComplete -Text $empty))
Write-Output ("package+notechnical=" + (Test-ReviewComplete -Text $noTechnical))
Write-Output ("note+contradictory=" + [bool](Get-ConsistencyNote -Text $contradictory))
Write-Output ("note+blocking=" + [bool](Get-ConsistencyNote -Text $passWithBlocking))
Write-Output ("note+consistent=" + [bool](Get-ConsistencyNote -Text $complete))
$PackageBlock = ''
Write-Output ("nopackage+bare=" + (Test-ReviewComplete -Text $bare))
Write-Output ("nopackage+note=" + [bool](Get-ConsistencyNote -Text $contradictory))
"""


@_needs_powershell
def test_powershell_rejects_an_incomplete_answer_for_real(tmp_path: Path) -> None:
    harness = tmp_path / "harness.ps1"
    harness.write_text(
        _PS_HARNESS.format(
            script=str(_PS1).replace("'", "''"),
            complete=_COMPLETE_ANSWER.rstrip("\n"),
            out_of_order=_OUT_OF_ORDER.rstrip("\n"),
            empty_gates=_EMPTY_GATES.rstrip("\n"),
            contradictory=_CONTRADICTORY.rstrip("\n"),
            no_technical=_NO_TECHNICAL_SECTIONS.rstrip("\n"),
            pass_with_blocking=_PASS_WITH_BLOCKING.rstrip("\n"),
        ),
        "utf-8",
    )
    proc = subprocess.run(
        [
            _POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(harness),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    out = proc.stdout
    assert "package+complete=True" in out
    # The two failure modes the loop must not close on:
    assert "package+bare=False" in out
    assert "package+noverdict=False" in out
    # ...the shape rules the bash side is executed for, executed here too:
    assert "package+outoforder=False" in out
    assert "package+emptygates=False" in out
    assert "package+notechnical=False" in out
    assert "note+contradictory=True" in out
    assert "note+blocking=True" in out
    assert "note+consistent=False" in out
    # ...and the gate-4-only mode still completes on a bare verdict, with no note.
    assert "nopackage+bare=True" in out
    assert "nopackage+note=False" in out
