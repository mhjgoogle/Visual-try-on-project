# ADR-0054：Production 是「建立整部作品创作基础」的上游工作空间

- 状态：Accepted
- 日期：2026-08-11
- 关联：[ADR-0052](ADR-0052-workflow-page-as-derived-provenance-graph.md)、
  [ADR-0053](ADR-0053-project-rooted-studio-storage.md)、
  [TASK-057](../tasks/TASK-057-production-upstream-workspace.md)

## 背景

Connected Studio baseline（6879370 + 7b182a3）里，Production 左栏同时长期显示
「项目」（故事 / 作品设定 / 剧集）与「本集制作」（剧本 / 分镜 / 画面 / 视频 /
音频 / 剪辑）。结果是：用户还在写 Story Outline、还没有一个角色的时候，下游
六个制作阶段就已经占据主导航。

同时，几类真正属于「整部作品创作基础」的对象在域里根本不存在，只能靠
Story Outline 里的自由文本兜着：

- Creative Brief 只有 `story.idea` 一个字符串（类型 / 基调 / 形式 / 目标集数 /
  时长方向无处存放）；
- 人物关系只能写在 Character 的文本字段里，不是 first-class 对象，无法表达
  「林照 × 沈既白」这一对关系自己的矛盾、张力、权力关系与 Arc；
- 世界观（时代 / 世界规则 / 社会背景 / 区域 / 视觉基调）没有上游 Canon 位置，
  只有具体的 Location/LocationState；
- Episode 作为 Arc 推进单位缺少 Plot / Character / Relationship / World Reveal
  beat，也没有「本集基于哪一版上游」的记录，因此上游改版之后系统无法回答
  「这一集是不是基于旧版本」。

## 决策

### 决策 1：Production 的职责边界收敛为「上游」

Production 只负责

    创意 → 故事大纲 → 作品设定 → 分集规划

Shot Image / Video / Audio / Edit / Render / Generation provenance 属于
Episode Production 与 Workflow，**不再出现在 Production 的主导航**。

实现方式是「两层导航」，不是删功能：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 作品开发（Project-level） | 创意 · 故事大纲 · 作品设定（人物 / 人物关系 / 世界观）· 分集规划 | 左栏一级 |
| Episodes | EP01 / EP02 …（Production 的出口） | 左栏一级 |
| 本集制作（Episode-level） | 剧本 · 场景 · 分镜 · 画面 · 视频 · 音频 · 剪辑 | 仅在进入某一集后，嵌在该集下 |

四个上游步骤是 **creative workspace，不是 Wizard**：没有 Step 1 → Next，任何
一步都可随时往返修改。

### 决策 2：Creative Brief 复用故事域，不新建版本系统

Creative Brief 落在 `story.brief`，与 `story.idea`（核心创意）、
`story.versions`（大纲）、`story.plans`（分集规划）同属一个故事文档、同一套
「working draft + 追加版本链」语义。

- `story.brief.draft` 是 Working Draft：日常编辑 autosave，**不产生版本**；
- `story.brief.versions[]` 只在用户显式「创建版本」时追加；
- 核心创意仍然只有一份：`story.idea`。Brief 的 coreIdea 字段直接写
  `story.idea`，版本快照时才拷入不可变的 revision 里。

这直接执行「Autosave != Version」，并且**不复制四套版本系统**。

### 决策 3：Relationship 是 first-class Project-level Canon

`production.relationships[]`，每条关联 **恰好两个** Character：

    relationshipId · characterIds[2] · profile{
      basis 基础关系 · aToB / bToA 双方视角 · coreConflict 核心矛盾 ·
      tension 情感张力 · power 权力关系 · history 共同历史 ·
      secrets 隐藏信息 · direction 长期发展方向 · arc Relationship Arc ·
      forbidden 不应发生的关系偏离 }

Project-level Relationship Definition 描述**整部作品**的关系走向（戒备 → 合作
→ 信任 → 决裂 → 再选择），**不写死每一集的实际关系状态**——那属于决策 5 的
Episode Relationship Beat。

Relationship 只按 characterId 引用 Character，绝不复制角色档案；同一对角色
至多一条关系（顺序无关）。删除仍被引用的角色前必须先删关系（与 M7 的
scene-reference 拒绝语义一致）。

### 决策 4：World Setting 是上游 Canon，与 Location 并存不重叠

`production.world` 保存 时代 / 世界规则 / 社会背景 / 主要区域 / 主要地点方向 /
视觉基调 / 整体氛围，是**更高层的作品设定**。

现有 `production.locations` / LocationState 保留自己的 canonical domain：
World Setting 里的「主要地点」是创作方向描述，**不是第二份地点数据库**，
不参与 Scene 的 locationRef 解析。

### 决策 5：Episode 成为 Arc 推进单位

Episode 实体新增 `beats`：

- `plot[]` Main Plot Beat
- `character[]` Character Beat（按 characterId 引用）
- `relationship[]` Relationship Beat（按 relationshipId 引用，
  记录 start / event / end）
- `world[]` World Rule / Information Reveal

Relationship Beat 是 **Episode-level 的实际发生记录**，写入它**不修改**
Project-level Relationship Definition。

### 决策 6：一套轻量统一的上游依赖 / 版本机制

