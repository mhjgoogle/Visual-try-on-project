# TASK-129：作品设定的结构写也走动作表 —— REQ-006 判据 1 的第三块

- 状态：**待开始**（2026-09-05 开卡；没有 Agent 在做 —— 切片 5 之后，与 TASK-128 同批）
- Workflow：Refactor（不改有效产品行为）· 深度：DEEP（人物 / 场景地状态与参考图、关系结构、节拍 —— 带身份的实体增删）
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  判据 1 —— 作品设定**结构**那一半。字段编辑（`character.fields / location.fields /
  relationship.fields / world.fields`）与新建（`character.add / location.add`）、正式 ↔ 临时
  （`character.tier`）已由 [TASK-127](../active/TASK-127-one-action-table.md) 接进表
- 关联 ADR：[ADR-0096](../../adr/ADR-0096-ui-and-agent-share-one-action-table.md) 决策 1–3
- 架构约束：`CA §3` · `CA §5.2`（不静默覆盖：删除必须是软删除 + 回收区）· `CA §6`
- 依据：`tests/contract/test_surface_manifest.py` 的**棘轮**——下面每一个名字都被钉死在
  `DEFERRED_BINDERS` 里：**只能减少，不能增加**；接一个划一个，两边同步

## 为什么单独一张卡

这些写带着**实体身份**（新建 / 改名 / 软删一个人物状态、一张参考图、一段关系），每一条
进表前都要先回答「撤销的那条路存不存在」（`convactions.js` 头部三条硬规矩之一）。
`removeCharacter` / `removeRelationship` 今天是不是软删除、回收区能不能找回，要逐条核；
核不过的先把它做成可逆的，再登记。这不是接线问题，是可逆性审计，所以不塞进 TASK-127。

## 棘轮里的名字（与合同同一份，逐条）

~~**`epplanws.js::bindEpPlanWs`** —— 分集规划里的节拍与上游戳：
`setCharacterBeat` · `setRelationshipBeat` · `setTextBeats` · `stamp`~~
**已收口（2026-09-05，切片 2b）**：前三个进表（`beat.character` / `.relationship` / `.text`），
界面走 `uiAct`，`bindEpPlanWs` 已移入 `CONVERTED_BINDERS`。

**`stamp` 不进表**，进的是 `ALLOWED_DIRECT`，与 `confirm` 同一类：它记录「本集基于
当前这一版上游」——认哪一版是他的决定，而且**盖下去旧基线就没了**（「⚠ N 个上游变化」
正是拿它算的）。Agent 替他盖一次，等于替他宣布「上游那些改动我都认了」。
不为它做可逆化：那要单独存一份基线历史，而这条本来就该他自己按。

~~**`relws.js::bindRelWs`** —— 关系的结构：
`addRelationship` · `removeRelationship` · `swapDirection`~~
**已接进表（2026-09-05，切片 2）**：`relationship.add` / `.remove` / `.restore` / `.swap`，
界面走 `uiAct`，`bindRelWs` 已移入 `CONVERTED_BINDERS`。`removeRelationship` 接进去之前
先改成了软删除 + 回收区（切片 1），回收区在关系图上有入口 —— 只有 Agent 撤销得了
而他不能，会把 REQ-006 判据 1 反过来。

**`workspaces.js::bindSettings`** —— 作品设定里的实体与状态：
`addCharacter` · `renameCharacter` · `removeCharacter` ·
`addCharacterState` · `renameCharacterState` · `removeCharacterState` · `setCharacterStateOverrides` ·
`setCharacterVoice` ·
`addLocation` · `renameLocation` · `removeLocation` ·
`addLocationState` · `renameLocationState` · `removeLocationState` · `setLocationStateOverrides` ·
`addReferenceAsset` · `removeReferenceAsset` · `setActiveReferenceAsset`

（`bindSettings` 里的 `addCharacter` / `addLocation` 与 `biblews` / `worldws` 里已接进表的
`character.add` / `location.add` 调的是同一个 `ctx.bible.*`——这里只是**另一个入口**没换过来。）

## IN SCOPE

1. 逐条核可逆性：`remove*` 必须是软删除 + 回收区可撤销（TASK-115 的做法）；不是的先改成是；
2. 每条 → `ACTIONS` 一条动作（状态 / 参考图 / 关系 / 节拍各一组前缀），界面改走 `uiAct`；
3. 把接好的名字从 `DEFERRED_BINDERS` 与本卡**同时**划掉（合同两边都钉着）；
   全部划完后把这三个 bind 函数搬进 `CONVERTED_BINDERS`。

## OUT OF SCOPE

- 剧集侧（`shot.* / blocking.*`，`ctx.actions.dispatch` envelope）→ TASK-128。
- `confirm`（确认一面设定升一版）—— 裁决类，Agent 不得静默定稿（IA §8.3），**不进表**。

## 完成判据

1. `DEFERRED_BINDERS` 为空，三个 bind 函数在 `CONVERTED_BINDERS` 里，合同全绿。
2. 与 TASK-128 一起闭合后，REQ-006 判据 1 由 `PARTIAL` 转 `PASS`（收敛审查 §3 同步）。
3. 前端全量、`tests/contract`、`tests/studio` 全绿；`motv_doctor` 无新红。
