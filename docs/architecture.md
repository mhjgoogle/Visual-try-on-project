# 架构设计（Architecture）

本文档描述 AI 视频工作流的目标架构。第一阶段只实现其中的最小子集（见 §11）。

## 1. 工作流分层

自上而下分为四层，层与层之间只通过文件产物和明确定义的接口交互：

| 层 | 职责 | 示例 |
|---|---|---|
| **创作层（Story）** | 故事、剧本、场景与镜头拆分 | 结构化剧本文件、分镜数据 |
| **资产层（Asset）** | 人物、场景、道具、图片、视频素材的管理 | 资产登记、素材目录、版本 |
| **生成层（Generation）** | 通过 Provider 生成图片/视频/音频 | VideoProvider、GenerationTask |
| **合成层（Assembly）** | 校验、FFmpeg 合成、质量检查、QCD 记录 | 文件校验器、合成器、QCD 日志 |

原则：

- 上层不感知下层的具体实现（创作层不知道视频是哪家厂商生成的）；
- 每层的每个步骤都可独立执行、独立重跑；
- 步骤之间的传递物是**落盘文件**，不是内存状态。

### WFM1 增量边界

WFM1 在已完成的原 M1 之上增加创意审核、阶段准入、生产规划、预算守门
和跨项目复用资产等工作流层能力。它们通过新增、明确归属的文件产物与
现有四层交互，不替换现有领域模型、Provider、编排、QCD 或恢复合同。

- WFM1 的创意/生产审批状态属于独立工作流语义域，不得复用或改写
  GenerationTask、StepManifest、Provider 或 orchestration 状态；
- 云端视频是 WFM1 默认生产路线，但所有视频生成仍须通过 `VideoProvider`，
  Manual 与未来 Local Provider 的架构地位不变；
- WFM1 继续使用 JSON 作为结构化持久化格式，不引入 YAML；
- ADR-0001 继续定义项目数据根和稳定目录。`workflow/` 仅表示跨项目复用
  资产的逻辑集合，本基线不创建物理目录、不规定迁移；
- 审批、预算、Provider 选择和复用资产的具体 schema 由后续任务或 ADR
  决定，本次不预先设计。

WFM1 的文档定位和治理规则见 ADR-0007。

## 2. 核心概念（领域模型）

第一阶段这些概念以结构化文件表达，阶段 1 才落为 Python 数据模型。
当前基础持久化格式使用 **JSON**；YAML 不属于 TASK-002，未来只有在出现明确
使用场景时才单独评估支持。

- **Project（项目）**：一部短剧/视频的顶层单位。拥有唯一 ID、目录、全局配置。
- **Character（人物）**：角色资产。名称、设定描述、参考图（未来）、在各镜头中的引用。
- **Scene（场景）**：故事中的一个场景。属于 Project，包含有序的 Shot 列表。
- **Shot（镜头）**：最小生成单位。属于 Scene，含镜头序号、描述/提示词、时长、
  引用的 Character/道具、期望规格（分辨率、帧率）。
- **GenerationTask（生成任务）**：针对一个 Shot 的一次生成请求，**只表示当前
  执行任务的业务与运行状态**：task_id、shot_id、provider 标识、输入参数、
  当前状态（pending / in_progress / done / failed）、provider 外部任务引用、
  产物引用、当前错误摘要、必要的编排时间戳，以及（如未来需要）与相关 QCD 事件
  的关联标识。**不嵌入** QCD 原始事件、人工评分历史、重做历史、成本明细历史或
  QCD 汇总指标（见 §10）。同一个 Shot 可以有多次 GenerationTask（重做）。
- **VideoAsset（视频资产）**：一次生成任务的产物文件。含文件路径、校验结果
  （格式、时长、分辨率）、版本号、与 Shot/Task 的关联。

关系：`Project 1—N Scene 1—N Shot 1—N GenerationTask 1—0..1 VideoAsset`；
`Character` 挂在 Project 下，被 Shot 引用。

## 3. VideoProvider 抽象接口

所有视频生成方式必须实现统一的 `VideoProvider` 接口，核心工作流只依赖该接口，
不依赖任何具体厂商。

