# TASK-065：创作对象优先的 IA 收口（基础资产 / 关系图 / 当前 Shot 生产图）

- 状态：实施完成，待产品验收
- 负责 Agent：Claude Code（单一实施 Agent）
- 依据：[ADR-0063](../adr/ADR-0063-creator-object-first-ia-and-shot-production-graph.md)
- 前置：[TASK-064](TASK-064-creator-ui-consolidation.md) Phase 1 / 1b / 2 / 3 全部完成
  （**仍未 commit，全部在 working tree**）

## 0. 基线与边界

从 `b341bbe` 起的 working tree 继续。**TASK-064 的 Phase 2 / Phase 3 不重做、不
reset、不丢弃**：后期控制台、镜头多轨音频、Shot Mix、字幕、自动初剪、Episode
剪辑台、Lock、Final Render provenance、`refinterp`、`framebind`、`promptdoc`、
Action Layer 全部原样保留，本轮只复用它们。

基线数字（本轮开始前）：

- 前端 `node --test tests/*.test.mjs`：**792 passed**
- 全量 pytest：2959 passed / 56 skipped
- Connected Project：`夜班沉默`（`D:\02_Work\04_video-work\MotvProjects\夜班沉默`）

本轮性质：**UX / Information Architecture 收口**。领域层只做加法（一个纯读模型
模块 ×3、一个纯编译函数、两个 canondoc transition、一个 Skill、三个 Action 名、
一个 Asset kind），不改既有 schema，不做 schema 迁移。

## 1. 交付

### 1.1 故事开发 · 人物（§1 / §2 / §3）

| 交付 | 位置 |
| --- | --- |
| 人物工作区 = `[正式角色] [临时角色] [人物关系]` | `src/ui/biblews.js` `TABS` |
| 人物页删除 `场景地` / `声音` / `风格` 三个页签 | 同上（能力未删，见 ADR 决策 1） |
| 基础资产读模型（参考图 / 状态参考 / Base Voice / 缺口） | `src/workflow/baseassets.js` |
| 基础资产面板（人物与场景地**共用一个组件**） | `src/ui/baseassetpanel.js` |
| 基础生图 Prompt 编译器 | `src/workflow/promptc.js` `compileEntityBasePrompt` |
| 基础生图 Prompt 版本 / Lock（复用 promptdoc，命名空间 key） | `app.js` `ctx.basePrompt` |
| 上传 / 从资产库选择 / 设为主图 / 移除 / 恢复继承 / 添加状态 | `app.js` `ctx.baseAssets` |
| Base Voice 上传 + 从资产库选择（`voice-reference` + `links.characterId`） | `ctx.baseAssets.uploadVoice` / `useVoiceAsset` |
| 上传后的建议名称（人物名 + 状态推导，预填可改，确认才登记） | `baseassets.suggestReferenceName` |

### 1.2 人物关系图（§2）

| 交付 | 位置 |
| --- | --- |
| 关系图布局 + 标签读模型（确定性布局，节点是真实 Character） | `src/workflow/relgraph.js` |
| 关系图 UI（SVG，点两个人物建关系，点连线编辑 11 个 facet） | `src/ui/relws.js`（导出名不变） |
| 关系类型 / 方向 / 情绪·冲突 / 当前关系 四件事都在图上 | 同上 |
| 「改方向」同时调换 `aToB` / `bToA` | `canondoc.swapRelationshipDirection` |
| 「当前关系」由 Episode Relationship Beat 派生（不存第二份） | `canondoc.relationshipCurrentState` |
| AI 关系提案 Skill（第 15 个） | `src/workflow/skills.js` `relationship-director` |
| 提案写回（create-or-revise，dispatcher 校验两个 characterId） | `skillapply.js` + `app.js` `upsertRelationship` |
| Action Layer 三个新动作 | `actions.js` `upsertRelationship` / `removeRelationship` / `swapRelationshipDirection` |

### 1.3 世界观 · 场景地（§4）

| 交付 | 位置 |
| --- | --- |
| 世界观 = `[世界设定] [场景地]` | `src/ui/worldws.js` `WORLD_TABS` |
| Location / LocationState / 场景参考图 / 场景基础 Prompt | 同上 + 共用的基础资产面板 |
| 「视觉基调」编译进每个场景地的基础 Prompt | `compileEntityBasePrompt` `worldTone` |

### 1.4 剧集制作（§5–§17）

