"""Repository path-ownership contract (ADR-0077 / TASK-099)."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
LAUNCH_DIR = REPO_ROOT / "scripts" / "launch"


def test_repository_root_contains_no_executable_or_python_files() -> None:
    forbidden = {".py", ".ps1", ".bat", ".sh"}
    found = sorted(p.name for p in REPO_ROOT.iterdir() if p.suffix.lower() in forbidden)
    assert found == []


def test_launchers_and_test_configuration_own_their_paths() -> None:
    assert {p.name for p in LAUNCH_DIR.iterdir() if p.is_file()} >= {
        "studio.ps1",
        "studio.bat",
        "studio.sh",
    }
    assert (REPO_ROOT / "tests" / "conftest.py").is_file()

    powershell = (LAUNCH_DIR / "studio.ps1").read_text("utf-8")
    batch = (LAUNCH_DIR / "studio.bat").read_text("utf-8")
    posix = (LAUNCH_DIR / "studio.sh").read_text("utf-8")
    assert 'Join-Path $scriptDir "..\\.."' in powershell
    assert "%~dp0..\\.." in batch
    assert '"$(dirname "$0")/../.."' in posix


def test_current_readme_names_only_the_owned_launcher_paths() -> None:
    readme = (REPO_ROOT / "README.md").read_text("utf-8")
    assert "scripts\\launch\\studio.ps1" in readme
    assert "scripts/launch/studio.sh" in readme
    assert ".\\run-windows.ps1" not in readme


def test_posix_launcher_parses_when_bash_is_available() -> None:
    if os.name == "nt":
        pytest.skip("the Ubuntu CI target performs the Bash syntax check")
    launcher = LAUNCH_DIR / "studio.sh"
    assert os.access(launcher, os.X_OK), "the Ubuntu launcher must retain mode 100755"
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is not installed on this supported target host")
    subprocess.run(
        [bash, "-n", str(launcher)],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
