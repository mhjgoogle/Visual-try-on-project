# TASK-128：剧集制作侧的写也走动作表 —— REQ-006 判据 1 的另一半

- 状态：**盘点完成，接线未开工，等一条 ADR**（2026-09-05）。没有 Agent 在做，所以回到
  `backlog/`。IN SCOPE 第 1 条（盘点剧集侧写入口）已完成、结论在文末；第 2–4 条
  **卡在一个本卡 OUT OF SCOPE 的架构问题上** —— 直接接线会默认绕过 `allowedAt`
  这道自动化闸，见文末第 2 节。与 [TASK-129](TASK-129-settings-structure-writes-into-the-table.md) 同批
- Workflow：Refactor（不改有效产品行为）· 深度：DEEP（跨 `ctx.actions.dispatch` envelope 与 `convactions`）
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  判据 1 —— **剧集制作侧**那一半。故事开发侧（四页 + 创意简报 / 大纲 / 人物 / 场景地 /
  分集规划）由 [TASK-127](../active/TASK-127-one-action-table.md) 闭合并有合同测试
- 关联 ADR：[ADR-0096](../../adr/ADR-0096-ui-and-agent-share-one-action-table.md) 决策 1–3（同一条纪律，另一侧）
- 架构约束：`CA §3`（写路径）· `CA §5.2`（不静默覆盖）· `CA §6`（动作表由前端拥有）
- 依据：codex 对 TASK-127 的轮 1 审查 —— 合同只证了故事侧前缀，`shot.* / blocking.*`
  在证明之外；按 ADR-0088 决策 6 把缺口写成卡、在 REQ 里记下去向，**不让 PARTIAL 被
  当成 PASS 合掉**

## 为什么单独一张卡

剧集制作侧的界面写不走 `swork.*`，走的是 `ctx.actions.dispatch(envelope)`（`postconsole` /
`epprod` 的 `act()`），而 Agent 侧的 `shot.hide / shot.restore / blocking.*` 直接调 `ctx.*`。
两套 envelope 合成一张表，要先回答「envelope 的 `action` 名与 `ACTIONS` 的 id 是不是同一个
词表」—— 今天不是（`hideShot` vs `shot.hide`）。这是词表统一问题，不是接线问题，
所以不塞进 TASK-127。

## IN SCOPE

1. 盘点剧集侧的**创作者写入口**：`epprod.js` / `postconsole.js` / `storyboard.js` /
   `blockingws.js` / `shotwork` 各分区里经 `act()` 或直接 `ctx.*` 的写；
2. 每一条可逆、非付费、非绑身份的写 → `ACTIONS` 里一条动作（有的合并进既有 `shot.* /
   blocking.*`），界面改走 `uiAct(ctx, id, args, { rerender })`；
3. `test_surface_manifest.py` 的前缀集合扩到 `shot.* / blocking.*` 及新增前缀；
   第 4 条（无直接写）扩到对应的 bind 函数；
4. 付费（渲染 / 生成）、绑定身份（`confirmPlan`）、删字节（存储管理）**不进表**，
   在合同里以显式 allow-list 记明理由。

### 已被独立审查点名的一处（2026-09-05 · codex 块 2b 补审）

> `production.js` 的 `bindBlocking`：增删按钮、字段编辑与拖动**直接改模型并
> `persist()`**，绕过动作表 —— 违反 REQ-006 判据 1 的单一登记点。

它来自 `23f80ec`（TASK-123 白膜导演台），**不是**块 2b 那批补审改动带进来的，所以
按 AGENTS.md 第 17 条没有在补审里顺手修，登记到这张卡 —— 它正是本卡第 1、2 条的
范围（`blockingws.js` 已在盘点清单里，`production.js` 的 `bindBlocking` 是同一条路
的界面这一端）。**做本卡时请把它当作已确认的一条，不必再论证。**

## OUT OF SCOPE

- `ctx.actions.dispatch` 这套 envelope 本身的去留 —— 若两张表合一需要 ADR，另立。
- ADR-0096 决策 4（页面地图 / 能力输入从表派生）—— 再另一张卡。

## 完成判据

1. `test_surface_manifest.py` 对**全部**非付费、非绑身份、可逆的 `ACTIONS` 成立双向：
   界面引用 ⊆ 表；表中每条被界面引用；allow-list 外无直接写。
