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
    assert "CANVAS_SCHEMA_VERSION = 4" in src
    assert "migrateV3ToV4" in src
    assert "1: migrateV1ToV2, 2: migrateV2ToV3, 3: migrateV3ToV4" in src


def test_creativeShotId_read_only_in_the_identity_bridge_layer() -> None:
    """creativeShotId 只在身份/桥接层被读，绝不散落进媒体查找 join 或工作流节点。

    写入限于迁移(canvasschema.js)与媒体写路径(mediaref.js)；读取限于身份桥接层
    (shotmap.js，M4c 读锁定记录的 creativeShotId 建 server 桥)。任何其它文件读
    ``.creativeShotId`` 都会把创作/服务端两个命名空间混进普通 join —— 正是整条
    M4 线要防的坑。（读模型经 shotmap 的解析函数间接使用，不直接读该字段。）
    """
    allowed = {"canvasschema.js", "mediaref.js", "shotmap.js"}
    hits = []
    for p in _SRC.rglob("*.js"):
        if p.name in allowed:
            continue
        for i, line in enumerate(p.read_text("utf-8").splitlines(), 1):
            if ".creativeShotId" in line:
                hits.append(f"{p.name}:{i}: {line.strip()}")
    assert hits == [], f"creativeShotId leaked into a non-bridge file: {hits}"


def test_core_contracts_untouched_by_m4a() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    hits = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["grep", "-rl", "creativeShotId", str(core)],
        capture_output=True,
        text=True,
    )
    assert hits.stdout.strip() == ""
