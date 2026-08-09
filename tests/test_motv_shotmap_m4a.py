"""motv canonical Shot↔slot resolver + v3→v4 rename — checkpoint M4a.

STRICTLY OFFLINE, no spend. Wraps the frontend M4a units and adds source-level
guards on the namespace-disambiguation invariants.

Covers the M4a guarantees:

- deterministic, non-destructive v3→v4 migration renaming the CREATIVE
  ``MediaRef.shot_id`` to ``creativeShotId`` (killing the name collision with
  the server's sequence-based ``shot_id``);
- a pure ``creativeShotId ↔ slot`` resolver over the authoritative draft;
- identity-not-position: reorder / insert / delete cannot shift a binding;
  ambiguity resolves to null, NEVER a positional-sequence fallback —
  via ``node --test tests/shotmap.test.mjs``;
- the runtime media write path emits ``creativeShotId`` (not ``shot_id``);
- no join was rewired (M4a is migration + resolver only): server-namespace
  ``shot_id`` usages remain, and no code READS ``MediaRef.creativeShotId`` yet.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_shotmap_units_via_node() -> None:
    """v3→v4 重命名 / 纯 resolver / 重排-插入-删除稳定 / 歧义判 null 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/shotmap.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_media_write_path_emits_creativeShotId_not_shot_id() -> None:
    src = (_SRC / "workflow" / "mediaref.js").read_text("utf-8")
    ref = src.split("export function refFromResponse")[1].split("\n}")[0]
    assert "creativeShotId:" in ref
    assert "shot_id:" not in ref  # the collided name is gone from the write path


def test_v3_to_v4_migration_registered() -> None:
    src = (_SRC / "services" / "canvasschema.js").read_text("utf-8")
    # the M4a rename step stays registered as the current chain grows (M5 → v5)
    assert "migrateV3ToV4" in src
    assert "3: migrateV3ToV4" in src


def test_read_models_and_nodes_never_read_creativeShotId_raw() -> None:
    """读模型与工作流节点必须经 shotmap 解析函数用身份，绝不直接读 .creativeShotId。

    creativeShotId 允许出现在：迁移/写路径(canvasschema.js, mediaref.js)、身份桥接层
    (shotmap.js)、以及编排层 app.js（M4d adopt：把解析器产出的 creativeShotId 盖到
    入槽 MediaRef、记录未解析付费）。但 PRODUCTION 读模型(workspaces.js)与工作流节点
    (workflow/nodes/*.js) 只能经解析函数间接用身份 —— 直接读该字段会把创作/服务端两个
    命名空间混进普通 join，正是整条 M4 线要防的坑。
    """
    must_not_read = [
        _SRC / "ui" / "workspaces.js",
        *(_SRC / "workflow" / "nodes").glob("*.js"),
    ]
    hits = []
    for p in must_not_read:
        for i, line in enumerate(p.read_text("utf-8").splitlines(), 1):
            if ".creativeShotId" in line:
                hits.append(f"{p.name}:{i}: {line.strip()}")
    assert hits == [], (
        f"a read-model/node reads creativeShotId directly (use the resolver): {hits}"
    )


def test_core_contracts_untouched_by_m4a() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    hits = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["grep", "-rl", "creativeShotId", str(core)],
        capture_output=True,
        text=True,
    )
    assert hits.stdout.strip() == ""