2. REQ-006 判据 1 由 `PARTIAL` 转 `PASS`（收敛审查 §3 那一行同步）。
3. 前端全量、`tests/contract`、`tests/studio` 全绿；`motv_doctor` 无新红。

---

## 盘点结果与一个必须先答的问题（2026-09-05，Claude）

IN SCOPE 第 1 条（盘点）**做完了**，写在下面。第 2 条（接进表）**没开工**，
因为盘点当场撞出一个属于本卡 OUT OF SCOPE 的架构问题 —— 不先答它，接线只会
悄悄拆掉一道现有的闸。卡因此退回 `backlog/`（没有 Agent 在做）。

### 1. 剧集侧的写入口（穷尽，按 grep 实测）

信封动作词表**已经存在且是完备的**：`src/workflow/actions.js` 的 `ACTIONS`
（约 45 条，每条带 `args` 与 `risk`）。界面实际用到的 22 个名字：

| 分组 | 信封 `action` | 用在哪 |
| --- | --- | --- |
| 镜头音频 | `autoArrangeShotAudio` `addAudioClip` `moveAudioClip` `setGain` `setFade` `setAudioMuted` `removeAudioClip` | `postconsole.js` |
| 成片时间线 | `buildRoughCut` `moveTimelineClip` `trimTimelineClip` `setTransition` `setTimelineVolume` `removeTimelineClip` `restoreTimelineClip` `replaceTimelineAsset` | `postconsole.js` |
| 字幕 | `buildSubtitles` `updateSubtitle` | `postconsole.js` |
| 锁 | `lockItem` / `unlockItem`（同一按钮按当前状态二选一） | `postconsole.js:952` |
| 镜头参考 | `addReference` `setReferenceUse` `attach` | `shotrefs.js` |
| 导演台 | `prepareGeneration` · `el.dataset.sdFix`（**动态名**，从 DOM 取） | `directorshot.js` |
| 裁决 | `review`（4 处） | 多处 —— 属于 TASK-127 已记的「裁决类」，本来就不进表 |

**卡上点名的五个文件里，有三个其实没有直接写**：`epprod.js` / `storyboard.js` /
`blockingws.js` 经 grep 没有 `act()` 也没有 `ctx.actions.dispatch`。剧集侧的写
**集中在 `postconsole.js`（约 25 处）**，加上 `shotrefs.js` `directorshot.js`
`production.js:3145` 三处。卡上「各分区里经 `act()` 或直接 `ctx.*` 的写」这句
预设了更分散的分布，实测不是 —— 这对第 2 条是好消息（改动面比预想窄）。

`directorshot.js:779` 的 `el.dataset.sdFix` 是**从 DOM 读出来的动作名**。它进表时
不能按「一个按钮一条动作」接，否则接不全；要么把 fix 的取值集合钉出来，要么这一处
单独作为一条带 `which` 参数的动作。

### 2. 撞出来的问题：搭桥会默认绕过 `allowedAt`

`src/workflow/actions.js` 的 `allowedAt()` 是这套信封的自动化闸：在当前级别
`CURRENT_LEVEL = "suggest"` 下，**`origin: "ai"` 的一切写动作一律拒绝**，只放行
`risk: "read"`。它的存在理由写在文件头上：「AI 建议 → 你确认 → 执行」。

而 `app.js:3634` 的分派是 `origin: meta.origin || "user"` —— **默认 user**。

于是：如果按本卡第 2 条把这些写接成 `convactions.js` 的动作、`apply` 里调
`ctx.actions.dispatch({...})` 而不显式传 `origin`，对话里的 Agent 就会以 `user`
的身份穿过这道闸。**那不是把两张表合一，那是拆掉其中一张表的闸，而且不留痕迹。**

这正是本卡 OUT OF SCOPE 写着的那一条：

> `ctx.actions.dispatch` 这套 envelope 本身的去留 —— 若两张表合一需要 ADR，另立。

所以第 2 条**不能在本卡范围内直接做**。要先答的是一个产品语义问题，不是接线问题：

> 创作者在对话里说「把第 3 个片段的增益调到 -6」，Agent 执行它 —— 这算
> `origin: "user"`（他本人下的指令，Agent 只是手），还是算 `origin: "ai"`
> （需要他再确认一次）？

两个答案都自洽，选哪个决定了整条剧集侧接线长什么样：

