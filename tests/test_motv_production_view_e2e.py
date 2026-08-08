"""motv mockup tests for the Production workspace shell (checkpoint: Script).

The shell is presentation over the same scriptDoc domain document as the
workflow node; its pure view-model (`scriptStatus`) is unit-tested through
real scriptdoc transitions via ``node --test``. STRICTLY OFFLINE, no spend.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_production_view_units_via_node() -> None:
    """生成中/提案/失败/版本切换 的视图镜像与域文档保持一致；各制作模块的
    只读视图模型（分镜/资产/视频/音频/剪辑/导航徽标）忠实反映现有数据。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/production.test.mjs", "tests/workspaces.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
