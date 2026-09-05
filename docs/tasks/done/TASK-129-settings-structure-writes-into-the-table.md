# TASK-129：作品设定的结构写也走动作表 —— REQ-006 判据 1 的第三块

- 状态：**实现完成**（2026-09-05 收口，切片 2e 划掉棘轮里最后两个名字）
  - 实现完成：是。证据 = `DEFERRED_BINDERS` 连同它那三条测试一起删了（名单空了，
    留着等于养一条永远绿的测试），`workspaces.js#settings` 进 `CONVERTED_BINDERS` ——
    那条测试更严：**一个直接写都不许有**。`tests/contract` 267 passed。
  - 独立审查：codex 4 轮（未降级到 claude 回退），第 4 轮对本卡改动面**四闸全绿**
    （Requirement `PASS`（仅第三块）· Architecture `CA §2`/`§3`/`§5.2`/`§6` 全 `PASS` ·
    Verification `SUFFICIENT` · 无 BLOCKING）。前三轮各报出**一条机制不同的 P1**，
    按 ADR-0081 §2a/§2c 各买一轮，全部修掉：① 摘图只比对显式主图（继承来的生效主图
    被摘掉后指针指向非成员）；② 轮 1 的抽取连**反应**一起共用了，于是显式的
    「不要主图」被摘图改掉；③ `undo` 声明 `remove` 是 `add` 的逆，但原本在继承时
    `add→remove` 得到的是显式空清单 —— 那一条**改说法不改行为**，理由写在动作注释里。
    驳回并记录 1 条（`reset` 丢掉「曾选过哪几张」→ TASK-087 §6.13）。
    报告：`.claude/tmp/last-review.md`（一次性产物，随卡删）。
  - 还没在真实项目上被人看过：状态级参考图那四个入口（挂图 / 摘图 / 换主图 /
    改回继承）换成 `uiAct` 之后的界面手感。语义有单测钉着（含三个变异体全被抓到），
    但「点起来还是那样」要他自己看一眼。**这是信息，不是闸门**（AGENTS.md §1）。
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

**`workspaces.js::bindSettings`** —— 作品设定里的实体与状态。
**切片 2c 已划掉实体本身那 6 个**（~~`addCharacter` · `renameCharacter` · `removeCharacter` ·
`addLocation` · `renameLocation` · `removeLocation`~~ → `character.add/.rename/.remove/.restore`
与 `location.*` 同名四条，回收区在角色库/场景地库下方有入口）。
**切片 2d 又划掉 10 个**（状态、参考图、声音）→ `character.state.*` / `location.state.*`
各五条（由一个工厂派生，不手写两遍）、`reference.add/.remove/.restore/.setActive`、
`character.voice`。

~~**棘轮里现在只剩 2 个**：`setCharacterStateOverrides` · `setLocationStateOverrides`。~~
**已收口（2026-09-05，切片 2e）**：`character.state.reference.add/.remove/.reset/.setActive`
与 `location.*` 同名四条，由 `stateActions` 同一个工厂派生 —— 两边不会长出第二套语义。

拖到最后是因为它不是接线，是一次**跨层搬迁**：`nextStateRefsOnAdd`（「加一张次要参考图
永远不顶掉当前主图」那条纯决策）原住 `ui/workspaces.js`，动作表要用它就得
`workflow` 反向 import `ui/`，撞 CA §2 的依赖方向。搬进 `workflow/bibledoc.js` 之后，
四个入口才接得上；它的单测跟着从 `workspaces.test.mjs` 搬到 `bible.test.mjs`
（测的是规则，不是界面怎么画）。

搬完顺手清掉三个没人再调的界面私有 helper（`entityRec` / `stateOv` / `setOv`）——
留着就是那条「一份算法两处陈述」的老账。

**界面里的动作 id 一律写字面量，不用 `${prefix}.state.reference.add` 拼**：合同那条
「他能点的 = 它能做的」反方向靠源码文本扫描，模板拼出来的 id 它扫不到 —— 实测撞到过，
八条动作全被判成「只有 Agent 能做」。扫不到的后果是**漏**，不是吵。

下面是原始的 18 个名字，原文保留：

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

1. ~~`DEFERRED_BINDERS` 为空，三个 bind 函数在 `CONVERTED_BINDERS` 里，合同全绿。~~
   **达成**（2026-09-05）：名单空了 → 连同 `test_deferred_*` 三条一并删除；
   `relws.js` / `epplanws.js` / `workspaces.js#settings` 都在 `CONVERTED_BINDERS` 里。
2. 与 TASK-128 一起闭合后，REQ-006 判据 1 由 `PARTIAL` 转 `PASS`（收敛审查 §3 同步）。
   **本卡这一半已到位**；判据 1 仍是 `PARTIAL`，因为剧集侧（TASK-128）还没做 ——
   那不在本卡范围内，REQ-006 与收敛审查 §3 里都已写清剩下的是哪一张。
3. ~~前端全量、`tests/contract`、`tests/studio` 全绿；`motv_doctor` 无新红。~~
   **达成**（2026-09-05）：前端 2226 passed / 0 failed、`tests/contract` 267 passed。
   变异验证：把「加次要图不顶掉主图」「摘掉主图后指针让位」「撤清单同时撤主图指针」
   三条各破一次，三次都转红。
