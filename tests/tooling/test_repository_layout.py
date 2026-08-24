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


def test_product_assets_own_their_top_level_paths() -> None:
    """`product-skills/` 与 `product-flows/` 是**产品资产**，住在仓库根。

    ADR-0067 决策 2 把内置 Skill 包放在根上而不是 `mockups/` 下面，理由是它不是
    这个原型的私有物 —— 将来产品换外壳它也要跟着走。ADR-0084 决策 7 给流程模板
    同一个理由，并要求两者**并列**：一个 flow 不是一个 skill 的一部分，
    id 空间也必须分开（同名的 `storyboard` skill 与 `storyboard` flow 合法）。

    这条钉的是那个**并列关系**：谁被挪进谁的下面，都会让上面那句话不再成立。
    """
    skills = REPO_ROOT / "product-skills" / "builtin"
    flows = REPO_ROOT / "product-flows" / "builtin"
    assert skills.is_dir(), "内置 Skill 包在仓库根（ADR-0067 决策 2）"
    assert flows.is_dir(), "内置流程模板在仓库根（ADR-0084 决策 7）"
    assert flows.parent.parent == REPO_ROOT, "与 product-skills 并列，不是嵌在它下面"
    assert not (skills / "flows").exists()
    assert not (flows / "skills").exists()

    # 而且两者都真的有内容 —— 一个空目录会让上面每一条断言都空转
    assert any(p.is_dir() for p in skills.iterdir())
    assert any(p.is_dir() for p in flows.iterdir())


def test_the_path_ownership_table_names_both_product_asset_roots() -> None:
    """规则写在会被读到的那张表里，不只写在 ADR 里。

    这正是 ADR-0083 落地时踩过的形状：规则进了参考表，却没进真正会被执行的
    那一步（见 dev-workflow 第 4/10 步的补记）。
    """
    agents = (REPO_ROOT / "AGENTS.md").read_text("utf-8")
    table = agents[agents.index("| 位置 | 放什么 |") :]
    table = table[: table.index("\n\n")]
    assert "product-skills/" in table
    assert "product-flows/" in table
