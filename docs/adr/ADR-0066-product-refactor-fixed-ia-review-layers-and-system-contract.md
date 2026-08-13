# ADR-0066：产品重构 —— 固定三空间 IA、三层检查、上下文 Agent 与统一系统合同

- 状态：Proposed
- 日期：2026-08-13
- 触发：产品负责人 2026-08-13 下发「产品与系统重构第一阶段：需求、界面、Agent
  协作与系统合同定稿」（本文以下称**本轮规格**）
- 关联 / 被本 ADR 修订：
  [ADR-0031](ADR-0031-workspace-query-and-projection-contract.md)（Query 合同）、
  [ADR-0033](ADR-0033-command-gateway-contract.md)（Command Gateway 合同）、
  [ADR-0052](ADR-0052-workflow-page-as-derived-provenance-graph.md)（溯源图）、
  [ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)（Runtime / Skill 分层）、
  [ADR-0057](ADR-0057-shot-production-state-and-dailies.md)（镜头状态与审片）、
  [ADR-0059](ADR-0059-production-graph-identity-contract.md)（身份与溯源契约）、
  [ADR-0061](ADR-0061-creator-ia-and-automated-episode-production.md)（三空间 IA）、
  [ADR-0063](ADR-0063-creator-object-first-ia-and-shot-production-graph.md)（对象优先 IA / Shot 生产图）、
  [ADR-0064](ADR-0064-ai-director-operationalization.md)（AI 导演可操作化）、
  [ADR-0065](ADR-0065-every-ai-action-through-the-runtime-layer.md)（AI 动作经 Runtime 层）
- 交付文档：
  [创作者产品信息架构](../design/creator-product-information-architecture.md)、
  [创作者系统合同](../design/creator-system-contract.md)
- 实施任务：[TASK-072](../tasks/TASK-072-system-contract-and-persistent-runs.md)、
  [TASK-073](../tasks/TASK-073-fixed-ia-and-contextual-agent.md)、
  [TASK-074](../tasks/TASK-074-delivery-migration-and-legacy-retirement.md)

> **本 ADR 不改任何业务代码。** 它冻结产品与系统边界；实施分三个后续阶段
> （TASK-072 / 073 / 074）。第一阶段的交付物就是本 ADR 与两份设计文档。

## 1. 背景：能力是齐的，归属是乱的

ADR-0061 → ADR-0065 逐轮补齐了能力：三个顶层空间、十类 Reference、Prompt 版本与
Lock、首尾帧绑定、Shot Context、检索式资产推荐、Action Layer、自动初剪、后期控制台、
Skill Run 与溯源。**本轮不新增任何能力。**

产品负责人在真实项目上完整走了一遍，暴露的问题全部是**归属与边界**问题：

| 问题 | 现状证据 |
| --- | --- |
| 一件事有多个入口 | `画面` / `视频` / `参考统筹` / `制作台` 都能改同一镜的参考绑定 |
| 剧集制作有 11 个同级模块 | `shell.js` `EPISODE_NAV` 共 11 项，其中 10 项挤在「工作区 ▾」菜单里 |
| 资产库有 8 个近似工作区 | `ASSET_NAV` 七个条目全部渲染同一个 `renderAssetLibrary`，只预置 type 过滤器 |
| 「审片」只有一层 | `dailies` 逐镜通过；**没有整集粗剪审片，也没有交付质检** |
| 系统语汇泄漏到主界面 | 制作台头部有「自动布局 / 手动布局 / 完整溯源 ↗」；AI 导演面板显示 Skill / Runtime / Executor |
| 长任务没有后端身份 | `/api/skill/run` **同步阻塞**返回，没有 `run_id`、没有进度、没有取消 |
| 查询与命令没有分离 | `services/query.js` 里 `getQuery` 与 `renderEpisode` / `ttsGenerate` / `generateScriptDraft` 并列 |
| Skill Run 状态把两件事混成一个字段 | `RUN_STATUSES = ["running","proposed","failed","accepted","rejected"]` —— 运行生命周期与提案处置共用一个枚举 |

结论：**再增加页面只会加剧问题。** 本轮唯一允许的动作是合并、降级、隐藏与删除。

