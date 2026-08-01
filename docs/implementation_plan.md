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
| 5 | TASK-008 | planned（M2，含产品级未决问题） |
| 6 | TASK-009 | implemented（M2 milestone review pending） |
| 7 | TASK-010 | outline（M3；付费边界已解除，仍待厂商/预算/凭据裁决） |
| 8 | TASK-011 | outline（M3，待用户裁决模型/硬件） |
| 9 | TASK-012 | outline（M3） |

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
| TASK-015 | 配置/审批/预算合同对齐（吸收原型 B1/B2/B3） | 无 | planned（Batch A） |
| TASK-016 | 云端 Provider 接线 + 权威成本事实（吸收 P-C） | 仅 `qcd/events.py` 增第 8 类事件（ADR-0008） | planned（Batch B，前置 TASK-015 + 厂商裁决） |

- 临时命名 B1/B2/B3 的已落盘原型归入 **TASK-015**；临时 P-C 归入
  **TASK-016**。原型代码不删除、不覆盖，由 TASK-015 在其上对齐合同。
- WFM1 相关 ADR：[ADR-0007](adr/ADR-0007-wfm1-document-baseline-and-governance.md)
  （治理基线）、[ADR-0008](adr/ADR-0008-wfm1-authoritative-cost-fact-and-qcd-cost-event.md)
  （成本事实与新增 QCD 事件）。合同细节见
  [TASK-014](tasks/TASK-014-wfm1-contract-consolidation.md)。

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

- 字幕文件（SRT 等）生成与烧录/挂载；
- 配音与音效轨道的管理与混音，接入 FFmpeg 合成流程。

## 阶段 6：QCD 汇总、指标计算与报告

- 消费阶段 2–4 采集的 QCD 原始事件（原始事件采集已随最小闭环实现，
  见 architecture.md §10）；
- 按 GenerationTask / Shot / Project 三个粒度计算质量、成本、交付周期指标；
- 实现汇总、比较与简单报表。

## 阶段 7：第一个云端 API Provider

- 实现首个 CloudVideoProvider（厂商在该阶段选型并记录 ADR）；
- 凭据通过环境变量/本地配置管理，绝不入 Git；
- 上层流程不做任何修改，验证 Provider 抽象的有效性。

## 阶段 8：本地视频模型 Provider

- 实现 LocalVideoProvider，调用本地部署的视频生成模型；
- 处理本地推理的排队、显存/资源约束与失败重试。

## 阶段 9：基于 QCD 的自动模型路由

- 基于阶段 2–4 采集、阶段 6 汇总的 QCD 数据，按质量/成本/时限要求自动为每个
  Shot 选择 Provider；
- 支持人工覆盖路由决策。

## 阶段间纪律

- 不跨阶段实现功能；后续阶段的需求只记录到文档，不提前编码；
- 每个阶段完成的标志：该阶段任务卡全部验收通过（格式化、静态检查、测试全绿）；
- 重大设计变更（接口、目录结构、数据模型）必须先创建 ADR 再实施。
