"""motv Production upstream workspace — TASK-057 / ADR-0054.

STRICTLY OFFLINE, no spend. The domain/view-model behavior tests live in
``mockups/motv-workspace/tests/upstream.test.mjs`` (run by the frontend suite +
gate + CI). This file keeps only the halves no ``.test.mjs`` can carry:

- no source file smuggles a literal NUL byte past code review;
- the Core contract is untouched (all of this is mockup/client-side).

The three guards whose controller wiring lives in ``app.js``（入口编排层，
nothing can import it）—— Autosave != Version 与 canon 唯一写路径、UI 不保存第二份
领域数据、基线只由显式人工动作记录 —— 已随 TASK-102 批次 E 移到
``tests/contract/test_frontend_write_path_invariants.py``。
"""

from __future__ import annotations

from pathlib import Path

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"


def test_no_source_file_contains_a_nul_byte() -> None:
    """源码里不得出现字面 NUL。

    git 会把含 NUL 的文件判定为 binary：它的内容从此不出现在任何 diff 里，
    也就**永远不会进入 code review**（TASK-057 实际发生过两次：canondoc.js 的
    pairKey 与 upstream.test.mjs 的分隔符用例）。控制字符必须写成 ``\\u0000``
    转义，而不是字面字节。
    """
    roots = [
        _MOCKUP_DIR / "src",
        _MOCKUP_DIR / "tests",
        _MOCKUP_DIR / "fixtures",
        _MOCKUP_DIR / "styles",
    ]
    offenders = []
    for root in roots:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {
                ".js",
                ".mjs",
                ".css",
                ".html",
            }:
                continue
            if b"\x00" in path.read_bytes():
                offenders.append(str(path.relative_to(_MOCKUP_DIR)))
    assert not offenders, f"literal NUL byte (git treats these as binary): {offenders}"


def test_core_contracts_untouched_by_task057() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in (
        "canondoc",
        "relationshipId",
        "basedOn",
        "confirmCanon",
        "briefVersionId",
    ):
        hits = [
            p
            for p in core.rglob("*.py")
            if needle in p.read_text("utf-8", errors="ignore")
        ]
        assert not hits, f"{needle} leaked into Core: {hits}"
