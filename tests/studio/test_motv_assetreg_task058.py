"""motv Asset Registration Foundation — TASK-058 / ADR-0055.

STRICTLY OFFLINE, no spend. Guards the wiring contract (the frontend units —
declaration vocabulary, domain checking, the v10→v11 migration, v11 validation,
canonical References, explicit reclassification — live in
``tests/assetreg.test.mjs``, run by the frontend gate/CI):

- a new project's folder shape (project.json / studio/ / media/) exists from
  creation, with NO physical classification subfolders (决策 5);
- the Core contract is untouched (all of this is mockup/client-side).

The three guards that read ``app.js``（入口编排层）—— 上传 ≠ 保存文件（每条媒体
写路径在写的那一刻登记声明）、语义永不来自路径或文件名（决策 2）、``reusable``
只能由创作者显式标记 —— 已随 TASK-102 批次 E 移到
``tests/contract/test_frontend_write_path_invariants.py``。
"""

from __future__ import annotations

from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"


def test_project_folder_shape_is_created_without_physical_classification() -> None:
    """决策 5: studio/ + media/ exist from creation; no per-type subfolders."""
    server = (_MOCKUP_DIR / "server.py").read_text("utf-8")
    assert 'for sub in ("studio", "media"):' in server
    assert "(target / sub).mkdir(exist_ok=True)" in server
    # the Asset Registry is the classification source of truth — a physical one
    # could only ever disagree with it
    assert "Asset Registry is the classification source of truth" in server
    for forbidden in ("media/images", "media/characters", "media/references"):
        assert forbidden not in server


def test_core_contracts_untouched_by_cp2() -> None:
    """The whole checkpoint is client-side; no core pipeline file changes."""
    core = _REPO / "src" / "ai_video_workflow"
    hits = [
        p.name
        for p in core.rglob("*.py")
        if "assetreg" in p.read_text("utf-8", errors="ignore")
    ]
    assert hits == [], f"core modules must not know about the mockup registry: {hits}"
