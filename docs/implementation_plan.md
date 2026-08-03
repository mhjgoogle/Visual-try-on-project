# 实施规划（Implementation Plan）

开发按以下阶段推进。每个阶段拆分为 `docs/tasks/TASK-XXX-*.md` 任务卡执行；
每个任务只有一个实施 Agent，另一个 Agent 作为独立审查者（见 [AGENTS.md](../AGENTS.md)）。

阶段 0–4 构成原 M1 第一阶段最小闭环（不接入付费 API）；M1 已完成并
通过 milestone review。WFM1 是其后的增量路线，见 ADR-0007。

## 批量里程碑模式（batch milestone mode，2026-07-28 起）

自 TASK-005 起，项目切换为批量里程碑模式（用户决策）：

- 剩余任务的规划与设计一次性完成，经**一次整体 Codex 架构审查**
  后连续实施，不再逐 Step 等待外部审查；
- 实施后的独立审查合并到 **milestone 回归门槛**（见
  [remaining-roadmap-design-report](design/remaining-roadmap-design-report.md)）；
- 实施者/审查者分离原则（AGENTS.md 14/15）不变，只改变审查粒度。

## 阶段 → 任务映射（当前）

| 阶段 | 任务卡 | 状态 |
| --- | --- | --- |
| 0 | TASK-001 | completed |
| 1 | TASK-002 | completed |
| 2（Provider 契约） | TASK-003 | completed |
| 2（Orchestrator） | TASK-004 | completed |
| 2（QCD 事件采集） | TASK-007（基础设施在 TASK-005） | completed（M1） |
| 3 | TASK-005 | completed（M1） |
| 4 | TASK-006 + TASK-007（CLI 接线与端到端闭环） | completed（M1） |
| 5 | TASK-008 | Delivered（WFM2，2026-08-04；用户音频/字幕 + AV 混流步骤） |
| 6 | TASK-009 | implemented（ADR-0020/TASK-021 已增补云成本） |
| 7 | TASK-010 | historical/superseded by TASK-016/017 |
| 8 | TASK-011 | outline（可选 WFM3 升级） |
| 9 | TASK-012 | outline（WFM3，由 TASK-038 承接） |

## WFM1 增量里程碑

WFM1 以原 M1 为稳定依赖，工作流需求见
[ai_shortfilm_pipeline_workflow](ai_shortfilm_pipeline_workflow.md)，治理决策见
[ADR-0007](adr/ADR-0007-wfm1-document-baseline-and-governance.md)。

- 原 M1 完成状态和验收记录不重开；
- WFM1 新任务从 `TASK-014` 起，不复用 `TASK-001`–`TASK-013`；
- 继续采用 batch milestone review：任务卡形成整体设计基线后连续实施，
  milestone gate 进行独立审查；
- 创意和生产物的人工审批是运行时工作流节点，不是逐任务开发审批；
- 文档基线（ADR-0007）之后，**TASK-014 一次性锁定**审批绑定、Provider
  选择、catalog 版本锁、预算 reservation、成本事实五个合同（取代
  ADR-0007 推迟这些具体结构的旧表述）；权威成本的唯一冻结变更由
  ADR-0008 授权；
- WFM1 必须保留现有冻结合同，优先复用 M1 的可靠能力。

### WFM1 任务映射

| 任务 | 内容 | 冻结变更 | 状态 |
| --- | --- | --- | --- |
| TASK-014 | 提交前合同收口（docs-only，锁定 5 合同） | 无 | Accepted |
| TASK-015 | 配置/审批/预算合同对齐（吸收原型 B1/B2/B3） | 无 | Implemented；已完成与 TASK-016 的统一审查 |
| TASK-016 | 云端 Provider 接线 + 权威成本事实（吸收 P-C） | 仅 `qcd/events.py` 增第 8 类事件（ADR-0008） | Implemented；资金安全修正已验收 |
| TASK-017 | MiniMax 真实 API + 外部任务恢复 + 安全冒烟 | 无；厂商合同见 ADR-0009 | Completed：六轮独立复审通过（`205a88f`），真实付费冒烟端到端通过（`b231b91`） |
| TASK-018 | 项目实例 profile 与跨项目复用资产引用 | ADR-0011 的新增路径；既有目录合同不变 | Implemented（`706a417`）；milestone review pending |
| TASK-019 | L0/S1-S7 阶段审批、退回与变更失效 | ADR-0012 的新增路径 | Implemented（`7e86578`）；milestone review pending |
| TASK-020 | L0-S3 生产规划、镜头任务包与预算预览 | ADR-0012 的新增路径 | Implemented（`159bcfa`）；milestone review pending |
| TASK-021 | 付费媒体接回 M1 生命周期 + 云成本纳入 QCD 报表 | ADR-0020 授权 QCD 聚合增量 | Implemented（`76a28fc`）；milestone review pending |
| TASK-022 | S4-S7 质检、发布包与归档复盘 | ADR-0012 的新增路径 | Implemented（`f9edd00`）；milestone review pending |
| TASK-023 | WFM1 端到端验收与正式文档收口 | 无 | Implemented；WFM1 milestone review PASSED（2026-08-02） |