## 2. 决策

### 决策 1：一级导航永久固定为三个空间，二级页面永久固定为十一个

```
故事开发   项目与创意 · 故事大纲 · 作品设定 · 分集规划 · 本集剧本
剧集制作   本集看板 · 分镜设计 · 镜头制作 · 粗剪审片 · 后期交付
资产库     （单一统一页面，条件筛选）
```

- **这是一个封闭集合。** 新增能力必须落进这十一个页面之一；
  **新增 Skill 不得触发新增一级或二级页面**（验收标准，见 §10）。
- 「项目设置」（含**存储与诊断**）是**工具面**，从顶栏项目名进入，不是生产页面、
  不计入上述十一个，也不出现在三空间导航里。
- 三空间的划分沿用 ADR-0061 决策 1（按创作对象命名），本轮只把二级收敛为固定集合。

### 决策 2：三层检查是三个不同的东西，各有唯一归属页面

这是本轮最重要的产品结论。此前系统只有一层「审片」（ADR-0057 的 dailies），
它同时被当成定稿、当成整集审阅、又没有任何交付检查。

| 层 | 页面 | 对象 | 判断什么 | 结论写到哪 |
| --- | --- | --- | --- | --- |
| 单镜头定稿 | 镜头制作 | 一个 Shot 的候选版本 | 人物 / 动作 / 构图 / 时长 / 画面异常 | 该 Shot 的 confirmed Artifact Version |
| 整集粗剪审片 | 粗剪审片 | 一个 Rough Cut 版本 | 剧情 / 节奏 / 衔接 / 连续性 / 镜头缺失 | Episode 的 Review Decision |
| 交付质检 | 后期交付 | 一个 Delivery 候选 | 音画同步 / 字幕 / 音量 / 黑帧 / 缺帧 / 规格 / 素材权限 | Delivery 的 QC Report |

**交付质检不是创意审片。** 它只回答「这个文件能不能交出去」。

四条流程门槛随之冻结（完整表述见系统合同文档 §6）：

1. 镜头未全部定稿 → 可生成**测试粗剪**，不可进入**正式整集审片**。
2. 整集审片通过 → 才可锁定画面剪辑，才可进入**正式**声音与字幕制作。
3. 后期修改若影响镜头结构（增删镜头、换镜头版本、改顺序、改时长）→ 整集审片状态
   自动回落为 `needs_rereview`。
4. 存在阻断级交付问题 → 不可正式导出。
5. 每次粗剪与每次导出**产生新版本**，禁止静默覆盖（AGENTS.md 第 13 条）。

### 决策 3：生产界面不是流程图；流程图降级为诊断与生成记录

- **撤销 ADR-0063 决策 4 / 决策 5 中「当前 Shot 生产图是剧集制作的中央」这一条。**
  `EPISODE_DEFAULT` 从 `workbench` 改为 `本集看板`。
- 「镜头制作」改为**四步线性流程**：准备输入 → 制作主画面 → 制作视频 → 对比候选并选定。
- 节点连线、自动布局 / 手动布局、整集溯源图**不再出现在普通用户的主路径上**。
  它们保留为：
  - 具体结果旁的「**生成记录**」（一次生成读了什么、用了什么、花了多少、谁确认的）；
  - 项目设置 · 存储与诊断下的**诊断视图**（沿用 ADR-0052 的派生规则，不新建流程模型）。
- **ADR-0052 的核心结论不变**：溯源图是**派生**的，不是第二套流程模型。本轮改的只是
  它在产品里的**位置**，不是它的实现方式。ADR-0063 决策 5 的边规则（没有记录就没有线、
  绑定但未解读不算 ready）在「生成记录」里**继续有效**。

**为什么撤销一个刚 Accepted 的决策**：ADR-0063 决策 4 解决的是「11 个同级 tab」这个
真问题，方向对；但它把**图**当成了工作台。本轮的判断是：图回答「这是怎么来的」，
线性四步回答「我下一步做什么」，后者才是生产界面。ADR-0063 对这一点的分析
（「provenance 先回答了错误的问题」）在本轮**同样适用于它自己的答案**。