- **算 user** → `allowedAt` 对「他明确指示的那一条」不再是闸，闸退回到
  `convactions.js` 的 `paid` / `identityBinding` 标签。这与 ADR-0096 决策 2 一致
  （标签由 `runAction` 统一判），但它**改变了 `allowedAt` 的既有含义**，要 ADR。
- **算 ai** → 剧集侧的写只能生成提案让他点，`REQ-006 判据 1`（他能点的 = 它能做的）
  在剧集侧**永远不可能 PASS**。那样的话该改的是判据，不是代码。

**建议**：立一张 ADR 回答这一条（`allowedAt` 的 origin 语义 vs REQ-006 判据 1），
Accept 之后 TASK-128 第 2–4 条才是纯接线，改动面已经盘清（见上表），一天之内能完。
本次没有替这个问题做主 —— 它会同时改动两个已有合同的含义。

### 3. 顺带核实到的、对第 2 条有用的事实

- `runAction(ctx, ...)` 把 `ctx` 原样交给 `spec.apply(ctx, args, meta)`，且 `meta`
  里带 `origin`。所以搭桥**不需要改 `app.js`**：`apply` 里能拿到 `meta.origin`
  并原样传给 `dispatch`。这也意味着上面那个语义问题在实现上只是一行 —— 正因为
  只是一行，才更要先把它写进 ADR，而不是顺手填一个值。
- 信封词表已经带 `args` 与 `risk`，所以第 2 条**应当派生而不是手写 22 条**
  （TASK-087 §7 推论 2：守卫的键集要派生，新成员应当因为存在而进测试）。手写的
  那一版会在有人往 `actions.js` 加第 46 条时安静地漏掉它。
- `risk: "heavy"` 的两条（`mixShotAudio` `renderEpisode`）与 `buildRoughCut` /
  `buildSubtitles` 的边界要单独判：前两条界面上没直接调，后两条调了。
  「花时间和字节」不等于「花钱」，但也不等于可逆 —— 逐条判，别按 `risk` 一刀切。

### 4. 订正：这个问题不是二选一（2026-09-05，与 `visual-try-on-project-2a` 对照后）

上面第 2 节把它写成了「算 user 还是算 ai」的二选一，**那个问法把两件事揉在了一起**：

- **谁发起的**（他点的按钮 / 他在对话里说的话 / Agent 自己决定的）
- **谁按的确认键**

而这个仓库**已经选过边了**，只是那条约定还只活在代码里：

- `runAction(ctx, id, args, meta)` 的 `meta.origin` 记的就是发起方；
- 带 `identityBinding` 的动作**只认 `origin === "ui"`** —— 也就是说
  **「他在对话里说的」已经明确不等于「他自己点的」**（`convactions.js` 里那条
  `if (spec.identityBinding && origin !== "ui")` 是活的，块 2a 那轮确认过）。

所以不需要一张 ADR 去答二选一。**该写进 ADR 的是「发起方与确认方是两个字段」这条
既成事实** —— 把它从代码里的隐含约定升成显式合同，顺带说清 `allowedAt` 的 origin
与 `runAction` 的 `meta.origin` 是同一个概念的两处表述。

**TASK-128 重开时按两步做，题目也要改**（不再是「剧集侧的写也走动作表」）：

1. 把 `postconsole.js` 那 25 处登记成动作，**`origin` 一律照实传** ——
   界面按钮传 `"ui"`，对话来的传 `"agent"`，`apply` 里原样交给 `dispatch`。
   （已核实：`runAction` 把 `meta` 交给 `apply`，所以这一步**不需要改 `app.js`**。）
2. 再逐条判每个动作在 `allowedAt` 下的级别。**该在 suggest 级别拒 ai 的就继续拒 ——
   那不是待修的阻碍，那是设计。** 他要在对话里做这些，正确形状是 Agent 提案 + 他点
   确认（`proposeOutline` / `proposeScript` 就是这个形状），不是给 Agent 发一张
   user 通行证。

**由此，REQ-006 判据 1 在剧集侧的判词也要跟着改**：不是「Agent 能不能直接写」，
而是「**每一条他能点的写，Agent 都说得出对应的名字，并且走得到那条提案路径**」。
按现在的判据原文去追 PASS，会追到一个拆掉闸门的实现上。

> 上面第 2 节那个二选一的问法**保留原文不改**（AGENTS §24：不篡改旧版）。
> 它错在哪、为什么错，就是本节。
