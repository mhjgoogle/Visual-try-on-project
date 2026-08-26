# 产品规格（Product Spec）

## 1. 项目解决的问题

AI 视频 / AI 短剧的制作目前是高度手工、碎片化的流程：故事、剧本、分镜、素材生成、
配音、剪辑合成分散在多个工具中，中间产物靠人工管理，导致：

- 流程不可复现：同一个项目换一个人（或换一天）就做不出同样的结果；
- 中间产物混乱：镜头素材、版本、命名全靠人记；
- 无法度量：不知道每一集的质量、成本、耗时（QCD），无法持续优化；
- 工具锁定：流程和某个视频生成厂商深度绑定，换供应商就要重来。

本项目提供一个**可运行在 WSL2 Ubuntu + VS Code 中的流水线工具**，
把从故事到成片的全流程结构化、可执行、可续跑、可度量，并且与具体视频厂商解耦。

## 2. 目标用户

- 主要用户：项目所有者本人 —— 使用 AI 工具制作短视频/短剧的个人创作者兼开发者。
- 次要用户：AI 编码 Agent（Claude Code、Codex），它们通过仓库文档理解并扩展本系统。
- 未来可能：其他小型 AI 短剧创作团队。

## 3. 长期工作流

```
故事构思
  → 结构化剧本
  → 场景与镜头拆分
  → 人物、场景、道具资产管理
  → 图片生成
  → 视频生成
  → 配音、音效和字幕
  → FFmpeg 合成
  → 质量检查
  → 质量、成本、交付周期（QCD）记录
  → 最终成片
```

每个环节都是独立可执行的步骤，产物落盘为文件，供下一步消费，也供人工检查与修改。

## 4. 第一阶段最小闭环

第一阶段**不接入付费 API**，视频由用户在网页视频工具中手工生成：

```
读取故事与镜头数据（人工编写的结构化文件）
  → 程序生成"人工视频制作任务"（每个镜头一份任务说明：提示词、时长、规格、目标路径）
  → 用户在网页视频工具中手工生成视频
  → 用户将视频文件放入指定目录
  → 程序检查视频文件（存在性、命名、格式、基本参数）
  → FFmpeg 按镜头顺序合成
  → 输出最终 MP4
```

这个闭环验证的是：数据模型、目录规范、任务生成、文件校验、合成流程 —— 即整个
流水线的骨架。视频生成本身在第一阶段是"人工 Provider"。

## 5. 第一阶段不实现的内容

- 不接入任何 LLM API（故事/剧本由人工编写为结构化文件）；
- 不接入任何视频生成 API（云端或本地模型）；
- 不做图片生成；
- 不做配音、音效、字幕（阶段 5）；
- 不做自动质量检查（仅做文件级校验）；
- 不做 Web UI、数据库、Docker、云端部署；
- 不做自动模型路由。

以上是原 M1 的局部范围边界，不是对后续 Creation Workspace 的永久禁止。

## 6. WFM1 增量路线

原 M1 最小闭环保持完成状态，并作为 WFM1 的稳定生产基础。WFM1 不重做
M1 已可靠提供的任务编排、文件校验、合成、断点续跑、防覆盖和 QCD 能力，
而是在其上增量建立与具体剧情解耦的短剧生产流程。

WFM1 产品范围包括：

- 从创意、叙事、视听设计到生产、后期、发布和复盘的阶段化流程；
- AI 生成候选、人工 Checklist 审核、定向修订和人工锁定；
- 在正式下游消费前设置工作流级审批节点；
- 在付费生成前执行预算检查，并保留成本与生成记录；
- 云端视频作为默认生产路线，同时保持核心工作流 Provider 中立；
- 工作流复用资产与单个剧集实例在概念和职责上分离。

本节只确立产品增量范围，不定义审批、预算、Provider 选择或目录扩展的
具体数据结构。WFM1 继续使用 JSON 作为结构化持久化格式，并遵守
ADR-0001 的项目数据目录合同。详细流程见
[ai_shortfilm_pipeline_workflow.md](ai_shortfilm_pipeline_workflow.md)，治理与
文档权威关系见
[ADR-0007](adr/ADR-0007-wfm1-document-baseline-and-governance.md)。

## 6.1 统一创作工作视窗（核心工作流后的产品方向）

长期产品不仅是 CLI 流水线，还包括一个跨项目 Creation Workspace，用于：

- 观察项目计划、阶段/步骤状态、依赖、产物谱系、版本和成本；
- 在核心命令支持范围内运行、恢复、重试、选择和审批常规创作步骤；
- 从具体对象创建反馈和版本绑定的 Action，并跟踪验证闭环；
- 评价创作目标、产物质量、实验差异和重要创作决定；
- 完成项目复盘、跨项目指标、经验沉淀和有证据的后续推荐。

Creation Workspace 是核心工作流之上的表现/控制层，不直接调用 Provider，也不
直接修改核心业务文件。写操作必须经 Command Gateway、审批/预算/版本/并发检查
和 Workflow Orchestrator 应用边界；观察 projection 必须可从权威文件和事件重建。

完整需求见
[ai_video_creation_workspace_requirements.md](ai_video_creation_workspace_requirements.md)，
安全边界见 [ADR-0010](adr/ADR-0010-creation-workspace-boundary.md)，核心数据
可观察性基线见
[creation_workspace_data_observability_requirements.md](creation_workspace_data_observability_requirements.md)。
WFM1 数据基线实现路线已由
[ADR-0030](adr/ADR-0030-creation-workspace-delivery-governance.md) 与
[creation-workspace-implementation-roadmap.md](design/done/creation-workspace-implementation-roadmap.md)
规划为 TASK-024～033。它不计入 WFM1/TASK-023 的界面功能验收；TASK-023 只验证
核心 data readiness，TASK-033 只验收 Workspace-on-WFM1 数据基线。完整多媒体
Workspace 由 TASK-039 扩展，两份顶层需求最终由 TASK-040 联合验收。UI、数据库、
Gateway 和领域 schema 仍须对应 Proposed ADR Accepted 后才能实现。

