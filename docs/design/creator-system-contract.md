# 创作者系统合同（冻结版）——对象 · 状态机 · Command / Query · Skill Run · 矩阵

- 依据：[ADR-0066](../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
- 配套：[创作者产品信息架构](creator-product-information-architecture.md)（IA / 流程 / 页面职责）
- 状态：**第一阶段冻结**。本文是创作者 Studio 系统边界的**唯一权威**。
- 沿用不变的既有合同：
  [ADR-0031](../adr/ADR-0031-workspace-query-and-projection-contract.md)（投影原则）、
  [ADR-0033](../adr/ADR-0033-command-gateway-contract.md)（Envelope / preflight / 高风险确认）、
  [ADR-0056](../adr/ADR-0056-local-ai-runtime-and-film-skills.md)（Role ≠ Skill ≠ Runtime ≠ Model）、
  [ADR-0059](../adr/ADR-0059-production-graph-identity-contract.md)（七层身份链）。

> 本文冻结**合同**，不冻结实现。字段名以现有代码为基线增量演进；凡是与现有
> `workflow/` 模块不同的地方，都在「迁移」栏写明从什么变到什么。

---

## 1. 核心对象与关系

```
Project
 ├─ 成片规格 / 预算与限制
 ├─ Outline ─────────────┐
 ├─ WorkCanon（作品设定）│   Character · Location · Prop · Relationship
 │    └─ 每个对象有「基础资产」（Reference / StateReference / BasePrompt / BaseVoice）
 ├─ EpisodePlan ─────────┘
 └─ Episode *
      ├─ Script
      ├─ Scene *
      │    └─ Shot *
      │         ├─ Binding *        （Shot ←→ Asset / Canon 对象，带 role 与 use）
      │         ├─ ArtifactVersion * （image / video / audio / prompt）
      │         └─ ReviewIssue *（层 1）
      ├─ Timeline（RoughCut 的可编辑形态）
      │    └─ TimelineClip *  → pin 到 (shotId, assetId, version)
      ├─ ArtifactVersion *（roughcut / subtitle / mix）
      ├─ ReviewIssue * / ReviewDecision *（层 2）
      └─ Delivery *
           ├─ QCReport（层 3：ReviewIssue *）
           └─ ArtifactVersion（final）

Asset（媒体，跨集复用）  ←─ Binding ─→ Shot / Canon 对象
Skill（能力定义，不可变）  ←─ Run(kind=skill) ─→ 目标对象 + Proposal
Run（统一运行对象）        ←──────────────────→ 目标对象 + 输出
     kind = skill | image-gen | video-gen | tts | ffmpeg | render | export
```

### 1.1 对象定义表

| 对象 | 身份 | 归属 | 是不是 Asset | 备注 |
| --- | --- | --- | --- | --- |
| `Project` | `projectId` | 根 | 否 | 成片规格 / 预算 / 存储根 |
| `Episode` | `episodeId` | Project | 否 | |
| `Scene` | `sceneId` | Episode | 否 | **剧情分组，不产出 Scene Video** |
| `Shot` | `shotId` | Scene（或未分配池） | 否 | 生产的最小单位 |
| `Asset` | `assetId` | Project | **是** | 只有**媒体**进 Asset Registry |
| `ArtifactVersion` | `(ownerType, ownerId, kind, version)` | 任意对象 | 否 | 见 §3 |
| `Binding` | `(shotId, referenceKey)` / `(canonId, assetId)` | Shot / Canon 对象 | 否 | 带 `role` 与 `use` |
| `Skill` | `(skillId, skillVersion)` | 全局，**不可变** | 否 | 删除定义会让历史 Run 指空 |
| `Run` | `runId` | Project | 否 | **一切长任务共用**，`kind` 区分；见 §5.0 |
| ┗ `SkillRun` | 同上（`kind="skill"`） | Project | 否 | Run 的专业化，**不是第二份记录**；见 §5 |
| `ReviewIssue` | `issueId` | Shot / Episode / Delivery | 否 | 见 §6 |
| `ReviewDecision` | `decisionId` | Shot / Episode / Delivery | 否 | 见 §6 |
| `Timeline` | `timelineId` | Episode | 否 | Clip 必须 pin 到 `(shotId, assetId)` |
| `Delivery` | `deliveryId` | Episode | 否 | 一次导出尝试 = 一个 Delivery |

**Domain First（ADR-0061 决策 10，继续有效）**：`Outline` / `Character` / `Relationship` /
`Location` / `Prop` / `EpisodePlan` / `Script` / `Scene` / `Shot` 是 canonical domain data，
**不是 Asset**。只有媒体（图片 / 视频 / 音频 / 字幕文件 / 成片）进入 Asset Registry。

### 1.2 Binding

一条 Binding 回答三个问题：**谁**用**什么**，用来做**什么**。

```
Binding {
  ownerType   "shot" | "character" | "location" | "prop"
  ownerId
  assetId                      真实资产，不是名字
  referenceKey                 稳定 key（ADR-0059）
  role     character-reference | location-reference | prop-reference | style-reference
         | external-reference | video-style-reference | motion-reference
         | camera-reference | performance-reference | voice-reference
         | start-frame | end-frame        （后两者是槽位，不是 kind）
  use      "model-input" | "ai-interpretation"       （ADR-0061 决策 4）
  state    "bound" | "interpreted" | "stale"
}
```

- **绑定但未解读的导演参考不是 ready**（ADR-0063 决策 5）：它对 Prompt 的贡献是 0，
  在准备输入清单里显示为「尚未解读」。
- **推荐 ≠ 绑定**：推荐是未勾选的一行（ADR-0063 决策 7）。系统的推荐**永远不会**
  偷偷变成看不见的输入。

---

## 2. 统一 Artifact 观

**图片、视频、音频、字幕、成片统一是带版本的 Artifact。** 不为每种媒体设计
互不兼容的生命周期。

| Artifact kind | owner | 载体 |
| --- | --- | --- |
| `prompt:image` / `prompt:video` | Shot | 文本（`promptdoc`） |
| `prompt:base` | Character / Location / Prop | 文本（`base:` 命名空间） |
| `image` | Shot | Asset |
| `video` | Shot | Asset |
| `audio:dialogue` / `audio:sfx` / `audio:ambience` / `audio:bgm` / `audio:mix` | Shot / Episode | Asset |
| `subtitle` | Episode | Asset |
| `roughcut` | Episode | Asset（或派生渲染） |
| `final` | Delivery | Asset |
| `outline` / `script` / `episodePlan` | Project / Episode | 文本 |

一条统一规则：**`Set Active` 只改 active 指针，历史版本一个都不删**
（ADR-0061 决策 5，继续有效）。

---

## 3. ArtifactVersion 状态机（冻结 —— **六态**）

`deprecated` 是这六态之一，不是状态之外的一个标记：一个 `deprecated` 版本仍然可查、
可恢复、可被历史记录指向。「五态 + deprecated」的旧口径已作废（ADR-0066 §6 校正 6）。

```
                ┌──────────────────────────────────────────┐
                │                                          ↓
draft ──→ suggested ──→ candidate ──→ confirmed ──→ locked
  │            │             │            │            │
  └────────────┴─────────────┴────────────┴────────────┴──→ deprecated
```

| 状态 | 含义 | 谁能产生 | 是否可成为 active |
| --- | --- | --- | --- |
| `draft` | 用户或 Agent 写的草稿，尚未成为方案 | 用户 / Agent | 否 |
| `suggested` | Agent 建议（来自一次 Skill Run 的 Proposal） | **仅 Agent** | 否 |
| `candidate` | 生成候选（真实产出，等待挑选） | 用户 / Agent | 否 |
| `confirmed` | **用户确认的版本**（active 指针指向它） | **仅用户** | 是 |
| `locked` | 用户满意并锁定；自动化一律不覆盖 | **仅用户** | 是 |
| `deprecated` | 已废弃，保留可查 | 用户 / 系统 | 否 |

### 3.1 不变量

1. **`confirmed` 与 `locked` 只能由用户产生。** AI origin 走到这两个状态一律拒绝
   （`actions.allowedAt` 在 `suggest` 级别拒绝所有 AI 写动作）。
2. **同一 `(ownerType, ownerId, kind)` 最多一个 active。** active 必须是 `confirmed`
   或 `locked`。
3. **不删除历史。** 任何转换都不删除任何版本，`deprecated` 也可查、可恢复。
4. **`locked` 是自动化的硬边界**：`Optimize` / `Regenerate Rough Cut` / `Auto Mix` /
   批量重新生成一律跳过 locked，并**如实报告跳过了几条**。
5. **下游不静默重写**（ADR-0061 决策 5）：上游 active 变化时，下游标记
   `outdated` / `diverged` 并给出三个出口（保持 / 基于新上游重生成 / 切回旧上游）。
   `basedOn = 0`（legacy）必须是 `unknown`，**绝不自动算 `outdated`**。

### 3.2 与现有实现的迁移

| 现有 | 目标 | 迁移 |
| --- | --- | --- |
| `promptdoc` 的 `versions[] + active + locked` | `draft/candidate/confirmed/locked` | `active>0` 的版本 → `confirmed`；`locked` → `locked`；其余 → `candidate` |
| `assetreg` 的 `storageState` | 与版本状态**正交**，保持独立 | 不合并——「字节在不在」不是「这版行不行」 |
| `shotprod` 的 approve 标记 | 层 1 的 `ReviewDecision` + video 版本 `confirmed` | 见 §6.4 |
| `timeline` 的 clip lock | `locked` | 不变 |

---

## 4. Shot 生产状态机

```
未开始 ──→ 准备中 ──→ 主画面制作中 ──→ 视频制作中 ──→ 待定稿 ──→ 已定稿
             ↑            │                │              │          │
             └────────────┴────────────────┴──────────────┴──────────┘
                       （任何一步都可以回到上一步，非破坏）
```

| 状态 | 判定（**派生**，不额外存储） |
| --- | --- |
| 未开始 | 无任何绑定、无 Prompt、无生成记录 |
| 准备中 | 有绑定或 Prompt 草稿，无 image candidate |
| 主画面制作中 | 有 image candidate，无 confirmed image |
| 视频制作中 | 有 confirmed image，无 video candidate |
| 待定稿 | 有 ≥1 个 video candidate，无 confirmed video |
| 已定稿 | 有 confirmed video（= 检查层 1 通过） |

**「已定稿」的唯一定义**：该 Shot 有一个 `confirmed` 的 video ArtifactVersion。
不存第二个布尔字段——两个真相源必然漂移。

---

## 5. Run 与 Skill Run 合同

### 5.0 统一运行身份（冻结）

**系统里只有一种运行记录。** 一次 Skill 运行、一次图片生成、一次视频生成、一次 TTS、
一次 FFmpeg 混音、一次粗剪渲染、一次成片导出——七件事在用户眼里是同一件事
（「一个需要等待、可能失败、可以取消、要记成本的任务」），因此在系统里也是同一个对象：

```
Run {
  runId        *** 唯一运行标识，后端签发，长任务立即返回它 ***
  kind         "skill" | "image-gen" | "video-gen" | "tts" | "ffmpeg" | "render" | "export"
  taskType     稳定机器标识（见下）
  status       §5.2 的八态，所有 kind 共用
  …            §5.3 的持久化字段，所有 kind 共用
}
```

`SkillRun` = `Run` 且 `kind === "skill"`，它额外携带 `skillId` / `skillVersion` /
`proposal`。**它不是第二张表**：两份运行记录必然漂移，而「本集现在有哪些任务在跑、
哪些失败了、一共花了多少」这个看板问题（IA §4 ⑥）只能由一份记录回答。

#### `taskType` 是机器标识，不是显示名

| 字段 | 谁读 | 会不会变 | 例 |
| --- | --- | --- | --- |
| `taskType` | 系统（筛选 / 聚合 / 看板分组 / 迁移） | **不变** | `skill.story-development` · `generation.image` · `render.roughcut` · `export.delivery` |
| `Skill.taskName` | 普通用户 | 随文案与语言变 | 「为这一镜写画面提示词」 |

把可翻译文案当成持久化键，改一次文案就丢一批历史。两者**不得互相推导**。

#### `runId` 与既有 `skillRunId` 的关系

| 阶段 | 状态 |
| --- | --- |
| v14 及更早 | 只有 `skillRunId`，且只有 Skill 有运行记录 |
| **v15（TASK-072 批次一）** | 迁移为每条 run 增加 `runId`，值**等于**原 `skillRunId`；`skillRunId` 保留为**兼容别名**并标 deprecated |
| **v19（TASK-074 §1.5，2026-08-25）** | **已删除** `skillRunId` 别名，只留 `runId`。`migrateV18ToV19` 先补齐身份再删旧名；形状不对的记录原样留着交给校验 |

迁移是**确定性**的：同一个 id 换一个字段名，不新建身份，不重排，不用时钟。
新签发的 id 一律走 `runId`；任何代码不得再新增对 `skillRunId` 的写入。

**这一节说的只有 Run 记录自己的那个字段。** 外键字段
（`generations[].origin.skillRunId`，以及 promptdoc / refinterp / ctxcache 版本
记录上的同名字段）**保持原名**：它们一个值一个名字，不是别名，改名要跨四种持久化
形状再做一次迁移而换不到任何行为上的东西（TASK-074 §1.5 批次 1 的范围判断）。

### 5.1 Skill（能力定义）

```
Skill {
  skillId        稳定标识
  skillVersion   不可变；定义变更 = 新版本（ADR-0056 决策 6）
  taskName       *** 普通用户看到的名字 ***    如「为这一镜写画面提示词」
  work           "creative" | "review"
  scope          "project" | "episode" | "scene" | "shot" | "asset"
  inputs         必需 / 可选输入声明
  outputSchema   fail-closed 校验
  cost           "free" | "subscription" | "paid"
  produces       它产出哪种 Proposal
}
```

- **`taskName` 是新增字段**，因为 §6.3 要求普通用户看到任务名称而不是 `skillId`。
- **不删除任何既有 Skill 定义**：历史 Run 按 `(skillId, skillVersion)` 引用它。
- **新增 Skill 不得要求新增页面**：一个 Skill 通过 `scope` 归属到某个对象，
  该对象所在页面的「让 Agent 处理」自动列出它。这是 §5.10 的验收方式。

### 5.2 Run 状态机（冻结 —— 这是一次真实的合同变更）

**所有 `kind` 共用这一个状态机。** 一次视频生成和一次 Skill 运行不需要两套状态词汇。

```
需要用户确认：
   awaiting_confirmation ──→ queued ──→ running ──→ succeeded
                                            │    └──→ failed
                                            └──→ cancelling ──→ cancelled
不需要确认：
                             queued ──→ running ──→ （同上）

人工执行（executor = manual：外部模型跑 Prompt、外部工具出视频）：
                             queued ──→ awaiting_input ──→ succeeded | failed
                                        （等创作者把结果粘回 / 上传回来）

取消入口有四个，终点只有一个：
   awaiting_confirmation ──→ cancelled     （用户不批准，什么都没跑）
   queued                ──→ cancelled     （还没拿到槽，无子进程可杀）
   awaiting_input        ──→ cancelled     （创作者不再打算交结果 —— 今天的 abandon）
   running               ──→ cancelling ──→ cancelled   （必须终止真实进程树）
```

**确认在排队之前**（2026-08-13 校正，原文顺序为 `queued → awaiting_confirmation`）。
先展示理解 / 输入 / 产物 / 影响 / 成本 / 耗时，用户点确认之后才去占执行槽——反过来
会让一个用户可能根本不批准的任务先占住并发额度，而并发额度正是这台机器的稀缺资源。

`awaiting_confirmation` / `queued` / `awaiting_input` 的取消**是即时的**：它们没有
本机进程，所以直接落 `cancelled`，不经过 `cancelling`。只有 `running` 需要
`cancelling` 这个中间态，因为杀一棵进程树需要时间，而且**可能失败**（§5.4）。

**`awaiting_input` 为什么必须是一个状态。** 手工路线是第一等公民，不是降级模式：
外部模型跑 Prompt、外部网页工具出视频（原 M1 的手工 VideoProvider）都属于它。
今天这类运行**停在 `running`** —— 那是一句假话：没有任何东西在跑，系统在等人。
后果是真实的：后端重启清扫会把它们当僵尸打成 `failed`（§5.4 第 4 条），
而它们其实完全健康；看板的「运行中」数字也把「机器在忙」和「等你交作业」混成一个数。
`awaiting_input` 让这两件事分开，代价只是一个枚举值。

| 状态 | 含义 | 谁触发 |
| --- | --- | --- |
| `awaiting_confirmation` | 展示了理解 / 输入 / 产物 / 影响 / 成本 / 耗时，等用户点确认。**还没占执行槽** | 系统 |
| `queued` | 已受理（必要时已获确认），等待执行槽；排队位置**读时派生**（§5.6） | 系统 |
| `running` | 后台任务真在跑 | 系统 |
| `awaiting_input` | **人工执行中**：任务已受理，等创作者把外部结果交回来（粘贴 Prompt 回答 / 上传视频文件） | 系统 |
| `cancelling` | 用户已请求取消，取消正在传递到后台任务 | 用户 |
| `cancelled` | 后台任务确认已终止 | 系统 |
| `succeeded` | 输出通过 outputSchema 校验 | 系统 |
| `failed` | runtime 不可用 / 输入缺失 / 输出不符契约 / 超时 / 执行错误 | 系统 |

**提案处置是另一个字段，不是状态：**

```
run.proposal.disposition   pending | accepted | rejected | superseded
```

#### 与现有 `RUN_STATUSES` 的映射（canvas schema v14 → v15）

| 现有 `status` | 目标 `status` | 目标 `proposal.disposition` |
| --- | --- | --- |
| `running` 且 `executor === "manual"` | **`awaiting_input`** | — |
| `running` 且 executor 是本机执行器 | **`failed`**，`failureReason.category = "interrupted"` | — |
| `proposed` | `succeeded` | `pending` |
| `accepted` | `succeeded` | `accepted` |
| `rejected` | `succeeded` | `rejected` |
| `failed` | `failed` | — |
| （新） | `awaiting_confirmation` / `queued` / `cancelling` / `cancelled` | — |

`running` 拆成两条**是确定性的**：分支条件是文档里已经记录的 `executor` 字段，
不是猜测。两条都在说真话——一次手工运行还在等创作者交结果；一次本机运行的宿主
进程早已不存在，它**永远不会**再有结果，让它继续显示 `running` 才是编造。
`interrupted` 与 `backend_restarted` 分开：前者是「迁移时发现的历史中断」，
后者是「本次重启清扫的结果」，两者的可信度与可操作性不同。

同一次迁移补齐身份与分类，同样是确定性的：

| 新字段 | v14 文档的取值 |
| --- | --- |
| `runId` | **等于**该条 run 已有的 `skillRunId`（不新建身份） |
| `kind` | `"skill"` —— v14 只有 Skill 有运行记录 |
| `taskType` | `"skill." + skillId` —— 从已有字段推导，不猜 |
| `provider` / `model` / `cost` / `progress` / `startedAt` / `endedAt` / `outputs` … | `null`（`model` 若已记录则保留）——文档从未捕获它们，**回填即伪造** |

迁移是**确定性**的：不需要时钟，不需要猜测。`ctx.skills.abandon`
（TASK-067 补记 2 引入）映射到 `cancelled`。

### 5.3 Run 必须持久化的字段（冻结）

标 *(skill)* 的字段只在 `kind === "skill"` 时有意义；其余字段**所有 kind 共用**。

| 字段 | 说明 |
| --- | --- |
| `runId` | 后端签发；**长任务立即返回它**。v15 起等于历史 `skillRunId`（§5.0） |
| `kind` | `skill` / `image-gen` / `video-gen` / `tts` / `ffmpeg` / `render` / `export` |
| `projectId` | 这次运行属于哪个项目。`null` **只**对兼容层的无项目调用合法（§5.5） |
| `taskType` | **稳定机器标识**（如 `skill.story-development` / `generation.image`）。**不是** `taskName`，不随文案与语言变化 |
| `queueSeq` | 单调递增整数，入队时分配。**排队位置由它派生，不持久化**（§5.6）|
| `commandId` | 触发这次运行的 Command（ADR-0033 Envelope）；无 Command 触发时 `null` |
| `idempotencyKey` | 幂等键（§5.7）。同一个键不得重复产生付费副作用 |
| `retryOfRunId` | 这是哪一次运行的重试；首次运行为 `null`（§5.7） |
| `sideEffect` | `none` / `applied` / **`unknown`** —— 外部 Provider 是否已执行（§5.8） |
| `target` | `{ ownerType, ownerId }` 目标对象 |
| `context` | `{ episodeId, sceneId, shotId }`（ADR-0059 身份契约，不变） |
| `skillId` / `skillVersion` *(skill)* | 能力与版本 |
| `provider` / `model` | 真实探测结果；未知即 `null`，**不猜** |
| `executor` | **封闭枚举**（见下）：`claude-code` · `codex-cli` · `manual` · `local-piper` · `local-ffmpeg` · `provider:<providerId>` |
| `inputs` / `inputVersions` | 输入及**输入版本**（`contextTrace`，ADR-0064 决策 2） |
| `params` | 参数 |
| `outputs` / `outputVersions` | 输出及**输出版本** |
| `progress` | 0–100 或阶段名 |
| `cost` | `{ currency, amount, basis }`；订阅内为 0 且注明 basis |
| `startedAt` / `endedAt` | 开始与结束时间 |
| `failureReason` | 失败原因（分类 + 可读说明） |
| `confirmation` | 用户确认记录：`{ by, at, kind, digest }` |
| `proposal` | `{ proposalId, disposition, payload }` |

#### `executor` 的封闭枚举（冻结）

| 值 | 是什么 | 用在哪些 `kind` |
| --- | --- | --- |
| `claude-code` | 本地订阅 Claude Code CLI | `skill` |
| `codex-cli` | 本地订阅 Codex CLI（审阅位；fail-closed，见 ADR-0065 决策 5） | `skill` |
| `manual` | **人工**：创作者在外部工具里跑，把结果交回来 → `awaiting_input` | 任意 `kind` |
| `local-piper` | 本机 Piper TTS（离线、免费） | `tts` |
| `local-ffmpeg` | 本机 FFmpeg（混音 / 合成 / 渲染 / 导出） | `ffmpeg` · `render` · `export` |
| `provider:<providerId>` | 外部付费 Provider，`providerId` 是目录里的稳定 id（如 `provider:minimax`） | `image-gen` · `video-gen` |

三条规则：

1. **这是封闭集合。** 新增执行器必须同时改这张表和 §5.9b 的端点表；
   两张表**必须完全一致**，由守卫测试逐行比对（TASK-072 §4 第 4j 条）。
2. **`manual` 横跨全部 `kind`**，因为手工兜底是产品级要求（IA §6.4），
   不是某一类任务的特权。它永远可用，因此在 `suggestExecutor` 里永远是最后一名。
3. **`provider:` 前缀是有意义的**：它把「本机跑的」和「花钱跑的」在**类型层面**
   分开。一个 `provider:` 执行器意味着可能产生外部副作用，因此 §5.8 的
   `sideEffect` 判定对它是必需的，对本机执行器则恒为 `none` / `applied`。

### 5.4 四条硬要求

1. **刷新可恢复。** 页面刷新后必须能通过后端记录恢复任务状态。
   今天 `skillRuns` 已持久化在 canvas 文档，但后端进程无身份
   （`/api/skill/run` 同步阻塞、无 `run_id`）——刷新即丢失那次运行。TASK-072 修复。
2. **取消是真取消。** `cancelling` 必须传递到实际后台任务（终止子进程），
   然后落到 `cancelled`。**只清空前端状态不算取消。**
3. **取消失败要说取消失败。** 子进程没死就**停在 `cancelling`** 并显示真实原因，
   不得伪装成 `cancelled`。一个还在烧订阅额度的进程被报告成「已取消」，
   比报告「取消中，未确认退出」危险得多。
4. **后端重启不留僵尸。** 后端进程重启后，任何停在 `queued` / `running` /
   `cancelling` 的 Run 必须落到 `failed`，`failureReason.category = "backend_restarted"`。
   **不得永久停在 `running`**——那正是 TASK-067 补记 2 修过的那类僵死。

   **`awaiting_input` 不在清扫范围内**，而且这不是例外，是同一条规则：清扫的对象是
   「宿主进程消失后不可能再有结果的运行」。一次手工运行的宿主是**创作者**，
   后端重启没有夺走它的任何东西——把它打成 `failed` 才是丢失用户的在途工作。
   `awaiting_confirmation` 同理保留。

### 5.5 运行状态的存储与唯一写入边界（冻结，2026-08-13 补）

#### 权威在后端

```
后端  <应用数据目录>/runs.json   ← 运行生命周期的唯一权威
       （单一写入者：运行注册表模块；原子替换；进程内单锁）
canvas <ProjectRoot>/studio/canvas.json  skillRuns[]
       ← 创作者的决定与运行的输入指纹；生命周期字段只是 SNAPSHOT
```

#### `runs.json` 放在哪（冻结）

**与 `projects.json` 同址、同类**：应用数据目录
（Windows `%LOCALAPPDATA%\motv\`，POSIX `$XDG_DATA_HOME/motv` 或 `~/.local/share/motv/`），
可由 `--app-data-dir` / `MOTV_APP_DATA_DIR` 覆盖。**不新增第三个存储位置。**

搬迁已在 [TASK-056](../tasks/done/TASK-056-app-storage-location.md) 完成。旧位置
`mockups/motv-workspace/data/` 是**只读 legacy**：新位置没有这两个文件时仍从那里读，
写入永远落在新位置，旧文件不改名不删除；`--migrate-app-data` 是显式的一次性拷贝
（不覆盖新位置已有的内容）。

为什么**不**放进 `<ProjectRoot>/studio/`：

1. **重启清扫必须在任何项目被打开之前跑完**（§5.4 第 4 条）。放进项目目录，
   清扫就得先枚举所有项目根才能开始——而「有哪些项目」本身来自 `projects.json`，
   于是启动路径多了一层它不需要的依赖。
2. **存在没有项目的 Run**：旧 `/api/skill/run` 不带 project（ADR-0056 决策 2 刻意
   如此：没有路径跨越 runtime 边界）。它们放不进任何一个项目目录。
3. **ADR-0053 不冲突**：该 ADR 把 `data/` 降为**项目画布与媒体**的只读 legacy，
   同时明确把**账户级**的 `projects.json` 留在原处并归 TASK-056。
   `runs.json` 是同一类东西——跨项目、非源码、属于这台机器上的这个后端。
4. 放进项目目录还要各自带一次迁移，正是 ADR-0053 警告过的**半迁移**状态。

**`outputs` 是投递缓冲，不是归档**：异步产物在这里停留到被消费，或到达保留上限
（条数 / 时长）后清除。归档在 canvas 与项目媒体里——运行注册表不得变成第二份内容库。

#### Run 的项目归属与跨项目隔离（冻结）

Run 增加 **`projectId`**。它可以是 `null`，而 `null` 是一个**真实的值**，不是缺省：

| 调用 | `projectId` | 说明 |
| --- | --- | --- |
| 旧 `/api/skill/run`（不带 project） | **`null`** | 兼容层。同时记 `origin: "legacy_no_project"`，它**不属于任何项目** |
| 新调用（异步路径、五个 `/api/agent/*`、一切生成 / 渲染 / 导出） | **必填** | 缺失即 `400`，**不猜「当前项目」**——后端没有「当前项目」这个概念，猜出来的归属会把运行记到别人账上 |

隔离规则（四条，缺一不可）：

1. **`GET /api/runs` 必须带 `project=`**，只返回该项目的 Run。
   **不带 project 就返回全部是被禁止的**——那正是让别的项目的运行混进当前项目页面
   的那条路径。
2. **`projectId = null` 的 Run 不出现在任何项目页面**。它们只在
   ⚙ 项目设置 · 存储与诊断的「无项目归属的运行」里可见，并标明它们来自兼容层。
3. **`GET /api/runs/<run_id>` 必须校验归属**：调用方声明的 project 与 Run 的
   `projectId` 不一致 → **`404`**，不是 `403`。403 会告诉调用方「这个 id 存在」，
   而它本来就不该知道别的项目有哪些运行。
4. **取消同样校验归属**：不能取消别的项目的运行。

看板、镜头制作、生成记录读到的运行集合，因此**永远只有本项目的**。

| 字段 | 权威方 | 另一方的副本算什么 |
| --- | --- | --- |
| `status` · `progress` · `startedAt` / `endedAt` · `failureReason` · `cost` · `sideEffect` · `provider` / `model` · `outputs` · `queueSeq` | **后端 `runs.json`** | canvas 里是**最后一次已知快照**，只用于离线 / 无后端时显示 |
| `proposal`（`proposalId` / `disposition` / `payload`）· `contextTrace` · `inputSummary` · `promptText` · `context` · `target` | **canvas 文档** | 后端不存、不读、不判断 |

分界线的理由：**「跑得怎么样」只有跑它的那个进程知道；「我怎么处置这个提案」只有
创作者知道。** 让两边各自拥有自己真正知道的那一半，就没有需要仲裁的字段。

#### Canvas PUT 不得覆盖后台 Run 进度

`PUT /api/canvas/<name>` 是前端整份文档写回。前端持有的是它**上次读到**的运行状态，
而后台任务在这期间还在推进——所以一次正常的画布保存会把 `running / 60%` 写回成
`running / 20%`，甚至把一个已经 `succeeded` 的运行写回 `running`。

规则（三条，缺一不可）：

1. **后端在 `canvas_put` 时忽略 `skillRuns[].<生命周期字段>`**：这些字段**不写入**
   `runs.json`，也**不因为不一致而让 PUT 失败**——前端本来就不是它们的所有者，
   拒绝一次合法的画布保存是把所有权问题变成用户的问题。
2. **后端不在 `canvas_get` 时注入运行状态**：注入会制造第二条读路径，而读运行状态
   只有一条 —— `GET /api/runs`。
3. **前端不得用 canvas 里的快照覆盖从 `/api/runs` 读到的状态**。冲突时**后端赢**。

#### 后端不认识的 Run

本地 / demo 模式没有后端，手工运行也可能完全发生在前端。**后端 `runs.json` 里不存在
的 runId，canvas 就是它的唯一真相**——这不是例外，是同一条规则的下半句：
谁真的知道，谁就是权威。

#### 并发更新规则

| 规则 | 内容 |
| --- | --- |
| 单一写入者 | 只有运行注册表模块写 `runs.json`；HTTP 层、canvas 层、任何 handler 都不直接写 |
| 串行化 | 模块内单锁；读改写在锁内完成，**不做「读→改→写」的无锁往返** |
| 原子落盘 | 临时文件 + 原子替换；进程被杀不会留下半个文件 |
| 崩溃语义 | 落盘失败 = 状态变更失败，如实报告；**不允许内存与文件分叉** |
| 边界 | 该模块不认识 HTTP、不认识路由、不 import `server`（TASK-072 §0.1） |

### 5.6 排队位置是派生的，不是事实

`queuePosition` **不持久化**。持久化的是入队序号 `queueSeq`（单调递增整数）；
位置在**读时**算出来：

```
queuePosition(run) = 1 + count(其它 run : status == "queued" 且 queueSeq < run.queueSeq)
```

理由：位置在**别的运行结束的那一刻**就变了，而那一刻没有人在写这条 run。
一个持久化的位置从写下的下一秒起就是错的，而它看起来像事实。
用序号（而不是时间戳）定序：整数没有并列，也不依赖时钟。

### 5.7 幂等：同一个命令不得重复花钱

三个字段一起工作：

| 字段 | 作用 |
| --- | --- |
| `commandId` | 哪一次 Command 触发了它（ADR-0033 Envelope），把运行接回命令链 |
| `idempotencyKey` | **同一个意图的稳定指纹**：`commandId` 存在时取它；否则由 `taskType + target + 输入摘要 + 参数摘要` 计算 |
| `retryOfRunId` | 这是哪一次运行的重试。**重试是新 Run**，不是旧 Run 复活 |

规则：

1. **非终态去重**：已存在同 `idempotencyKey` 且非终态的 Run → **不新建**，
   返回那一个的 `run_id`。重复点击、断线重发、双标签页都落到同一次运行上。
2. **付费 kind 的终态去重**：已成功的付费运行，同键再来 → **拒绝**并指向已有结果。
   要再花一次钱，必须**显式重试**（带 `retryOfRunId`），那是一次新的用户决定。
3. **免费 kind** 允许同键重跑（本地渲染重来一次不花钱），但仍记 `retryOfRunId`。
4. **重试不继承副作用**：新 Run 从 `sideEffect = none` 开始，成本单独记账。
   §9.1 第 3 条不变——已花的钱如实记账，两次就是两笔。

### 5.8 `side_effect_unknown`：不知道就不许自动重试

外部 Provider 调用失败时，**「请求被拒绝」和「请求可能已经执行」是两件事**。
超时、5xx、连接中断都发生在**已经把请求发出去之后**——上游可能已经生成、已经计费。

```
run.sideEffect   none      确定没有发生外部副作用（请求在发出前被拒）
                 applied   确定发生了（拿到了结果）
                 unknown   *** 无法确认 ***
```

判定沿用 `paidImageGenerate` 已有的做法并把它升为合同：**只有一小撮 4xx**
（400 / 401 / 403 / 404 / 422）算「确定未执行」；**其余全部**（408 / 409 / 425 / 429 /
所有 5xx / 网络中断 / 超时）落 `unknown`。

`unknown` 的三条硬规则：

1. **禁止自动重试。** 任何自动重试逻辑遇到 `unknown` 一律停下。
2. **必须由用户显式决定**，且决定前要看到「这次可能已经计费但没拿到产物」。
3. **成本如实记账**，Run 上注明「已计费但未产出」（§9.1 第 3 条）。

自动重试一个 `unknown` 是本合同里最贵的一种「乐观」：它把一次不确定的扣费
变成两次确定的扣费，而用户看到的只有一次失败。

### 5.9 取消：完整进程树 + 竞态的确定性结果

#### 必须杀干净

取消 `running` 必须终止**整棵进程树**，不是直接子进程：文档中的 WSL 桥是
`wsl.exe → node → CLI`，杀掉桥留下 CLI 继续烧订阅额度。
Windows 走 `taskkill /T /F`，POSIX 走进程组信号（子进程以 `start_new_session` 启动）。

#### 取消与完成的竞态（确定性判定表）

取消请求和子进程结束**必然会**撞在一起。结果不能取决于谁先被调度：

| 情形 | 结果 | 理由 |
| --- | --- | --- |
| 取消到达时 Run 已是 `succeeded` / `failed` / `cancelled` | **保持原终态**，取消返回「已结束，未取消」 | 终态不可逆；把一个已完成的运行改写成 `cancelled` 是篡改历史 |
| 已置 `cancelling`，随后子进程**正常退出且输出完整** | 落 **`cancelled`**；输出**记入 `outputs` 但不作为产物应用**，并注明「取消传递期间已完成」 | 用户已表达停止，产物不得被静默采纳；但也不销毁已产生的数据（尤其付费产物） |
| 已置 `cancelling`，子进程被杀 | 落 `cancelled` | 正常路径 |
| 已置 `cancelling`，宽限期内进程树仍存活 | **停在 `cancelling`**，记 `cancelFailure`（真实原因 + 残留 PID） | §5.4 第 3 条：不得伪装成功 |
| `awaiting_confirmation` / `queued` / `awaiting_input` 被取消 | 直接 `cancelled` | 无进程，无竞态 |
| 取消请求重复到达 | 幂等：已 `cancelling` 则再试一次终止，状态不变；已 `cancelled` 则直接返回 | 重试取消必须安全 |

**唯一的仲裁者是状态机，不是时序**：状态迁移在注册表模块的同一把锁内完成，
终态一旦写下不再改写。

### 5.9a 后端退出与重启合同（冻结，2026-08-13 补）

§5.4 第 4 条只说了**记录**该变成什么。那不够：把一条 Run 标成 `failed` 而实际的
CLI 还在跑，得到的是**一个说谎的记录加一个吃着订阅额度的孤儿进程**——比什么都不做
更糟，因为看板会说这里已经没有任务了。

#### 退出时：先杀干净，再改记录

后端**正常退出**（Ctrl-C / SIGTERM / 服务停止）必须：

1. 拒绝新的运行受理；
2. **主动终止自己启动的每一棵进程树**（同 §5.9 的树终止方式）；
3. 确认退出后，才把受影响的 Run 落到终态并落盘。

顺序不可交换：先改记录再杀进程，中途崩溃就留下「记录已终态、进程仍在跑」的分叉。

#### 首选机制：让子进程**自己**跟着死

最可靠的清理不是退出时去杀，而是让残留**不可能存在**：

| 平台 | 机制 |
| --- | --- |
| Windows | **Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**：后端进程消失，整个 job 里的进程一并终止 |
| POSIX | 子进程以 `start_new_session` 起在自己的进程组；退出钩子 `killpg` 整组 |

有了它，**后端被 `kill -9`、崩溃、断电重启之后也不会有孤儿**，重启清扫面对的是一张
干净的桌子。退出钩子是第二道防线，不是唯一一道。

#### 绝不凭旧 PID 盲杀

重启后**不得**读出上次记录的 pid 直接 `taskkill` / `kill`。**PID 会被复用**：
那个号码现在可能是编辑器、是数据库、是用户的浏览器。凭一个隔了一次重启的 pid
去杀进程，是本合同里唯一一处可能伤到无关程序的操作。

因此 Run 记录的不是 pid，而是**足以唯一识别一个进程的元组**：

```
run.process = { pid, createdAt(进程创建时间), sessionId/jobId, argv0 }
```

重启后要终止残留，**三项必须同时匹配**（pid + 进程创建时间 + argv0）才允许下手；
任何一项对不上 → **不杀**，并如实记录「无法确认残留进程」。
拿不到进程创建时间的平台路径 → **一律不杀**。

#### 重启清扫的判定

| 情形 | Run 落到 | `sideEffect` |
| --- | --- | --- |
| 残留进程树被确认终止 | `failed`，`failureReason.category = "backend_restarted"` | 按已知情况：本机执行器 `none` |
| 无法确认残留是否退出（元组对不上 / 平台拿不到创建时间） | `failed`，`failureReason` 里**如实写明「未能确认子进程已退出」** | **`unknown`**（§5.8）→ **禁止自动重试** |
| `kind` 会调用外部 Provider，且请求已发出 | 同上 | **`unknown`**：上游可能已执行、已计费（§5.8） |
| `awaiting_input` / `awaiting_confirmation` | **不动**（§5.4 第 4 条） | 不变 |

「不知道它死没死」和「确认它死了」是两个不同的结论，记录里必须能分辨——
把前者写成后者，下一次自动重试就会在一个仍在运行的任务旁边再起一个。

#### 能证明什么，不能证明什么（2026-08-13 实施时收口）

「这棵进程树死了吗」在通用情况下**没有廉价的完整答案**，这一点必须写在合同里，
否则每一轮审查都会在同一个洞口发现一个更窄的变体：

| 情形 | 能不能证明 | 我们怎么做 |
| --- | --- | --- |
| Windows，进程仍是我们的 | **能** | Job Object（`KILL_ON_JOB_CLOSE` + 当前进程入 job，成员身份被继承）；真进程测试断言硬杀后代全灭 |
| POSIX，进程仍是我们的 | **能**（进程组 + 组存活检查，容忍短暂僵尸） | `killpg` 后轮询组是否还在 |
| 任一平台，**pid 已被回收** | **不能** | **绝不发信号**。回收后的编号可能属于用户的浏览器；`childExitVerified: false` |
| POSIX，后端被 `SIGKILL` | **不能**（需 cgroup / PID namespace，超出范围） | 如实上报未确认，不声称已清理 |

**因此**：`cancelled` / `childExitVerified: true` 只在**确实验证过**时出现；
验证不了就停在 `cancelling` 或标 `false`，并且**不重复对已回收的 pid 动手**。
彻底关闭 POSIX 硬杀这个缺口需要 cgroup 或 PID namespace，属于另一次带 ADR 的变更。

#### 必须有的真实测试（不是代码检查）

一条**真的起进程**的测试，因为这条合同的全部价值就在于进程是否真的没了：

1. 启动后端，发起一个会 spawn **父 → 子** 两层进程树的运行；
2. 记录整棵树的 pid 集合（含后代）；
3. **终止 / 重启后端**（分别测正常退出与 `kill -9` 两条路径）；
4. **断言全部后代进程都不存在**（按 pid + 创建时间核对，避免 PID 复用造成的假阴性）；
5. 断言受影响的 Run 落到 `failed(backend_restarted)`，
   且无法确认时 `sideEffect === "unknown"`。

第 4 步用「pid 存在性」单独判断是不够的：一个被复用的 pid 会让测试**误判为失败**，
一个恰好退出的无关进程会让它**误判为通过**。核对创建时间是这条测试成立的前提。

### 5.9b 长任务端点全表：endpoint → kind → taskType → executor（冻结）

**这张表是封闭的。** 一个会让用户等待的端点，必须在这里有一行；新增长任务端点
必须同时新增一行，否则它就是一个没有运行身份的任务——正是本轮要消灭的东西。

| endpoint | `kind` | `taskType` | executor | 落地批次 |
| --- | --- | --- | --- | --- |
| `POST /api/skill/run` | `skill` | `skill.<skillId>`（调用方给出；缺失则 `skill.unknown`） | `claude-code` / `codex-cli` / `manual` | 一 |
| `POST /api/agent/story-develop` | `skill` | `skill.story-development` | 同上 | 一 |
| `POST /api/agent/episode-plan` | `skill` | `skill.episode-plan` | 同上 | 一 |
| `POST /api/agent/script-draft` | `skill` | `skill.script-writer` | 同上 | 一 |
| `POST /api/agent/shots-draft` | `skill` | `skill.storyboard-director` | 同上 | 一 |
| `POST /api/agent/bible-breakdown` | `skill` | `skill.script-breakdown` | 同上 | 一 |
| `POST /api/agent/tts` | `tts` | `generation.tts.piper` | `local-piper` | 四 |
| `POST /api/agent/image-gen` | `image-gen` | `generation.image.minimax` | `provider:minimax` | 四 |
| `POST /api/agent/adopt-paid` | `image-gen` | `generation.image.adopt` | `manual` | 四 |
| `POST /api/agent/mix-shot` | `ffmpeg` | `post.mix.shot` | `local-ffmpeg` | 四 |
| `POST /api/agent/compose` | `ffmpeg` | `post.compose.draft` | `local-ffmpeg` | 四 |
| `POST /api/agent/render-episode` | `render` | `render.roughcut` | `local-ffmpeg` | 四 |
| （TASK-074 新增）导出成片 | `export` | `export.delivery` | `local-ffmpeg` | 四 |
| 手工视频生成（原 M1 VideoProvider） | `video-gen` | `generation.video.manual` | `manual` → `awaiting_input` | 待定（TASK-074）|

**executor 列的取值必须来自 §5.3 的封闭枚举，一个不多一个不少**——两张表由同一条
守卫测试逐行比对。一张表里出现另一张表没有的执行器，就是一个没有合同的执行路径。

**不是 Run 的写路径**（同步、无等待语义，不进运行注册表）：
`PUT /api/canvas/<name>` · `PUT /api/uploads/<project>/<slug>` ·
`POST /api/assets/delete-file` · `POST /api/projects*` ·
`POST /api/projects/<name>/{preflight,command}`。

关于 `skill.episode-plan`：Skill 目录里今天**没有**与它精确对应的能力
（TASK-068 §3 风险 2）。`taskType` 是**端点能力**的标识，与目录条目解耦，
所以「给 `story-development` 加 plan 分支」还是「新增 `episode-planner`」这个设计
决定可以留到 TASK-073，**而这个 key 不会因为那个决定而改变**。
这正是 `taskType` 与 `taskName` / `skillId` 分开的价值。

### 5.9c 接口迁移：新旧两条路怎么并存（冻结）

| 调用方式 | 请求 | 响应 | 谁用 |
| --- | --- | --- | --- |
| `POST /api/skill/run`，**带 `X-Motv-Async: 1`** | 同今天 + 可选 `skillId` / `commandId` / `idempotencyKey` | **`202 { run_id, status, queuePosition }`** | **新 UI**（TASK-073 起） |
| `POST /api/skill/run`，无该头 | 同今天 | 同今天：`200 { ok, text, model }`；槽满仍 **429** | 兼容层，TASK-074 下线 |
| `POST /api/agent/*` 五个创作端点，**默认（无 async 头）** | **不变** | **不变**：`{ shots \| script \| breakdown \| outline \| episodes, draft, source }` + **新增** `run_id` / `executor` / `model`（加法） | 现有前端，不改也能工作 |
| `POST /api/agent/*` 五个，**带 `X-Motv-Async: 1`** | 不变 | **`202 { run_id, status, queuePosition }`**，**不含**产物键 | 新 UI |

三条约束：

1. **默认同步 + 旧响应结构不变**，但**内部一律走 Runtime 层**（执行器解析、并发槽、
   进程树终止、运行注册表）。「行为不变」指的是**响应契约**，不是实现路径。
2. **异步响应里没有产物。** 产物只在 `GET /api/runs/<run_id>` 的 `outputs` 里，
   且**用与同步响应完全相同的键**（`shots` / `script` / …）——同一件东西两个名字，
   是下一次解析错误的来源。
3. **`/api/skill/run` 的同步路径不排队。** 无 async 头时槽满就是 429（旧行为），
   **不把调用方挂起**：一个同步调用方的连接被无限期占住，与「立即返回 run_id」
   是相反的两种承诺。

   **五个 `/api/agent/*` 的同步路径则相反：槽满时等待，不 429**（2026-08-13 实施时
   收口）。它们的旧实现**根本没有并发上限**，从不返回 429；收口后让它们共用同一个
   上限是对的，但把「等一会儿」变成「一个它从没见过的失败码」，就把一次收口变成了
   对现有调用方的行为破坏。等待保留的是它们唯一的旧承诺——**这个请求最终会有结果**。

   两条路的差别不是不一致，而是各自保留各自的旧承诺：`/api/skill/run` 旧行为就是
   429，五个端点旧行为就是无限等。**新 UI 一律走异步路径**，两条同步路径都在
   TASK-074 下线。

### 5.10 「新增 Skill 不需要新增页面」的执行方式

| 机制 | 保证 |
| --- | --- |
| Skill 声明 `scope` | 它归属到某个对象层级 |
| 对象级「让 Agent 处理」按 `scope` 过滤 | 自动出现在正确页面，无需布线 |
| 面板结构固定七项（IA §6.3） | 不因能力增加而变形 |
| Proposal 类型映射到既有 Action 词汇表 | 不新增第二套业务逻辑 |
| 技术信息进「生成记录」 | 不占主界面预算 |

守卫测试（第三阶段）：新增一个假 Skill，断言页面数量与导航结构不变。

---

## 6. 三层检查的系统合同

### 6.1 ReviewIssue

```
ReviewIssue {
  issueId
  layer      "shot" | "episode" | "delivery"
  targetType "shot" | "episode" | "delivery"
  targetId
  locatedShotId   *** 层 2 必填 ***   问题必须定位到具体镜头
  category   见下表
  severity   "blocking" | "warning" | "info"
  source     "user" | "agent"        Agent 只能产生 Issue，不能产生 Decision
  text
  state      "open" | "resolved" | "ignored"
  ignoredBy / ignoredAt              忽略非阻断问题必须留记录（U10）
}
```

| layer | category 取值 |
| --- | --- |
| `shot` | `character` `action` `composition` `duration` `artifact` |
| `episode` | `story` `pacing` `continuity` `transition` `missing_shot` |
| `delivery` | `av_sync` `subtitle` `loudness` `black_frame` `dropped_frame` `spec` `rights` |

**三层的 category 集合互不相交**——这是「边界清晰」在数据上的执行方式。
一个 `loudness` 问题不可能出现在层 2，一个 `pacing` 问题不可能出现在层 3。

### 6.2 ReviewDecision

```
ReviewDecision {
  decisionId
  layer       "shot" | "episode" | "delivery"
  targetId
  verdict     "passed" | "needs_rework" | "needs_rereview"
  by          *** 永远是 "user" ***
  at
  basedOnVersion   审的是哪一版（层 1: video 版本；层 2: roughcut 版本；层 3: delivery 版本）
  openIssueIds     做决定时仍然打开的问题
}
```

**`by` 永远是 `user`。** Agent 产生 Issue，用户产生 Decision。这是 §7.3 四条禁令里
「不得静默定稿」的系统级执行方式，不是 UI 约定。

### 6.3 门槛判定（精确定义）

| 门槛 | 判定 |
| --- | --- |
| G1 正式审片 | `episode.shots.every(s => s.hasConfirmedVideo)`；否则新建的 RoughCut 标记 `kind = "test"`，不可提交 Decision |
| G2 画面锁定 | 存在 `layer=episode, verdict=passed` 且 `basedOnVersion == 当前 roughcut active 版本` 的 Decision |
| G3 结构变更回退 | 当以下任一发生：Shot 增删、Shot 的 confirmed video 版本变更、TimelineClip 顺序变更、TimelineClip 入出点变更 → 该 Episode 最新 Decision 置 `needs_rereview`，画面锁定解除 |
| G4 阻断导出 | `delivery.qcReport.issues.some(i => i.severity === "blocking" && i.state === "open")` → 拒绝导出 |
| G5 版本非破坏 | `buildRoughCut` / `exportDelivery` 一律 append 新版本；不存在覆盖路径 |

G3 的触发点是**领域层**，不是 UI：任何走 Action 层的相关写入都触发它。
一个只在某个页面里检查的回退规则，会被另一个页面的同类操作绕过。

### 6.4 与 ADR-0057 `approveShot` 的迁移

现状：`approveShot(shotId, note)` 记录逐镜通过，`hasStaleApproval` 检测上游变化。

目标：
- `approveShot` → 层 1 的 `ReviewDecision(layer="shot", verdict="passed")`，
  **同时**要求该 Shot 已有 `confirmed` video 版本（现状已在 domain 层守卫，保留）。
- `hasStaleApproval` → `Decision.basedOnVersion != 当前 active video 版本`，
  显示为「已定稿的不是当前版本」。
- **不新增布尔字段**：定稿与否由 §4 派生。

### 6.5 Delivery 的生命周期（冻结，2026-08-13 补）

「一次导出尝试 = 一个 Delivery」此前没有写死候选与 Final 的关系，导致
「质检通过」「已导出」「Final 是哪一版」三件事没有唯一答案。冻结为一条链：

```
① 生成 Delivery 候选     exportDelivery(dryRun) 或 buildDelivery
      ↓                   → final ArtifactVersion(candidate)，Delivery.state = "candidate"
② 运行交付质检           runDeliveryQc → QCReport(ReviewIssue*，层 3)
      ↓                   Delivery.state = "qc_passed" | "qc_blocked"
③ 用户确认导出           exportDelivery（**用户确认**；G4 拦阻断问题）
      ↓
④ Final 版本             final ArtifactVersion(confirmed) + 导出记录
```

| 规则 | 内容 |
| --- | --- |
| 顺序不可跳 | 没有 QCReport 的候选**不可**进入 ③；`runDeliveryQc` 未跑过 = 未知，不是通过 |
| G4 | `qcReport.issues.some(blocking && open)` → ③ 拒绝执行并列出问题 |
| G5 | ①③ 一律 **append 新版本**；`final` 绝不覆盖，代码里不存在覆盖分支 |
| 谁能 `confirmed` | 只有用户（§3.1 不变量 1）。质检通过**不等于**定稿——它只是解除阻断 |
| 失败 | 渲染失败保留已产出的部分并说明；Delivery 记 `failed`，不删除 |
| 重跑质检 | 候选变化后旧 QCReport 失效，Delivery 回落 `candidate`（与 G3 同一条道理） |

**归属**：本节由 TASK-074 §1.1 / §1.2 实施，TASK-072 与 TASK-073 只需保证
`exportDelivery` / `runDeliveryQc` 的 Command 名与风险等级（§8.1）不被改动。

---

## 7. 前后端交互原则（冻结）

```
页面
 ↓  只读投影 / 只发意图，不含业务规则
前端业务状态层           （ctx.* 领域控制器；只保存临时界面状态）
 ↓
统一 API Client          services/apiclient.js —— 唯一 fetch 出口
 ↓
Query（读）  |  Command Gateway（写）
 ↓
Workflow Orchestrator
 ↓
Skill / Provider / Repository
```

### 7.1 十条规定

1. 页面不得直接调用 Claude、Skill、Provider 或 FFmpeg。
2. API 路由不得直接执行具体 Provider 或 CLI。
   （**已收口**（2026-08-22 实测）：五个创作端点经 `server.py::_creative_agent` →
   Runtime 层，`_run_claude` 已不存在。原「现状违反」标注由 TASK-072 §1.8 消除，
   TASK-103 核对后更新此处。）
3. 前端只保存**临时界面状态**（选中项 / 展开态 / 筛选条件 / 未提交的输入）。
4. 任务、版本、成本、确认与错误由**后端持久化**。
5. **所有写操作必须有明确 Command**（有名字、有参数契约、有风险等级）。
6. **所有长任务立即返回 `run_id`**，随后轮询 / 推送进度。
7. **API 错误不得静默转换为空列表或本地数据。** 错误必须冒泡成可见状态
   （「读取失败：<原因>」+ 重试），**绝不降级为「这里什么都没有」**。
8. 新增 Skill 不应要求新增主页面或重新设计任务状态。
9. Query 是纯读，**不得有副作用**；Command 是纯写意图，返回受理结果而非业务数据。
10. 统一 API Client 是**唯一** `fetch` 出口。
    （**已收口**（TASK-103 批次 A）：`services/{gateway,persist,query,runtime}.js` 与
    `workflow/mediaref.js` 全部改经 `apiclient`；由前端套件
    `tests/apioutlet.test.mjs` **派生式**守住 —— 扫 `src/**.js`，新加的 service
    因为存在而被检查。唯一豁免 `services/mediaprobe.js` 的可注入 `fetch` 缺省值：
    它探的是媒体字节而非后端 API，且是测试注入点；豁免被断言，不是被假设。）

### 7.2 现状差距

| 差距 | 现状 | 目标 | 承接 |
| --- | --- | --- | --- |
| Query 与 Command 混在一个模块 | `services/query.js` 里 `getQuery` 与 `renderEpisode` / `ttsGenerate` / `generateScriptDraft` 并列 | 拆为 `query.js` / `command.js`，共用 `apiclient.js` | TASK-072 **批次二** |
| 长任务同步阻塞 | `/api/skill/run` 阻塞返回，无 `run_id` | 立即返回 `run_id` + `/api/runs/<id>` 轮询 + `/api/runs/<id>/cancel` | TASK-072 **批次一** |
| 取消不可达 | 无取消路径 | `cancelling` → 终止子进程 → `cancelled` | TASK-072 **批次一** |
| 运行记录只有 Skill 有 | 生成 / 渲染 / 导出各自记账，看板无法统一回答 | 一个 `Run` + `kind`（§5.0） | TASK-072 **批次一** |
| AI 路径二选一 | `/api/agent/*` 与 `/api/skill/run` 并存 | 全部经 Runtime 层 | TASK-068（规格）并入 TASK-072 **批次一** |
| 多个 fetch 出口 | ~~5 个模块~~ **1 个（+1 条被断言的媒体字节豁免）** | 1 个 | TASK-072 批次二（24/30）+ **TASK-103 批次 A（收口）** |
| 评价 / 反馈闭环够不到 Studio 项目 | ~~四个 LOW-risk 命令只注册在 `workspace_shell`~~ **`record-evaluation` 等四条已注册进 Studio Gateway；审片「✓ 通过 / 撤销」经网关落核心并留回执** | 闭环接通 | **TASK-103 批次 B**（`create-feedback` 仍无调用方 —— 界面尚无「提出审片问题」入口，见 TASK-087 §5.9） |
| 媒体是否还在只能从浏览器猜 | ~~前端 `HEAD` 探针 + 第三态 `INCONCLUSIVE`~~ **服务端 `media-audit` 目录审计，项目媒体只有「在 / 不在」** | 服务端权威 | **TASK-103 批次 C** |

---

## 8. Command 与 Query 名录

### 8.1 Command 词汇表

以现有 `workflow/actions.js` 的 `ACTIONS` 为基线。风险等级沿用
`read | pointer | edit | heavy`，新增一级 `paid`（产生外部费用，必须金额确认）。

| 分组 | Command | 风险 | 需用户确认 |
| --- | --- | --- | --- |
| 项目 | `updateProjectSpec` `setBudgetLimits` | edit | 否 |
| 故事 | `proposeOutline` `updateOutline` `confirmOutline` `lockOutline` | edit / pointer | `confirm*` / `lock*` 是 |
| 设定 | `upsertCharacter` `upsertLocation` `upsertProp` `removeCanonObject` | edit | 删除是 |
| 设定 | `upsertRelationship` `removeRelationship` `swapRelationshipDirection` | edit / pointer | 删除是 |
| 设定 | `importReference` `setBasePrompt` `setBaseVoice` | edit | 否 |
| 分集 | `proposeEpisodePlan` `updateEpisodePlan` `confirmEpisodePlan` `setActiveEpisode` | edit / pointer | `confirm*` 是 |
| 剧本 | `proposeScript` `updateScript` `confirmScript` `lockScript` `unlockScript` | edit / pointer | `confirm*` / `lock*` / `unlock*` 是 |
| 分镜 | `replaceShotDraft` `patchShots` `addShot` `removeShot` `reorderShots` `assignShotToScene` | edit | `replaceShotDraft` / `removeShot` 是 |
| 参考 | `addReference` `replaceReference` `removeReference` `setReferenceUse` `updateInterpretation` | edit / pointer | `removeReference` 是 |
| 帧 | `extractFrame` `bindStartFrame` `unbindFrame` `usePreviousShotEndFrame` | edit | 否 |
| Prompt | `updatePrompt` `setActiveVersion` `lockItem` `unlockItem` | edit / pointer | `lockItem` 是 |
| 生成 | `prepareGeneration` | read | 否 |
| 生成 | `startGeneration` | **paid / heavy** | **是（金额预览）** |
| 生成 | `cancelRun` `retryRun` | pointer / heavy | `retryRun` 若付费则是 |
| 生成 | `registerGenerationResult` | edit | 否 |
| 定稿 | `confirmShotVersion`（= 设为最终版本 + 层 1 Decision） | pointer | **是** |
| 定稿 | `unconfirmShotVersion` | pointer | 是 |
| 粗剪 | `buildRoughCut` | heavy | 否（免费本地）|
| 粗剪 | `moveTimelineClip` `trimTimelineClip` `replaceTimelineAsset` `removeTimelineClip` `restoreTimelineClip` `setTransition` `setTimelineVolume` | edit | `remove*` 是 |
| 审片 | `addReviewIssue` `resolveReviewIssue` `ignoreReviewIssue` | edit | `ignore*` 是 |
| 审片 | `submitEpisodeReview`（verdict） | pointer | **是** |
| 审片 | `lockPictureEdit` `unlockPictureEdit` | pointer | **是** |
| 后期 | `autoArrangeShotAudio` `addAudioClip` `removeAudioClip` `moveAudioClip` `trimAudioClip` `setGain` `setFade` `setAudioMuted` | edit | `remove*` 是 |
| 后期 | `mixShotAudio` `buildSubtitles` `updateSubtitle` | heavy / edit | 否 |
| 后期 | `generateVoice` | paid 或 free（本地 TTS） | 付费时是 |
| 交付 | `runDeliveryQc` | heavy | 否 |
| 交付 | `exportDelivery` | heavy | **是** |
| 资产 | `registerAsset` `updateAssetMeta` `archiveAsset` `unarchiveAsset` `removeAssetBytes` `deleteAsset` | edit | 后三个是（删除双重确认）|
| 能力 | `runSkill` `confirmSkillRun` `applyProposal` `rejectProposal` | edit | `runSkill` 若付费则是；`applyProposal` 是 |
| 批量 | `batchRegenerate` | **paid / heavy** | **是（影响范围 + 总额）** |

### 8.2 Query 名录

| Query | 返回 | 主要消费页面 |
| --- | --- | --- |
| `project.summary` | 项目信息 / 规格 / 预算 / 花费 | ① ⚙ |
| `story.outline` | 大纲版本树 + active | ② |
| `canon.objects` | 人物 / 场景 / 道具 / 关系 + 基础资产完整度 | ③ |
| `canon.object(id)` | 单个对象档案 + 状态 + 基础资产 | ③ |
| `episode.plan` | 分集规划版本 + 各集摘要 | ④ |
| `episode.script` | 本集剧本版本 + active + lock | ⑤ |
| `episode.board` | **看板模型**：阶段 / 完成度 / 阻塞 / 失败任务 / 成本 / 待处理镜头 / 推荐下一步 | ⑥ |
| `episode.shotlist` | 场景 → 镜头 + 设计字段 + 状态 | ⑦ |
| `shot.workbench(shotId)` | 四步模型：A/B 分区 · 生成清单 · Prompt · 候选 · 任务 | ⑧ |
| `shot.candidates(shotId, kind)` | 候选版本 + 版本差异 | ⑧ |
| `shot.generationRecord(versionId)` | **生成记录**：Skill Run / Provider / Model / 输入版本 / 成本 / 确认人 | ⑧ ⑨ ⑩ |
| `episode.roughcut` | 粗剪版本 + 镜头条 + 问题 + Decision | ⑨ |
| `episode.post` | 时间线 / 音轨 / 字幕 / 锁定状态 | ⑩ |
| `episode.delivery` | Delivery 列表 + QC Report + 导出记录 | ⑩ |
| `assets.search(filter)` | 统一资产查询（对象类 / 媒体类 / 范围 / 状态） | ⑪ + 抽屉 |
| `assets.usage(assetId)` | 「在哪被用」反查 | ⑪ ⚙ |
| `agent.context(page, objectId)` | Agent 面板七项模型 | 全部 |
| `runs.list(filter)` / `runs.get(runId)` | **全部 kind** 的 Run 状态、进度、排队位置与失败原因（§5.0） | ⑥ ⑧ ⑨ ⑩ |
| `runtime.status` | 执行器真实探测结果 | ⚙ |
| `storage.overview` | 存储生命周期 | ⚙ |

**投影原则**（ADR-0031，不变）：Query 只投影，不复制 canon 的第二份副本；
一切派生结论可从权威文件 / 事件重建。

---

## 9. 主要操作矩阵：界面 → 命令 → 任务 → 输出 → 确认 → 失败恢复 → 锁定影响

> 列含义：**界面操作** → 对应 **Query/Command** → 输入对象 → 后台任务 →
> 输出对象 → 是否需要确认 → 失败恢复方式 → 是否影响锁定状态。

| 界面操作 | Command / Query | 输入对象 | 后台任务 | 输出对象 | 确认 | 失败恢复 | 锁定影响 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ① 保存创意新版本 | `updateOutline`(brief) | Project | 无 | brief ArtifactVersion(candidate) | 否 | 本地重试；错误可见 | 无 |
| ① 设置成片规格 / 预算 | `updateProjectSpec` / `setBudgetLimits` | Project | 无 | Project | 否 | 同上 | 无 |
| ② 生成故事大纲 | `runSkill`(story-development) | brief | SkillRun | outline(suggested) | 付费时是 | Run 记 `failed`+原因；重试 / 手工兜底 | 无 |
| ② 确认大纲 | `confirmOutline` | outline candidate | 无 | outline(confirmed) | **是** | —— | 无 |
| ② 锁定大纲 | `lockOutline` | outline confirmed | 无 | outline(locked) | **是** | —— | 锁定大纲 |
| ③ 新增 / 编辑人物 | `upsertCharacter` | Canon | 无 | Character | 否 | 错误可见 | 无 |
| ③ 上传参考图 | `importReference` + `registerAsset` | 文件 | 上传 | Asset + Binding | 否 | 上传失败保留本地选择 | 无 |
| ③ 编辑基础生图 Prompt | `setBasePrompt` | Canon 对象 | 无 | prompt:base(candidate) | 否 | 同上 | 若已 locked 需先解锁 |
| ③ 删除对象 | `removeCanonObject` | Canon 对象 | 无 | —— | **是** | 引用阻断时拒绝并列出引用 | 无 |
| ④ 生成分集规划 | `runSkill`(episode-plan) | outline | SkillRun | episodePlan(suggested) | 付费时是 | 同 ② | 无 |
| ④ 确认分集规划 | `confirmEpisodePlan` | plan candidate | 无 | plan(confirmed) | **是** | —— | 无 |
| ⑤ 生成剧本 | `runSkill`(script-writer) | plan + outline | SkillRun | script(suggested) | 付费时是 | 同 ② | 无 |
| ⑤ 锁定剧本 | `lockScript` | script confirmed | 无 | script(locked) | **是** | —— | 锁定剧本 |
| ⑥ 看板加载 | `episode.board` | Episode | 无 | 看板模型 | —— | **错误显示为错误，不显示为空** | 无 |
| ⑥ 重试失败任务 | `retryRun` | SkillRun | 新 SkillRun | 同原任务 | 付费时是 | 新 Run 独立记录 | 无 |
| ⑥ 取消运行中任务 | `cancelRun` | SkillRun | 终止子进程 | Run(cancelled) | 否 | 终止失败 → 停在 `cancelling` 并如实说明 | 无 |
| ⑦ 生成分镜草稿 | `runSkill`(storyboard-director) | script | SkillRun | shotDraft(suggested) | 付费时是 | 同 ② | 剧本 locked 不阻止 |
| ⑦ 应用分镜草稿 | `replaceShotDraft` | shotDraft | 无 | Shot* | **是（覆盖）** | 旧草稿保留可回退 | 无 |
| ⑦ 编辑镜头卡 | `patchShots` | Shot | 无 | Shot | 否 | 错误可见 | **触发 G3 判定** |
| ⑦ 删除镜头 | `removeShot` | Shot | 无 | —— | **是** | —— | **触发 G3** |
| ⑧ 打开准备输入 | `shot.workbench` | Shot | 无 | 四步模型 | —— | 错误可见 | 无 |
| ⑧ 添加参考（抽屉） | `addReference` | Shot + Asset | 无 | Binding | 否 | 错误可见 | 无 |
| ⑧ 移除参考 | `removeReference` | Binding | 无 | —— | **是** | —— | 无 |
| ⑧ Agent 推荐资产 | `runSkill`(shot-asset-recommender) | shotContext + 候选集 | SkillRun | Proposal(addReference*) | 否（免费） | Run 记 `failed`；候选集仍可手选 | 无 |
| ⑧ 接受推荐 | `applyProposal` | Proposal | 无 | Binding | **是** | 校验失败丢弃并报告条数 | 无 |
| ⑧ 写 Image Prompt | `runSkill`(image-prompt-director) | shotContext | SkillRun | prompt:image(suggested) | 付费时是 | 同 ② | prompt locked 则拒绝 |
| ⑧ 生成主画面 | `startGeneration`(image) | Prompt + Bindings | 生成任务（run_id） | image(candidate) | **是（付费）** | Run(failed)+原因；重试；已花费如实记账 | 无 |
| ⑧ 选定主帧图 | `confirmShotVersion`(image) | image candidate | 无 | image(confirmed) | **是** | —— | 下游 video 标记 outdated |
| ⑧ 写 Video Prompt | `runSkill`(video-prompt-director) | shotContext + **confirmed image** | SkillRun | prompt:video(suggested) | 付费时是 | 无 confirmed image → 能力层拒绝并说明 | 无 |
| ⑧ 生成视频候选 | `startGeneration`(video) | Prompt + 首尾帧 | 生成任务（run_id） | video(candidate) | **是（付费）** | 同上 | 无 |
| ⑧ **选为最终版本（定稿）** | `confirmShotVersion`(video) | video candidate | 无 | video(confirmed) + Decision(layer=shot) | **是** | —— | **触发 G3** |
| ⑨ 生成粗剪 | `buildRoughCut` | 已定稿镜头 | 渲染任务（run_id） | roughcut(candidate) | 否 | Run(failed)+缺口清单 | 未全定稿 → `kind=test` |
| ⑨ 调整镜头顺序 / 时长 | `moveTimelineClip` / `trimTimelineClip` | TimelineClip | 无 | Timeline | 否 | 错误可见 | **触发 G3** |
| ⑨ 标记问题 | `addReviewIssue`(layer=episode) | RoughCut + **locatedShotId** | 无 | ReviewIssue | 否 | —— | 无 |
| ⑨ 退回重新生成 | 跳转 ⑧ + `startGeneration` | Shot | 生成任务 | video(candidate) | **是（付费）** | 同 ⑧ | **触发 G3** |
| ⑨ **确认整集审片通过** | `submitEpisodeReview`(passed) | roughcut active 版本 | 无 | ReviewDecision(layer=episode) | **是** | —— | 满足 G2，允许锁定画面 |
| ⑩ 锁定画面剪辑 | `lockPictureEdit` | Episode（需 G2） | 无 | Timeline(locked) | **是** | 未通过 G2 → 拒绝并说明 | 锁定画面 |
| ⑩ 生成配音 | `generateVoice` | 对白 + BaseVoice | TTS 任务（run_id） | audio:dialogue(candidate) | 付费时是 | Run(failed)+原因 | 无 |
| ⑩ 自动混音 | `mixShotAudio` | 音轨 | ffmpeg 任务（run_id） | audio:mix(candidate) | 否 | 同上 | 跳过 locked 并报告条数 |
| ⑩ 生成字幕 | `buildSubtitles` | 对白 + 时序 | 无（Case A）| subtitle(candidate) | 否 | 无 ASR → 显示 not available | 无 |
| ⑩ 运行交付质检 | `runDeliveryQc` | Delivery 候选 | 质检任务（run_id） | QCReport(ReviewIssue*) | 否 | Run(failed)+原因 | 无 |
| ⑩ 忽略非阻断问题 | `ignoreReviewIssue` | ReviewIssue(warning) | 无 | Issue(ignored)+记录 | **是** | —— | 无 |
| ⑩ **导出成片** | `exportDelivery` | Delivery（需 G4） | 渲染任务（run_id） | final(candidate→confirmed) + 导出记录 | **是** | 有 blocking → 拒绝并列出；渲染失败保留部分产物并说明 | 新版本，绝不覆盖 |
| ⑪ 上传资产 | `registerAsset` | 文件 | 上传 | Asset | 否 | 上传失败可重试 | 无 |
| ⑪ 归档 / 移除字节 | `archiveAsset` / `removeAssetBytes` | Asset | 无 | Asset(storageState) | **是** | 被引用则阻断并列出引用 | 无 |
| ⑪ 永久删除 | `deleteAsset` | Asset | 无 | —— | **是（双重）** | 同上 | 无 |
| 任意 | 页面级「询问 Agent」 | `agent.context` + `runSkill` | 当前页面 + 主对象 | SkillRun | 付费时是 | runtime 不可用 → 手工兜底路径 | 无 |
| 任意 | 对象级「让 Agent 处理」 | 同上（scope 过滤） | 该对象 + 上游 | SkillRun | 付费时是 | 同上 | 无 |
| 任意 | 批量重新生成 | `batchRegenerate` | 对象集合 | N 个生成任务 | **是（范围+总额）** | 逐项独立记录；部分失败不回滚已成功项 | 跳过 locked 并报告 |

### 9.1 失败恢复的三条通则

1. **失败是一个被记录的状态，不是一个 toast。** 每次失败落到 Run 的
   `status=failed` + `failureReason`，在看板「失败任务」里可见、可重试。
2. **部分成功不回滚。** 批量操作里成功的那些保留；失败的那些逐条报告原因。
3. **已花费的钱如实记账。** 生成失败但 Provider 已计费时，成本仍然记录，
   并在 Run 上注明「已计费但未产出」。

---

## 10. 数据与接口迁移策略

| 层 | 现状 | 目标 | 迁移方式 | 阶段 |
| --- | --- | --- | --- | --- |
| canvas schema | v14 | v15 | 确定性迁移：`skillRuns[].status` 拆两字段（§5.2 映射表）；新增 `reviewIssues` / `reviewDecisions` / `deliveries` 三个 registry，默认空数组 | 二 |
| ArtifactVersion 状态 | 各文档各自的 `versions/active/locked` | 统一**六态**（含 `deprecated`） | 派生映射（§3.2），**不改存储结构** | 二（批次三）|
| 运行身份 | `skillRunId`（只有 Skill 有运行记录） | `runId` + `kind`，生成 / 渲染 / 导出共用 | v15 起 `runId === skillRunId`，旧名保留一版别名（§5.0） | 二（批次一）→ 四 |
| `approveShot` | 布尔标记 | 层 1 Decision | 迁移为 Decision；旧标记保留一版做对照 | 二 |
| `/api/skill/run` | 同步阻塞 | `run_id` + 轮询 + 取消 | 新端点并存 → 前端切换 → 旧端点下线 | 二 → 四 |
| `/api/agent/*` 五个创作端点 | 直连 `claude` | 经 Runtime 层 | ADR-0065 / TASK-068 | 二 |
| `services/query.js` | 读写混合 | `apiclient` + `query` + `command` | 拆分，保留旧导出为 re-export 一个版本 | 二 → 四 |
| 模块 key（`refplan` / `frames` / `video` / `dailies` / `assets:*` …） | 12+8 个 | 11 页 | **每个旧 key 必须解析到新页面的对应分区**；落空即回归 | 三 |
| 旧页面组件 | 40+ 个 `src/ui/*.js` | 复用为新页面的分区 | 组件复用优先于重写；只删入口，不删能力 | 三 → 四 |
| 旧接口 | 保留 | 下线 | 第四阶段统一清理，需真实项目验收后 | 四 |

**迁移的两条硬规则**：

1. **不删除任何用户数据。** 所有迁移是加法或派生；schema 迁移必须是确定性的
   （不用时钟、不用随机、不猜）。
2. **每个既有跳转目标都必须落到实处。** 空状态按钮、看板阻塞项、Agent 缺口修复
   链接——任何一个落空都是回归，不是迁移（ADR-0063 决策 1 已确立此规则）。
