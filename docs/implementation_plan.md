# 实施规划（Implementation Plan）

开发按以下阶段推进。每个阶段拆分为 `docs/tasks/TASK-XXX-*.md` 任务卡执行；
每个任务只有一个实施 Agent，另一个 Agent 作为独立审查者（见 [AGENTS.md](../AGENTS.md)）。

阶段 0–4 构成第一阶段最小闭环（不接入付费 API）。

## 阶段 0：项目规则和架构（当前阶段）

- 建立 AGENTS.md、CLAUDE.md、产品规格、架构文档、实施规划、任务卡规范
  （以 TASK-001 的章节结构作为后续任务卡的标准结构，不单设模板文件）；
- 不写任何业务代码。
- 产出：本仓库现有文档；任务卡 [TASK-001](tasks/TASK-001-project-foundation.md)。

## 阶段 1：Python 项目骨架与数据模型

- 创建 venv、`pyproject.toml`、`src/` 包结构、测试框架、格式化与静态检查配置；
- 实现核心数据模型：Project、Character、Scene、Shot、GenerationTask、VideoAsset，
  以及结构化文件（JSON/YAML）的读写与校验；
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
