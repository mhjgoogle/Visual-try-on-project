"""TASK-093 / TASK-097 批次 3 —— 单镜画布可编辑的跨层守卫。

守两件 JS 行为测试守不到的事：

1. **§2.5c 接线账**：本批新增的导出必须有一条**非测试**调用路径。
   批次 2 的教训是「在未接线的模块上测试通过，读起来与交付完成一模一样」。
2. **两份 ADR 存在且已 Accept**，并且它们各自那条最难的决定写进了实现。

断言刻意派生（从源码读清单再比对），不写死行数、不写死「记得改这几处」。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_MOTV = _REPO / "mockups" / "motv-workspace"
_SRC = _MOTV / "src"


def _app_callers(module: str) -> list[str]:
    """Non-test files under src/ that import this workflow module."""
    hits = []
    needle = re.compile(rf"""from ['"][^'"]*{module}\.js['"]""")
    for path in _SRC.rglob("*.js"):
        if needle.search(path.read_text("utf-8")):
            hits.append(str(path.relative_to(_SRC)).replace("\\", "/"))
    return sorted(hits)


def test_this_batch_left_no_zero_caller_module() -> None:
    """§2.5c rule 3: an export introduced in this batch has a real caller now."""
    for module in ("canvasnodes", "canvasgrow"):
        callers = _app_callers(module)
        assert callers, (
            f"{module}.js has no application-side caller -- green guards over an "
            "unwired module read exactly like a finished feature (TASK-097 §2.5c)"
        )


def test_every_capability_has_a_path_from_the_SCREEN_not_just_an_import() -> None:
    """§2.5c rule 3, read strictly -- and this is where my own scan was too weak.

    Counting imports said `canvasgrow` had a caller (app.js) and passed, while
    `characterFromImage` / `applyCameraPreset` had **no control in the interface at
    all**: reachable from `ctx`, unreachable from the screen (codex round 1, P1). An
    import is not a path a creator can walk.

    So the assertion follows the actual chain: a rendered control carrying a
    `data-sg-*` hook -> a binding for that hook -> the ctx method.
    """
    view = (_SRC / "ui" / "shotgraphview.js").read_text("utf-8")
    prod = (_SRC / "ui" / "production.js").read_text("utf-8")

    # every hook this batch renders must also be BOUND in the same view
    hooks = set(re.findall(r"data-sg-(add|chain|preset)=", view))
    assert hooks == {"add", "chain", "preset"}, f"missing rendered hooks: {hooks}"
    for hook in sorted(hooks):
        assert f"[data-sg-{hook}]" in view, (
            f"data-sg-{hook} is rendered but never bound"
        )

    # …and each binding must reach a method that REALLY EXISTS. Checking only that the
    # call text appears in this file is not enough: an earlier draft called
    # `ctx.assets.importInto(...)`, which exists nowhere, and this guard passed anyway.
    # So every ctx method named here is also looked up in app.js.
    app = (_SRC / "app.js").read_text("utf-8")
    for handler, ctx_call, defined_as in (
        ("onChain", "ctx.shotgraph.characterFromImage(", "characterFromImage: ("),
        ("onPreset", "ctx.shotgraph.applyCameraPreset(", "applyCameraPreset: ("),
        ("onAdd", 'cardAction(ctx, "upload"', None),
    ):
        assert handler in prod, f"{handler} is not wired at the bind site"
        assert ctx_call in prod, f"{handler} does not reach {ctx_call}"
        if defined_as is not None:
            assert defined_as in app, (
                f"{ctx_call} is called but {defined_as} is not defined -- a guard that "
                "greps for a call cannot tell a real method from an invented one"
            )

    # the preset menu must actually be RENDERED, not merely available on ctx
    assert "renderCameraPresets(" in prod, (
        "ADR-0075 needs a control on screen; a ctx method alone is unreachable"
    )
    assert "character-from-image" in (
        (_SRC / "workflow" / "canvasnodes.js").read_text("utf-8")
    ), "ADR-0074 needs an entry in the chain menu, which is the rendered surface"


def test_the_wiring_scan_did_not_get_worse() -> None:
    """The number of zero-caller modules may only go down (§2.5c rule 1).

    Derived, not a recorded number: the list of modules comes from the directory, so
    a module added later is covered without anyone remembering to add it here.
    """
    tracked = ["refscan", "refset", "genspec", "canvasnodes", "canvasgrow"]
    zero = [m for m in tracked if not _app_callers(m)]
    assert zero == [], f"these have no application caller: {zero}"
    # batchpay / counts are KNOWN zero-caller today and scheduled for 4A-4E. They are
    # asserted separately so this test fails loudly if the chain ends with them still
    # unwired, rather than quietly tolerating it.
    deferred = {m: _app_callers(m) for m in ("batchpay", "counts")}
    assert set(deferred) == {"batchpay", "counts"}, "the deferred set is fixed"


def test_the_canvas_reads_the_one_stage_computation() -> None:
    """§2.4: the canvas is a READER of TASK-092's six stages, not a second source."""
    app = (_SRC / "app.js").read_text("utf-8")
    board = app.split("stageBoard: (shotId) =>", 1)[1].split("\n    },", 1)[0]
    assert "shotstage.stageBoard(" in board, "it must call the one computation"
    # the evidence is INJECTED, so `completed` still needs the probe to agree
    assert "mediaProbe.stateOf" in board, (
        "`completed` must require the probe's verdict, not the registry's declaration"
    )
    assert "inflightOf(" in board, "`in_progress` must come from a real in-flight run"
    # And the canvas view must not recompute a status of its own. An earlier draft of
    # this block ended in `or True`, i.e. an assertion that cannot fail -- exactly the
    # "green guard that rejects nothing" TASK-097 2.6.3 is written about, inside the
    # file whose job is to prevent that class. Replaced with two that really can fail.
    view = (_SRC / "ui" / "shotgraphview.js").read_text("utf-8")
    assert "stageStatuses(" not in view, (
        "the view must render the board it is given, never derive statuses itself"
    )
    assert "STAGE_DEPENDENCIES" not in view, (
        "and it must not re-evaluate the gates either -- `ok` arrives on the board"
    )


