"""他能点的 = 它能做的 —— 由一张表保证，由这份合同证明（TASK-127 / ADR-0096 决策 3）。

产品负责人 2026-08-29：「用户能够操作的前端的agent都应该可以操作。」

以前这是两份名单：`convactions.js` 的 `ACTIONS`（Agent 能做的）与各页面按钮直接调的
`ctx.story.* / ctx.bible.* / ctx.canon.* / swork.*`（他能点的），靠人眼对齐。2026-08-31
人物 / 关系 / 场景地「只会改、不会加」就是这样漏掉的（TASK-126）。现在按钮走
`uiAct` → `runAction`：一个按钮若没有对应的动作，**它根本发不出写**。

这份测试证的是**穷尽性**，不是抽查（收敛审查 §5.C 的完成判据原文）。三层：

    1. 界面上每一个 `uiAct(…"<id>")` 的 id 都在 `ACTIONS` 里；
    2. 故事开发侧的每一条 `ACTIONS` 都被界面引用 —— 否则它是「Agent 专用」；
    3. 每条动作都有 `undo` 与三个能力标签；付费动作一条也没有；
    4. **已接线**的 bind 函数里没有任何直接写；**未接线**的 bind 函数里直接写的种类
       是一份**只能收缩的棘轮**（新种类进不来），并且逐条记在一张卡上。

「允许留在表外」的只有两类，每一条写着理由：
    · 裁决类 —— 接受 / 丢弃 Agent 的提案、取消一次生成、用某一版内容覆盖草稿、
      **确认一面设定升一版**。Agent 不得替创作者接受自己的提案、不得静默定稿
      （IA §8.3 四条禁令），所以它们不该有动作；
    · 起跑类 —— `develop` 起一次能力运行，走 runtime 那条路（有自己的闸），不是数据写。

还没接进表的两块，各有一张卡，REQ-006 判据 1 在那两张卡闭合之前是 PARTIAL：
    · 剧集制作侧（`shot.* / blocking.*`，走 `ctx.actions.dispatch` envelope）
      → TASK-128
    · 作品设定的**结构**写（人物 / 场景地的状态与参考图、关系的增删与方向、节拍、
      改名、软删）→ TASK-129
codex 对 TASK-127 轮 1 判 PARTIAL，判得对 —— 缺口写成卡、在 REQ 里记下去向，不让
PARTIAL 被当成 PASS（ADR-0088 决策 6）。

跨 py↔js 合同只住 `tests/contract/`（ADR-0080 决策 3）。第 3 条要读**运行后**的目录
（标签在加载时补默认值），所以经 node 读一次 `actionCatalog()`；这不是内嵌
`node --test`，是读一份由前端拥有的数据。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MOCKUP = REPO / "mockups" / "motv-workspace"
UI = MOCKUP / "src" / "ui"
ACTIONS_JS = MOCKUP / "src" / "workflow" / "convactions.js"
TASK_129 = (
    REPO
    / "docs"
    / "tasks"
    / "backlog"
    / "TASK-129-settings-structure-writes-into-the-table.md"
)

#: 故事开发侧的动作前缀（ADR-0096 决策 1 的范围）。剧集侧的 `shot.* / blocking.*`
#: 归 TASK-128 —— 列在这里是为了让「哪些还没证」是**显式**的，不是遗漏。
STORY_PREFIXES = (
    "work.",
    "plan.",
    "unit.",
    "brief.",
    "outline.",
    "settings.",
    "character.",
    "relationship.",
    "world.",
    "location.",
    # 分集规划里的节拍（TASK-129 切片 2b）。它落在**作品设定这一侧** ——
    # 写的是 canon（本集推进了什么），不是剧集制作的镜头/白膜。
    "beat.",
    # 参考图挂在人物**和**场景地两类实体上，所以它自己一个前缀，
    # 而不是 `character.reference.*` / `location.reference.*` 两套（TASK-129 切片 2d）。
    "reference.",
)
EPISODE_PREFIXES_DEFERRED_TO_TASK_128 = ("shot.", "blocking.")

#: 已接线的 bind 函数：**不许**有任何直接写。（用签名而不是名字：`production.js`
#: 里叫 `bind` 的不止一个。）
CONVERTED_BINDERS = {
    "production.js#story": ("production.js", "function bindStoryWork(root) {"),
    "production.js#settings": ("production.js", "function bind(ctx) {"),
    "briefws.js": ("briefws.js", "function bindBriefWs(root, ctx, ui, rerender) {"),
    "storyws.js": ("storyws.js", "function bindStoryWs(root, ctx, ui, rerender) {"),
    "worldws.js": (
        "worldws.js",
        "function bindWorldWs(root, ctx, ui, rerender = () => {}) {",
    ),
    "biblews.js": ("biblews.js", "function bindBibleWs(root, ctx, ui, rerender) {"),
    # TASK-129 切片 2：关系的**结构**（建 / 删 / 拿回来 / 改方向）进表了。
    # 删除同时从硬删除改成了软删除 + 回收区 —— 「不可逆的不许进表」那道准入检查
    # 因此不是被绕过，是先把它变成可逆的（AGENTS.md §1「回不了头是缺陷」）。
    "relws.js": ("relws.js", "function bindRelWs(root, ctx, ui, rerender) {"),
    # TASK-129 切片 2b：三条节拍写入进表
    # （`beat.text` / `beat.character` / `beat.relationship`）。第四个名字 `stamp`
    # 留在 `ALLOWED_DIRECT` 里，理由写在那儿 —— 它是裁决，不是数据写。
    "epplanws.js": ("epplanws.js", "function bindEpPlanWs(root, ctx, ui, rerender) {"),
}

#: 未接线的 bind 函数：直接写的**种类**钉死在这里 —— 只能减少，不能增加。
#: 每一份名单原样抄在 TASK-129 里（下面有测试钉住这一点）。
DEFERRED_BINDERS = {
    "workspaces.js#settings": (
        "workspaces.js",
        "function bindSettings(root, ctx, ui = {}) {",
        # 切片 2c 划掉实体本身那 6 个，切片 2d 又划掉 10 个（状态、参考图、声音）。
        # **只剩这两个**，而且它们剩下的原因是同一件事：
        #
        # 状态级参考图那四个入口（`data-b-ovref*`）自己算出一份新的 overrides，
        # 再经 `setCharacterStateOverrides` 写下去。要把它们接进表，得先把
        # `nextStateRefsOnAdd`（「加一张次要参考图永远不顶掉当前主图」那条纯决策，
        # 现在住在 `ui/workspaces.js` 并在那儿有单测）搬进 workflow 层 ——
        # 否则 `workflow/convactions.js` 会反过来 import `ui/`，撞 CA §2 的依赖方向。
        #
        # 那是一次跨层搬迁 + 测试跟着搬，不是接线，所以单独一片做。记在卡上。
        frozenset({"setCharacterStateOverrides", "setLocationStateOverrides"}),
    ),
}

#: 直接写的形状。读（`doc()` / `find` / 常量）不算 —— 见 ALLOWED_DIRECT。
DIRECT_WRITE = re.compile(
    r"\b(?:ctx\.story|ctx\.bible|ctx\.canon|swork)\.([A-Za-z_]\w*)\s*\("
    r"|\bctx\.(setDeliverySpecField)\s*\("
)
#: 允许直接调的 —— 全是**读**、**裁决**或**起跑**。每一条都要说得出为什么它不该是动作。
ALLOWED_DIRECT = {
    # 读
    "doc",
    "planDirty",
    "visiblePlanRows",
    "outlineText",
    "docSnapshot",
    "danglingRefs",
    # 裁决类：Agent 不得替创作者接受 / 丢弃 Agent 自己的提案，也不该替他取消一次生成
    "applyProposal",
    "discardProposal",
    "cancel",
    # 裁决类：确认一面设定、升一个正式版本 —— 「不得静默定稿」（IA §8.3）
    "confirm",
    # 裁决类：`stamp` 记录「本集基于当前这一版上游」。同一族的判断 —— 认哪一版是
    # 他的决定，而且**盖下去旧基线就没了**（「⚠ N 个上游变化」正是拿它算的）。
    # Agent 替他盖一次，等于替他宣布「上游那些改动我都认了」。
    # 不做成可逆的，是因为可逆化要为它单独存一份基线历史，而这条本来就该他自己按
    # （TASK-129 切片 2b：其余三条节拍写入已进表，只有它留在这里）。
    "stamp",
    # 用某一版内容覆盖当前草稿 —— 会丢掉未版本化的修改，界面上要先 confirm；
    # 「覆盖他已有的东西」是 AGENTS.md 第 13 条那道闸，留给他自己按
    "restoreBriefDraft",
    # 起跑类：起一次能力运行，走 runtime（有自己的确认与预算闸），不是数据写
    "develop",
}


def _declared_action_ids() -> list[str]:
    """表里**实际登记**了哪些动作 —— 问运行时，不扫源码。

    上一版拿正则找源码里字面量的 `id: "..."`。那样只看得见**手写**的那些：
    TASK-129 切片 2d 把人物/场景地的状态动作改成由一个工厂派生（同一套机制，
    手写两遍必然长出细微差异），id 是模板串 —— 于是十条真实存在、界面也确实在
    调的动作，在这份合同眼里**不存在**，`test_every_ui_action_is_declared` 当场
    报「界面在调表里没有的动作」。

    这正是 TASK-087 §7 推论 1 说的那件事：**断言性质，不要断言写法。**
    「表里有哪些动作」的权威是 `actionCatalog()`，不是源码长什么样 —— 这份合同
    的第 3 条本来就已经在读它了，这里只是把另外几条也接到同一个事实上。
    """
    return [str(a["id"]) for a in _catalog_via_node()]


def _ui_action_ids() -> list[str]:
    """界面上被调用的动作 id。

    **允许换行。** 上一版要求 `uiAct(ctx, "id"` 挤在同一行，而参数一多就会被
    格式化工具折行 —— 那时这个扫描器看不见它。看不见的后果有两个方向，坏的是
    第二个：

      · 表里的动作被判成「界面上没有按钮调它」（吵，但看得见）；
      · **界面上的动作被判成不存在，于是「界面引用 ⊆ 表」那条查不到它** ——
        一次纯排版的换行就能让一个没进表的写动作躲过这道穷尽性检查（TASK-129
        切片 2b 实测撞到）。

    文本扫描本来就脆，那更要让它脆在**吵**的一侧，不是漏的一侧。
    """
    ids: list[str] = []
    for f in sorted(UI.glob("*.js")):
        ids += re.findall(
            r'uiAct\(\s*(?:ctx\s*,\s*)?"([a-zA-Z][\w.]*)"', f.read_text("utf-8")
        )
    return ids


def _function_body(text: str, signature: str) -> str:
    start = text.index(signature)
    # 到下一个同缩进的 `function ` 为止 —— 与 convroute.test.mjs 用的是同一种切法
    indent = text[:start].rsplit("\n", 1)[-1]
    nxt = text.find(f"\n{indent}function ", start + 1)
    if nxt < 0:
        nxt = text.find(f"\n{indent}export function ", start + 1)
    if nxt < 0:
        nxt = text.find("\n}\n", start + 1)
    return text[start : nxt if nxt > 0 else len(text)]


def _direct_writes(fname: str, signature: str) -> set[str]:
    text = (UI / fname).read_text("utf-8")
    body = _function_body(text, signature)
    calls = {a or b for a, b in DIRECT_WRITE.findall(body)}
    if "workWrite(" in body:
        calls.add("workWrite")
    return calls - ALLOWED_DIRECT


def _catalog_via_node() -> list[dict]:
    node = shutil.which("node")
    if not node:
        pytest.skip(
            "node not on PATH — the catalog can only be read by its own runtime"
        )
    url = ACTIONS_JS.resolve().as_uri()
    code = (
        f"import('{url}')"
        ".then(m => process.stdout.write(JSON.stringify(m.actionCatalog())))"
        ".catch(e => { process.stderr.write(String(e && e.stack || e));"
        " process.exit(2); })"
    )
    out = subprocess.run(
        [node, "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        cwd=str(MOCKUP),
    )
    assert out.returncode == 0, f"读不到动作目录：{out.stderr[-600:]}"
    return json.loads(out.stdout)


# --- 1. 界面引用的每个动作都在表里 ---------------------------------------- #


def test_every_ui_action_is_declared():
    declared = set(_declared_action_ids())
    ui = _ui_action_ids()
    assert len(ui) >= 40, f"界面只有 {len(ui)} 处 uiAct？按钮又直接写了？"
    missing = sorted(set(ui) - declared)
    assert not missing, f"界面在调表里没有的动作（按下去会被 runAction 拒）：{missing}"


# --- 2. 故事侧每条动作都被界面引用 —— 不存在「Agent 专用」 ------------------ #


def test_every_story_action_is_reachable_from_the_ui():
    declared = [a for a in _declared_action_ids() if a.startswith(STORY_PREFIXES)]
    ui = set(_ui_action_ids())
    orphan = sorted(a for a in declared if a not in ui)
    assert not orphan, (
        "这些动作只有 Agent 能做、界面上没有按钮调它 —— "
        f"「他能点的 = 它能做的」反方向不成立：{orphan}"
    )


def test_no_action_prefix_is_silently_out_of_scope():
    """表里每个前缀要么在故事侧（本卡证）、要么显式记在 TASK-128（剧集侧）。"""
    prefixes = {a.rsplit(".", 1)[0] + "." for a in _declared_action_ids()}
    covered = tuple(STORY_PREFIXES) + tuple(EPISODE_PREFIXES_DEFERRED_TO_TASK_128)
    stray = sorted(p for p in prefixes if not p.startswith(covered))
    assert not stray, f"新前缀没有归属（本卡 or TASK-128）：{stray}"


# --- 3. 每条动作有 undo 与三个标签；没有付费动作 ------------------------------ #


def test_every_action_carries_undo_and_the_three_capability_tags():
    catalog = _catalog_via_node()
    assert len(catalog) >= 45, f"动作目录只有 {len(catalog)} 条？"
    for a in catalog:
        assert isinstance(a.get("undo"), str) and a["undo"].strip(), (
            f"{a['id']} 没有 undo"
        )
        for tag in ("reversible", "paid", "identityBinding"):
            assert isinstance(a.get(tag), bool), f"{a['id']} 缺标签 {tag}"
        # 不可逆、又不付费、又不绑身份的动作没有资格进表
        # （AGENTS.md §1「回不了头是缺陷」—— 先把它做成可逆的）
        assert a["reversible"] or a["paid"] or a["identityBinding"], (
            f"{a['id']} 不可逆却进了表"
        )
    paid = [a["id"] for a in catalog if a["paid"]]
    assert not paid, f"付费动作不该在这张表里执行（花钱只能问他）：{paid}"


# --- 4a. 已接线的 bind 函数：一个直接写都不许有 -------------------------------- #


@pytest.mark.parametrize("key", sorted(CONVERTED_BINDERS))
def test_converted_binders_have_no_direct_writes(key):
    fname, signature = CONVERTED_BINDERS[key]
    writes = sorted(_direct_writes(fname, signature))
    assert not writes, f"{key} 直接调了写函数，绕过了动作表：{writes}"


# --- 4b. 未接线的 bind 函数：棘轮 —— 只能减少，不能增加 -------------------------- #


@pytest.mark.parametrize("key", sorted(DEFERRED_BINDERS))
def test_deferred_binders_only_shrink(key):
    fname, signature, pinned = DEFERRED_BINDERS[key]
    writes = _direct_writes(fname, signature)
    new = sorted(writes - pinned)
    assert not new, (
        f"{key} 出现了新的直接写 {new} —— 新写只能经动作表（uiAct）。"
        "已有的那些在 TASK-129 里等着接，不许再长。"
    )


def test_deferred_writes_are_each_recorded_on_the_card():
    """棘轮里的每一个名字都要原样出现在 TASK-129 上。

    「记下去向」不是一句话，是逐条。
    """
    assert TASK_129.exists(), "TASK-129 不在 backlog/ —— 未接线的写没有去向"
    card = TASK_129.read_text("utf-8")
    missing = sorted(
        name
        for _f, _sig, pinned in DEFERRED_BINDERS.values()
        for name in pinned
        if f"`{name}`" not in card
    )
    assert not missing, f"这些未接线的写没有记在 TASK-129 上：{missing}"


def test_deferred_lists_do_not_carry_dead_names():
    """棘轮反过来也要真：名单里的名字必须还在代码里，否则它是已经接好却忘了从名单里划掉的。"""
    stale = []
    for key, (fname, signature, pinned) in DEFERRED_BINDERS.items():
        present = _direct_writes(fname, signature)
        stale += [f"{key}:{n}" for n in sorted(pinned - present)]
    assert not stale, f"这些已经不再直接写了 —— 从棘轮名单与 TASK-129 里划掉：{stale}"


def test_ui_act_is_one_implementation_and_speaks_as_ui():
    shared = (UI / "uiact.js").read_text("utf-8")
    assert 'runAction(ctx, id, args, { origin: "ui" })' in shared, (
        "uiAct 必须以 origin: ui 调 runAction —— 身份绑定类动作只认这个来源"
    )
    # production.js 不再自己 runAction；它委托共享的那一份
    # （第二份适配器 = 第二份漂移点）
    prod = (UI / "production.js").read_text("utf-8")
    assert "sharedUiAct(" in prod and 'from "./uiact.js"' in prod
    assert "runAction(" not in prod, "production.js 不该再直接调 runAction"