### 概念生命周期（阶段 0 只定义到此）

`prepare → submit → poll → collect` 是任务的**概念生命周期**，不是固定的
Python 方法签名：

- `prepare`：根据 GenerationTask 准备生成所需的输入（提示词、参数、目标路径）；
- `submit`：发起生成（对手工 Provider 而言是"发布任务给人"）；
- `poll`：查询任务进展；
- `collect`：获取产物并返回产物引用（对媒体的校验、导入与登记由编排器执行）。

各 Provider 按自身能力映射到这一生命周期：例如 ManualVideoProvider 不存在真实的
远程 submit 和 poll（见 §4），CloudVideoProvider 则有真实的远端任务提交与查询。
**不得为了凑齐四个方法而实现无意义的空操作。**

接口的确定阶段：阶段 1 只提供 Provider 将依赖的基础数据模型与通用标识；
**阶段 2 基于阶段 1 的数据模型确定** VideoProvider 的精确接口（方法、参数、
返回类型）、ProviderResult 的精确定义、标准化状态的完整枚举、以及
ManualVideoProvider 与 Orchestrator 的调用契约。阶段 0 文档不写出 Python 方法签名。

### 职责边界（对 Manual、Cloud、Local Provider 一律适用）

Provider 的每一步都**只返回结构化结果**（概念上为 ProviderResult）：标准化状态
（如 `waiting_for_user`、`asset_available`）、产物引用、外部任务 ID、错误信息、
成本与耗时观测值。

**Provider 不得写入或修改以下业务状态文件**：

- GenerationTask 持久化文件；
- VideoAsset 登记文件；
- step manifest；
- 人工任务说明；
- QCD 事件日志；
- 项目正式资产索引；
- 其他业务状态文件。

**Provider 对媒体文件的写入边界**：

- Provider 可以按自身能力返回外部 URL、临时产物引用或现有本地文件路径，
  或将媒体生成/下载到由 Workflow Orchestrator 明确提供的 staging 路径；
- Provider 不得自行选择正式项目资产路径，不得自行覆盖既有媒体，不得自行执行
  正式资产版本管理，不得自行将 staging 文件登记为 VideoAsset；
- staging 目录的具体名称与最终目录结构不在阶段 0 确定（随阶段 1 的目录结构
  ADR 一并确定，见 §7）。

**Workflow Orchestrator（工作流编排器）负责**：

Workflow Orchestrator 是**应用层角色**，由一组步骤组件构成（任务
bootstrap 与 driver、ProviderOrchestrator、校验步骤、合成步骤）。
每类业务文件仍各有唯一写入组件，职责分配不变：

- 分配 staging 路径（bootstrap，TASK-007）；
- 应用覆盖与版本策略（见 §9）；
- 校验 Provider 返回的媒体（校验步骤，TASK-005）；
- 将通过校验的媒体导入/移动到正式资产目录（校验步骤，TASK-005）；
- 持久化 GenerationTask：**创建**由任务 bootstrap 负责
  （TASK-007），创建后的全部**状态更新**由 ProviderOrchestrator
  的内部 executor 负责（TASK-004）——同一文件在生命周期的不同
  阶段各有唯一写入组件，二者不重叠；generation StepManifest 同理
  （bootstrap 创建，编排器更新）；
- 登记 VideoAsset（校验步骤为唯一写入者，TASK-005）；
- 写入各步骤 manifest 与 QCD 原始事件（各步骤组件写自己的
  manifest；QCD 事件按 ADR-0003 的 per-type writer 归属）。

其他约束：

- Provider 的凭据（API key 等）一律来自环境变量/本地配置，永不入库、永不进 Git。

## 4. ManualVideoProvider（第一阶段）

第一阶段唯一的 Provider，把"人"当作生成后端。它**不存在真实的远程 submit 和
poll**，按自身能力映射到概念生命周期。

**Provider 不扫描目录**：Provider（含 ManualVideoProvider 的全部方法）不扫描
项目目录或 staging，不通过 `exists`、`glob`、`rglob`、`walk` 等方式发现用户
产物；用户产物文件是否已经产生，由未来 Workflow Orchestrator 或调用方负责
确认，并通过显式输入把产物引用交给 Provider。