- 临时命名 B1/B2/B3 的已落盘原型归入 **TASK-015**；临时 P-C 归入
  **TASK-016**。原型代码不删除、不覆盖，由 TASK-015 在其上对齐合同。
- WFM1 相关 ADR：[ADR-0007](adr/ADR-0007-wfm1-document-baseline-and-governance.md)
  （治理基线）、[ADR-0008](adr/ADR-0008-wfm1-authoritative-cost-fact-and-qcd-cost-event.md)
  （成本事实与新增 QCD 事件）、[ADR-0009](adr/ADR-0009-minimax-vendor-contract.md)
  （首个真实云厂商契约）。合同细节见
  [TASK-014](tasks/TASK-014-wfm1-contract-consolidation.md)。

### WFM1 剩余实施顺序

1. **TASK-017 milestone gate**：已完成——六轮独立复审全部闭合并通过，
   真实付费冒烟（submit → query → retrieve → 下载真实 MP4）端到端验证。
2. **Batch C（TASK-018 + TASK-019）**：已实现项目/复用边界与独立阶段审批，
   等待 WFM1 milestone review 收口。
3. **Batch D（TASK-020 + TASK-021）**：已实现生产任务包、付费媒体接回 M1
   校验/资产/合成及官方 QCD 云成本聚合，等待 WFM1 milestone review 收口。
4. **Batch E（TASK-022 + TASK-023）**：TASK-022/023 实现已完成；下一步是
   TASK-023 的独立 WFM1 milestone review、全量验证与正式状态收口。

### Creation Workspace WFM1 数据基线路线（TASK-024～033）

Creation Workspace 不属于 TASK-018～023 或 WFM1 验收。安全边界见
[ADR-0010](adr/ADR-0010-creation-workspace-boundary.md)，交付治理见
[ADR-0030](adr/ADR-0030-creation-workspace-delivery-governance.md)，完整依赖图见
[creation-workspace-implementation-roadmap.md](design/creation-workspace-implementation-roadmap.md)。

| 任务 | 里程碑 | 内容 | 实现门槛 | 状态 |
| --- | --- | --- | --- | --- |
| [TASK-024](tasks/TASK-024-workspace-query-contract-and-information-architecture.md) | WSM0 | Query contract、信息架构、source gap、ADR-0031 | 可立即 docs-only | Planned |
| [TASK-025](tasks/TASK-025-workspace-projection-and-query-service.md) | WSM1 | 可重建 projection/query service | TASK-024 + ADR-0031；最终验收等 TASK-023 | Planned |
| [TASK-026](tasks/TASK-026-workspace-read-only-shell.md) | WSM1 | 跨项目只读工作视窗 | TASK-025 + ADR-0032 | Planned |
| [TASK-027](tasks/TASK-027-workspace-lineage-comparison-and-cost.md) | WSM1 | 谱系、版本/产物比较、成本深钻 | TASK-020/021/022 + TASK-025/026 | Planned |
| [TASK-028](tasks/TASK-028-workspace-evaluation-experiment-decision.md) | WSM2 | 评价、实验、创作决定 + 只读页面 | ADR-0034 + TASK-018/020/022/026/027 | Delivered（步骤 1–5） |
| [TASK-029](tasks/TASK-029-workspace-feedback-and-action.md) | WSM2 | Feedback/Action + 只读 Action Center | ADR-0035 + TASK-025/026/028 | Delivered |
| [TASK-030](tasks/TASK-030-command-gateway-foundation.md) | WSM2 | Gateway、preflight、确认、幂等回执 | **TASK-023** + ADR-0033 | Delivered |
| [TASK-031](tasks/TASK-031-workspace-controlled-operations.md) | WSM2 | Workspace 受控运行与 Action 写闭环 | TASK-023 + TASK-026/028/029/030 | Delivered |
| [TASK-032](tasks/TASK-032-workspace-learning-and-recommendations.md) | WSM3 | 复盘、跨项目学习、证据化推荐 | ADR-0036 + TASK-022/027～031 | Delivered |
| [TASK-033](tasks/TASK-033-workspace-end-to-end-acceptance.md) | WSM3-B | Workspace-on-WFM1 数据基线、安全与恢复验收 | TASK-023～032 | Accepted（2026-08-03 用户签字） |