| 交付 | 位置 |
| --- | --- |
| 中央改为「制作台」：`EPISODE_DEFAULT = "workbench"` | `src/ui/shell.js` |
| 轻量 Scene → Shot 选择（两行 chip） | `src/ui/epprod.js` `placeBar` / `currentPlace` |
| 当前 Shot Production Graph 读模型（交叉网络 + A/B 派生） | `src/workflow/shotgraph.js` |
| 当前 Shot Production Graph 渲染 + 实测几何画边 | `src/ui/shotgraphview.js` |
| 生成溯源改为工作区 + 中央常驻入口「完整溯源 ↗」 | `epprod.js` `topBar` |
| 左栏去掉七按钮功能 tab 条，改为对象路径 | `src/ui/prodinspector.js` `pi-where` |
| Generation Input 可勾选清单（推荐可见不隐藏） | `prodinspector.js` `referencePicker` |
| 点节点 → 左栏 Inspector（可点性由同一个解析器决定） | `shotgraph.inspectFromShotNode` + `production.js` `onOpen` |
| 后期控制台位置不变（中央下方 dock） | 未改动 |

### 1.5 CSS

`styles/epprod.css` 追加：`pi-where` / `pi-refrow`+`pi-check` / `ep-place` /
`sg-*`（生产图）/ `ba-*`（基础资产）/ `rg-*`（关系图）/ `drawer.wide` 两栏抽屉。

## 2. 本轮的关键判断

1. **基础生图 Prompt 复用 `promptdoc`，用 `base:<kind>:<id>[|<stateId>]` key。**
   第二套 Prompt 存储 = 第二套版本规则 + 第二个自动化层会忘记查的 Lock。
   前缀保证它永远不可能等于某个 shotId。
2. **Base Voice 不覆盖 `voice.voiceId`。** 那是本地 TTS 的身份串
   （`ttsDialogue` 缺它就拒绝运行），覆盖会直接搞坏这个人物的配音。
   样本改为 `voice-reference` 音频资产 + `links.characterId`。
3. **不给 Asset `links` 加 `stateId`。** 校验层要求每个 canonical link key 都存在，
   加一个要 schema 迁移 + 版本 bump；而「状态有自己的参考图」已经由
   `states[].overrides.referenceAssetIds` 表达——那本来就是领域设计的位置。
4. **建议名称是推导，不是模型调用。** 它由人物名 + 状态名确定，调模型只多一次
   等待和一种失败模式，并且会稀释本项目里「AI 提案」的含义（那指一次有记录的
   Skill Run + 一次 accept/ignore）。UI 明说它是推导来的。
5. **`relationshipsModel` 删除而不是保留。** 同一批记录上的第二个读模型必然漂移。
6. **节点可点性由 `inspectFromShotNode` 决定**，而不是由第二条关于 state 的规则。
7. **勾选框读渲染时状态（`data-on`）而不是 `checkbox.checked`。** 浏览器在 handler
   触发前已经翻了框；信它会在 re-render 落在点击与 handler 之间时把动作反过来。
8. **`relationships` / `settings` 仍是可解析 module key。** `setModule` 路由到对应
   页签，既有跳转目标一个都不落空。

## 3. 自己的守卫抓到的两个真实缺陷

1. **`relgraph.js` 里有两个字面 NUL 字节。**
   `tests/test_motv_upstream_task057.py::test_no_source_file_contains_a_nul_byte`
   抓到。git 会把含 NUL 的文件判为 binary，**该文件从此不出现在任何 diff 里，
   也就永远不会进入 code review**（TASK-057 已发生过两次）。
   来源是手写的 pair key 分隔符。修法不是换个分隔符：**改用
   `canondoc.pairKey`**——characterId 是任意非空文本，任何分隔符都可能合法出现在
   id 内部并让两个不同的对撞成一个 key，这正是 `pairKey` 存在的理由。
2. **生成图上「生成任务」节点被渲染成不可点。**
   第一版用 `state !== "gap"` 猜可点性，于是没有生成记录的 `gen:image`
   （state `absent`）看起来像故意不可点——而**打开它恰恰是创作者发起一次生成的
   方式**。改为由 `inspectFromShotNode` 决定，即点击处理器解析选择用的同一个函数；
   新增一条断言把「可点 ⟺ 有面板」逐节点钉死。

## 4. 验证结果

- 前端 `node --test tests/*.test.mjs`：**823 passed / 0 failed**
  （792 → 823；新增 `tests/creatorobject.test.mjs` 29 项 + `upstream.test.mjs`
  的关系图与方向调换守卫）
- 模块导入 smoke：19 个新旧模块全部可加载（`_agent-tools/impsmoke.mjs`）
- 受影响 pytest（12 个文件，含全部 motv 前端契约守卫）：**132 passed / 3 skipped**
  （skip 均为 Windows symlink 权限与 piper POSIX shim，ADR-0049 既有原因）
- `ruff check .`：**All checks passed**
- 浏览器驱动验收：见 §6
- Codex 独立审查：见 §7
- 全量回归：见 §8

## 5. 有意的合同变更（测试同步更新，不是测试迁就实现）

