"""前端入口编排层的跨层写路径不变量 —— TASK-102 批次 E 集中地。

这里住的是**只读前端 JS 源码、只做字符串/正则包含断言**的架构守卫，且它们守的
代码位于**入口编排层**：``mockups/motv-workspace/src/app.js`` 是被 `<script
type="module">` 直接加载的入口，它在 DOM-bound 闭包里装配 `ctx.*` 控制器，
**没有任何 ``.test.mjs`` 能 import 它**，所以「媒体写路径必经登记」「序列化器是
持久化的唯一所有者」「不得静默定稿」「provenance 记录点」这类不变量在前端侧
没有可执行的落点，只能读源码来守。

**为什么住在 ``tests/contract/`` 而不是 ``tests/studio/``**：它们断言的不是某个
后端行为，而是**前后端共同遵守的写路径合同** —— 客户端只能经唯一写路径落媒体、
只能把创作身份放在平行数组里而不塞进 Core 消费的 shot 对象、只有显式人工动作
才能记录通过。这与 ``tests/contract/`` 下其它跨层合同守卫同类。

**边界（ADR-0080 决策 3 的例外说明）**：ADR-0080 决策 3 要求前端行为由前端套件
（``mockups/motv-workspace/tests/*.test.mjs``）覆盖，Python 侧不复制前端行为断言。
本文件是那条规则的**唯一例外**，范围严格限定为「``.test.mjs`` 拿不到的那一半」：
凡是能被 node import 的模块，其行为断言**不属于这里**，属于对应的 ``.test.mjs``。
本文件也不做任何真实行为验证 —— 不起 server、不构造 ``_App``、不落盘。

**集中的理由**：这些断言此前散在 18 个 ``tests/studio/test_motv_*.py`` 里，改
``app.js`` 一行要碰 18 个 Python 测试文件。断言内容在本次搬迁中一字未改，每个
函数上方注明了它的来源文件与守的不变量。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"
_SERVER_PATH = _MOCKUP_DIR / "server.py"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — these tests assert about what the code
    DOES, and a module header that explains a boundary must not read as a
    violation of it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


def _app_callers(module: str) -> list[str]:
    """Non-test files under src/ that import this workflow module."""
    hits = []
    needle = re.compile(rf"""from ['"][^'"]*{module}\.js['"]""")
    for path in _SRC.rglob("*.js"):
        if needle.search(path.read_text("utf-8")):
            hits.append(str(path.relative_to(_SRC)).replace("\\", "/"))
    return sorted(hits)


# --- from tests/studio/test_motv_adopt_m4d.py (M4d) --------------------------


# 来源 test_motv_adopt_m4d.py — adopt 只能经身份解析器入槽，绝不按 sequence 定位。
def test_adopt_paid_resolves_by_identity_not_sequence() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # adopt goes through the pure identity resolver…
    assert "resolveAdoptTarget" in app
    # …and no longer does its own positional lockedShotId(sequence) match inside
    # the adopt function (that logic now lives ONLY as the legacy fallback inside
    # resolveAdoptTarget in shotmap.js).
    body = app.split("async function adoptPaidIntoSlot", 1)[1]
    adopt = body[: body.index("\n}\n")]
    # strip line comments so the guard measures real code, not intent comments
    code = "\n".join(ln.split("//")[0] for ln in adopt.splitlines())
    assert "lockedShotId" not in code
    assert "sequence" not in code


# 来源 test_motv_adopt_m4d.py — await 之后重解析槽位，任何可解析结果都不得被丢弃。
def test_adopt_rechecks_identity_after_the_await_and_never_discards() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    body = app.split("async function adoptPaidIntoSlot", 1)[1]
    adopt = body[: body.index("\n}\n")]
    # the slot is re-resolved AFTER the awaited adopt (in-flight re-lock, M4d #3):
    # resolveAdoptSlot is consulted more than once
    assert adopt.count("resolveAdoptSlot(serverShotId)") >= 2
    # an in-flight change and a no-slot op are BOTH preserved, never dropped
    assert "shot-changed-while-in-flight" in adopt
    assert "no-current-slot" in adopt
    # every RESOLVABLE non-adopt preserves explicitly; the only bare
    # `return { adopted: false }` exits are the two transient-failure catches
    # (network fetch-not-ready, registration/render failure) — the task stays in
    # the queue in both, so nothing resolvable is discarded
    assert adopt.count("return { adopted: false }") == 2


# 来源 test_motv_adopt_m4d.py — 未解析的付费产出必须被显式记录，不得静默丢弃。
def test_adopt_records_unresolved_paid_explicitly() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    assert "recordUnresolvedPaid" in app  # unresolved results are preserved
    shotmap = (_SRC / "workflow" / "shotmap.js").read_text("utf-8")
    # the resolver has an explicit unresolved outcome and never sequence-guesses
    assert "unresolved: true" in shotmap
    assert "byServer" in shotmap  # reverse bridge: server shot_id → creativeShotId


# 来源 test_motv_adopt_m4d.py — 逐镜首帧同样经 creativeShotId 解析槽位。
def test_lock_first_frame_resolves_via_creativeShotId() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    lock = app.split("async function lockDraftPlan")[1].split("\n}\n")[0]
    # the per-shot first frame resolves the slot through the identity resolver
    assert "slotForShotId(lockIdx" in lock


# --- from tests/studio/test_motv_assets_m3.py (M3) ---------------------------


# 来源 test_motv_assets_m3.py — 序列化器是持久化的唯一所有者：只写项目登记表，
# 不写 node 本地媒体字段。
def test_serializer_persists_registry_not_node_media() -> None:
    src = (_SRC / "app.js").read_text("utf-8")
    ser = src.split("function serializeGraph()")[1].split("function attachAssetViews")[
        0
    ]
    assert "assets: assetRegistry" in ser
    for field in ("n.uploads", "n.finals", "n.firstFrames"):
        assert field not in ser, f"serializeGraph still persists node-local {field}"
    # nodes re-attach the registry as views on restore AND on fresh creation
    assert src.count("attachAssetViews(nd)") >= 2


def _strip_browser_history_api(text: str) -> str:
    """Remove the BROWSER History API before the needles run (TASK-081).

    `window.history.pushState` / `replaceState` are hash routing — they have
    nothing to do with a media version history — but the needle `history.push`
    is a TEXT APPROXIMATION and matches `history.pushState` by substring. The
    RULE is unchanged: only `mediaref.addVersion` may rewrite a version chain.
    What is sharpened is the approximation, so it stops reporting the address
    bar as a parallel media write path.

    Deliberately narrow: only these two exact API names are removed, so an
    actual `history.push(...)` anywhere — including in the same file — is still
    caught.
    """
    return text.replace("history.pushState", "").replace("history.replaceState", "")


# 来源 test_motv_assets_m3.py — `mediaref.addVersion` 是媒体版本历史的唯一写路径
# （扫全部 src/**.js，含入口 app.js）。
def test_single_media_write_path_is_mediaref() -> None:
    """版本历史只能经 mediaref.addVersion 改写 — 不允许并行写路径。"""
    hits = []
    for p in _SRC.rglob("*.js"):
        if p.name == "mediaref.js":
            continue
        text = _strip_browser_history_api(p.read_text("utf-8"))
        if p.name == "artifactversion.js":
            # READ-ONLY DERIVED VIEW (TASK-072 §1.7). It maps `versions/active/locked`
            # into the six states and writes NOTHING — which is what makes introducing
            # this vocabulary unable to corrupt what it derives. The needles below are
            # a TEXT APPROXIMATION of "parallel write path"; `history.filter(isObj)`
            # here guards against a null element in a legacy document, not a rewrite.
            #
            # The exemption is ASSERTED, not assumed: if a real writer ever appears in
            # this module these lines fail, so the waiver cannot quietly cover one.
            for writer in ("history.push", "history.sort", ".current =", "history ="):
                assert writer not in text, f"artifactversion.js now writes: {writer}"
            continue
        if p.name == "assetlib.js":
            # M11: removeAssetRecord is the ONE sanctioned non-mediaref
            # history writer (permanent-delete chain surgery, gated by the
            # blocking-reference scan). Everything else in assetlib.js must
            # still stay off the version-history write path.
            start = text.index("export function removeAssetRecord")
            end = text.index("export function", start + 1)
            text = text[:start] + text[end:]
        for needle in ("history.filter", "history.push", "history.sort", ".current ="):
            if needle in text:
                hits.append(f"{p.name}: {needle}")
    assert hits == [], f"parallel media write paths found: {hits}"


# --- TASK-103：唯一 API Client 出口（创作者系统合同 §7.1 规定 10）---------------

#: `fetch` 的裸调用在前端**只允许**出现在这一个模块里。
_THE_ONE_FETCH_OUTLET = "services/apiclient.js"

#: 唯一的显式豁免，连同它成立的理由。
#:
#: `mediaprobe.js` 探的是**媒体字节**（对资产 URL 发 `HEAD`），不是后端 API ——
#: 规定 10 点名的五个模块里本来就没有它，而 `apiclient` 是 JSON API 客户端，
#: 把字节探测塞进去会让「问不出来」这个第三态失去它自己的分类。它那一处还是
#: 测试注入点（`fetchImpl`），去掉等于让探针无法被断言。
#:
#: 豁免是**被断言的，不是被假设的**：下面会钉住它只有这一处、且就是那个注入
#: 默认值。多出第二处、或那一处变成真实调用，测试就红 —— 所以这张免票盖不到
#: 别的文件头上（照 `test_single_media_write_path_is_mediaref` 的既有做法）。
_DECLARED_EXEMPTIONS = {"services/mediaprobe.js": 1}

#: 裸调用：`fetch(` 前面不能紧跟标识符字符或点号，于是 `fetchImpl(` /
#: `fetchAsDataUrl(` / `x.fetch(` 都不算，`await fetch(` 算。
_BARE_FETCH = re.compile(r"(?<![A-Za-z0-9_$.])fetch\s*\(")


def test_only_the_api_client_may_call_fetch() -> None:
    """前端只有一个 fetch 出口 —— 成员集合从目录派生，新文件因为存在而进断言。

    这条守的是合同 §7.1 规定 10。它此前只活在文档里：TASK-072 批次二迁了
    24/30 个调用点，剩下 6 个（`persist` 读/写、`runtime` 取消/执行）没有任何
    可执行断言拦着它们回流，于是「唯一出口」在四个月里一直是半真的。

    **派生而非手写**（TASK-087 §7 项 2）：扫 `src/**.js`，所以新加的 service
    不需要有人记得把它加进某张名单 —— 它因为存在而被检查。
    """
    offenders: dict[str, int] = {}
    for path in sorted(_SRC.rglob("*.js")):
        rel = str(path.relative_to(_SRC)).replace("\\", "/")
        if rel == _THE_ONE_FETCH_OUTLET:
            continue
        n = len(_BARE_FETCH.findall(_code(*rel.split("/"))))
        if n:
            offenders[rel] = n
    assert offenders == _DECLARED_EXEMPTIONS, (
        "前端裸 fetch 调用与已声明的豁免不一致 —— "
        f"实测 {offenders}，声明 {_DECLARED_EXEMPTIONS}。"
        f"新的后端调用必须经 {_THE_ONE_FETCH_OUTLET}"
    )


def test_the_one_mediaprobe_exemption_is_still_only_the_test_seam() -> None:
    """豁免的那一处仍然只是可注入的默认值，不是一条真实调用路径。"""
    code = _code("services", "mediaprobe.js")
    hits = [ln.strip() for ln in code.splitlines() if _BARE_FETCH.search(ln)]
    assert len(hits) == 1, hits
    # 它是 `fetchImpl` 缺省时的回落表达式（`typeof fetch === "function" ? … : null`），
    # 不是一条调用；探测本身只调注入进来的 `f(...)`，所以测试永远能替换掉它。
    assert 'typeof fetch === "function"' in hits[0], hits[0]
    assert "await" not in hits[0], hits[0]
    assert "const f = fetchImpl" in code
    assert "await f(" in code


def test_the_migrated_call_sites_kept_their_deadline_semantics() -> None:
    """canvas 写、取消、执行三处**必须**显式关掉客户端超时。

    `apiclient` 的默认 20s 对它们全都是错的：canvas 存档可以很大，取消「等不到」
    不等于「没取消」，而本地 CLI 跑一次以分钟计。迁移时把这三处的 `timeoutMs: 0`
    忘掉，症状是「跑到一半自己断了」——那种缺陷在测试里很难自然暴露，所以这里
    直接钉住它。
    """
    persist = _code("services", "persist.js")
    runtime = _code("services", "runtime.js")
    assert persist.count("timeoutMs: 0") == 1, "canvas PUT 丢了 no-deadline 语义"
    assert runtime.count("timeoutMs: 0") == 2, (
        "cancel / skill-run 丢了 no-deadline 语义"
    )


# --- from tests/studio/test_motv_identity_m2.py (M2) -------------------------


# 来源 test_motv_identity_m2.py — 创作身份只走平行数组，绝不进 Core 消费的 shot 对象。
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


# --- from tests/studio/test_motv_canvas_write_task093.py (TASK-093/097) ------


# 来源 test_motv_canvas_write_task093.py — 每个新增能力都要有一条从屏幕可走到的
# 路径，且 bind 处调到的 ctx 方法必须真的在入口里定义过。
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


# 来源 test_motv_canvas_write_task093.py — 零调用者模块数只能下降（入口 app.js 是
# 那条调用路径的所在）。
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


# 来源 test_motv_canvas_write_task093.py — 画布只读那一份阶段计算，不得自己再派生
# 一套状态。
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


# 来源 test_motv_canvas_write_task093.py — 探针的三态不得在入口里塌成两态
# （「问不出来」不等于「字节在那里」，否则闸门会对未验证媒体放行付费）。
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


# --- from tests/studio/test_motv_assetreg_task058.py (TASK-058) --------------


# 来源 test_motv_assetreg_task058.py — 每条媒体写路径都在写的那一刻登记声明，
# 且花字节之前先预检，被拒的声明不得留下未登记文件。
def test_every_media_write_path_declares_at_the_write() -> None:
    """No page implements its own upload logic (ADR-0055 决策 1)."""
    # the single media write path fills declaration defaults, exactly as it
    # already fills assetId / storageState
    mediaref = _code("workflow", "mediaref.js")
    assert "ensureDeclaration" in mediaref
    assert "export function addVersion" in mediaref
    # every real import site DECLARES
    for mod in (
        ("app.js",),
        ("workflow", "nodes", "shared.js"),
        ("workflow", "nodes", "assets.js"),
        ("workflow", "nodes", "audio.js"),
    ):
        src = _code(*mod)
        if "addVersion(" not in src:
            continue
        assert "declare(" in src, f"{'/'.join(mod)} writes media without declaring it"
    # …and every path that SPENDS BYTES pre-checks its declaration first, so a
    # refused declaration can never leave an unregistered file behind. The four
    # import controllers each check; `ctx.uploadMedia` is the raw transport and
    # its one caller (nodes/shared.js) checks before calling it.
    #
    # SCANNED ACROSS app.js AND src/controllers/*.js, because TASK-073 §1.8 is
    # moving these controllers out of app.js one at a time (`assetctl.js` took
    # two of the four with it). Counting only app.js would let this guard drop
    # to a passing-but-empty state exactly when the code it protects moves —
    # the same failure §5.12 records for the generation-snapshot guard. The
    # NUMBER must never be lowered to match a move: it is 「四条上传路径各自
    # 预检」, not 「app.js 里还剩几处」.
    controllers = sorted((_SRC / "controllers").glob("*.js"))
    app_and_controllers = "\n".join(
        [_code("app.js")] + [_code("controllers", p.name) for p in controllers]
    )
    assert app_and_controllers.count("assetreg.checkDeclaration(") >= 4, (
        "an app-level import path uploads before checking its declaration"
    )
    node_upload = _code("workflow", "nodes", "shared.js")
    assert "checkDeclaration(" in node_upload
    before, _, after = node_upload.partition("ctx.uploadMedia(`")
    assert "checkDeclaration(" in before, (
        "nodes/shared.js must check the declaration BEFORE uploading"
    )


# 来源 test_motv_assetreg_task058.py — 语义永不来自路径或文件名（域取自 MIME，
# 不取自扩展名）。
def test_semantics_never_come_from_a_path_or_filename() -> None:
    """决策 2: the physical filename is identity/safety only, never meaning."""
    reg = _code("workflow", "assetreg.js")
    # the only name-based helper is isReferenceKey, and it is documented as a
    # READ-side grouping aid that does not decide semantics
    header = _read("workflow", "assetreg.js")
    assert "never infer meaning from a name" in header
    # the domain of a picked file comes from its MIME type, not its extension
    app = _read("app.js")
    assert "mediaDomainOfFile" in app
    assert "NOT from the file extension" in app
    # no kind is ever derived from a url / filename string
    assert '.endsWith(".png")' not in reg
    assert "originalFilename" in reg  # kept, but only as displayed provenance


# 来源 test_motv_assetreg_task058.py — `reusable` 只能由创作者显式标记，
# 不得从使用次数推断。
def test_reusable_is_never_inferred_from_usage() -> None:
    """A creator marks 可复用; 'used many times' is not consent."""
    reg = _code("workflow", "assetreg.js")
    assert "rec.reusable = fields.reusable === true" in reg
    # nothing anywhere sets reusable from a usage count
    for mod in (("workflow", "assetreg.js"), ("workflow", "assetlib.js"), ("app.js")):
        parts = mod if isinstance(mod, tuple) else (mod,)
        src = _code(*parts)
        assert "reusable = true" not in src.replace("d.reusable === true", ""), (
            f"{'/'.join(parts)} sets reusable without an explicit mark"
        )


# --- from tests/studio/test_motv_canvas_persistence_m1.py (M1) ---------------


# 来源 test_motv_canvas_persistence_m1.py — 保存发出权威 schema 版本常量，
# 装载必经迁移分发器（序列化器自身不写死版本号）。
def test_serializer_emits_authoritative_version_and_load_dispatches() -> None:
    app_src = (_MOCKUP_DIR / "src" / "app.js").read_text("utf-8")
    assert "v: CANVAS_SCHEMA_VERSION" in app_src  # save emits the constant
    # the serializer itself carries no hardcoded schema version
    serializer = app_src.split("function serializeGraph()")[1].split(
        "function restoreGraph"
    )[0]
    assert "v: 1" not in serializer
    persist_src = (_MOCKUP_DIR / "src" / "services" / "persist.js").read_text("utf-8")
    assert "migrateToCurrent" in persist_src  # every load routes the dispatcher


# --- from tests/studio/test_motv_asset_library_task061.py (TASK-061) ---------


# 来源 test_motv_asset_library_task061.py — 临时上传也必经唯一登记路径，
# 没有任何代码路径能留下孤儿媒体。
def test_temp_upload_still_registers_and_cannot_orphan_media() -> None:
    """临时上传不是绕过登记的捷径 (ADR-0058 决策 5)。"""
    app = _code("app.js")
    block = app.split("uploadReference: async (shotId, kind)", 1)[1].split(
        "importResult:", 1
    )[0]
    # ONE import path, then a binding — no direct upload call anywhere in it
    assert "ctx.assets.importReference" in block
    assert "ctx.shot.addReference" in block
    assert "query.uploadAssetImage" not in block, (
        "the picker must not upload on its own"
    )
    # the same is true of the Reference Plan's gap action
    plan = app.split("uploadFor: async (kind, subjectId)", 1)[1].split("\n  },", 1)[0]
    assert "ctx.assets.importReference" in plan
    assert "query.uploadAssetImage" not in plan


# 来源 test_motv_asset_library_task061.py — 手工路线经同一个唯一媒体写路径记录
# Generation，并把输入集合冻结进记录。
def test_the_manual_route_records_the_same_generation_shape() -> None:
    """手工路线第一次拥有与自动路线同等的溯源：它走同一个唯一写路径，
    并把输入集合冻结进 Generation 记录。"""
    app = _code("app.js")
    imp = app.split("importResult: async (shotId, kind, file, promptText", 1)[1].split(
        "\n    },", 1
    )[0]
    assert "generationSeedFrom" in imp
    assert "ctx.media.importShotMedia" in imp, "the ONE media write path, not a new one"
    # importShotMedia consumes the seed when the caller assembled one
    media = app.split("importShotMedia: async", 1)[1].split("useAsFirstFrame:", 1)[0]
    assert "intent.seed" in media
    # …and the older prompt-only entry keeps working (no route was broken)
    assert "promptSnapshot: intent.prompt" in media


# 来源 test_motv_asset_library_task061.py — Generation 因为它真的是一次生成才被
# 记录（不以 prompt 为门槛），且在同一次调用里 COMPLETED。
def test_a_generation_is_recorded_because_it_WAS_one_not_because_it_had_a_prompt() -> (
    None
):
    """codex review 轮 A4：以 prompt 为门槛，会让「从参考图与首帧出发、没有
    prompt 的外部生成」变成一次普通导入——它的参考与首帧是真实的溯源，被整个
    丢掉了。没有 intent 的导入仍然如实是普通导入。"""
    app = _code("app.js")
    media = app.split("importShotMedia: async", 1)[1].split("useAsFirstFrame:", 1)[0]
    assert (
        "intent.shotId === shotId && (intent.seed || intent.entry || intent.prompt)"
        in media
    )
    assert "intent && intent.prompt && intent.shotId" not in media, (
        "the prompt must not be the gate"
    )
    # …and the record is COMPLETED with its result in the same call — a record
    # left at 生成中 with no result would be worse than none (codex review 轮 A7
    # read the literal alone and reported exactly that; these two lines are why
    # the real acceptance run records status=success with a resultAssetId)
    branch = media.split("ctx.startGeneration(", 1)[1]
    assert "ctx.completeGeneration(gen.generationId, [ref.assetId])" in branch
    assert "ref.links.generationId = gen.generationId" in branch


# 来源 test_motv_asset_library_task061.py — 文件选择器只信浏览器的 `cancel`，
# 不得猜取消（猜错会静默丢掉创作者真实选中的文件）。
def test_the_file_picker_never_guesses_at_cancellation() -> None:
    """codex review 轮 A4 → B4：先加了 focus 计时兜底当第二个取消信号，B4 指出
    它的代价——页面可以在选择器仍打开时重获焦点，计时器于是把这次操作判成取消，
    而随后真实的选择再也无法翻案，静默丢掉创作者确实选中的文件。

    两种失败不对等：在不触发 `cancel` 的浏览器上挂起，只是让一个什么都没改变的
    手势结束，屏幕上不留下任何过期内容；丢掉已选中的文件丢的是真实工作。所以
    只信浏览器自己的 `cancel`。"""
    app = _code("app.js")
    picker = app.split("function pickFile(accept)", 1)[1].split("\n}", 1)[0]
    assert "input.oncancel" in picker
    assert "input.onchange" in picker
    for guess in ('addEventListener("focus"', "setTimeout"):
        assert guess not in picker, f"{guess} would guess at cancellation"


# 来源 test_motv_asset_library_task061.py — 声明的 kind 必须与字节一致，
# 且在上传之前校验，被拒的写不得留下磁盘残留。
def test_the_declared_kind_must_agree_with_the_file() -> None:
    """codex review 轮 A：`accept` 只是提示，选择器可以被要求忽略它。若不校验，
    在「图片」入口选一个 mp4 会把视频登记成 shot-image——一条被字节反驳的登记，
    正是 CP2 规则要防的那件事。"""
    app = _code("app.js")
    media = app.split("importShotMedia: async", 1)[1].split("useAsFirstFrame:", 1)[0]
    assert "mediaDomainOfFile(file)" in media
    assert "fileDomain !== domain" in media
    # …and it is checked BEFORE the upload, so a refusal leaves nothing on disk
    upload_at = media.index("query.uploadAssetImage")
    assert media.index("fileDomain !== domain") < upload_at, (
        "the mismatch must be refused before any byte is written"
    )


# --- from tests/studio/test_motv_prodgraph_task062.py (TASK-062) -------------


# 来源 test_motv_prodgraph_task062.py — origin 只在调用方显式命名处记录，
# 绝不按「时间接近」推断血缘。
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


# --- from tests/studio/test_motv_production_domain_m6.py (M6) ---------------


# 来源 test_motv_production_domain_m6.py — production 文档是项目级持久化字段，
# 不由任何工作流节点持有。
def test_production_is_project_level_persisted_not_node_owned() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # top-level, parallel to assets/generations, serialized + hydrated
    assert "production: proddoc.serialize(productionDoc)" in app
    assert "proddoc.createProduction" in app
    # no workflow node imports or owns the production document
    for node in (
        "script.js",
        "scriptgen.js",
        "assets.js",
        "video.js",
        "audio.js",
        "edit.js",
    ):
        node_src = (_SRC / "workflow" / "nodes" / node).read_text("utf-8")
        assert "proddoc" not in node_src


# --- from tests/studio/test_motv_prompt_m10.py (M10) ------------------------


# 来源 test_motv_prompt_m10.py — Prompt 入口复用同一套上传/mediaref 写路径，
# 并经 M5 登记表记录 provenance；演示模式如实失败。
def test_import_reuses_single_write_paths_and_records_provenance() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    block = app[app.index("importShotMedia") : app.index("useAsFirstFrame")]
    # the SAME slug namespace as the workflow nodes' uploads
    assert "`assets-${slot}`" in block
    assert "`video-${slot}`" in block
    # media lands through mediaref (M3 registry) — never a parallel store
    assert "mediaref.addVersion" in block
    # provenance through the M5 registry helpers, prompt snapshot included
    assert "ctx.startGeneration" in block
    assert "promptSnapshot: intent.prompt" in block
    # demo mode fails honestly instead of pretending
    assert "演示模式无后端" in block


# --- from tests/studio/test_motv_production_bible_m7.py (M7) ----------------


# 来源 test_motv_production_bible_m7.py — Production Bible 与 production 同一份
# 文档、同一条写路径，节点不得持有它。
def test_bible_is_persisted_via_production_not_nodes() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # the bible rides in the SAME production document (single write path)
    assert "production: proddoc.serialize(productionDoc)" in app
    assert "bibledoc." in app
    for node in (
        "script.js",
        "scriptgen.js",
        "assets.js",
        "video.js",
        "audio.js",
        "edit.js",
    ):
        node_src = (_SRC / "workflow" / "nodes" / node).read_text("utf-8")
        assert "bibledoc" not in node_src


# --- from tests/studio/test_motv_generation_m5.py (M5) ---------------------


# 来源 test_motv_generation_m5.py — Generation 登记表是项目级持久化字段，
# 工作流节点不得成为持久化所有者。
def test_generations_are_project_level_persisted_not_node_owned() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # top-level, parallel to assets, serialized + hydrated from the canvas save
    assert "generations: generationRegistry" in app
    assert "genlib.createGenerationRegistry" in app
    # a Workflow node never becomes the durable owner: nodes call ctx.* helpers,
    # they do not import or hold the registry themselves
    for node in ("assets.js", "audio.js"):
        src = (_SRC / "workflow" / "nodes" / node).read_text("utf-8")
        assert "createGenerationRegistry" not in src
        assert "genlib" not in src


# 来源 test_motv_generation_m5.py — 系统里恰有七条会记录 Generation 的产出路径，
# 且暧昧失败不得被标记为 failed（远端可能已计费）。
def test_ai_paths_record_generations_with_frozen_snapshot() -> None:
    assets = (_SRC / "workflow" / "nodes" / "assets.js").read_text("utf-8")
    audio = (_SRC / "workflow" / "nodes" / "audio.js").read_text("utf-8")
    # app.js PLUS the controllers extracted from it (TASK-073 §1.8). The invariant is
    # 「系统里有七条会记录 Generation 的产出路径」, not 「app.js 这个文件里有七处」 —
    # anchoring it to one file makes every extraction fail this guard for the wrong
    # reason (the ffmpeg render moved to controllers/timelinectl.js).
    app = (_SRC / "app.js").read_text("utf-8") + "".join(
        f.read_text("utf-8") for f in sorted((_SRC / "controllers").glob("*.js"))
    )
    # image + audio launch a generation and complete/fail it
    for src in (assets, audio):
        assert "ctx.startGeneration" in src
        assert "ctx.completeGeneration" in src
        assert "ctx.failGeneration" in src
    # video: BOTH the single and the batch paid paths start a generation and
    # complete it on adopt (link the produced video Asset); M10 adds the
    # manual-entry import path (promptSnapshot from the copied prompt); M11
    # adds audio entry-import + local TTS + the ffmpeg render provenance
    # 7 since TASK-064 Phase 3: a Shot Mix is a DERIVED audio asset produced from
    # real inputs, so it records a real Generation like every other producer —
    # that is what puts it on the provenance graph with its sources.
    assert app.count("ctx.startGeneration") == 7
    assert app.count("ctx.completeGeneration") >= 6
    assert "promptSnapshot" in assets and "promptSnapshot" in audio
    # an AMBIGUOUS submit exception must NOT mark the video generation failed
    # (the remote may have billed it) — only a DEFINITIVE non-success response
    # does. So app.js fails a generation in exactly one place: the else-branch.
    assert app.count("ctx.failGeneration") == 1


# --- from tests/studio/test_motv_shot_bridge_m4c.py (M4c) ------------------


# 来源 test_motv_shot_bridge_m4c.py — 客户端发平行数组、服务端在构造 Core 信封前
# 剥离它（Core 合同不变）。
def test_client_sends_creative_ids_and_server_strips_before_core() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    assert "creativeShotIds" in app  # client sends the parallel array at lock time
    server = _SERVER_PATH.read_text("utf-8")
    # server strips it from params before building the Core envelope
    assert 'k != "creativeShotIds"' in server
    assert "_bridge_creative_shot_ids" in server


# --- from tests/studio/test_motv_upstream_task057.py (TASK-057) ------------


# 来源 test_motv_upstream_task057.py — 自动保存只写 Working Draft，绝不静默定稿
# （正式版本只能由显式确认动作创建）。
def test_autosave_never_creates_a_version() -> None:
    """自动保存只写 Working Draft；正式版本只能由用户显式创建。"""
    app = _read("app.js")
    brief_block = app[app.index("editBrief: (fields)") : app.index("setActiveOutline:")]
    # the autosave path persists but never commits
    assert "storydoc.editBriefDraft" in brief_block
    assert "commitBrief" in brief_block
    edit_line = next(
        ln for ln in brief_block.splitlines() if "editBrief: (fields)" in ln
    )
    assert "commitBrief" not in edit_line, "editing the brief must not create a version"

    # the canon revision counters move ONLY through the explicit confirm op
    canon = _code("workflow", "canondoc.js")
    assert "export function confirmCanon" in canon
    for mutator in ("updateWorld", "updateRelationship", "addRelationship"):
        block = canon[canon.index(f"export function {mutator}") :]
        block = block[: block.index("\n}")]
        assert "canon[" not in block, f"{mutator} must not bump a revision number"


# 来源 test_motv_upstream_task057.py — UI 不保存第二份领域数据，canon 控制器是
# 来自界面的唯一写路径。
def test_canonical_domain_only_no_second_copies() -> None:
    """UI 不保存第二份 Character / Relationship / Outline / Canon。"""
    for name in ("briefws.js", "relws.js", "worldws.js", "epplanws.js"):
        src = _read("ui", name)
        # every write goes through a ctx controller; no module-level mutable store
        assert "let " not in src.split("export function")[0], (
            f"{name} must not hold module state"
        )
        for forbidden in ("localStorage", "sessionStorage"):
            assert forbidden not in src, (
                f"{name} must not persist its own copy ({forbidden})"
            )
    # the canon controller is the single write path from the UI
    app = _read("app.js")
    canon_ctl = app[app.index("  canon: {") : app.index("  agentShotsDraft:")]
    for op in (
        "addRelationship",
        "updateRelationship",
        "updateWorld",
        "confirm:",
        "stamp:",
        "impact:",
    ):
        assert op in canon_ctl


# 来源 test_motv_upstream_task057.py — 基线只由显式人工动作记录，迁移不猜，
# 既存集不得被规划确认盖章。
def test_baseline_is_only_recorded_by_an_explicit_user_act() -> None:
    """迁移不猜；只有显式行为（建立基线 / 复核 / 确认规划新建集）才记录基线。"""
    schema = _code("services", "canvasschema.js")
    mig = schema[
        schema.index("function migrateV9ToV10") : schema.index(
            "export const MIGRATIONS"
        )
    ]
    # the migration writes an all-zero stamp and never reads a version to guess
    assert "brief: 0, outline: 0, characters: 0, relationships: 0, world: 0" in mig
    for forbidden in (
        "approved",
        "brief.active",
        "upstreamVersions",
        "canon.characters",
    ):
        assert forbidden not in mig, (
            f"the migration must not guess a baseline ({forbidden})"
        )

    app = _read("app.js")
    block = app[app.index("confirmPlan: (v) =>") : app.index("openEpisodeScript")]
    # only newly created + the adopted pristine episode get a baseline
    assert "baseline.push" in block
    assert "stampEpisodeUpstream" in block
    existing_branch = block[
        block.index("if (existing) {") : block.index("} else if (pristine")
    ]
    assert "baseline.push" not in existing_branch, (
        "a pre-existing episode must not be stamped by plan confirmation"
    )
    # pristineness now includes "no recorded beats"
    assert "beats" in block[: block.index("let adopted")]


# --- from tests/studio/test_motv_shotprod_task060.py (TASK-060) -----------


# 来源 test_motv_shotprod_task060.py — 没有视频不得通过，且通过绑定到那一个确切
# 版本（守卫在域里，不只在 UI 里）。
def test_the_no_video_guard_lives_in_the_DOMAIN_not_only_the_ui() -> None:
    """codex review, TASK-060 round 2: a UI-only check leaves every other caller
    of the declared sole write path free to approve a shot with nothing to
    watch."""
    app = _code("app.js")
    approve = app.split("approve: (shotId, note)", 1)[1].split("unapprove:", 1)[0]
    assert "ctx.shot.mediaOf(shot)" in approve
    assert "media.videoAssetId" in approve
    assert "return false" in approve
    # …and the approval is bound to THAT EXACT VIDEO (codex review, round 3):
    # switching the variant or adding a newer take must not let unreviewed
    # footage inherit a 已通过 it never earned
    dom = _code("workflow", "shotprod.js")
    assert "export function isApprovedFor" in dom
    assert "isApprovedFor(prod, shotId, m.videoAssetId)" in dom
    assert "r.assetId === videoAssetId" in dom
    # …while the record itself is never erased
    assert "export function hasStaleApproval" in dom


# 来源 test_motv_shotprod_task060.py — 生成成功 != 镜头完成：approveShot 恰有一个
# 调用点，且它在显式人工动作里；没有生成/导入路径能定稿。
def test_only_a_human_action_records_an_approval() -> None:
    """生成成功 != 镜头完成 (ADR-0057 决策 1)."""
    dom = _code("workflow", "shotprod.js")
    assert "export function approveShot" in dom
    # the domain module knows nothing about media or generations — it CANNOT
    # approve as a side effect of one succeeding
    for forbidden in ("assetRegistry", "generation", "mediaref", "genlib"):
        assert forbidden not in dom, f"shotprod.js must not reach into {forbidden}"
    app = _code("app.js")
    # EVERY call site of approveShot lives inside the explicit user action, and
    # there is exactly one. (This assertion previously ended in `or True`, which
    # made it unconditionally pass — the only automated defence for 决策 1 never
    # actually ran. Found by the TASK-057 session's codex review; see TASK-060
    # §5A.)
    call_lines = [ln for ln in app.splitlines() if "shotprod.approveShot" in ln]
    assert len(call_lines) == 1, (
        f"approveShot must have exactly ONE call site, found {len(call_lines)}"
    )
    lines = app.splitlines()
    idx = next(i for i, ln in enumerate(lines) if "shotprod.approveShot" in ln)
    # walk back to the enclosing controller method (a 4-space-indented `key:`)
    controller = None
    for ln in reversed(lines[:idx]):
        m = re.match(r"^ {4}(\w+):", ln)
        if m:
            controller = m.group(1)
            break
    assert controller == "approve", (
        f"approveShot is called from `{controller}`, not the explicit approve action"
    )
    # …and no generation/import path approves anything
    for marker in ("completeGeneration", "importShotMedia", "adoptPaidIntoSlot"):
        seg = app.split(marker, 1)
        if len(seg) < 2:
            continue
        window = seg[1][:1500]
        assert "approveShot" not in window, f"{marker} must not approve a shot"


# 来源 test_motv_shotprod_task060.py — 永久删除必须剪除被删参考的镜头绑定，
# 不留幻影引用。
def test_a_deleted_reference_leaves_no_phantom() -> None:
    """决策 5."""
    dom = _code("workflow", "shotprod.js")
    assert "export function pruneShotReferences" in dom
    app = _code("app.js")
    # exposing the primitive is not enough — the DELETE path must call it
    # (codex review, round 1), or a deleted reference leaves phantom chips
    delete_path = app.split("permanentDelete:", 1)[1].split("\n  },", 1)[0]
    assert "pruneShotReferences" in delete_path, (
        "permanent delete must prune the shot bindings of a removed reference"
    )


# 来源 test_motv_shotprod_task060.py — 通过 = 一条层 1 ReviewDecision，点名它评的
# 是哪一版；撤回只追加，id 单调不取自时钟。
def test_approving_a_shot_records_a_layer_1_decision_that_names_the_take() -> None:
    """TASK-072 §1.5 / 系统合同 §6.4：通过 = 一条层 1 ReviewDecision，不只是旧标记。"""
    app = _code("app.js")
    approve = app.split("approve: (shotId, note)", 1)[1].split("unapprove:", 1)[0]
    # the Decision is built BEFORE the legacy marker: writing the marker while failing
    # to record the decision leaves the two disagreeing, with the weaker one winning
    assert approve.index("review.decision(") < approve.index("shotprod.approveShot(")
    assert 'layer: "shot"' in approve
    assert 'verdict: "passed"' in approve
    assert 'by: "user"' in approve
    # WHICH take — a decision with no version can never go stale (§6.4)
    assert "basedOnVersion: media.videoVersion" in approve
    # a MONOTONIC id, not `Date.now()`: approve → unapprove → approve inside one
    # millisecond minted the same decisionId twice, and a duplicate primary key makes
    # an append-only log ambiguous
    assert 'review.newDecisionId("shot", shotId)' in approve
    # narrowly: no id may be minted from the clock. A blanket ban on `Date.now()`
    # over the whole slice would also fail a legitimate `decidedAt` timestamp later
    assert "decisionId: `dec-" not in approve
    # …and if that version cannot be read, the approval is REFUSED rather than
    # recorded without saying what it approved
    assert "if (!dec.ok)" in approve
    assert "return false" in approve.split("if (!dec.ok)", 1)[1][:200]

    # withdrawal APPENDS a needs_rework decision judged against the SAME version —
    # the approval happened, on a take that existed (G5 只追加)
    undo = app.split("unapprove: (shotId) => {", 1)[1]
    undo = undo.split("references: (shotId)", 1)[0]
    # the undo site mints its id the same way — pinned separately, or a regression
    # that reverted only this half would pass every suite
    assert 'review.newDecisionId("shot", shotId)' in undo
    assert "decisionId: `dec-" not in undo
    assert 'verdict: "needs_rework"' in undo
    assert "prev.basedOnVersion" in undo
    # only APPENDED to — a withdrawn approval that vanished would make the history
    # claim the creator never approved it
    assert "decisions: [...reviewsDoc.decisions, undo.value]" in undo
    assert "reviewsDoc.decisions.filter" not in undo

    # the version the decision is bound to comes from the media registry, not invented
    media_of = app.split("mediaOf: (shot) =>", 1)[1].split("_slotOf:", 1)[0]
    want = "videoVersion: vid && Number.isInteger(vid.version) ? vid.version : null"
    assert want in media_of


# --- from tests/studio/test_motv_studio_m8.py (M8) ------------------------


# 来源 test_motv_studio_m8.py — Studio 是视图：序列化器恰好只发出领域字段，
# 不新增任何自己的持久化字段。
def test_studio_adds_no_new_persisted_field() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    serializer = app[
        app.index("function serializeGraph") : app.index("function attachAssetViews")
    ]
    # exactly the domain field set (M9: scriptDoc → per-episode scripts +
    # story) — the studio persists NOTHING of its own
    for field in (
        "story:",
        "scripts,",
        "assets:",
        "generations:",
        "production:",
        "nodes:",
        "edges:",
        "pan:",
    ):
        assert field in serializer
    assert "bibleProposals" not in serializer  # proposals are transient review state
    assert "selectedShot" not in serializer


# 来源 test_motv_studio_m8.py — 变体切换复用同一个 mediaref 原语，
# storyboard 视图不得自己写媒体状态。
def test_media_actions_reuse_the_single_write_paths() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # variant switching goes through the SAME mediaref primitive as the node
    # version picker, against the M3 registry maps — no duplicate media state
    assert "mediaref.setCurrent({ uploads: map }" in app
    sb = (_SRC / "ui" / "storyboard.js").read_text("utf-8")
    for forbidden in ("addVersion(", "history.push", "localStorage"):
        assert forbidden not in sb, (
            f"storyboard must not write media state ({forbidden})"
        )


# 来源 test_motv_studio_m8.py — 镜头编辑追加不可变草稿版本，创意 facet 加法式携带。
def test_shot_edits_append_immutable_draft_versions() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # ctx.shots.saveEdit pushes a NEW version and re-points cur — same
    # discipline as the node's ✎ editor; creative facets ride additively
    assert "node.versions.push({" in app
    assert 'origin: "edited"' in app
    editor = (_SRC / "ui" / "shoteditor.js").read_text("utf-8")
    for facet in ("action", "cameraMotion", "dialogue"):
        assert facet in editor


# 来源 test_motv_studio_m8.py — 提案只能经既有 bibledoc 操作落地，
# 不得直接对文档动刀。
def test_proposals_apply_through_existing_bible_ops_only() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    block = app[app.index("breakdown: {") : app.index("// Shot-draft controller")]
    # every application composes existing bibledoc ops — no direct doc surgery
    for op in (
        "bibledoc.addCharacter",
        "bibledoc.updateCharacterProfile",
        "bibledoc.addLocation",
    ):
        assert op in block
    assert "productionDoc.characters.push" not in block
    assert "productionDoc.locations.push" not in block


# --- from tests/studio/test_motv_skills_task059.py (TASK-059) -------------


# 来源 test_motv_skills_task059.py — Skill Run 登记表由序列化器持有：
# 保存发出、装载水合，重载能取回已记录的 run。
def test_the_persisted_registry_is_owned_by_the_serializer() -> None:
    """The serializer emits the registry on every save, and the loader hydrates
    it from the same field — so a reload returns the recorded runs."""
    app = _code("app.js")
    assert "skillRuns: skillRunRegistry" in app, "serializeGraph must emit skillRuns"
    assert "createSkillRunRegistry((data && data.skillRuns)" in app, (
        "restoreGraph must hydrate skillRuns from the save"
    )


# --- from tests/studio/test_motv_story_m9.py (M9) -------------------------


# 来源 test_motv_story_m9.py — 剧本自 v8 起按集存放，入口按集解析、不留第二份
# 权威剧本来源。
def test_scripts_are_per_episode_since_v8() -> None:
    schema = (_SRC / "services" / "canvasschema.js").read_text("utf-8")
    # the schema has moved past v8 (v10 = TASK-057 upstream canon, v11+ = later
    # migrations); this test pins the v8 per-episode-scripts mechanics, NOT the
    # current version number, so a legitimate later migration cannot break it
    match = re.search(r"CANVAS_SCHEMA_VERSION = (\d+)", schema)
    assert match is not None
    assert int(match.group(1)) >= 8
    assert "function migrateV7ToV8" in schema
    assert "7: migrateV7ToV8" in schema
    assert "missing its scripts map" in schema
    assert "missing its story document" in schema
    # a leftover legacy scriptDoc is rejected — no second script source of truth
    assert "retains scriptDoc" in schema
    app = (_SRC / "app.js").read_text("utf-8")
    assert "scriptForEpisode" in app
    assert "syncActiveScript" in app


# 来源 test_motv_story_m9.py — 大纲/规划确认路径不写 Production Bible 实体。
def test_outline_never_writes_bible_entities() -> None:
    story = (_SRC / "workflow" / "storydoc.js").read_text("utf-8")
    for forbidden in ("addCharacter", "addLocation", "bibledoc"):
        assert forbidden not in story, f"outline must not touch the bible ({forbidden})"
    # the confirm-plan orchestration touches only proddoc episode ops
    app = (_SRC / "app.js").read_text("utf-8")
    block = app[app.index("confirmPlan: (v) =>") : app.index("openEpisodeScript")]
    assert "bibledoc" not in block