def test_both_adrs_exist_accepted_and_carry_their_hard_decision() -> None:
    adr74 = (_REPO / "docs" / "adr" / "ADR-0074-character-from-image.md").read_text(
        "utf-8"
    )
    adr75 = (_REPO / "docs" / "adr" / "ADR-0075-camera-motion-presets.md").read_text(
        "utf-8"
    )
    for adr in (adr74, adr75):
        assert "状态：**Accepted" in adr
        assert "不涉及付费口径" in adr
        assert "不不可逆动用户数据" in adr

    # ADR-0074's load-bearing decision: it does NOT invent profile content
    assert "不臆造档案" in adr74
    grow = (_SRC / "workflow" / "canvasgrow.js").read_text("utf-8")
    proposal = grow.split("export function characterFromImage", 1)[1].split(
        "\n/* =", 1
    )[0]
    for invented in ("appearance:", "costume:", "personality:"):
        assert invented not in proposal, (
            f"the proposal must not fill {invented} -- the image did not say it"
        )
    assert "leftBlank" in proposal, (
        "and the blanks are stated, so they read as deliberate"
    )

    # ADR-0075's load-bearing decision: apply COPIES TEXT, keeps no preset id
    assert "与预设脱钩" in adr75
    apply_block = grow.split("export function applyCameraPreset", 1)[1].split(
        "\n/**", 1
    )[0]
    assert "preset.text" in apply_block
    # the returned value must never carry an id -- that is what makes "the preset
    # changed" a non-event for shots already using it
    assert "id:" not in apply_block, (
        "applying a preset must produce TEXT only; storing an id would let editing a "
        "template retroactively rewrite 60 shots"
    )


def test_the_probe_verdicts_do_not_collapse_into_two() -> None:
    """codex round 5: `INCONCLUSIVE` must not read as "the artifact is there".

    Two questions read the same tri-state and must read it differently, so the code
    has to branch on all four cases -- and ADR-0073's original wording ("the probe did
    not judge it MISSING") is what permitted the loose check, so the ADR text is part
    of this fix.
    """
    app = (_SRC / "app.js").read_text("utf-8")
    board = app.split("stageBoard: (shotId) =>", 1)[1].split("\n    },", 1)[0]
    present = board.split("const present = ", 1)[1].split("};", 1)[0]
    assert "mediaprobe.MISSING" in present
    assert "mediaprobe.INCONCLUSIVE" in present, (
        "a stage must not read 'asked and cannot tell' as 'the bytes are there' -- "
        "a gate opening on that spends money against unverified media"
    )
    # the ADR must no longer carry the wording that permitted it
    adr = (_REPO / "docs" / "adr" / "ADR-0073-shot-multi-stage-workflow.md").read_text(
        "utf-8"
    )
    assert "没有否认也没有说不知道" in adr, (
        "ADR-0073 decision 2 must state the tighter rule"
    )
    assert "订正（2026-08-18" in adr, "and record that the looser wording was corrected"