- 发布任务：为每个 Shot 生成一份**人工制作任务说明**（Markdown/JSON）的内容，
  包括提示词、时长、规格要求、以及**必须放置产物的目标位置与文件名**
  （由编排器分配的 staging 位置）；任务说明内容作为结构化结果返回，
  由编排器落盘，并返回 `waiting_for_user` 状态；
- 用户在网页视频工具中手工生成视频，并按任务说明把文件放入指定的
  staging 位置；
- 检查进展（poll）：只能根据调用方已经显式提供的信息报告当前状态，
  不检测文件系统、不访问网页、不伪造进度；文件是否出现由编排器或调用方
  确认后以显式输入告知 Provider；
- 收集产物（collect）：只接收调用方显式传入的产物引用，并将其作为结构化
  结果返回——由编排器对文件做校验（存在、命名、容器格式、可解码、基本
  参数），通过后将媒体导入正式资产目录、登记 VideoAsset、将任务置为 done；
  校验不通过时由编排器标记任务失败并输出明确的错误报告。

Provider 在整个生命周期中不修改 GenerationTask、不创建或登记 VideoAsset、
不执行媒体校验（见 §3 职责边界）。

## 5. 未来 Provider 的扩展方式

- **CloudVideoProvider（阶段 7）**：对接云端视频生成 API。实现同一接口，
  `submit` 调 API、`poll` 查询远端任务；收集产物时可以使用自身鉴权将产物下载到
  编排器指定的 staging 路径，或返回可访问的临时产物引用（由编排器完成下载）。
  后续的校验、导入正式资产目录、登记 VideoAsset 与手工流程完全相同，
  上层流程零改动。
- **LocalVideoProvider（阶段 8）**：调用本地部署的视频模型。同接口，
  `submit` 触发本地推理进程/队列；媒体**只能输出到编排器指定的 staging 路径**。
- Provider 通过配置选择（Project 或 Shot 级别指定 provider 名称），
  阶段 9 引入基于 QCD 数据的自动路由（按质量/成本/时限自动选 Provider）。

## 6. 中间产物的保存

- 一切中间产物（剧本、分镜数据、任务说明、视频、校验报告、合成结果、QCD 记录）
  都以**文件**形式保存在项目目录内，人类可读优先（JSON、Markdown、媒体文件等
  可检查的中间产物）；
- 状态即文件：流程状态从落盘文件推导，不依赖内存或外部数据库；
- 生成的视频文件不进 Git（通过 .gitignore 排除），结构化元数据进 Git。

## 7. 文件目录原则

具体目录结构在阶段 1 由实施任务确定并写入 ADR，原则如下：

- 代码与数据分离：Python 包在 `src/` 下，各视频项目的数据在独立的数据目录下
  （如 `projects/<project-id>/`）；
- 数据目录按领域分区：如 `story/`（剧本与分镜）、`assets/`（人物/场景/道具）、
  `tasks/`（生成任务与人工任务说明）、`renders/shots/`（镜头视频）、
  `renders/final/`（合成成片）、`qcd/`（度量记录）；
- 镜头文件命名可排序且可追溯：包含 scene、shot 序号与版本号
  （如 `s01_sh003_v2.mp4`）；
- 所有路径为相对项目根的 POSIX 路径。

## 8. 断点续跑机制

- 每个可恢复步骤在执行时落盘一份**最小 manifest**（状态文件），至少包含：
  `step_name`、`input_digest`、`relevant_config_digest`、`output_paths`、
  `output_metadata`、`status`、`created_at`、`completed_at`、`error_summary`、
  `schema_version`；
- 只有当以下条件**全部满足**时才允许跳过该步骤：
  1. 当前输入的摘要与 manifest 中的 `input_digest` 一致；
  2. 相关配置的摘要与 `relevant_config_digest` 一致；
  3. `status` 为 completed；
  4. `output_paths` 中的输出文件全部存在；
  5. 输出校验通过；
- 输出校验是 **step-specific** 的：视频文件用 ffprobe 等方式校验；JSON 等
  结构化文件用 schema 校验；其他步骤由对应步骤自行定义最低有效性检查；