**依赖状态是三态（实现为四态），彼此绝不混淆**：

| 状态 | 含义 | 判定 |
| --- | --- | --- |
| `unknown` | **基线未记录**——信息缺失，**不等于旧版本** | 戳 = 0 |
| `current` | 记录的基线正是当前生效版本 | 戳 = 当前 |
| `outdated` | 已记录基线，且当前版本**向前**移动 | 当前 > 戳 |
| `diverged` | 已记录基线，当前版本**被回退**到更早修订 | 当前 < 戳 |

规则：

1. `basedOn = 0` 只表示 **unknown / 未记录**，永远不判为落后；
2. unknown 只能显示「上游基线未记录」，**不得**显示「N 个上游更新」，
   也不得计入变化计数（`count` 只统计 outdated ∪ diverged）；
3. 只有 Episode **已记录**明确基线之后，当前版本再向前变化，才是 `outdated`；
   回退是 `diverged`——同样需要复核，但措辞是「上游已回退」，不是「已更新」；
4. **迁移绝不猜测** legacy Episode 原来基于哪个版本：全部为 0 / unknown；
5. 建立基线只能由用户显式行为产生：「建立当前基线」按钮、影响审阅里的
   「本集已复核」，以及**确认分集规划时**——但确认只为**本次新建的剧集**
   （含被收养的 pristine 默认集）记录基线；已有内容的剧集保持原状，
   否则就是规则 4 禁止的猜测。

五个上游面各有一个**编号**：

| 上游面 | 当前版本号 | 变更方式 |
| --- | --- | --- |
| Creative Brief | `story.brief.active` | 显式创建版本 |
| Story Outline | `story.approved` | 显式批准（既有语义） |
| 人物 | `production.canon.characters` | 显式「确认人物设定版本」 |
| 人物关系 | `production.canon.relationships` | 显式「确认关系设定版本」 |
| 世界观 | `production.canon.world` | 显式「确认世界观版本」 |

每个 Episode 有一个戳 `episode.basedOn`（同样五个键）。**Impact = 戳 vs 当前**：

- 系统只负责确定性结论：「这个 Episode 基于旧版本」（deterministic
  dependency change）；
- AI semantic impact proposal（「这个改动在剧情意义上是否真的影响 EP03」）
  当前**没有**成熟 checker，Impact Review 里显示为 unavailable，
  **不伪造 AI 判断**；
- 上游创建新版本**绝不自动重写**任何 Episode，只显示「N 个上游更新」。

Autosave 不改任何编号，因此日常编辑不会让所有 Episode 变成「过期」。

### 决策 7：正式角色 / 临时角色

`character.tier`：`"formal"`（正式角色）或 `"bit"`（临时 / Episode Character，
如服务员、路人、警察、医生）。临时角色不要求填写完整 Character Bible；
「提升为正式角色」只翻转 tier，**characterId、参考图、场景引用、关系、beat
引用全部保留**。

AI 未来可以提出「EP04 需要一名值班医生完成信息揭示」，但只能是 Proposal：
用户选择「创建正式角色 / 作为临时角色 / 忽略」。**未经确认，AI 不写 Canon。**
本批不存在真实 AI proposal route，因此只保证 Domain/UI 支持这个决策，
不模拟 AI 自动创建。

### 决策 8：canvas schema v10

以上持久化全部落在 canvas 文档，`CANVAS_SCHEMA_VERSION = 10`，
`migrateV9ToV10` 纯追加：

- `story.brief` 以既有 `story.idea` 为唯一内容来源新建（Working Draft，
  0 个正式版本 —— 迁移绝不伪造版本）；
- `production.relationships = []`、`production.world` 空档案、
  `production.canon = {characters:0, relationships:0, world:0}`；
- 每个 character 补 `tier: "formal"`（既有角色都是用户手工/拆解确认过的正式
  角色，降级为临时才是失真）；
- 每个 episode 补空 `beats` 与 `basedOn`（全 0 = 未戳过；未戳过的 Episode
  显示「未记录上游版本」，**不假装它基于当前版本**）。

不顺手做 asset URL schema 迁移（TASK-055 §4 的已知项仍留在 TASK-056）。

**编号占用声明**：`v10` 自本 ADR 起被 Production 上游 canon 正式使用并已写入
真实项目存档。后续的 asset URL / project-relative path 迁移**必须使用 v11 或
更高**，不得再称为 v10。

## 后果

正面：

- 用户打开 Production 看到的是「建立作品基础」，不再是六个下游制作阶段；
- 人物关系、世界观、Episode Beat 第一次成为真正的域对象，AI 导演可以读到
  结构化的 Relationship Arc / World Rule，而不是从自由文本里猜；
- 上游改版的影响是**可证明的**（版本号差集），不依赖 AI；
- Autosave 与 Version 彻底分开，日常编辑不再制造版本噪音。

代价：

- 高风险变更：canvas schema + 持久化 + 迁移，需要 full pytest + node + ruff +
  Codex 独立审查；
- 需要用户显式「确认版本」才会产生 Impact 信号——这是刻意的（自动版本化会让
  每次打字都把全部 Episode 标成过期）；
- `basedOn` 全 0 的既有 Episode 只能显示「未记录上游版本」，历史依赖无法追溯
  重建（迁移不猜）。
