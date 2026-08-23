# ADR-0061：创作者 IA 收口与自动初版剧集制作

- 状态：Accepted
- 日期：2026-08-12
- 关联：[ADR-0052](ADR-0052-workflow-page-as-derived-provenance-graph.md)、
  [ADR-0054](ADR-0054-production-upstream-workspace.md)、
  [ADR-0055](ADR-0055-unified-asset-registration.md)、
  [ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)、
  [ADR-0057](ADR-0057-shot-production-state-and-dailies.md)、
  [ADR-0058](ADR-0058-production-memory-library-and-episode-production.md)、
  [ADR-0059](ADR-0059-production-graph-identity-contract.md)、
  [TASK-064](../tasks/done/TASK-064-creator-ui-consolidation.md)
- **被 [ADR-0066](ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
  部分修订**：决策 1（三个顶层空间）**保留并强化**，二级页面收敛为固定十一页；
  决策 2 的「右侧永远属于 AI 导演」**被撤销**，改为按需打开的上下文 Agent 面板；
  决策 3～10（Skill 链路、十类 Reference、版本与 Lock、Automation First、
  Audio timing、字幕诚实规则、Action Layer、Domain First）**全部保留不变**。

> **任务编号说明**：产品负责人下发这份需求时称之为「TASK-063」。仓库中
> `TASK-063` 已被 [ADR-0060](ADR-0060-risk-based-local-commit-gate.md) 的
> 风险分级 commit gate 占用，故本条工作线在仓库内正式编号为 **TASK-064**。

## 1. 背景

ADR-0059 之后，七层身份链已经贯通，溯源图能回答「这个结果是怎么来的」。
但把工作台放到创作者面前看，仍有四类结构性问题：

1. **顶层 IA 说的是系统结构，不是创作对象。**
   顶栏是「制作 / 工作流 / 资产」。「制作」里既有整部作品的故事开发，也有单集的
   画面/视频/音频/审片/剪辑；「工作流」里并列着「生成溯源」和「流程画布」两套
   流程模型。创作者要先理解系统怎么分层，才能找到自己要做的事。

2. **Skill domain 已经存在，却没有真实入口。**
   `ctx.skills.*` 完整（catalog / context / scopeOf / prompt / run / submitManual /
   accept / reject / originOf），`skillRun` 有持久化与溯源，但**整个 `src/ui/` 没有
   一个调用者**。Skill Run 只能出现在溯源图上，创作者无法发起。

3. **Reference 事实上等于图片。**
   `REFERENCE_KINDS` 只有人物/场景/道具/风格/外部五种，全部落在 images 域。
   视频风格、运动、机位、表演这些导演真正用来说清楚「要什么」的参考没有位置。

4. **后期是一张空白工作台。**
   镜头音频、字幕、剧集时间线都要创作者从零搭。而所需数据（对白、时长、
   镜头顺序、已选视频版本）系统其实已经有了。

## 2. 决策

### 决策 1：顶层三个空间，按创作对象命名

```
故事开发    把故事写出来      Brief → Outline → Character/Relationship/World → Episode Plan → Episode Script
剧集制作    把这一集做出来    Episode Script → Scene → Shot → Reference → Prompt → Image → Video → Audio → Review → Edit → Final
资产库      我有什么可以复用   References / Images / Videos / Audio / Final / Collections
```

- 「故事开发」的终点是**每一集的 Episode Script**，之后给出明确出口
  「进入剧集制作 →」。媒体制作导航从这里移除。
- 「剧集制作」承担从剧本到成片的全部生产。
- 「生成溯源」是剧集制作内部的一个视图，不是第二套流程模型。
  **主入口移除「流程画布」**——Production 本身已经是一条 workflow。
  画布代码保留（`?canvas=1` 诊断入口），但不出现在创作者的路径上。

### 决策 2：剧集制作是固定三栏，各栏职责不重叠

```
LEFT                  CENTER                      RIGHT
当前对象 / 输入        生产工作台 / 生成溯源         AI 导演
Inspector             Scene → Shot → 卡片          Observe / Review / Suggest
Versions / Upload                                 Skill / Proposal
Actions / Relations
```

- **中央点任何卡片 → 左侧切换成该对象的操作面板。**
  Reference / Prompt / Generation / Image / Video / Audio 各有 Inspector。
- **右侧永远属于 AI 导演。** 原来占据右侧的 Node Detail、关系控件
  （仅看上游 / 仅看下游 / 完整链路）全部移到左侧 Inspector 的「关系」区。
- 顶部 Episode Selector（`EP01 ▾`）取代原来的「剧集 / 场景 / 镜头 / 全项目」
  scope tabs：Scene / Shot 是剧集**内部**的层级导航，不是并列的页面模式。
- Focus Filter（全部 / 图片 / 视频 / 音频 / 失败）保留，作用于中央卡片。

### 决策 3：Skill 有真实 UI，链路一路通到 Generation

```
AI 导演 → 运行 Skill → Skill Run → Proposal → [应用 | 用于生成 | 忽略]
                                                        ↓
                                          Generation Input Set → Generation Task
```

- Skill 列表只显示 `skills.SKILLS` 里真实存在的能力；Runtime / Executor /
  Model 显示真实探测结果，未知即「未记录」。
- 「用于生成」不是假按钮：它把 proposal 通过 `ctx.skills.accept` 记为已接受，
  取得 `originOf(skillRunId)` 的 `{skillRunId, proposalId}`，写进
  Generation Input Set 的 `origin`，并携带到 Generation 记录上。
- **Role / Skill / Runtime / Executor / Model 继续互相独立**：
  不把「AI 导演 = Claude」或「Prompt Director = Codex」写死在任何一处。

### 决策 4：Creative Reference 扩展为十类，且区分两种用途

新增五类（连同已有五类共十类，`REFERENCE_KINDS`）：

```
character-reference   location-reference   prop-reference   style-reference   external-reference
video-style-reference motion-reference     camera-reference performance-reference
（另有 start-frame / end-frame：不是 kind，是镜头槽位上的角色）
```

用途分两种，**在数据上区分，不在 UI 上假装**：

| 用途 | 含义 |
| --- | --- |
| `model-input` | 媒体模型直接吃这份参考（图生图的人物参考、首帧） |
| `ai-interpretation` | 模型不吃视频参考时，Skill 读它，提炼成 camera language / motion rhythm / performance，再编译进 Prompt |

**Video Reference ≠ 必须直接传入 Video API。** 这是本决策的要点：
一个 motion reference 即使当前 provider 不支持，它对 Prompt 的贡献依然真实。

新的 reference kinds 落在 `videos` 域（视频风格/运动/机位/表演可以是视频，
也允许图片——见 `KIND_DOMAIN` 的多域声明）。

### 决策 5：版本语义、Lock 与 downstream 一律非破坏

- `Set Active` 只改 active 指针，历史版本一个都不删。
- downstream 不静默重写：Video v2 基于 Image v3，创作者把 active image 切回 v1，
  Video v2 继续存在，UI 显式报告「上游已变化」，并给出三个出口
  （保持 / 基于 v1 新生成 / 切回 v3）。
- Dependency State 继续沿用 `none / unknown / current / outdated / diverged`；
  `basedOn = 0`（legacy）必须是 `unknown`，绝不自动算 `outdated`。
- **Lock**：创作者人工满意的内容可以锁定（Reference / Prompt / Image selection /
  Video selection / Audio timing / Audio gain / Timeline Clip / Subtitle）。
  `Optimize Episode` / `Regenerate Rough Cut` / `Auto Mix` 一律不覆盖 Locked 内容。

### 决策 6：Automation First — 系统先给一版能用的初版

后期不是空白工作台。数据足够时自动构建：

```
Shot Audio Timeline（对白/环境/音效/拟音/BGM/VO 轨 + timing + gain + fade）
Episode Rough Cut v1（镜头顺序 + 已选视频版本 + 音频 + 字幕）
```

- 真实媒体尚未生成时状态是 `prepared / waiting for media`，**不 fake media**。
- Timeline Clip 必须 pin 到具体 Asset（`shotId` + `assetId`），
  不能只存 `shotId`——否则「用的是哪一版」这个问题没有答案。
- Shot Mix 是**派生 Asset**：source assets 永远保留，mix provenance 记录
  source assetIds / versions / timings / anchors / offsets / gains / fades / mix settings。

### 决策 7：Audio timing 两种模式并存

```
Absolute   startTimeMs = 3200               环境音 / BGM / 手工摆放
Anchored   anchor = "action:glass_hits_table", offsetMs = +80   音效 / 拟音 / 对白同步
```

Audio Event（`door_close` / `footstep` / …）可由 AI 提出，但
**AI proposal 不直接改 canonical timeline**：创作者「应用」或「忽略」。

### 决策 8：字幕优先走免费本地路径，缺能力就说缺

```
Case A  已有 Dialogue text + timing  → 直接生成 Subtitle Track（不需要 ASR）  ← 本轮实现
Case B  有 text、timing 不准          → 本地 alignment adapter                 ← 预留接口
Case C  只有 Audio / Video           → 本地 ASR / Whisper-class adapter        ← 预留接口，显示 unavailable
```

**没有 ASR 就显示 not available，绝不伪造「AI 已听写」。**

### 决策 9：统一 Action Layer

UI 与 AI 导演调用同一套 domain action，不做两套业务逻辑：

```
setActiveVersion  replaceReference  updatePrompt  runSkill  applyProposal
prepareGeneration registerGenerationResult  approveShot
moveAudioClip trimAudioClip setGain setFade
replaceTimelineAsset trimTimelineClip moveTimelineClip
updateSubtitle lockItem unlockItem renderEpisode
```

本轮的自动化权限只有一档：

```
AI Suggest → User Accept → Action
```

架构支持未来扩到 `AI Execute with Confirmation` / `Auto Low-risk Actions`，
但本轮**不开启任何 autonomous mutation**。

### 决策 10：Domain First — 以下不是 Asset

```
Creative Brief · Story Outline · Character · Relationship · World
Episode Plan · Episode Script · Scene · Shot
```

它们是 canonical domain data；只有**媒体**进入 Asset Registry。
Production Bible 不复制媒体数据；Character / Location identity 稳定，
只有 State 可变（外观/服装/伤势/时期/表演指示；不含 identity、base personality、
canonical base voice identity）。

## 3. 后果

### 正面

- 创作者的路径与创作对象一致：写故事 → 做这一集 → 找可复用的东西。
- Skill 从「只在溯源图上出现」变成可发起、可审阅、可用于生成的真实能力。
- 后期从空白工作台变成「先有一版，再微调」。
- Lock 让自动化可以反复运行而不毁掉人工成果——这是 Automation First 能成立的前提。

### 代价与风险

- 剧集制作是一个新的大型 surface，短期内 UI 复杂度集中在这里。
- Reference kinds 从 5 扩到 9，canvas schema 需要一次增量迁移。
- Rough Cut 的「自动」质量取决于上游数据完整度；数据不足时它必须显式报告
  `waiting for media` 而不是产出一个看起来完整的空壳。

### 明确不做（本轮）

Image / Video API Provider、Global Shared Asset Library、项目改名/移动/导出、
专业 NLE、完整 DAW、复杂调色、AE/Fusion 合成、multi-camera、高级遮罩与关键帧动画。
新代码不得进一步写死「Asset 只能属于单个项目」，为将来的 Shared Library 留路。
