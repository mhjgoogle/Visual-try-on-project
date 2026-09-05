# TASK-127：切片 4 —— 他能点的 = 它能做的，靠一张表

- 状态：**实现完成**（2026-09-05；证据见 §实施记录）。**未在真实项目上由人点过**：四页按钮的人工走查归切片 5。ADR-0096 决策 4（派生页面地图 / 能力输入）不在本卡，另开卡
- Workflow：Refactor（不改有效产品行为；把两份名单变成一张表）· 深度：DEEP（跨前后端合同）
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  判据 1（Agent 能做创作者能做的一切可逆动作）
- 关联 ADR：[ADR-0096](../../adr/ADR-0096-ui-and-agent-share-one-action-table.md)
- 架构约束：`CA §3`（写路径：前端不直接改核心业务文件 —— 本卡改的是 Studio 自己的
  canvas 写入口，与 `ctx.story.*` 同层）· `CA §5.2`（不静默覆盖）· `CA §6`（Agent 读什么：
  动作表由前端拥有、随请求上送）
- 依据：[收敛审查](../../design/active/product-requirement-and-ux-convergence-review.md) §5.C ·
  [一份面清单提案](../../design/active/proposal-one-surface-list.md) §4.2

## 起因（数出来的，不是印象）

`convactions.js` 的 `ACTIONS` 35 条，每条 `apply` 调创作者按钮的同一个 `ctx.*` —— 这一半
2026-08-29 就对了。**反方向没有**：`production.js` `bindStoryWork` 里 18 处写直接调
`swork.*`，不经 `ACTIONS`。于是「UI 有、Agent 没有」只能人眼比；2026-08-31 人物 / 关系 /
场景地「只会改、不会加」正是这样漏掉的（TASK-126）。收敛审查因此判 REQ-006 判据 1
`NOT_EVIDENCED`。

## IN SCOPE

1. `bindStoryWork` 的写按钮全部改走 `runAction(ctx, id, args, { origin: "ui" })`；
   缺的 action 补进 `ACTIONS`（预计 ~10 条：`work.core` 已有，`work.outline` 已有；
   缺 `plan.row.hide`/`restore` 的 UI 侧对应、`unit.ensure`、`work.seed.*`、
   `work.finalize`/`restoreFinalized`/`deleteFinalized` 的 UI 侧对应……以实际 diff 为准）。
2. 每条 action 加 `reversible / paid / identityBinding` 三个标签；`runAction` 统一判
   （ADR-0096 决策 2）。
3. `tests/contract/test_surface_manifest.py`：穷尽性合同（ADR-0096 决策 3 的四条）。
4. `motv_doctor.py` 加一项：「UI 写入口是否都经 `runAction`」（对真实项目跑）。

## OUT OF SCOPE

- 第二步「页面地图 / 能力输入从 manifest 派生」（ADR-0096 决策 4）—— 另开卡，本卡先把
  两份名单合成一张表；合不成一张表，派生无从谈起。
- `_conv_facts` 读路径不动。
- 剧集制作侧（`epprod.js` / `postconsole.js` 的 `act()` dispatch 走的是 `ctx.actions.dispatch`
  另一套 envelope）→ [TASK-128](../backlog/TASK-128-episode-side-actions-into-the-table.md)。
- 作品设定的**结构**写（人物 / 场景地的状态与参考图、关系的增删与方向、节拍、改名、软删）
  → [TASK-129](../backlog/TASK-129-settings-structure-writes-into-the-table.md)。合同里它们是
  **只能收缩的棘轮**（`DEFERRED_BINDERS`）：新种类进不来，已有的逐条记在卡上，接一个划一个。
  codex 轮 1 判 REQ-006 判据 1 `PARTIAL`，判得对 —— 缺口写成卡、REQ 里记下去向，
  **不让 PARTIAL 被当成 PASS**（ADR-0088 决策 6）。
- 付费动作、删除字节、`confirmPlan` 这类绑定身份的动作**不进表**（标签把它们挡在登记时）。

## 完成判据

