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


def main() -> int:
    root = Path.cwd()
    payload = sys.stdin.buffer.read()

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
            str(root / ".claude" / "hooks" / "gate.ps1"),
        ]
    else:
        bash = shutil.which("bash")
        if bash is None:
            return 2
        command = [bash, str(root / ".claude" / "hooks" / "gate.sh")]

    result = subprocess.run(command, input=payload, check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