TASK-024 可以立即开始。TASK-025/026 可针对已 Accepted 的 WFM1 source contract
增量开发，但 WSM1 最终验收等待 TASK-023。TASK-030/031 的 Gateway 与界面写能力
在 TASK-023 前禁止实施；此前评价、反馈和 Action 只能通过批准的 CLI/app service
写入，Workspace 页面保持只读。

### WFM2 完整作品路线

WFM2 在 WFM1 gate 之后补齐两份顶层需求仍缺少的完整创意、多媒体生成、正式音画、
后期和发布；不重做 M1/WFM1 已可靠能力。
阶段与步骤的统一逻辑输入输出基线见
[L0–S7 工作层级输入输出合同](design/workflow-stage-step-io-contract.md)。

| 任务 | 内容 | 决策门槛 | 状态 |
| --- | --- | --- | --- |
| [TASK-034](tasks/TASK-034-wfm2-full-creative-and-audiovisual-design.md) | 完整 L0–S3 创意/叙事/视听设计产物 | ADR-0037 | Implemented（2026-08-03；验收 TASK-037） |
| [TASK-035](tasks/TASK-035-wfm2-multimedia-generation-and-lineage.md) | 图片/音频等多媒体 Provider、资产、谱系与成本 | ADR-0038 | Implemented（2026-08-04；打桩不花钱；验收 TASK-037） |
| [TASK-008](tasks/TASK-008-subtitles-voice-audio.md) | 字幕、用户音频与合成增量 | ADR-0038/0039 | Delivered（2026-08-04；audio/ 包 + AV 混流步骤 + audiovisual_completed 事件） |
| [TASK-036](tasks/TASK-036-wfm2-formal-postproduction-qc-release.md) | 正式 S4–S7 后期、QC、发布与复盘 | ADR-0039 | Delivered（合同层，2026-08-04；postproduction catalog+index，事实域分离+status 语义） |
| [TASK-037](tasks/TASK-037-wfm2-end-to-end-acceptance.md) | WFM2 端到端 milestone gate | TASK-008/034～036 | Evidence Ready — 等用户签字（2026-08-04；L0→S7 E2E + 矩阵 + runbook + 评审） |

### WFM3 自动化路线

| 任务 | 内容 | 决策门槛 | 状态 |
| --- | --- | --- | --- |
| [TASK-011](tasks/TASK-011-local-video-provider.md) | 本地视频 Provider | 用户模型/硬件裁决 | Optional outline |
| [TASK-012](tasks/TASK-012-qcd-auto-routing.md) | QCD 自动路由 | ADR-0040 + 至少两个候选 | Outline |
| [TASK-038](tasks/TASK-038-wfm3-automation-and-command-capabilities.md) | 自动化职责、能力注册表和安全命令语义 | ADR-0040 | Planned |

### 最终联合验收

| 任务 | 内容 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [TASK-039](tasks/TASK-039-workspace-multimedia-and-full-workflow-expansion.md) | Workspace 扩展到完整多媒体与 WFM2/WFM3 命令能力 | TASK-037/038 + TASK-033 | Planned |
| [TASK-040](tasks/TASK-040-final-unified-product-acceptance.md) | 两份顶层需求的联合端到端验收 | TASK-037～039 | Planned |

逐项需求归属与完成层级以
[端到端需求追踪矩阵](design/end-to-end-requirements-traceability.md) 为准。

注：implementation_plan 阶段 2 原列出的 QCD 原始事件采集
（`task_created`、`task_status_changed`、`manual_attempt_recorded`）
在 TASK-003/004 中被显式排除，现归属：事件日志基础设施 →
TASK-005；三类事件的实际发射点（bootstrap/driver）→ TASK-007。

## 阶段 0：项目规则和架构

- 建立 AGENTS.md、CLAUDE.md、产品规格、架构文档、实施规划、任务卡规范
  （以 TASK-001 的章节结构作为后续任务卡的标准结构，不单设模板文件）；