### 决策 4：作品设定收敛为一个页面；资产库收敛为一个页面

- **作品设定** = 原「人物」+「世界观」+「人物关系」+ 道具设定，一个二级页面，
  内部按创作对象分区（人物 / 场景 / 道具 / 关系）。
  ADR-0063 决策 1（关系是人物的页签、场景地归世界观、删除只读汇总页签）**继续成立**，
  本轮只是把两个 rail 入口收成一个。
- **资产库** = 一个页面，通过**筛选条件**区分人物 / 场景 / 道具 / 图片 / 视频 / 音频 /
  成片。`ASSET_NAV` 的七个条目全部降级为该页面的**预置筛选**，不再是导航项。
- **Collections**：当前实现只是「可复用的筛选条件」，因此**删除独立入口**，
  改为资产库内的「已保存筛选」。若将来 Collection 获得独立身份（成为可被绑定、
  可被版本化的对象），需要新 ADR 才能重新获得入口。
- **参考统筹**取消独立页面 → 变成镜头内的**资产选择抽屉**（沿用 ADR-0063 决策 7
  的可勾选清单语义：推荐永远是**未勾选**的一行，绝不偷偷变成输入）。
- **底部常驻参考素材库**取消 → 改为「添加参考」触发的抽屉。同一个抽屉组件，
  两个触发点，**一份实现**。

### 决策 5：AI 协作是上下文面板，不是常驻聊天侧栏

**修订 ADR-0061 决策 2 的「右侧永远属于 AI 导演」与 ADR-0064 决策 8 的常驻右栏。**
ADR-0064 决策 1–7（Shot Context、contextTrace、缓存与 stale、检索式候选、
Image / Video 双 Prompt 能力、Prompt Review 与 Continuity 只读、Proposal → Action 映射）
**全部保留不动**——本轮改的是**呈现与入口**，不是能力。

统一交互流程（冻结）：

```
用户表达意图
→ Agent 读取当前页面与对象上下文（shotctx / 页面级投影）
→ 检查输入完整性
→ 只询问缺失信息
→ 按能力声明选择 Skill（用户不选 Skill ID）
→ 展示：任务理解 · 输入 · 产物 · 影响 · 成本 · 耗时
→ 必要时用户确认（awaiting_confirmation）
→ 创建持久化 Skill Run
→ 返回建议或候选
→ 用户接受 / 修改 / 重新生成
→ 用户确认为正式版本
```

**入口只有两类**，没有第三类：

1. 页面级「询问 Agent」
2. 对象级「让 Agent 处理」

面板只展示七项：当前发现的问题、Agent 对任务的理解、缺失输入、推荐下一步、
一个主要执行按钮、查看其他方案、执行后的候选结果与版本差异。

**Runtime / Skill ID / Skill 版本 / Provider / Model / 内部任务 ID 一律不出现在普通
用户主界面**，全部进入结果旁的「生成记录」。ADR-0064 决策 8 的
「技术信息进 `<details>`」由此升级为「技术信息进生成记录」。

### 决策 6：权限边界二分，且 Agent 永远不越过审美与花钱的线

Agent 可自动执行（无需逐次确认）：分析现有输入、检查缺失与冲突、生成草稿、
生成建议、生成候选、执行**不产生外部费用**的检查、标记质量问题。

必须由用户确认：锁定大纲或剧本、覆盖用户修改过的内容、删除镜头或资产、
修改正式绑定关系、使用付费生成能力、批量重新生成、将候选设为最终版本、
通过单镜头定稿、通过整集审片、忽略非阻断质量问题、锁定粗剪、导出或发布成片。

**Agent 不得静默覆盖、静默定稿、静默付费、静默替用户完成审美决策。**

这与 `actions.js` 的 `CURRENT_LEVEL = "suggest"` 一致，但**更严格也更明确**：
本轮把「哪些读动作允许 AI 自动跑」写成了正列表，而不是靠 `risk: "read"` 反推。
`LEVELS` 与 `allowedAt` 的机制保留；提升自动化级别仍然需要单独 ADR。

### 决策 7：核心对象十二类，Artifact 生命周期只有一套