## 6.2 WFM2/WFM3 与最终产品范围

- **WFM2**：完整执行 L0–S7，补齐正式创意/叙事/视听产物、参考图和图片生成、
  正式音频/字幕、后期、QC、发布和复盘；路线为 TASK-008、TASK-034～037，
  合同由 ADR-0037～0039 裁决。
- **WFM3**：在不替代人工创意批准的前提下，提高固定职责自动化率，建立核心
  command capability registry，并按可用候选进行可审计路由；路线为 TASK-012/038，
  TASK-011 仅为可选本地 Provider。
- **最终 Creation Workspace**：TASK-039 消费完整 WFM2/WFM3 source/capability，
  TASK-040 对本产品规格、短剧流程和工作视窗统一需求做最终端到端验收。

逐项归属见
[端到端需求追踪矩阵](design/end-to-end-requirements-traceability.md)，完整 L0–S7
步骤输入输出见
[工作层级输入输出合同](design/workflow-stage-step-io-contract.md)。

## 7. QCD 的基本定义

QCD = Quality（质量）、Cost（成本）、Delivery（交付周期），是本项目度量与优化的核心指标：

- **Quality（质量）**：产出是否可用。以人工主观评分与重做次数为起点，
  后续阶段引入结构化质量检查项。
- **Cost（成本）**：产出的花费。包含人工操作与重做次数、API 调用费用、
  本地算力时间（未来）。
- **Delivery（交付周期）**：从任务生成到镜头/成片完成的耗时。

QCD 的实现分两步：

- **第一阶段（阶段 2–4）只采集最小原始事件**（append-only 事件日志）：
  `task_created`、`task_status_changed`、`manual_attempt_recorded`、
  `asset_imported`、`validation_completed`、`composition_completed`、
  `manual_quality_rating_recorded`（人工评分可在任意时刻记录）；
- **WFM1** 受 ADR-0008 授权新增 `provider_cost_recorded`，以整数原币记录
  云端权威成本；
- **阶段 6** 再基于这些事件实现按 GenerationTask / Shot / Project 三个粒度的
  汇总、指标计算、比较和报告。

QCD 数据用于未来比较不同 Provider 的性价比，并支撑阶段 9 的自动模型路由；
第一阶段不实现复杂分析。

## 8. 成功标准

第一阶段（最小闭环）成功的标准：

1. 给定一份人工编写的故事与镜头数据文件，程序能生成清晰的人工视频制作任务清单；
2. 用户按任务清单将视频放入指定目录后，程序能校验出缺失、命名错误、格式不符的文件并给出明确报告；
3. 校验通过后，一条命令即可用 FFmpeg 按镜头顺序合成出可播放的最终 MP4；
4. 全流程任一步骤中断后可以续跑，不重做已完成的工作，不静默覆盖已有文件；
5. 以上流程在 WSL2 Ubuntu 中、仅用项目 venv 内的依赖即可完成；
6. Claude Code 与 Codex 任一 Agent 仅凭仓库内容即可理解项目现状并继续开发。

WFM1 成功标准：

1. 一个角色、一个场景、一个地点、6–10 个镜头组成约 60 秒单集；
2. 从 project profile 到 L0–S7 最小子集均有可定位产物、JSON 阶段状态和
   人工审批；创意正文可继续使用 Markdown，WFM2 才要求完整执行 L0–S7；
3. 付费前完成单镜头、单集和跨项目月度预算守门，单集计划与实际派生成本
   均不超过 1200 JPY；
4. 云端为默认生产路线但 Provider 可切换，凭据只来自环境变量；
5. 中断后不重复付费、不重复记账、不静默覆盖，并能从首个未完成步骤续做；
6. 输出可播放 MP4、发布包和可重算的 QCD/复盘记录；
7. 至少以两个项目证明项目实例与不可变复用资产版本相分离。

以上标准由 [TASK-018 至 TASK-023](implementation_plan.md#wfm1-任务映射)
分批实现。在 TASK-023 milestone 验收前，不得声称全部 L0–S7 已完成。

WFM2 成功标准：

1. 完整 L0–S7 均有版本化、可审批、可追溯的正式输入与输出；
2. 参考图、生成图片、视频、音频和字幕均进入统一谱系与成本审计边界；
3. 8–12 个镜头形成正式音画作品，无阻断 QC 问题，单集成本不超过 1500 JPY；
4. 完成发布包、项目复盘，并记录模型表现与返工原因；
5. TASK-037 通过独立 milestone review。

WFM3 成功标准：

1. 固定职责可通过批准命令安全组合，失败和恢复不重复执行或付费；
2. 核心明确声明 start/retry/resume/select/approve 以及 pause/cancel/skip 等能力的
   supported/unsupported 语义，Workspace 不自行猜测；
3. 自动路由可审计、可人工覆盖，不替代创意判断和最终批准。

最终产品成功标准：TASK-040 对
[短剧工作流](ai_shortfilm_pipeline_workflow.md) 与
[工作视窗统一需求](ai_video_creation_workspace_requirements.md) 的全部条目给出真实
端到端证据；任何未满足项都必须保持未完成状态，不能以 `unavailable` 或 UI mock
冒充通过。
