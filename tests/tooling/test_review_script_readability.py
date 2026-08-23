"""Neither review script may treat "cannot read this file" as "it is binary".

TASK-052 §2.4. A binary file is silently skipped, so folding an unreadable file
into that branch let a source file held by an ACL or an open handle sit out the
whole review while the round still came back ``pass``. That is a hole in the
review gate itself: the verdict claims coverage the run never had.

WHY THIS IS A SOURCE-TEXT ASSERTION. Both scripts are top-to-bottom shell with
no importable surface, and exercising the branch for real needs a file the
process genuinely cannot open — ACL surgery on Windows, a root-owned file on
Linux — plus a reviewer binary to reach the branch at all. The repo already
accepts source-text guards for exactly this shape (see
`tests/contract/test_frontend_write_path_invariants.py`, which guards the one
entry file `.test.mjs` cannot import). The assertions below are written against
the two BEHAVIOURS that matter, not against a spelling: the fail-open fallback
is gone, and an unreadable file reaches the same ENV_ERROR posture the scripts
already use when `git diff` fails.

Both shells must give the SAME verdict (ADR-0050 决策 1), so both are checked.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / ".claude"
    / "skills"
    / "codex-review-loop"
    / "scripts"
)
_PS1 = _SCRIPTS / "run-review.ps1"
_SH = _SCRIPTS / "run-review.sh"


def _code_only(text: str, comment: str) -> str:
    """Strip comment lines. The assertions below are about CODE — an early
    version of this test matched the old `catch { return $true }` quoted in the
    new comment explaining why it was removed, and went red on a correct file."""
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(comment):
            continue
        out.append(line)
    return chr(10).join(out)


@pytest.fixture(scope="module")
def ps1() -> str:
    return _PS1.read_text("utf-8")


@pytest.fixture(scope="module")
def sh() -> str:
    return _SH.read_text("utf-8")


def test_powershell_no_longer_calls_an_unreadable_file_binary(ps1: str) -> None:
    """The old body was `catch { return $true }` — read failure answered
    "binary", and binary is skipped."""
    code = _code_only(ps1, "#")
    assert "unreadable -> treat as binary" not in code, (
        "the fail-open fallback is back in run-review.ps1"
    )
    # `Test-BinaryFile` must not swallow the failure itself.
    start = code.index("function Test-BinaryFile")
    end = code.index("function Get-UntrackedDiff")
    assert "catch" not in code[start:end], (
        "Test-BinaryFile must let a read failure out, not classify it"
    )


def test_powershell_turns_an_unreadable_file_into_env_error(ps1: str) -> None:
    assert "ENV_ERROR: cannot read untracked" in ps1


def test_bash_separates_unreadable_from_binary(sh: str) -> None:
    """`grep -Iq` answers non-zero for binary AND for unreadable, so it cannot
    be the only check."""
    assert "ENV_ERROR: cannot read untracked" in sh
    # The readability probe must come BEFORE the binary probe, or the binary
    # branch swallows the unreadable case again.
    code = _code_only(sh, "#")
    assert code.index("head -c 1") < code.index("grep -Iq")


def test_both_shells_agree(ps1: str, sh: str) -> None:
    """ADR-0050 决策 1: the .ps1 is authoritative and the .sh serves the Ubuntu
    target, but they must reach the SAME verdict."""
    for script, name in ((ps1, "run-review.ps1"), (sh, "run-review.sh")):
        assert "ENV_ERROR: cannot read untracked" in script, name
        assert "refusing to review a diff that would silently omit it" in script, name
