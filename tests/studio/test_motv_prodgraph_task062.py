"""motv 生产图身份合同 — TASK-062 / ADR-0059.

STRICTLY OFFLINE, no spend. 域与读模型的行为测试在
``mockups/motv-workspace/tests/prodgraph.test.mjs``（由前端套件 + gate 前端档 +
CI 承担）。这里只守 ``.test.mjs`` 拿不到的那一半：origin 的记录点接线在
``app.js``（没有任何测试能 import 它）——按「时间接近」推断血缘比没有血缘更糟。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — a rule can never be 'satisfied' by a
    comment that merely describes it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


def test_origin_is_recorded_only_where_the_caller_named_it() -> None:
    """按「时间接近 + 同 context」推断出的血缘比没有血缘更糟：它看起来像记录。"""
    gen = _code("workflow", "genlib.js")
    assert "origin: originOf(entry.origin)" in gen
    assert "function originOf(raw)" in gen
    assert "if (!skillRunId || !proposalId) return null;" in gen
    # nothing in the generation registry searches for a nearby proposal
    for guess in ("skillRuns", "findRun", "nearest", "createdAt >"):
        assert guess not in gen, f"{guess} would infer an origin"

    app = _code("app.js")
    imp = app.split("importResult: async", 1)[1].split("\n    },", 1)[0]
    # ADR-0061 决策 3 added a SECOND way for the creator to name the run: pressing
    # 「用于生成」 on a proposal. Both branches are an explicit human statement —
    # what stays forbidden is INFERRING one, and `pendingOriginFor` refuses to:
    # it returns only what 「用于生成」 recorded, scoped to that run's own shot.
    assert "ctx.skills.originOf(fromSkillRunId)" in imp, (
        "a named run is still the primary origin"
    )
    assert "ctx.skills.pendingOriginFor(shotId)" in imp, (
        "the 「用于生成」 intent is the only other source of an origin"
    )
    # an import with NEITHER has no origin — the fallback chain must bottom out in
    # a lookup that can answer null, never in a search for a plausible proposal
    #
    # SCANNED IN `controllers/skillctl.js`: TASK-073 §1.8 第四批 moved the skill
    # controller (and the `pendingOrigin` intent with it) out of app.js. The
    # invariant is about that method, not about which file it lives in — so the
    # scan follows the code rather than being relaxed. (A slice that no longer
    # finds its anchor raises here, which is why this failed loudly rather than
    # passing vacuously.)
    skillctl = _code("controllers", "skillctl.js")
    skills_block = skillctl.split("pendingOriginFor:", 1)[1].split("\n    },", 1)[0]
    assert "if (!pendingOrigin) return null;" in skills_block, (
        "no explicit 「用于生成」 → no origin"
    )
    for guess in ("nearest", "createdAt >", "slice(-1)"):
        assert guess not in skills_block, f"{guess} would infer an origin"
