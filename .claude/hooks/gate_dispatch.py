"""Run exactly one native commit gate without waking a foreign runtime.

The hook configuration is shared by Windows and WSL.  Calling ``bash`` from a
Windows PowerShell hook starts the WSL VM even when the Bash gate immediately
stands down, so the dispatcher selects the native implementation before any
shell process is created.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def repo_root() -> Path:
    """The repository root, resolved from **this file's own location**.

    Not ``Path.cwd()``.  The previous version asked the working directory, so a
    client that fired ``PreToolUse`` from anywhere but the repository root sent
    the dispatcher looking for ``<cwd>/.claude/hooks/gate.ps1`` — a path that
    does not exist, which means **the gate goes looking for itself in the wrong
    place** (TASK-087 §5.26).  Nothing was observed failing yet because Claude
    Code happens to use the repo root as cwd, so this was a latent defect rather
    than a live one; it is fixed on the same discipline TASK-131 set for every
    new tool ("resolve the root from the script's location, be callable from any
    subdirectory"), and **a gate has less business betting on cwd than a
    diagnostic does** — it is the thing that decides whether a commit happens.
    """

    return Path(__file__).resolve().parents[2]


def gate_script(root: Path | None = None) -> Path:
    """The native gate for this platform."""

    base = (root or repo_root()) / ".claude" / "hooks"
    return base / ("gate.ps1" if os.name == "nt" else "gate.sh")


def main() -> int:
    payload = sys.stdin.buffer.read()
    gate = gate_script()

    # FAIL CLOSED, AND SAY WHY.  A missing gate script used to reach
    # `subprocess.run` and die with a traceback about a path nobody would
    # recognise; exit 2 blocks the tool call, so the honest answer is to block
    # with the path printed rather than to let the commit through.
    if not gate.is_file():
        sys.stderr.write(f"commit gate not found: {gate}\n")
        return 2

    if os.name == "nt":
        powershell = shutil.which("powershell")
        if powershell is None:
            return 2
        command = [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(gate),
        ]
    else:
        bash = shutil.which("bash")
        if bash is None:
            return 2
        command = [bash, str(gate)]

    result = subprocess.run(command, input=payload, check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