冻结对象：`Project` · `Episode` · `Scene` · `Shot` · `Asset` · `ArtifactVersion` ·
`Binding` · `Skill` · `SkillRun` · `ReviewIssue` · `ReviewDecision` · `Timeline` ·
`Delivery`。

**图片、视频、音频、字幕、成片统一是带版本的 Artifact**，共用同一条版本生命周期：

```
draft → suggested → candidate → confirmed → locked
                          └──────────────→ deprecated（任何状态可达）
```

不为每种媒体设计互不兼容的生命周期——那是本仓库反复付出代价的那类重复。
详细语义、不变量与迁移规则见系统合同文档 §3。

### 决策 8：Skill Run 状态拆成两个轴，并且必须能被后端恢复与取消

现状 `RUN_STATUSES = ["running","proposed","failed","accepted","rejected"]` 把
**运行生命周期**与**提案处置**塞进了一个字段。冻结为两个字段：

```
run.status       queued → awaiting_confirmation → running → succeeded | failed
                                                     └→ cancelling → cancelled
run.proposal.disposition   pending | accepted | rejected | superseded
```

`SkillRun` 必须持久化：任务类型、目标对象、Skill 与版本、Provider 与模型、
输入及输入版本、参数、输出及输出版本、进度、成本、开始与结束时间、失败原因、
用户确认记录。

两条硬要求：

1. **页面刷新后必须能通过后端记录恢复任务状态。** 今天 `skillRuns` 已经持久化在
   canvas 文档里（schema v12+），但**后端进程本身没有身份**：`/api/skill/run` 同步阻塞、
   不返回 `run_id`。刷新页面 = 那次运行的结果永久丢失。
2. **取消必须传递到实际后台任务。** `cancelling` 是一个真实状态：前端置 `cancelling`
   → 后端终止子进程 → 落到 `cancelled`。只清空前端状态不算取消。

**所有长任务立即返回 `run_id`。** 这条同时适用于 Skill Run、生成任务、渲染与导出。

### 决策 9：查询与命令彻底分离，页面永不直连能力

```
页面 → 前端业务状态层 → 统一 API Client → Query | Command Gateway
                                              → Workflow Orchestrator
                                              → Skill / Provider / Repository
```

- 页面不得直接调用 Claude、Skill、Provider 或 FFmpeg。
- API 路由不得直接执行具体 Provider 或 CLI（**这条今天被 `/api/agent/*` 违反**，
  由 ADR-0065 / TASK-068 承接，本轮把它升级为全局原则）。
- 前端只保存**临时界面状态**；任务、版本、成本、确认与错误全部由后端持久化。
- 所有写操作必须有明确 Command。
- **API 错误不得静默转换为空列表或本地数据。**
- 现状 `services/query.js` 同时承载读与写（`getQuery` 与 `renderEpisode` /
  `ttsGenerate` / `generateScriptDraft` 并列），必须拆分为 `query.js` / `command.js`。

Query 名录、Command 名录与「界面—命令—任务—输出—确认」矩阵见系统合同文档 §7–§9。
Command 词汇表**以现有 `workflow/actions.js` 的动作名为基线增量演进**，不另起一套。

### 决策 10：迁移一律「先并存、后清理」，且旧入口有明确终点

- 本轮（第一阶段）**不删除任何页面、接口或数据**。
- 第二阶段新增后端合同与持久化任务，旧路径并存。
- 第三阶段前端切到新 IA，旧模块 key 保持可解析（**每个既有跳转目标都必须落到
  新页面的对应分区**，落空即回归——ADR-0063 决策 1 已确立此规则）。
- 第四阶段清理旧页面与旧接口，并以**真实 Connected Project** 验收
  （AGENTS.md 第 20 条：demo seed 与 SVG 占位素材不作为主要验收依据）。

## 3. 与既有 ADR 的关系（逐条）