| 文件 | 断言 | 变更 |
| --- | --- | --- |
| `tests/workspaces.test.mjs` | `NAV[0].items` | 去掉 `relationships`，并新增「module key 仍可解析」的守卫 |
| `tests/workspaces.test.mjs` | `EPISODE_DEFAULT` / `EPISODE_NAV[0]` | `provenance` → `workbench` |
| `tests/upstream.test.mjs` | `NAV[0].items` | 同上 |
| `tests/upstream.test.mjs` | `relationshipsModel` | 换成 `relationshipGraph`，并补两条新守卫 |
| `tests/creatornav.test.mjs` | 中央是什么 / focus filter 在哪 | 制作台是中央；focus 属于镜头选择器 |
| `tests/skills.test.mjs` | `SKILLS.length` | 14 → 15 |
| `tests/test_motv_upstream_task057.py` | 左栏一级导航 | 去掉 `relationships`，加「key 仍有 label」守卫 |

## 6. 浏览器驱动验收

### 6a. 真实 Connected Project `夜班沉默`

`_agent-tools/accept-task065.mjs`（真实 `server.py --account-root
D:/02_Work/04_video-work/MotvProjects`，真实项目目录，非 demo seed）：

**69 / 69 断言通过 · 0 个 JS 异常 · 0 个失败请求**

覆盖 §1 / §2 / §3 / §4 / §6 / §8 / §9 / §10 / §11 / §12 / §13 / §14 / §15 / §16 /
§17 / §18 全部编号。其中值得单列的实测：

- 基础生图 Prompt 在真实人物 `林晚 / 少女时期` 上**编译出 127 字符**，
  并跑通完整往返：禁用 → 打字即可用 → 保存为 v1 且 ACTIVE → 正文逐字是创作者写的
  → 「回到自动编译」切回编译结果且 v1 保留可回切。
  （这条特意验的是「版本层建好了但没有调用者真正使用」那一类空承诺。）
- 切到某个 Character State 后，Prompt 与参考区**同时**改成对这个状态
  （render 与 bind 共用同一个 target）。
- 当前 Shot 生产图：八个 band 顺序正确、**9 条实测几何画出的连线**、
  连线区分 `produces / source / frame` 三类、画面 v1–v4 且 v3 ACTIVE。
- A/B 分开且各自有界：A 列出 `林晚 v1（故事开发 · 人物）`、
  `林晚 Base Voice`、`暗夜酒吧 v1（世界观 · 场景地）` 并标注「可复用 / 已在用」；
  B 列出 5 项真实缺口。
- 参考清单 8 项可勾选，**启用 0 / 未启用 8** 同屏可见 —— 推荐没有变成隐形输入。
- 「完整溯源 ↗」真的打开整集溯源图（992×460 可见）并能回到制作台。
- 后期控制台三个页签一个没少（Phase 3 无回归）。

**验收产生的一条真实写入**：往返测试在 `林晚 / 少女时期` 的基础 Prompt 上留下了
一个 v1 版本，随后已切回「自动编译」（`active: 0`），因此**不生效**。如实记录，
不假装验收没有碰过项目。

### 6b. 关系图（在演示项目上验收，真实项目数据够不到）

真实项目 `夜班沉默` 目前**只有一个人物**（林晚），而一段关系需要两个。
`relationshipGraph` 因此拒绝作图并说明原因「先有两个人物，才有关系」——
这是**正确行为**，Connected 脚本正是这样断言的。图本身在设计版演示项目上验收：

`_agent-tools/accept-t065-relgraph.mjs`：**20 / 20 断言通过 · 0 个 JS 异常**

- 4 个真实人物节点（都有头像）、2 条关系连线、每条都有箭头与关系类型标签、
  冲突强度分级为 `hot`、两条都标出了「情绪 / 冲突」。
- **「当前关系」的规则被完整验了三条**：
  EP01 的 `relationship` beat 为空 → 图上**不写**当前关系（不拿作品级定义顶上）；
  切到 EP02（那一集真的推进了林晚 × 苏婉）→ 出现 `EP02 · 察觉庇护里有隐瞒`，
  用的是 beat 的 `end` 而不是 `start`；未被 EP02 推进的另一段**仍然不写**（不外溢）。
- 「改方向」翻箭头**并且**把 `aToB` / `bToA` 一起换过去（实测两段文字互换），
  再点一次完全还原。
- 「让 AI 读剧本提关系」打开右栏 AI 导演并选中 `Relationship Director`。

演示模式无后端，`serve.py` 是静态服务器，5 条 API 404 / 连接重置属预期且
**单独计数、不混进 JS 异常里**。

### 6c. 只有截图能抓到的一个缺陷

