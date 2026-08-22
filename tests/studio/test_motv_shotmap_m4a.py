"""motv canonical Shot↔slot resolver + v3→v4 rename — checkpoint M4a.

STRICTLY OFFLINE, no spend. Source-level guards on the namespace-disambiguation
invariants that no frontend behavior test can express.

The M4a behavior itself (deterministic non-destructive v3→v4 rename, the pure
``creativeShotId ↔ slot`` resolver, identity-not-position stability, ambiguity
→ null, and the ``refFromResponse`` write path emitting ``creativeShotId``)
lives in ``mockups/motv-workspace/tests/shotmap.test.mjs`` and the mediaref
suites, run by the frontend suite directly (TASK-102 批次 B removed the
subprocess wrapper and the duplicated source-text assertions).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


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
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    assert core_files_containing("creativeShotId", core) == []
