"""motv canvas identity/provenance — checkpoint M2 (v1→v2 migration).

STRICTLY OFFLINE, no spend. Wraps the frontend identity units and adds
source-level guards on the flows that live inside DOM-bound closures.

Covers the M2 guarantees:

- deterministic, non-destructive v1→v2 migration (real fixtures included),
  stable Script/Draft/Shot ids, honest null legacy provenance, slot behavior
  unchanged — via ``node --test tests/identity.test.mjs``;
- the AI-draft flow captures the Script version id at call time and never
  fabricates a based-on relation; the manual-edit flow records its base draft
  version (source guards on scriptgen.js);
- the lock-draft-plan payload still projects exactly the legacy fields —
  ``shotId`` must NOT leak into Gateway commands in M2;
- Core ``src/ai_video_workflow/`` remains untouched by this checkpoint.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_identity_units_via_node() -> None:
    """迁移确定性/身份稳定/溯源诚实/slot 兼容 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/identity.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_draft_flows_record_provenance_at_the_real_push_sites() -> None:
    src = (_MOCKUP_DIR / "src" / "workflow" / "nodes" / "scriptgen.js").read_text(
        "utf-8"
    )
    # AI draft: source id captured when the script text is read, before the call
    assert "ctx.getScriptSourceId" in src
    assert "assignShotIdentity(shots)" in src
    # a regeneration is NOT a revision of the previous draft — no fabricated link
    assert "basedOnDraftId: null" in src
    # manual edit: records the base draft version it provably opened from
    assert "basedOnDraftId: typeof curV.id" in src
    assert 'origin: "edited"' in src


def test_lock_payload_shot_objects_carry_only_legacy_fields() -> None:
    """锁定载荷里每个 shot 对象仍只投影旧字段（title/desc/duration/first_frame_image）。

    M4c 在 params 里另加 PARALLEL 数组 ``creativeShotIds`` 建桥（服务端剥离后
    交 Core），但绝不把创作身份塞进 shot 对象本身 —— shot 对象保持 Core 消费的
    旧形状不变。
    """
    src = (_MOCKUP_DIR / "src" / "app.js").read_text("utf-8")
    # the per-shot payload pushed inside the loop
    shot_push = src.split("shots.push({")[1].split("});")[0]
    assert "title: s.title" in shot_push
    assert "first_frame_image" in shot_push
    assert "shotId" not in shot_push  # creative identity never inside the shot object


def test_core_contracts_untouched_by_m2() -> None:
    """M2 是 mockup 域检查点：核心合同目录不得出现 creator 身份字段。"""
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    hits = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["grep", "-rl", "sourceScriptVersionId", str(core)],
        capture_output=True,
        text=True,
    )
    assert hits.stdout.strip() == ""
