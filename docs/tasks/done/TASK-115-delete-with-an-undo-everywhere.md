# TASK-115：故事与镜头都能删 —— 而且都能撤销

- 状态：完成（2026-08-29）
- Workflow：Feature · 深度：SHALLOW
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  判据 1（他能做的 Agent 也能做）与判据 5（可逆是前提）
- 关联 ADR：[ADR-0089](../../adr/ADR-0089-conversational-agent-write-path.md) 决策 3 / 决策 7
- 起因：产品负责人 2026-08-29 —— 「不管是故事还是镜头。应该都可以有删除的选项。
  不然画面会很乱。」

## 查明的现状

- **镜头**其实已经能删，但只在**表格视图**里。同一个能力，看不见的那一半等于没有 ——
  他在卡片视图上，那里一个删除入口都没有。
- **版本**（创意简报 / 故事大纲）完全不能删。上一批做的「只显示最新版」把噪声压下去了，
  但他要的是**删掉**，不是折叠。

## 做法：删除一律是软删除，回收区可撤销

**为什么版本不能真删**：`v` 在 hydration 时是**密集重编号**的（`v: out.length + 1`），
真删一版会把后面所有版本号左移，于是「Based on 创意 v2」指向另一版 —— 这正是
AGENTS.md §1 说的「不可逆是实现的缺陷」。所以删除 = 打 `hidden` 标记 + 回收区可撤销，
版本链一字不动。

| 位置 | 改法 |
| --- | --- |
| `workflow/storydoc.js` | `hideBriefVersion` / `restoreBriefVersion` / `hideOutlineVersion` / `restoreOutlineVersion` + `visibleVersions` / `hiddenVersions`；`hidden` 标记进 sanitize，版本记录**出生时**就带它（否则 round-trip 不无损） |
| `ui/versionrow.js` | 展开历史时每一版旁边一个 ✕；回收区一行「vN ↩」 |
| `ui/briefws.js` · `ui/storyws.js` | 接线；**正在依据的那一版与已批准的那一版不给 ✕** |
| `ui/studioparts.js` | `renderShotList(..., { delAttr })` —— 镜头行可选的删除出口（✕ 是 `.shotitem` 的**兄弟**：它自己是 `<button>`，套一个进去点了会变成「打开这个镜头」） |
| `ui/storyboard.js` | 卡片视图接上**同一条**软删除（`ctx.shots.softDelete` / `restoreDeleted`）+ 回收区；删除时先算 `deletionImpact` 并如实说出后果（告知不是闸门） |
| `workflow/convactions.js` | 六条新动作：`brief.hideVersion` / `brief.restoreVersion` / `outline.hideVersion` / `outline.restoreVersion` / `shot.hide` / `shot.restore` —— 他能删，Agent 就能删 |

**不许删的两版**：下游正在依据的（`active`）与已批准的（`approved`）。想删它们，先切换
或改批到别的版本 —— 这不是刁难，它就是「先把不可逆变可逆」那条路。

## 真机验证时抓到的缺陷

删掉一个镜头后，那一行变成 **「不在当前草稿」** —— 场景仍然引用着它（撤销要靠这条引用
把它原位放回），但屏幕上看着像坏了。现在回收区里的镜头**直接从列表消失**；真正的坏引用
（引用了一个既不在草稿也不在回收区的 id）仍然照常露出来 —— 那两件事不能长得一样。

## 顺带修掉的一条「为了错误的理由而通过」的测试

`convactions.test.mjs` 里守「破坏性动作不进表」的那条，判据是**扫 id 里有没有
`delete`/`remove` 字样**。这一批把动作命名成 `hide` 就绕过去了。换成两条真判据：

1. 每条动作必须写明 `undo` —— 撤销它的动作 id，或它为什么天然可逆；
2. 源码里不许**调用** `confirmPlan(` / `startGeneration(` / `promptBatch(` /
   `removeProject(` / `unregisterProject(` / `saveCanvas(`（找的是调用，不是提及，
   否则文件头里解释「为什么 confirmPlan 不在表里」的那句话会让测试转红）。

## 验证

- `mockups/motv-workspace/tests/versiondelete.test.mjs` → 12 passed（删了不再显示但链不动、
  撤销放回、不许删 active、大纲不许删 approved 且改批之后就能删、未知版本号说得清、
  标记活过 round-trip、收起时不画 ✕、展开后除不许删的都有 ✕、回收区列出并可撤销、
  空回收区不占地方、回收区镜头从场景列表消失、真正的坏引用仍然露出）
- `mockups/motv-workspace/tests/convactions.test.mjs` → 12 passed（含改写后的两条守卫）
- 前端全量 **1929 passed / 0 failed**
- **真机**（隔离账户根，不碰他的项目）：创意简报三版 → 展开历史 → 删 v1 → 列表只剩 v2/v3、
  回收区出现 `v1 ↩` → 撤销 → v1 回来；分镜三镜 → 删第一镜 → 列表只剩两镜、
  「回收区（1）」→ 撤销 → 原位回来

## Follow-up

- 人物 / 关系 / 分集这些页面各有自己的删除或归档，形态不完全一致（关系是硬删除 +
  前置检查，分集是归档）。统一成同一套「删除 + 回收区」值得做，但不在本卡范围