1. 新增一个可逆 UI command 时，只加一条 `ACTIONS` 记录 + 一个调 `runAction` 的按钮，
   Agent 词汇表 / 白名单 / 落地 / 文案自动跟上 —— 由合同测试证明，不是人眼。
2. `test_surface_manifest.py` 全绿：UI 引用 ⊆ ACTIONS · **故事开发侧**每条 ACTIONS 被界面
   引用（剧集侧 `shot.* / blocking.*` 显式记在 TASK-128；作品设定的结构写在 TASK-129 的
   **棘轮**里，只能收缩） · 每条有 undo + 三标签、零付费 · 已接线的 bind 函数无直接写 ·
   `uiAct` 单实现且以 `origin: ui` 说话。
   （原文写「ACTIONS 每条被 UI 或 skillapply 引用」—— 比证到的宽，codex 轮 2 判得对，
   改成实际证到的范围；REQ-006 判据 1 在 TASK-128/129 闭合前是 `PARTIAL`。）
3. 前端全量、`tests/contract`、`tests/studio` 全绿；`motv_doctor` 对真实项目无红。

## 实施记录（2026-09-05）

**实现完成**；三条完成判据的证据如下。真实项目上点一遍四页按钮的人工走查 → 切片 5。

| 件 | 在哪 | 证据 |
| --- | --- | --- |
| UI 写路径改走动作表 | `production.js` 新增 `uiAct(id, args, {quiet})`：`runAction(ctx, id, args, {origin:"ui"})` → `persist` → `render`；抛错 → toast 原因。`bindStoryWork` 里 **20 处** `workWrite(swork.*)` 全部改成 `uiAct("<id>")`；`workWrite` 只剩加载期的 seed 迁移在用 | `tests/contract/test_surface_manifest.py` 第 4 条：`bindStoryWork` 内无直接 `swork.<write>(`、无 `workWrite(`、`uiAct` 以 `origin: "ui"` 调 |
| 只缺一条动作 | 对照 18 个 UI 写点与 35 条 `ACTIONS`，缺的只有「打开第 N 章/集」→ 新增 `unit.ensure`（幂等；已有的一个字不动）；`plan.row.link` 加可选 `remove: true`（界面「×」的语义：只删不加） | `tests/actiontags.test.mjs`：ensure 幂等、不建第二个、空参数说「不是有效编号」；link 切换 / remove 只删 |
| 三个能力标签 | `convactions.js` 加载时给每条补 `reversible / paid / identityBinding` 默认值；登记时**不可逆又不付费不绑身份的抛错**；`runAction` 统一判：`paid` 谁调都拒，`identityBinding` 只认 `origin: "ui"`；`actionCatalog()` 带标签；新增 `actionTags(id)` | `actiontags.test.mjs` 6 条：标签齐、今天零付费零绑身份、paid 对 ui/agent/无 origin 都拒、identityBinding 对 agent 拒且一字未写、ui 放行 |
| **穷尽性合同** | `tests/contract/test_surface_manifest.py` 4 条：① 界面每个 `uiAct` id ∈ `ACTIONS`；② `work.* / plan.row.* / unit.*` 每条都被界面引用（不存在「Agent 专用」）；③ 每条有 `undo` + 三标签、零付费（经 node 读**运行后**的目录）；④ `bindStoryWork` 无直接写 | 4 passed |

**验证**：前端全量 **2126 passed / 0 failed**（`actiontags` 6 新增；`convactions / convapply /
storypages / storywork / convthread` 100 条既有守卫全绿）；`pytest tests/contract tests/studio
-n 8` → **843 passed / 16 skipped**；ruff 全过；`lifecycle_check` 0 finding；
`motv_doctor` 对真实项目：写路径一项仍是**原有的** 3 ⚠（`actions.js` envelope 词表的
`applyProposal / registerGenerationResult / runSkill`，与本卡无关），无新红。

**完成判据 1 的演练**（新增一条可逆 UI command 只需两处）：`unit.ensure` 正是这一轮加的
—— 一条 `ACTIONS` 记录 + 一个 `uiAct("unit.ensure")` 调用；Agent 词汇表（`actionCatalog`）、
白名单（`sanitizeArgs`）、落地（`runAction`）、文案（`label`）**没有再改任何一处**，
且合同测试第 ①② 条同时为它作证。

