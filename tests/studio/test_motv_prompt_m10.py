"""motv Prompt 编译器 + 手动生成入口 — checkpoint M10.

STRICTLY OFFLINE, no spend. What stays here is the Core-untouched contract
(prompt compilation from state-resolved bible refs, honest gap reporting,
entry-panel rendering are covered by the frontend suite,
``tests/promptc.test.mjs``).

The wiring guard —— 经 prompt 流的导入记录一条 REAL Generation，媒体经与工作流
节点**同一个**上传端点 + mediaref 写路径落地，没有第二份媒体状态 —— reads
``app.js``（入口编排层）and moved to
``tests/contract/test_frontend_write_path_invariants.py`` (TASK-102 批次 E).
"""

from __future__ import annotations

from pathlib import Path

from tests._scan import core_files_containing


def test_core_contracts_untouched_by_m10() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in ("compileImagePrompt", "compileVideoPrompt", "importShotMedia"):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"