第一版把 A/B 摘要按内容自然撑高。在 1000px 视口、后期控制台按 Phase 3 默认展开
（46vh）的情况下，**当前 Shot 生产图整个被挤到折叠线以下**：在 DOM 里、handler
全绑好、每条行为断言都过，创作者一格都看不见 —— 与 Phase 3 控制台完全同一类失败。

三处修法：

1. A/B 各自**限高 168px、内部滚动**；缺口行压成一行（完整原因留在 `title` 里）。
2. 后期控制台的 dock **默认收起**。收起时它仍然显示完整 bar（标题 / 三个页签 /
   初剪版本 / 展开 ↗），点任一页签即展开 —— 什么都没藏，只是推迟到它真的是工作的
   时候。上面负责制作镜头，下面负责把镜头剪成一集。
3. 验收脚本新增两条**测量 boundingBox** 的断言：生产图第一个 band 必须在第一屏内，
   且 A/B 高度必须 ≤ 180px。这一类缺陷从此不可能静默复发。

顺带修掉 band 标题被连线穿过的问题（连线画在卡片之下，但标题原本没有底色）。

## 7. Codex 独立审查

<!-- 逐轮记录写在这里 -->

## 8. 全量回归

<!-- Codex 收敛后只跑一次 -->

## 8b. 环境事实（沿用 TASK-064，本轮复核）

1. **node 已在 Windows 可用**（v24.19.0），前端测试与浏览器验收都能原生跑。
2. **本环境不能后台 spawn**（`run_in_background` / `Start-Process` 报 EPERM）；
   连接后端改用 Bash 的 `nohup … &` 分离启动。
3. **pytest 拉起 node 时会 cp932 解码失败**：必须
   `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`。这是 TASK-064 §4b 已记录的范围外缺陷。
4. **playwright 在 npm 全局**，需 `NODE_PATH=C:\Users\MO\AppData\Roaming\npm\node_modules`。
5. **演示项目只在 LOCAL 模式出现**（`serve.py`），Connected 模式（`server.py`）的
   项目列表只有真实项目 —— 所以 6b 用 `serve.py --port 8796` 另起一个静态服务。

## 8c. 待处理：codex 在 TASK-067 审查中对 `upsertRelationship` 的发现（范围外转入）

2026-08-13，TASK-067 的 codex 审查（本任务的代码仍在 working tree 未提交，因此一并进了
那次 diff）在**本任务**的代码上报了一条 blocking，按 AGENTS.md 第 17 条原样转记，
**未在 TASK-067 中修改**：

> `mockups/motv-workspace/src/app.js`（dispatcher `case "upsertRelationship"`）— 修改
> 一段已存在的人物关系时不检查 `ctx.locks.is("relationship", relationshipId)` →
> 应用一份 Relationship Director 提案会覆盖一段**已锁定**的关系。

判断（供实施时参考，尚未实施）：

- **前提目前不成立**：`workflow/locks.js` 的 `SCOPES` 里**没有 `relationship` 这个 scope**
  （只有 reference / image / video / timelineClip / subtitle，加三个由各自文档拥有的
  prompt / audioClip / frameBinding）。因此 `ctx.locks.is("relationship", …)` 恒为 false，
  今天不存在「已锁定的关系」这种状态。
- 所以这条不是一个可以就地加一行守卫的缺陷，而是一个**设计缺口**：要让关系可锁，先要在
  ADR-0061 决策 5 的锁词汇表里加 `relationship` scope（谁拥有它、id 是什么、界面在哪里
  锁），再让 dispatcher 读它。那是本任务卡的范围，不是一次审查循环里顺手能做的事。
- 现有的保护仍在：dispatcher 会把两个 characterId 都对 `production.characters` 解析，
  解析不到就跳过并报告（不会写到别人身上）。

## 9. 明确不做

Provider API、全局共享资产库、专业 NLE、完整 DAW、复杂调色、AE/Fusion 合成、
multi-camera、高级遮罩与关键帧、新的顶级页面、新的流程系统、无关的 legacy 清理。

### 8d. codex 批量审查 round 4 的新发现（范围外转入，2026-08-13）

**（blocking）`src/app.js` dispatcher `upsertRelationship` 没有归一化 A/B 顺序**：先按
`(a, b)` 查找已有关系，但提案里的 `characterAId` / `characterBId` 完全可能是**反过来**
的一对。此时要么匹配不到已有关系（新建一条重复的），要么——更糟——把 `aToB` /
`bToA` 这两个**有方向**的字段写到相反的人身上，即两个人物的立场被对调。

修法：查找与写入前先按稳定顺序（例如 characterId 字典序）归一化这一对，并在方向被
翻转时同步交换 `aToB` / `bToA`。

> 与 round 1～4 反复报的「locked relationship 可被覆盖」不同，这一条**成立**：它不
> 依赖 `locks.js` 里存在 `relationship` scope。