**ADR-0096 决策 4（页面地图 / 能力输入从表派生）未做**，按卡上 OUT OF SCOPE 另开卡。

### 审查轮 1 之后（2026-09-05）—— 合同扩到整个故事开发侧

codex 判 P1：合同只证了 `work.* / plan.row.* / unit.*` 三个前缀，`brief.* / outline.* /
character.*` 等**故事侧**动作我并没有在卡上排除。判得对。扩完之后合同自己又抓出两层：

| 层 | 发现 | 处理 |
| --- | --- | --- |
| 「只有 Agent 能调」 | `character.fields / location.fields / relationship.fields / world.fields / settings.delivery` 界面上没有按钮走它 | 人物 / 场景地档案栏（`workspaces.js#bindSettings`）、关系栏（`relws.js`）、世界观栏（`worldws.js`）、⚙ 成片规格（`production.js#bind`）全部改走 `uiAct`；`relationship.fields` 加可选 `relationshipId`（界面手里有 id，不必按两个名字反查） |
| 「只有界面能做」 | 创意简报 6 处 / 大纲 5 处 / 人物 2 / 场景地 1 / 分集规划 2 + 6 直接调 `ctx.*` | 新增 **9 条动作**：`brief.commit` · `character.add` · `character.tier` · `location.add` · `plan.discard` · `plan.item.add / edit / beat / remove`；共享适配器 `ui/uiact.js`（一份实现，`production.js` 委托它） |
| 第三块面 | `workspaces.js#bindSettings` 还有 18 种结构写（状态 / 参考图 / 改名 / 软删 / 声音 / 覆盖），`relws` 3 种，`epplanws` 节拍 4 种 | **不塞进本卡**：那是带实体身份的增删，进表前要逐条核可逆性 → [TASK-129](../backlog/TASK-129-settings-structure-writes-into-the-table.md)。合同里做成**棘轮**：`DEFERRED_BINDERS` 钉死这 25 个名字，只能减少不能增加，且每个名字必须原样出现在 TASK-129 上（两条测试互为反向：新名字进不来、接好的必须划掉） |

**允许留在表外、逐条写了理由的**：裁决类 `applyProposal / discardProposal / cancel /
restoreBriefDraft / confirm`（Agent 不得替创作者接受自己的提案、不得静默定稿，IA §8.3）；
起跑类 `develop`（起一次能力运行，走 runtime 那条路，不是数据写）。

`ACTIONS` 36 → **45**；`uiAct` 调用 20 → **50**。合同 `test_surface_manifest.py` 4 → **16** 条
（已接线六个 binder 零直接写 · 未接线三个只能收缩 · 棘轮名字 ⟷ TASK-129 双向对账 ·
`uiAct` 单实现且以 `origin: ui` 说话）。

### 审查轮 2 之后（2026-09-05）—— 一句多余的预判吞掉了成片规格

codex 判 P1：`production.js` 里本地 `uiAct` 开头「没有 `story.work` 就 `return null`」是给故事
四页写的；⚙ 成片规格（`settings.delivery`）接进同一条路之后，**一个还没写过故事的项目改
成片规格会被它静默吞掉** —— 不写、不说。判得对。修：删掉那句预判（数据在不在由动作自己的
`apply` 判并说出来 —— `workOf(ctx)` 抛「这个项目还没有故事开发的数据模型」，`uiAct` 把它
toast 出来）。`actiontags.test.mjs` 加三条：没有故事数据的项目改成片规格照样落且不 toast 噪音 ·
同一项目改故事核心由动作自己说缺什么、不 persist · 源码守卫钉住 `.doc().work` 那句不回来。

轮 2 另外三条 `PARTIAL`（REQ-006 判据 1 / §5.C / 本卡判据 2）说的都是同一件事 ——
剧集侧与结构写还没进表。它们**就该**是 PARTIAL：TASK-128 / TASK-129 显式挂着，REQ 里记了
去向，合同里是只能收缩的棘轮。本卡判据 2 的原文比证到的宽，已改成实际范围（见上）。
