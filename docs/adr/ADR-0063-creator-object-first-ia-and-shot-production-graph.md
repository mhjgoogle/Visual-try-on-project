# ADR-0063：创作对象优先的 IA、基础资产与当前 Shot 生产图

- 状态：Accepted
- 日期：2026-08-12
- 关联：[ADR-0054](ADR-0054-production-upstream-workspace.md)、
  [ADR-0055](ADR-0055-unified-asset-registration.md)、
  [ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)、
  [ADR-0058](ADR-0058-production-memory-library-and-episode-production.md)、
  [ADR-0059](ADR-0059-production-graph-identity-contract.md)、
  [ADR-0061](ADR-0061-creator-ia-and-automated-episode-production.md)、
  [TASK-065](../tasks/TASK-065-creator-object-first-ia.md)
- **被 [ADR-0066](ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
  部分撤销**：决策 4 / 决策 5（`EPISODE_DEFAULT = workbench`，当前 Shot 生产图作为
  剧集制作的中央）**被撤销** —— 剧集制作的默认落点改为「本集看板」，镜头生产改为
  四步线性流程，生产图降级为「生成记录」与诊断视图。决策 1 进一步**收敛**（人物 /
  世界观两个入口合为一个「作品设定」页）。决策 2（基础资产四件套与四条硬约束）、
  决策 3（关系用图表达，图成为页内视图）、决策 6（A/B 分区）、决策 7（可勾选生成
  清单、推荐永远未勾选）**全部保留**，迁入「镜头制作 · 准备输入」。

## 1. 背景

ADR-0061 / TASK-064 交付后，能力是齐的：三个顶层空间、九类 Reference 与两种用途、
Prompt 版本与 Lock、首尾帧绑定、后期控制台、真实 Skill 入口、七层身份链。
产品负责人在真实项目上把这些能力用了一遍，暴露的不再是缺能力，而是**能力放错了
位置**——五个结构性问题：

1. **人物只是文字。**
   `production.characters` 有 `referenceAssetIds`，`states[].overrides` 甚至已经
   whitelist 了 `referenceAssetIds` / `activeReferenceAssetId`——即「林婉 / 少女时期
   有自己的参考图」这件事领域层一直支持。但没有任何界面把它组织成
   「这个人物长期复用的基础资产」：没有基础生图 Prompt，没有 Base Voice 上传，
   状态参考图埋在一个折叠表单的第三层。结果是创作者到镜头里才第一次想起要参考图，
   然后重复上传已经存在的东西。

2. **一个主题两个入口。**
   左栏「作品设定」下并列 `人物` / `人物关系` / `世界观`。一段关系连接两个人物，
   没有人物就不存在；要改「林照怎么看沈既白」却必须离开正在看的人。
   同时「人物」页里挂着 `场景地`——地点不属于人物——于是「世界观」变成一页
   指向别处的散文，真正的 Location canon 在另一个空间里。

3. **人物页承担了不属于它的东西。**
   `声音` 与 `风格` 两个页签是**读透镜**：数据都存在各自的角色 / 场景地档案里。
   把只读汇总做成长期占据页面的顶级 Tab，等于用两个入口换零个新能力。

4. **剧集制作的中央回答错了问题。**
   TASK-064 Phase 1b 把整集生成溯源图设为中央，这修掉了「11 个同级 tab」的真问题，
   但它先回答的是「这个东西是怎么来的」——那是**已经做出来之后**才重要的问题。
   进入剧集制作的创作者是来**做下一个镜头**的，整集图把那一个镜头埋在其余一切里面。
   实测 `夜班沉默`：一条完整镜头链约 1790px，中央栏约 990px，尾部要横向滚动才能看到。

5. **推荐可能变成看不见的输入。**
   Reference picker 把库分成 `已绑定 / 本集推荐 / 从资产库选择` 三段互斥列表。
   「推荐」是一个视觉上的第三段，创作者无法在一处看到「这次生成到底会用哪几个」。

## 2. 决策

### 决策 1：作品设定收敛为两个入口，按创作对象归属

```
故事开发 · 作品设定
  人物      [正式角色] [临时角色] [人物关系]
  世界观    [世界设定] [场景地]
```

- **人物关系是「人物」的一个页签。** 关系的两端都是人物；同屏才能改。
- **场景地归「世界观」。** 地点不是人物。世界观从此既是上游设定，也是可复用地点
  档案的家：Location · LocationState · 场景 Reference · 场景基础 Prompt。
- **`声音` / `风格` 两个页签删除。** 二者都是读透镜，改为在拥有它的卡片上编辑：
  基础声音是人物「基础资产」面板的一节，画面指令仍然是它一直是的那个字段。
  **没有删掉任何数据或能力**，只是不再为只读汇总留一个顶级入口。
- **模块 KEY 全部保留。** `relationships` / `settings` 仍是可解析的 module key；
  `setModule` 把它路由到对应工作区的对应页签。既有的跳转目标
  （`data-goto="relationships"`、AI 导演的 blocker 修复、空状态按钮）一个都不能
  落到空处——那是回归，不是迁移。

### 决策 2：Bible 实体拥有「基础资产」，且不新建任何存储

一个人物 / 场景地的基础资产是四件东西，全部**读自已有状态**：

| 基础资产 | 存在哪里（不新建） |
| --- | --- |
| Reference Image | `characters[].referenceAssetIds` / `locations[].referenceAssetIds` |
| 每个 State 的 Reference | `states[].overrides.referenceAssetIds`（领域层早已 whitelist） |
| 基础生图 Prompt | `workflow/promptdoc.js`，key 为 `base:<kind>:<id>[\|<stateId>]` |
| Base Voice | 声明为 `voice-reference` 的音频 Asset，`links.characterId` 指向人物 |

四条硬约束：

1. **不建第二套「人物图片数据库」。** 写入一律经 `ctx.assets.importReference`
   （登记）+ `ctx.bible.*`（挂载），与手工编辑走同一条路径、同一批 guard。
2. **「继承基础」与「这个状态没有参考图」是两件不同的事。** 只有后者是缺口。
   状态第一次拥有自己的列表时，列表用它当前显示的内容做种子——否则第一次状态级
   上传会静默丢掉继承来的参考图（领域层要求状态的 active 指针必须在状态自己的
   列表内，两者必须一起写）。
3. **基础生图 Prompt 复用 promptdoc，用命名空间 key。** append-only 版本、
   active 指针、`active: 0` = 用自动编译、Lock——一套实现。第二套 Prompt 存储
   就是第二套版本规则和第二个自动化层会忘记查的 Lock。`base:` 前缀保证它永远
   不可能等于某个 shotId。
4. **Base Voice 不覆盖 `voice.voiceId`。** 那个字段是本地 TTS 传给引擎的身份串
   （`ttsDialogue` 没有它就拒绝运行）；用媒体 key 覆盖它会直接搞坏这个人物的配音。
   样本是一条普通登记音频资产，用 `links.characterId` 认领。
   `voice-reference` **不在** `REFERENCE_KINDS` 内——它绑在人物上，不绑在镜头上，
   放进去会让每个镜头的「从资产库选择」都列出它。

**上传后的名称是「建议」，不是「AI 生成」。**「林婉 / 少女时期」由人物名 + 状态名
推导（`baseassets.suggestReferenceName`）。这是确定的值，调模型只会多一次等待和一
种失败模式，并且会让本项目里「AI 提案」这个词变弱——在别处它指一次有记录的
Skill Run 加一次 accept/ignore 决策。名称预填、可改、确认后才登记；取消即整次上传
中止，绝不以没人接受过的名字登记。

### 决策 3：人物关系用图表达，四件事在图上

| 图上要说的 | 来自 |
| --- | --- |
| 关系类型 | `profile.basis`（本领域里 basis 就是类型） |
| 方向 | `characterIds` 顺序，由 `canondoc.swapRelationshipDirection` 调换 |
| 情绪 / 冲突 | `profile.tension` / `coreConflict` / `forbidden` |
| 当前关系 | `canondoc.relationshipCurrentState(…, activeEpisodeId)` |

- **节点是真实 Character。** 每次派生都从 bible 解析名字与头像；不存副本，
  所以在「人物」里改名不会在图上留下过期标签。
- **布局是确定的**，由 cast 顺序推导。不存布局：布局不是创作决策，存下来只会
  产生一个能和 cast 打架的文档。
- **「改方向」必须带着 `aToB` / `bToA` 一起换。** 只翻箭头会让创作者写过的话
  描述反了的方向——静默改写人写的文字，比没有箭头更糟。
- **「当前关系」是派生的，不存第二份。** 它是到当前剧集为止最新的 Relationship
  Beat 的 `end`（没有 `end` 用 `start`）。没有任何一集推进过 → **返回 null**，
  而不是拿作品级 `basis` 顶上：那会把作品级定义显示成某一集已经到达的状态。
- **AI 只提案。** 新增 Skill `relationship-director`（第 15 个）。提案必须用
  `characterId` 指名两个不同的人物；写回经 Action Layer 的 `upsertRelationship`，
  由 dispatcher 拿文档校验这两个 id 是否真实存在，不存在就跳过并如实报告。
  修改只写提案里真的带了的字段——「补一条核心矛盾」不能抹掉手写的 Arc。

### 决策 4：剧集制作的中央是「制作台」——当前 Shot 的生产图

```
EP01 ▾   [场景 ▸ 镜头]   聚焦 ▾                      完整溯源 ↗   工作区 ▾
─────────────────────────────────────────────────────────────────────────
✓ 已有可复用基础资产                    |   ! 当前 Shot 还需要补充
─────────────────────────────────────────────────────────────────────────
当前 Shot Production Graph
```

- `EPISODE_DEFAULT` 从 `provenance` 改为 `workbench`（制作台）。
- **生成溯源什么都没丢**（ADR-0061 决策 1 仍然成立：它是本空间的一个视图，
  不是第二套流程模型）。它是工作区之一，并且中央头部有一个常驻入口
  「完整溯源 ↗」。它回答的问题没变，只是不再是唯一的地图。
- **先选对象，再看能做什么。** 中央没有操作 tab 条。左栏顶部是**对象路径**
  （`SH02 林婉擦杯子 › 参考`），只提供一个动作：回到镜头。原来那条
  `镜头 / 参考 / Prompt / 生成 / 画面 / 视频 / 音频` 七按钮条正是
  「先选功能，再找对象」，已删除。
- **Scene → Shot 是两行 chip，不是卡片墙。** 选镜头是一秒钟的动作，之后要让路。
  原来的大卡片工作台不是被删除而是被取代：它的每一项能力都在左栏 Inspector 里，
  每个镜头的缩略图与状态都在 chip 上，整集概览仍有「本集总览」。

### 决策 5：当前 Shot 生产图是真实交叉关系网

按 band 自上而下排布，边在布局之后**实测 DOM 几何**再画：

```
参考（人物 / 场景 / 风格 / 道具）+ 首帧
        ↓
   Image Prompt  ←── 风格参考
        ↓
   图片生成
        ↓
   画面 v1 / v2 / v3(ACTIVE)
        ↓                    ↖ 运动 / 机位 / 视频风格 / 表演（AI 解读）
   Video Prompt  ←── 风格参考、首帧、尾帧
        ↓
   视频生成
        ↓
   视频 v1 / v2(ACTIVE)
```

- **不强行画成四列 INPUT → OUTPUT。** 风格参考同时进两个 Prompt；每一版视频指向
  **它自己的 generation 记录**里那一版画面（take v1 可以来自画面 v1 而 v3 来自
  v3）；首帧可能来自**上一镜**的视频。这些边如果被压进单一 rank，就必须丢掉——
  而它们正是这张图存在的理由。
- **没有记录就没有线。** 人物参考只连 Image Prompt（`compileImagePrompt` 编译它，
  `compileVideoPrompt` 不编译）；一次 import 的视频没有 generation 说明源画面，
  就不画 source 边。
- **绑定但未解读的导演参考不是 ready。** 它对 Prompt 的贡献是 0（promptc 会把它
  报成缺口），画成 ready 就是声称一个不在文本里的输入。
- **节点可点性由 `inspectFromShotNode` 决定**，即点击处理器解析选择用的同一个
  函数。第一版用 `state !== "gap"` 猜，两头都错：没有记录的「生成任务」看起来像
  故意不可点（而打开它恰恰是创作者发起一次生成的方式），未来任何解析不出面板的
  节点又仍会渲染成一个什么都不做的按钮。

### 决策 6：A / B 分开——已有可复用 vs 本镜头还缺

```
✓ 已有可复用基础资产              ! 当前 Shot 还需要补充
  林婉 Ref v3     可复用            ! Motion Reference
  暗夜酒吧 Ref v2 已在用            ! Camera Reference
  林婉 Base Voice                   ! 林婉 的当前状态
  Rain Style v1   可复用            ○ 特殊道具参考
```

- A 来自故事开发 / 世界观 / 资产库，每行标注它的来源，并区分
  **已在用 / 可复用 / 还没有这份资产**——「有」和「已经在用」是两件不同的事，
  只有后者对这一镜有帮助。
- B 只放这一镜自己的缺口。`!` 是真缺，`○` 是可选（有更好），并且**只有 `!` 计入
  头部数字**。
- 把两者混成一堆 asset node，正是让创作者重新上传一张已经存在的肖像的原因。
- 缺口的措辞必须能被执行：「没有绑定运动参考」后面跟着点一下就能打开的入口。
  一个创作者无法行动的缺口只是抱怨。

### 决策 7：Generation Input 是一份可勾选清单

```
人物参考   [✓] 林婉 Ref v3        已在用      [新版本]
场景参考   [✓] 暗夜酒吧 Ref v2    已在用      [新版本]
风格参考   [ ] Rain Style v1      本集推荐（还没有启用）
运动参考   [ ] Motion Ref v1      资产库 · 尚未解读
           ▸ 从资产库选择（12）
首帧/尾帧  [✓] 已绑定的首帧 · SH01 视频 v3 · 尾帧   [在视频里改]
```

- **系统的推荐不会偷偷变成看不见的输入。** 每一个可能进入这次生成的参考都在
  同一份清单上，勾选状态就是「会不会用它」。推荐 = 未勾选的一行：看得见、
  一次点击就能启用、绝不已经是了。
- 按**角色**分组，而不是按「来自哪个列表」——创作者的问题是「这一镜的人物参考是
  哪张」。行上仍然写着它的来源。
- 整个资产库放在每个角色下的折叠区里：六十条参考会把真正相关的两条埋掉。
- 首尾帧在这里**只读**：绑定与重新提取由视频面板拥有。同一个动作放两处，正是
  本轮在消除的重复入口。
- 勾选框读的是**渲染时**的状态（`data-on`），不是 `checkbox.checked`：浏览器在
  handler 触发前已经翻了那个框，信它会在 re-render 落在点击与 handler 之间时把
  动作反过来。

## 3. 明确不做 / 不动

- **Phase 2 / Phase 3 的领域与 UI 一律不重做**：后期控制台、镜头多轨音频、
  Shot Mix、字幕、自动初剪、Episode 剪辑台、Lock、Final Render provenance、
  `refinterp` 解读、`framebind` 首尾帧、`promptdoc` 版本、Action Layer——
  全部原样保留，只被复用。
- 不扩展 Provider API，不做全局共享资产库，不做专业 NLE / 完整 DAW。
- 不新增顶级页面。本轮**净减少两个**一级入口（`人物关系`、以及人物页里的
  `场景地` / `声音` / `风格` 三个页签换成零个）。
- 不给 Asset `links` 加 `stateId`。校验层要求每个 canonical link key 都存在，
  加一个就需要 schema 迁移与版本 bump；而状态与参考的关系已经由
  `states[].overrides.referenceAssetIds` 表达，那本来就是领域层设计的位置。

## 4. 有意的合同变更

以下断言是**本轮有意改的**，不是测试迁就实现：

| 合同 | 从 | 到 |
| --- | --- | --- |
| `NAV[0].items` | 含 `relationships` | 不含（并入人物页签） |
| `EPISODE_DEFAULT` | `provenance` | `workbench`（制作台） |
| `EPISODE_NAV[0]` | `provenance` | `workbench` |
| `showsFocus` | 只在 `workbench` | 在 `EPISODE_DEFAULT`，不在 `provenance` |
| `SKILLS.length` | 14 | 15（`relationship-director`） |
| `ui/relws.js` 导出 | `relationshipsModel` | 删除，改为 `workflow/relgraph.js` 的 `relationshipGraph` |
| `ASSET_KINDS` | 无 `voice-reference` | 有（audio 域，不在 `REFERENCE_KINDS`） |

`relationshipsModel` 是**删除**而不是保留：同一批记录上的第二个读模型必然漂移。

## 5. 后果

- 创作者第一次打开剧集制作看到的是「我在做哪一个镜头 / 它有什么 / 还缺什么」，
  而不是整集已经存在的一切。
- 一个人物 / 场景地在故事开发阶段就可以被做「完」（参考图 + 状态参考 + 基础
  Prompt + 基础声音），后续每一镜复用而不是重做。
- 一段关系的定义与它在图上的样子是同一份数据的两个面，改任一处另一处立刻跟上。
- 溯源仍然完整可达，但不再是工作台。
- 风险：制作台一次只显示一个镜头，跨镜头的批量操作要走「工作区」。这是有意的
  取舍——批量面仍然全部存在（参考统筹 / 画面 / 视频 / 音频 / 审片工作区）。