- 任一条件不满足时**不复用旧结果**：产生版本号递增的新输出，或要求用户显式处理
  （见 §9 文件覆盖保护），不得静默覆盖；
- GenerationTask 状态持久化在文件中，流程重启后从文件恢复，从第一个未完成任务继续；
- 步骤必须幂等：同样的输入重复执行得到同样的结果，不产生副作用累积；
- 失败的步骤标记为 failed 并在 manifest 中保留现场（输入摘要、`error_summary`），
  可单独重跑；
- 阶段 0 只定义以上原则和必要字段。各项内容的确定边界：
  - 阶段 1 确定 manifest 的数据结构、字段语义和基础持久化格式
    （TASK-002 不实现摘要计算）；
  - `input_digest` 和 `relevant_config_digest` 的具体计算算法，由阶段 2 或
    首个实际使用该摘要的工作流步骤确定；
  - 不引入统一缓存框架或复杂版本管理机制。

## 9. 文件覆盖保护

- 任何写入操作前检查目标文件是否存在；
- 已存在时的默认行为是**拒绝并报告**，绝不静默覆盖；
- 需要重做时使用版本号递增的新文件名（v1 → v2），旧版本保留；
- 显式的 `--force` 类选项必须由用户明确传入才允许覆盖，且覆盖行为要写入日志。
  **M1 范围决定（owner：TASK-007 CLI）**：M1 **不提供** `--force`
  覆盖既有 durable 输出的选项；冲突时一律返回类型化错误，或按
  合同生成版本递增的新路径。`--force` 记录为未实施的后续范围，
  未来引入时由 CLI 所在任务实现并补日志要求。

## 10. QCD 数据记录边界

QCD 数据分两层：**原始事件采集**（阶段 2–4，随第一阶段最小闭环实现）与
**汇总、指标计算、比较和报告**（阶段 6 实现）。

- 原始事件以 append-only 事件日志形式追加写入，第一阶段至少包含以下事件类型：
  - `task_created`（生成任务创建）；
  - `task_status_changed`（任务状态变更）；
  - `manual_attempt_recorded`（一次人工制作尝试）；
  - `asset_imported`（视频文件放入指定目录并被登记）；
  - `validation_completed`（文件校验完成，含结果）；
  - `composition_completed`（FFmpeg 合成完成）；
  - `manual_quality_rating_recorded`（人工质量评分——可在任意时刻记录，
    不要求绑定任务状态变更）；
- 每条事件携带能归属到 GenerationTask / Shot / Project 的标识；按这三个粒度的
  汇总（含重做汇总、整体汇总）由阶段 6 的计算实现；
- **append-only QCD 事件日志是原始 QCD 事实的唯一来源**：GenerationTask 等
  业务状态文件不嵌入 QCD 原始事件、评分历史、重做历史或成本明细（见 §2）；
  GenerationTask 中为当前编排所需的状态与时间戳不视为 QCD 的正式事实来源；
- 阶段 6 的汇总结果是**派生数据**，必须可以由事件日志重新计算；未来如为查询
  性能增加派生字段，必须明确标注为缓存/快照，不得成为第二事实来源；
- QCD 模块**只读**业务数据，不反向修改工作流状态；
- 第一阶段不实现复杂分析和自动模型路由；QCD 数据是阶段 9 自动路由的输入，
  在此之前仅用于人工分析。

## 11. 第一阶段暂不实现的功能

- LLM 驱动的故事/剧本/分镜生成（创作层为人工编写的结构化文件）；
- 图片生成、配音、音效、字幕；
- CloudVideoProvider、LocalVideoProvider、自动模型路由；
- 自动质量检查（仅实现文件级校验）；
- Web UI、数据库、Docker、云端部署；
- 资产（人物/场景/道具）的完整管理功能（第一阶段只需 Shot 数据中能引用到即可）。

以上是原 M1 的范围边界，不是对 WFM1 的禁止。WFM1 只能在保留已接受
M1 合同的前提下增量补充这些能力，并遵循 ADR-0007 与后续批准任务卡。