- 不写任何业务代码。
- 产出：本仓库现有文档；任务卡 [TASK-001](tasks/TASK-001-project-foundation.md)。

## 阶段 1：Python 项目骨架与数据模型

- 创建 venv、`pyproject.toml`、`src/` 包结构、测试框架、格式化与静态检查配置；
- 实现核心数据模型：Project、Character、Scene、Shot、GenerationTask、VideoAsset，
  以及 JSON 结构化文件的读写与校验（确定性输出、反序列化与验证）；
  **只实现 JSON**：YAML 不属于阶段 1，是否支持留到未来有明确使用场景时
  单独决定，不为 YAML 引入依赖；
- 为 Provider 提供其将依赖的基础数据模型与通用标识；
  **本阶段不定义 VideoProvider 接口**（接口在阶段 2 确定）；
- 确定项目数据目录结构并记录 ADR。

## 阶段 2：ManualVideoProvider

- 基于阶段 1 的数据模型确定并定义：`VideoProvider` 精确接口（方法、参数、
  返回类型）、ProviderResult、标准化状态的完整枚举、ManualVideoProvider 与
  Orchestrator 的调用契约（遵循 architecture.md §3 的概念生命周期与职责边界）；
- 实现 ManualVideoProvider：从 Shot 数据生成人工视频制作任务说明的内容
  （提示词、时长、规格、目标位置），只返回结构化结果，不写任何业务状态文件；
- 实现最小 Workflow Orchestrator：分配 staging 路径、调用 Provider，
  并作为唯一写入者落盘任务说明、持久化 GenerationTask 状态；
- 采集 QCD 原始事件：`task_created`、`task_status_changed`、
  `manual_attempt_recorded`。

## 阶段 3：视频文件检查

- 实现视频文件校验器：存在性、命名规范、容器格式、可解码性、时长/分辨率等基本参数
  （基于 ffprobe）；
- 输出人类可读的校验报告；校验结果由编排器写入 VideoAsset；
- 采集 QCD 原始事件：`asset_imported`、`validation_completed`、
  `manual_quality_rating_recorded`（提供人工评分的记录入口，评分可随时补记）。

## 阶段 4：FFmpeg 合成

- 按镜头顺序将校验通过的镜头视频合成为最终 MP4；
- 处理编码参数统一、断点续跑、输出文件版本化与覆盖保护；
- 采集 QCD 原始事件：`composition_completed`。
- **完成本阶段即达成第一阶段最小闭环。**

## 阶段 5：字幕、配音和音频

- 当前归入 WFM2，由 TASK-008 在 ADR-0038/0039 下实施；
- 字幕文件（SRT 等）生成与烧录/挂载；
- 配音与音效轨道的管理与混音，接入 FFmpeg 合成流程。

## 阶段 6：QCD 汇总、指标计算与报告

- 消费阶段 2–4 采集的 QCD 原始事件（原始事件采集已随最小闭环实现，
  见 architecture.md §10）；
- 按 GenerationTask / Shot / Project 三个粒度计算质量、成本、交付周期指标；
- 实现汇总、比较与简单报表。

## 阶段 7：第一个云端 API Provider

- 历史 TASK-010 已由 WFM1 TASK-016/017 与 ADR-0008/0009 实现并取代；
- 其它云 Provider 继续沿用同一可插拔合同接入；
- 凭据通过环境变量/本地配置管理，绝不入 Git；
- 上层流程不做任何修改，验证 Provider 抽象的有效性。

## 阶段 8：本地视频模型 Provider

- 实现 LocalVideoProvider，调用本地部署的视频生成模型；
- 处理本地推理的排队、显存/资源约束与失败重试。

## 阶段 9：基于 QCD 的自动模型路由

- 当前归入 WFM3 ADR-0040/TASK-038，TASK-012 保留为能力规格输入；
- 基于阶段 2–4 采集、阶段 6 汇总的 QCD 数据，按质量/成本/时限要求自动为每个
  Shot 选择 Provider；
- 支持人工覆盖路由决策。

## 阶段间纪律

- 不跨阶段实现功能；后续阶段的需求只记录到文档，不提前编码；
- 每个阶段完成的标志：该阶段任务卡全部验收通过（格式化、静态检查、测试全绿）；
- 重大设计变更（接口、目录结构、数据模型）必须先创建 ADR 再实施。