| ADR | 关系 | 说明 |
| --- | --- | --- |
| ADR-0031 Query 合同 | **扩展** | 新增页面级 Query 名录；投影原则不变 |
| ADR-0033 Command Gateway | **扩展** | 所有写操作都要有 Command；preflight / 高风险确认机制不变 |
| ADR-0052 溯源图 | **降级不撤销** | 派生规则全部保留；不再是创作者主界面（决策 3） |
| ADR-0056 Runtime / Skill 分层 | **保留** | Role ≠ Skill ≠ Runtime ≠ Model 不变；只是不显示给普通用户 |
| ADR-0057 镜头状态与 dailies | **拆分** | 单层审片拆成三层（决策 2）；`approveShot` 归「镜头制作」 |
| ADR-0059 身份与溯源契约 | **保留** | 七层身份链不变；`SkillRun.context` 不变 |
| ADR-0061 决策 1 | **保留强化** | 三空间不变，二级收敛为固定十一页 |
| ADR-0061 决策 2 | **部分撤销** | 「右侧永远属于 AI 导演」改为按需上下文面板（决策 5） |
| ADR-0061 决策 3–10 | **保留** | Skill 链路、十类 Reference、版本与 Lock、Automation First、Action Layer、Domain First 全部不变 |
| ADR-0063 决策 1 | **收敛** | 两个入口（人物 / 世界观）收成一个「作品设定」页面（决策 4） |
| ADR-0063 决策 2 / 3 | **保留** | 基础资产四件套、不新建存储、关系用图表达（图降级为页内视图） |
| ADR-0063 决策 4 / 5 | **撤销** | 制作台生产图不再是剧集制作中央（决策 3） |
| ADR-0063 决策 6 / 7 | **保留迁移** | A/B 分区与可勾选生成清单并入「镜头制作 · 准备输入」 |
| ADR-0064 决策 1–7 | **保留** | Shot Context / trace / 缓存 / 检索式候选 / 双 Prompt / Review / Proposal→Action 全部不动 |
| ADR-0064 决策 8 | **修订** | 常驻右栏 → 按需上下文面板；技术信息 → 生成记录（决策 5） |
| ADR-0064 追加决策 9 | **保留** | Claude Code 执行 / Codex 审阅的建议式分工不变 |
| ADR-0065 全部 | **保留强化** | 「每个 AI 动作经 Runtime 层」升级为决策 9 的全局原则 |

**需要产品负责人拍板的一处**：ADR-0063 决策 4 / 5 是 2026-08-12 Accepted 并已在
TASK-065 / 066 实施完成的决策，本 ADR 在其落地次日提出撤销。这不是文档冲突，
是一次**产品方向变更**——按 AGENTS.md 第 18 条以新 Proposed ADR 记录，
**不静默修改原决策文字**。本 ADR 转 Accepted 即代表该撤销被批准。

## 4. 后果

### 正面

- 每项功能只有一个归属页面；「这个东西在哪改」有唯一答案。
- 三层检查边界清晰，「审片通过了但成片不能交付」这类矛盾状态不再可能存在。
- 长任务第一次拥有后端身份：刷新可恢复、取消是真取消。
- 新增 Skill 不再牵动 IA：能力增长与页面数量脱钩。

### 代价与风险

- 剧集制作从 11 个模块收敛到 5 个页面，是一次**大范围前端重构**（第三阶段）。
- `SkillRun` 状态枚举变更需要 canvas schema 迁移（v14 → v15）与守卫测试。
- `/api/skill/run` 从同步改为「立即返回 run_id + 轮询 + 取消」是**真实行为变更**，
  会影响每一个既有调用点。
- 撤销 ADR-0063 决策 4 / 5 意味着 `ui/shotgraphview.js` 与 `workflow/shotgraph.js`
  从主路径退到诊断与生成记录路径。**代码不删除**（第四阶段再评估），
  但它们不再获得主界面预算。

## 5. 明确不做（本 ADR 范围内）

- 不修改任何业务代码、前端、后端、数据或接口实现。
- 不实现新接口、不删除旧页面或旧接口、不迁移数据。
- 不接入新模型、Provider 或 Skill。
- 不改变视觉风格。
- 不提高自动化级别（`CURRENT_LEVEL` 保持 `suggest`）。
- 不把后期交付做成 Premiere / DaVinci 的替代品：不做复杂节点、专业调色、
  多机位、插件系统、无限轨道。
- 不通过增加页面解决功能归属问题。
