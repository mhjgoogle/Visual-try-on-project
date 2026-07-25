# TASK-003：VideoProvider 契约与 ManualVideoProvider（Video Provider Contract and Manual Provider）

## 背景

TASK-002 已完成并通过独立审查（当前分支 `feat/task-003-video-provider` 自其
完成提交创建），仓库已具备：

- 六个核心数据模型（Project、Character、Scene、Shot、GenerationTask、
  VideoAsset）与 `GenerationTaskStatus`；
- StepManifest 与 `ManifestStatus`；
- 确定性 JSON 序列化与原子持久化（`serialization.py`、`persistence.py`）；
- 项目级引用验证入口（`project_data.py`）；
- 项目基础异常体系（`errors.py`，根为 `AiVideoWorkflowError`）；
- ADR-0001 项目数据目录契约（含 `staging/` 与 `assets/media/` 的分离）。

项目进入实施规划的阶段 2。本任务只覆盖阶段 2 的 **Provider 契约部分**：
正式确定 `VideoProvider` 抽象接口、Provider 请求与结果数据结构、Provider
标准化状态与错误体系，并实现第一个不依赖外部 API 的 `ManualVideoProvider`。
阶段 2 中 implementation_plan.md 提到的最小 Workflow Orchestrator 与 QCD
原始事件采集（`task_created`、`task_status_changed`、
`manual_attempt_recorded`）**不属于本任务**，由后续任务卡承接。

**architecture.md §4 已同步**：architecture.md §4 中"检查指定位置下文件是否
出现"的旧边界已在 TASK-003 编码前完成最小同步修订。**"Provider 不扫描目录"
已成为当前正式架构基线**（详见"设计决定 D1"）：Provider 不扫描项目目录或
staging，不通过 `exists`、`glob`、`rglob`、`walk` 等方式发现用户产物；文件
是否已产生由未来 Orchestrator 或调用方确认，并通过显式输入把产物引用交给
Provider。该修订只同步职责边界，未实现 Orchestrator，未扩大阶段范围。

Codex 第一轮预实施审查结论为**有条件通过**，其审查问题已按用户裁决落实
（正式设计文档门槛、ArtifactReference 两维语义、七状态矩阵、异常与 FAILED
结果分工、Provider 参数不可变与 JSON-compatible 约束、四阶段文件系统禁令
测试）。Codex 第二轮窄范围复审提出的唯一剩余问题——`observed_at` 与
`completed_at` 的语义和时序关系——已在本次修订中补充（见"ProviderResult
要求"的时间字段语义）。本任务规格仍需最终窄范围复审通过后才能提交为
规格基线。

本任务工作分支：`feat/task-003-video-provider`。

## 单一目标

定义稳定、可测试的 VideoProvider 抽象契约，并实现第一种不依赖外部 API 的
ManualVideoProvider，使用户可以获得明确的视频生成操作说明，并将用户人工
生成的视频引用作为 Provider 结果返回，为后续 Workflow Orchestrator 接入
提供稳定边界。

## 编码门槛

以下门槛必须**按顺序全部满足**后才能开始编码；在此之前本任务保持
planned，不得先编码后补设计文档：

1. architecture.md §4 完成同步修订（已完成）；
2. TASK-003 任务规格通过审查（第一轮有条件通过、第二轮复审问题已在本版
   补充，仍需最终窄范围复审通过）；
3. 创建正式设计文档 `docs/design/TASK-003-provider-contract-design.md`
   （内容要求见"预实施设计文档要求"；本轮不创建）；
4. 该设计文档通过 Codex 预实施审查；
5. 以上全部完成后方可开始编码。

## 范围内

1. `VideoProvider` 抽象接口（精确方法、参数、返回类型及类型契约文档）；
2. Provider 请求数据结构（ProviderRequest，最终命名由设计文档确定）；
3. Provider 结果数据结构（ProviderResult）;
4. Provider 标准化状态（独立 ProviderStatus 类型，七状态集合已固定，
   见"Provider 状态要求"）；
5. Provider 错误体系（继承 `AiVideoWorkflowError` 的 ProviderError 子树）;
6. `ManualVideoProvider` 实现；
7. Manual Provider 的人工生成操作说明数据（结构化返回值，不落盘）；
8. Manual Provider "等待用户在外部工具中生成视频"的状态表达；
9. 用户产物引用的收集行为（只接受调用方显式传入的引用）；
10. 编码前的正式设计文档
    `docs/design/TASK-003-provider-contract-design.md`（编码门槛第 3 项，
    本轮不创建）；
11. Provider 接口与 Manual Provider 的单元测试；
12. Provider 与 GenerationTask、VideoAsset、未来 Orchestrator 的职责边界
    文档（写入设计文档与代码模块 docstring）；
13. 对现有模型保持兼容：不修改 TASK-002 已批准的数据事实来源边界，
    不修改六个核心模型与 StepManifest 的字段和序列化契约。

## 范围外

- Workflow Orchestrator 完整或最小实现；
- GenerationTask 状态写入或修改；
- VideoAsset 创建、登记或持久化；
- StepManifest 写入；
- QCD 事件写入；
- 视频文件内容验证；
- ffprobe；
- FFmpeg；
- 云端视频 API；
- 本地视频生成模型；
- 浏览器自动化；
- 自动登录网页；
- 自动上传或下载；
- 自动目录扫描（包括 staging 目录的文件发现）；
- 正式资产移动；
- 正式资产覆盖和版本管理；
- digest 计算；
- 缓存命中；
- 自动断点续跑；
- 数据库；
- Web UI；
- Docker；
- YAML；
- 网络认证、限流、重试与云 API 错误体系；
- 取消传播策略、timeout 与取消操作 API；
- architecture.md 的进一步修订（§4 最小同步修订已完成，超出该范围的
  架构文档变更不属于本任务）。

## 输入

- 基线文档：AGENTS.md、docs/product_spec.md、docs/architecture.md
  （含已同步的 §4）、docs/implementation_plan.md、docs/adr/ADR-0001；
- TASK-002 交付的 `src/ai_video_workflow/` 全部模块与测试；
- Codex 预实施审查结论（有条件通过）与用户裁决；
- 本任务卡。

## 输出

- `docs/design/TASK-003-provider-contract-design.md`（编码前交付，
  本轮不创建）；
- `src/ai_video_workflow/` 下新增的 Provider 契约模块与
  ManualVideoProvider 实现（最终文件结构由设计文档确定）；
- Provider 接口、请求、结果、状态与错误的单元测试；
- 实施说明（设计理由以设计文档为正式记录；PR 描述可补充，但不得成为
  唯一正式设计记录）。

## 设计决定

以下决定已由用户裁决，实施与审查阶段不得推翻；如实施中发现无法满足，
必须先回到用户重新决策，不得临时变通。

### D1：Provider 不扫描目录（已成为架构基线）

- Provider（含 ManualVideoProvider 的全部方法）不扫描 staging 目录或
  项目目录；
- Provider 不调用 `Path.exists`、`os.path.exists`、`glob`、`rglob`、
  `os.walk` 或任何等价方式发现用户产物；
- 用户产物是否已经产生，只能由调用方通过显式输入告知 Provider；
- `collect` 只接受调用方显式传入的产物引用；
- 文件发现和未来任务状态更新属于 Orchestrator 或其调用方职责。

architecture.md §4 已在编码前完成同步修订，本决定是当前正式架构基线，
不再是"待修订事项"。

### D2：单次操作观测值

ProviderResult 允许表达**单次当前 Provider 操作**的可选观测值：

- `observed_at`（必要时间信息，带时区 UTC）；
- 可选 `elapsed_seconds`（本次操作耗时观测，必须是有限非负值）；
- 可选当前操作成本观测。

边界：这是单次当前观测，不是成本历史；ManualVideoProvider 可以不提供
成本观测；不保存累计成本、重试成本、账单历史；不写 QCD；货币、计费与
详细成本模型留给 Cloud Provider 任务。字段设计必须保证未来可扩展，且不
与 architecture.md §3 "成本与耗时观测值"冲突；不得现在固定复杂的货币
数据结构。

### D3：取消是独立状态

- waiting_for_user 不等于 failed；
- cancelled 不等于 failed；
- 用户取消不得通过 error_summary 假装成 Provider 失败；
- timeout、取消操作 API 和取消传播策略留给后续任务。

### D4：ArtifactReference 两维语义模型

产物引用固定为**一个规范化 ArtifactReference 结构**，且 ProviderResult
**最多保存一个**规范化 artifact 引用，不同时保存多个可能表示同一产物的
引用字段。来源和位置是不同概念，不得压成同一维度的互斥值：

- `reference`：一个非空、原样保存的稳定字符串（不得为空或只有空白）；
- `origin`：产物**来源**维度，语义至少包括：
  - `user`（用户人工产生）；
  - `provider`（Provider 自动产生）；
- `location`：产物**位置或引用机制**维度，语义至少包括：
  - `external`（外部系统或外部工具中的引用）；
  - `staging`（调用方分配的 staging 位置）。

由此可明确表达：

| 场景 | origin | location |
| --- | --- | --- |
| 用户在外部工具中生成的产物 | user | external |
| 用户放入调用方分配 staging 的产物 | user | staging |
| 未来 Cloud Provider 的远端引用 | provider | external |
| 未来 Local Provider 写入 staging | provider | staging |

要求：

- 同一产物不得在多个字段中产生不一致的重复事实；
- `reference` 原样保存：不静默 `strip`、`resolve`、`expanduser` 或任何
  规范化；
- Provider 不调用 `exists`、`open` 或媒体探测；
- Provider 不把引用转换为正式 VideoAsset；
- Provider 不决定正式资产 ID、路径、版本或登记结果。

精确类名和 Enum 名称由设计文档确定，但以上两维语义是任务规格要求。

### D5：异常与 FAILED 结果的分工

见"错误处理"一节的规范性分工；等待用户和取消是正常状态，不是假失败，
不得通过异常表示。

### D6：Provider 参数 JSON-compatible 且不可变

见"Provider 请求要求"一节的规范性约束。

## 预实施设计文档要求

编码前必须创建 `docs/design/TASK-003-provider-contract-design.md` 并通过
Codex 预实施审查（编码门槛第 3、4 项）。持久性设计决定必须记录在该仓库
文档中，**不得只依靠 PR 描述保存**。设计文档必须记录：

- ABC 或 Protocol 的最终选择和理由；
- 精确模块结构；
- `prepare`、`submit`、`poll`、`collect` 的精确 Python 签名；
- 每个方法的输入和返回类型；
- Provider 身份标识方式；
- ProviderRequest 的全部字段；
- ProviderResult 的全部字段；
- ManualInstruction 等人工说明结构；
- ArtifactReference 的正式结构（遵循 D4 两维语义）；
- ProviderStatus 的完整集合（遵循"Provider 状态要求"的七状态）；
- 状态与结果不变量矩阵（遵循本任务卡的规范性矩阵）；
- `observed_at` 和 `completed_at` 的精确字段类型与两者的语义；
- 终态和非终态下 `completed_at` 的存在规则；
- `completed_at <= observed_at` 的验证方式；
- 时间由哪个方法或调用方提供；`prepare`、`submit`、`poll`、`collect`
  各自如何确定 `observed_at`；
- succeeded、failed、cancelled 如何获得 `completed_at`；
- 对 naive datetime、非 UTC datetime 和逆序时间的错误处理，及对应的
  单元测试计划；
- 异常与 FAILED 结果的分工（遵循 D5 与"错误处理"）；
- Provider 参数的不可变策略（遵循 D6 最低要求）；
- dict 转换或序列化边界（遵循"持久化边界"）；
- ManualVideoProvider 四阶段的具体行为；
- 测试文件和测试覆盖计划。

设计文档通过审查前，本任务保持 planned，不得开始编码。

## Provider 职责

Provider 负责：

- 接收调用方提供的生成请求；
- 准备 Provider 所需的指令或参数；
- 提交或表达等待人工操作的状态；
- 查询当前 Provider 状态（只基于调用方已显式提供的信息，见 D1）；
- 返回外部产物引用、用户提供的文件引用或 staging 引用
  （以 D4 的 ArtifactReference 表达）；
- 返回明确错误信息。

Provider 不负责：

- 修改 GenerationTask；
- 创建或更新正式 VideoAsset；
- 写入 StepManifest；
- 写入 QCD 事件；
- 选择正式资产最终路径；
- 正式登记资产；
- 决定覆盖或版本策略；
- 执行媒体内容校验；
- 执行工作流调度；
- 发现文件或扫描目录（见 D1）。

## Orchestrator 职责边界

未来 Workflow Orchestrator（本任务不实现）是以下内容的**唯一写入者**：

- GenerationTask 当前业务状态；
- VideoAsset 正式记录；
- manifests；
- 用户任务说明文件；
- QCD 原始事件；
- 正式资产路径和登记结果。

Provider 与 Orchestrator 的唯一通道是：接收 Provider 请求（含调用方
分配的 staging 引用等输入）→ 返回 ProviderResult。必须明确区分：

- **Provider 返回的产物引用**（ArtifactReference）：未经校验、未登记的
  外部引用、用户提供的文件引用或 staging 引用；
- **Orchestrator 后续登记的正式 VideoAsset**：经校验并正式登记后由
  Orchestrator 创建的记录，Provider 永不产生。

## VideoProvider 接口要求

- 语义生命周期固定为 `prepare → submit → poll → collect`
  （architecture.md §3 的概念生命周期）；
- 精确 Python 签名不在本任务卡写死，由**设计文档**在编码前给出并说明
  理由，经 Codex 预实施审查确认；
- 推荐方向为标准库 `abc.ABC` 抽象基类；设计文档须记录选择 ABC、Protocol
  或其他轻量方式的最终理由（不引入重量级框架）；
- 以下内容**不得**提前视为无需审查的固定设计：每个方法都必须接收完全
  相同的请求对象；每个方法都必须返回完全相同形态的结果；`collect`
  的具体参数形式；
- 如最终保留四个方法，每个方法必须具有真实职责，不得为了满足接口而
  实现无意义空操作（architecture.md §3）；
- 接口必须能覆盖 Manual、未来 Cloud 与未来 Local Provider；
- Provider 不得修改传入的请求或模型对象；
- Provider 不得返回正式 VideoAsset；
- Provider 不得依赖具体 Orchestrator 实现；
- 所有 I/O 路径或引用由调用方明确提供；
- Provider 不自动发现项目目录（见 D1）；
- 接口设计基于现有 GenerationTask、Shot 和 VideoAsset 的既有边界，
  不修改这些模型。

## Provider 请求要求

请求结构至少应能表达：

- provider 标识；
- task_id；
- shot_id；
- 生成提示或生成参数；
- 调用方分配的 staging 位置或相关引用；
- 可选的 Provider 特定参数；
- 必要的关联上下文。

通用要求：

- 使用稳定、可序列化的数据（对齐现有 frozen dataclass 风格）；
- 不嵌入完整 ProjectData 或完整关联模型对象；
- 不包含凭据；
- 不包含正式 VideoAsset；
- 不保存 QCD 历史；
- Provider 不得修改请求对象。

### Provider 特定参数的 JSON-compatible 约束（D6）

Provider 特定参数必须：

- 顶层是字符串键 mapping；
- 值递归只允许：`None`、`bool`、`int`、有限 `float`、`str`、list、
  字符串键 mapping；
- 禁止：NaN、Infinity、`Path`、`datetime`、`Enum`、`bytes`、`set`、
  `tuple`（作为参数值）、任意自定义对象、非字符串 key、循环结构。

（可复用现有 `validate_json_compatible` 的验证边界。）

### 不可变策略最低要求（D6）

不可变策略的具体实现由设计文档确定，但以下为任务规格固定的最低要求：

- 构造时对调用方输入做递归防御性复制；
- 内部不能继续引用调用方可变 dict/list；
- 对外不得暴露可修改内部状态的原始 dict/list；
- 可以使用标准库只读 mapping、tuple 化或等价轻量策略；
- 不引入重量级不可变数据框架；
- Provider 不得修改原始输入；
- 测试必须验证：嵌套输入在构造后被调用方修改时，ProviderRequest 内部值
  不发生变化。

## ProviderResult 要求

ProviderResult 至少应能表达：

- provider 标识；
- 标准化状态（见"Provider 状态要求"）；
- 外部任务引用 `external_task_ref`（如适用）；
- 产物引用 `artifact`（最多一个规范化 ArtifactReference，见 D4）；
- 面向用户或 Orchestrator 的消息；
- 当前错误摘要；
- 单次当前观测：`observed_at`、可选 `elapsed_seconds`、可选当前操作
  成本观测（见 D2）；
- 终态完成时间 `completed_at`（语义见"时间字段语义"）；
- 是否还需要用户操作（由状态派生，不作为独立持久字段，见"Provider
  状态要求"）。

**external_task_ref 与 artifact 是不同概念，两者不得互相替代**：

- `external_task_ref`：外部系统中的**任务**标识；
- `artifact`：生成**产物**引用。

### 时间字段语义（observed_at 与 completed_at）

`observed_at`：

- ProviderResult 必须具有 `observed_at`；
- 表示该结果快照被 Provider 观察或形成的时间；
- 必须是带时区 UTC，不得使用 naive datetime；
- 所有状态都必须存在。

`completed_at`：

- 表示底层 Provider 任务进入终态的时间；
- 必须是带时区 UTC，不得使用 naive datetime；
- 仅以下终态必须存在：succeeded、failed、cancelled；
- 以下非终态必须禁止：not_submitted、waiting_for_user、processing、
  artifact_available。

时序关系：

- 终态结果必须满足 `completed_at <= observed_at`；
- `completed_at` 不得晚于生成该 ProviderResult 快照的 `observed_at`；
- 不得为了满足不变量而静默把 `completed_at` 改成 `observed_at`；
- 不得从文件时间、当前目录内容或媒体元数据推断 `completed_at`
  （见 D1 文件系统禁令）；
- 时间值由 Provider 当前已知信息或调用方显式输入提供；Provider 不静默
  修正调用方提供的时间。

ProviderResult 不得包含：

- 正式 VideoAsset 对象；
- 正式资产 ID；
- QCD 历史；
- 成本历史（单次当前观测除外，见 D2）；
- 重做历史；
- 工作流状态迁移历史；
- Orchestrator 持久化结果。

## Provider 状态要求

本任务使用以下**七个**独立状态语义，状态集合已固定，实施时不得随意合并
或增删；未来如需改变状态模型，必须通过后续设计变更流程，不得实施时临时
决定：

- `not_submitted`（尚未开始或尚未提交）；
- `waiting_for_user`（等待用户操作）；
- `processing`（Provider 正在处理）；
- `artifact_available`（产物引用已知，可进入 collect）；
- `succeeded`（collect 已完成，ProviderResult 已包含调用方可处理的
  产物引用）；
- `failed`（失败）；
- `cancelled`（已取消，不是 Provider 失败）。

要求：

- 必须是独立 ProviderStatus 类型，不复用 `GenerationTaskStatus` 或
  `ManifestStatus`，三个类型的语义域互不混用；
- 必须支持稳定 JSON 序列化；
- `requires_user_action` **不作为独立持久字段保存**，由状态派生：
  - `waiting_for_user` → True；
  - 其他所有状态 → False；
- `artifact_available` 与 `succeeded` 的区分固定为：前者表示 Provider
  已知产物引用可供 collect；后者表示 collect 已完成并返回调用方可处理
  的引用。

### 规范性状态矩阵

| 状态 | artifact | error_summary | completed_at | terminal |
| --- | --- | --- | --- | --- |
| not_submitted | 禁止 | 禁止 | 禁止 | 否 |
| waiting_for_user | 禁止 | 禁止 | 禁止 | 否 |
| processing | 禁止 | 禁止 | 禁止 | 否 |
| artifact_available | 必须存在 | 禁止 | 禁止 | 否 |
| succeeded | 必须存在 | 禁止 | 必须存在 | 是 |
| failed | 禁止 | 必须是非空字符串 | 必须存在 | 是 |
| cancelled | 禁止 | 禁止 | 必须存在 | 是 |

补充不变量：

- `requires_user_action` 派生规则：仅 waiting_for_user 为 True；
- 所有时间字段必须是带时区 UTC（复用现有 `validate_utc_datetime`）；
- 所有状态：`observed_at` 必须存在；
- succeeded、failed、cancelled：`completed_at` 必须存在且
  `completed_at <= observed_at`；
- not_submitted、waiting_for_user、processing、artifact_available：
  `completed_at` 必须为 None；
- ProviderResult 的 provider 标识必须和实际 Provider 一致；
- 用户产物引用不得被静默修正、移动或转成正式资产；
- artifact 满足 D4（最多一个规范化引用，reference 非空且原样保存）；
- 取消不得借用 error_summary 表达（见 D3）。

## ManualVideoProvider 行为

ManualVideoProvider 的目标：

- 不调用任何视频生成 API；
- 不启动浏览器，不自动操作网页；
- 为用户生成明确的人工操作说明数据；
- 表达"等待用户在外部工具中生成视频"的状态；
- 接收调用方明确提供的用户产物引用；
- 返回可供未来 Orchestrator 处理的 ProviderResult。

各阶段要求：

1. **prepare** 可以返回：提示词、建议参数、用户操作步骤、预期输出要求、
   调用方提供的 staging 位置。说明数据是结构化返回值，**Provider 不写
   用户说明文件**——未来 Orchestrator 可以把说明数据写成任务说明文件，
   本任务不实现该写入行为。
2. **submit** 不得假装调用真实 API；只表达"任务已发布给人、等待用户
   操作"。
3. **poll** 不得扫描目录或访问网页（见 D1）；只能根据调用方已经显式
   提供的信息报告当前状态，不得伪造进度。
4. **collect**：
   - 只接收调用方明确提供的文件或产物引用；
   - 不执行 ffprobe 或媒体内容校验；
   - 不创建 VideoAsset；
   - 不移动到正式 `assets/media/`；
   - 不决定版本号；
   - 不覆盖正式资产；
   - 可以进行最低限度的数据类型或引用格式验证（如 D4 的非空约束），
     但不得将其描述为媒体校验。

四个阶段全部适用 D1 的文件系统禁令（不仅 poll 和 collect，
见"测试要求"）。

## 错误处理

定义 ProviderError 子树，继承现有 `AiVideoWorkflowError`（如不继承，
必须明确说明理由并通过预实施审查）。至少可通过类型区分：

1. 不支持或无效请求；
2. Provider 状态组合无效；
3. 缺少显式人工产物引用；
4. Provider 实际操作失败。

### 异常与 FAILED 结果的规范性分工（D5）

**返回 `ProviderResult(status=failed)`，当且仅当**：

- Provider 已正常完成一次状态查询或操作；
- 并确认底层生成任务已经以失败终态结束；
- `error_summary` 表达该任务失败的当前摘要。

**抛出类型化异常，用于**：

- 请求结构无效；
- 不支持的请求；
- 方法调用所处 Provider 状态无效；
- collect 缺少显式产物引用；
- 调用本身无法形成一个合法 ProviderResult；
- Provider 实现发生非任务终态性质的操作错误。

**ProviderOperationError 只用于**：方法执行本身失败，因而无法可靠返回
合法 ProviderResult。

**以下情况不得使用异常**（属正常可表达状态，通过 ProviderStatus 表达）：

- waiting_for_user；
- processing；
- artifact_available；
- cancelled；
- 已确认的 Provider 任务终态失败（用 status=failed 的结果表达）。

其他要求：

- 错误不暴露凭据或敏感参数；
- 不把用户取消、等待操作和真正失败混为一谈；
- 网络错误、API 限流、认证错误的完整体系不在本任务实现，留给
  Cloud Provider 任务。

## 持久化边界

- Provider 请求和结果**不要求**直接写入 JSON 文件；
- 可以：使数据结构具备稳定、可序列化字段；提供基本 dict 转换或测试其
  JSON-compatible 属性；
- 不得：修改 TASK-002 的七模型序列化注册表（`serialization.py` 的
  SupportedModel 集合），把 ProviderResult 当成第八个项目核心模型；
  创建 ProviderResult 文件仓储；创建数据库；创建项目级 Provider 状态
  保存机制；
- 是否需要正式序列化 ProviderResult，必须作为**设计文档**中的明确设计
  决定记录（含理由），不得自动扩大 TASK-002 schema。

## 测试要求

至少测试：

1. VideoProvider 接口可由 ManualVideoProvider 实现；
2. Provider 请求的合法与非法构造（含 D6 的 JSON-compatible 约束：
   禁止 NaN、Infinity、Path、datetime、Enum、bytes、set、非字符串 key、
   循环结构等）；
3. ProviderRequest 不可变性：嵌套输入在构造后被调用方修改时，内部值
   不发生变化（D6）；
4. ProviderResult 的合法与非法状态组合，覆盖规范性状态矩阵的全部七行
   （artifact / error_summary / completed_at / terminal 约束）；
5. `requires_user_action` 派生规则（仅 waiting_for_user 为 True）；
6. ArtifactReference：reference 非空且原样保存（不 strip、不 resolve、
   不规范化）；origin 与 location 两维语义可区分（D4）；
7. Provider 状态与 GenerationTaskStatus、ManifestStatus 是不同类型；
8. Manual Provider 不调用外部 API；
9. Manual Provider 不访问浏览器；
10. **四阶段文件系统禁令**：`prepare`、`submit`、`poll`、`collect`
    四个方法全部不得调用 `Path.exists`、`os.path.exists`、`glob`、
    `rglob`、`os.walk`，不扫描目录、不自动发现用户产物、不打开或检查
    媒体文件内容；测试必须覆盖全部四个阶段（不只 poll 和 collect）；
    可通过 monkeypatch 文件系统访问函数使其一旦被调用就失败来验证，
    不得仅依赖脆弱的源码字符串搜索；
11. Manual Provider 不修改 GenerationTask；
12. Manual Provider 不创建 VideoAsset；
13. prepare 返回稳定的人工操作说明；
14. submit 正确表达等待人工操作；
15. poll 不伪造远端进度，只返回基于调用方已提供信息可确认的状态；
16. collect 只处理显式提供的产物引用；collect 缺少显式产物引用时抛出
    对应类型化异常（D5）；
17. collect 不检查真实视频内容；
18. succeeded 必须有产物引用；failed 必须有非空错误摘要；cancelled 不得
    携带错误摘要；
19. 等待用户、已取消与失败三种状态可明确区分，取消不借用
    error_summary（D3）；
20. 异常与 FAILED 结果分工：正常表达的状态（waiting_for_user、
    processing、artifact_available、cancelled、任务终态失败）不通过
    异常表示（D5）；
21. 时间字段：每个 ProviderResult 都必须有带时区 UTC 的
    `observed_at`；非终态状态（not_submitted、waiting_for_user、
    processing、artifact_available）拒绝 `completed_at`；succeeded、
    failed、cancelled 缺少 `completed_at` 时构造失败；`completed_at`
    晚于 `observed_at` 时构造失败；naive `observed_at` 被拒绝；naive
    `completed_at` 被拒绝；非 UTC 时间被拒绝；合法的
    `completed_at < observed_at` 可以通过；合法的
    `completed_at == observed_at` 可以通过；Provider 不静默修正调用方
    提供的时间；`elapsed_seconds` 如存在必须是有限非负值（D2）；
22. 单次操作观测值可选且 Manual Provider 可不提供成本观测（D2）；
23. external_task_ref 与 artifact 是不同字段、不同概念，互不替代；
24. 输入对象（请求与传入模型）不被修改；
25. 不实现 Provider 之外的 Orchestrator 行为；
26. 不实现 API、FFmpeg 或 ffprobe；
27. Ruff format、Ruff lint、pytest 全量测试通过（含 TASK-002 既有
    全部测试）。

## 验收标准

以下 **14 条**标准客观可验证（通过测试或文件检查独立验证），审查 Agent
不读取任何聊天记录即可独立验收：

1. VideoProvider 精确接口有明确文档和类型契约，且与通过审查的设计文档
   `docs/design/TASK-003-provider-contract-design.md` 一致；
2. ManualVideoProvider 能实现完整的人工生成生命周期
   （prepare → submit → poll → collect）；
3. ProviderStatus 为独立类型且恰好包含固定的七个状态语义，与
   GenerationTaskStatus、ManifestStatus 严格分离；规范性状态矩阵全部
   不变量通过测试，包括时间关系不变量——`observed_at` 必填且为带时区
   UTC、终态（succeeded/failed/cancelled）`completed_at` 必填、非终态
   `completed_at` 禁止、`completed_at <= observed_at`；
   requires_user_action 由状态派生而非持久字段；
4. ProviderResult 不包含正式 VideoAsset 或正式资产 ID；产物引用满足
   D4 两维 ArtifactReference 模型，最多一个规范化引用、无不一致重复；
   external_task_ref 与 artifact 概念分离；
5. Provider 不修改 GenerationTask；
6. Provider 不写正式项目状态（GenerationTask、VideoAsset、manifest、
   QCD、任务说明文件均不写）；
7. Manual Provider 不调用 API、浏览器；四阶段全部满足文件系统禁令
   （D1），且有覆盖四阶段的测试（monkeypatch 方式，非仅源码字符串
   搜索）；
8. 人工操作说明可以由调用方读取和展示；
9. 用户产物引用只能由调用方显式传入；collect 缺少显式引用时抛出类型化
   异常；异常与 FAILED 结果的分工符合 D5（正常状态不通过异常表示）；
10. Provider 特定参数满足 JSON-compatible 约束与不可变最低要求（D6），
    并有构造后修改嵌套输入的测试；
11. 单次操作观测值边界符合 D2（elapsed_seconds 有限非负、Manual 可不
    提供成本、无累计/历史成本、不写 QCD）；
12. 不实现 Orchestrator、媒体校验、FFmpeg 或 QCD；
13. 全部新增测试和现有测试通过（格式化、静态检查、测试全绿）；
14. 没有修改 TASK-003 范围外文件。

## 预计影响文件

以下为**候选**结构，不视为已批准的固定设计；最终结构由设计文档确定并
说明理由：

- 新增（编码前）：`docs/design/TASK-003-provider-contract-design.md`
- 新增：`src/ai_video_workflow/providers/__init__.py`
- 新增：`src/ai_video_workflow/providers/base.py`（接口）
- 新增：`src/ai_video_workflow/providers/manual.py`（ManualVideoProvider）
- 新增：`src/ai_video_workflow/providers/types.py` 或更明确的名称
  （请求、结果、状态、ArtifactReference、ManualInstruction）
- 新增：`src/ai_video_workflow/providers/errors.py`（或并入现有
  `errors.py`，由设计文档说明）
- 新增：`tests/test_provider_contract.py`
- 新增：`tests/test_manual_provider.py`
- 已修改：`docs/architecture.md`（§4 最小同步修订，已完成）
- 修改：本任务卡（状态更新与实施说明指引）
- 不修改：六个核心模型、StepManifest、`serialization.py` 的模型注册表、
  ADR-0001、AGENTS.md、CLAUDE.md、docs/product_spec.md、
  docs/implementation_plan.md、TASK-001、TASK-002

## 实施 Agent

Claude Code

## 审查 Agent

Codex（独立审查，不直接修改实施文件，审查意见记录到本文件或新文档）

## 预实施审查记录

- reviewer: Codex
- 第一轮预实施审查：有条件通过；审查问题已按用户裁决落实——
  architecture.md §4 同步修订、正式设计文档门槛、ArtifactReference 两维
  语义模型、固定七状态与规范性矩阵、异常与 FAILED 结果分工、Provider
  参数 JSON-compatible 与不可变约束、四阶段文件系统禁令测试、验收标准
  明确为 14 条；
- 第二轮窄范围复审：唯一剩余问题为 `observed_at` 与 `completed_at` 的
  语义和时序关系，已在本次修订中补充（时间字段语义、状态矩阵补充
  不变量、设计文档要求与测试要求同步更新）；
- 下一步：最终窄范围复审通过后提交规格基线；随后创建
  `docs/design/TASK-003-provider-contract-design.md` 并提交 Codex
  预实施审查（见"编码门槛"）。

## 当前状态

planned（设计文档通过 Codex 预实施审查前不得开始编码，见"编码门槛"）

## 尚待后续任务决定的事项

以下事项明确**不在本任务解决**：

- Workflow Orchestrator 精确实现；
- ProviderResult 如何映射到 GenerationTask 状态；
- 正式任务说明文件由 Orchestrator 如何写入；
- staging 路径如何由 Orchestrator 分配；
- 文件发现（staging 下用户产物的检测）如何由 Orchestrator 或其调用方
  实现（Provider 不扫描目录已是架构基线，见 D1）；
- 媒体校验和 ffprobe；
- VideoAsset 正式登记；
- QCD 事件写入；
- Cloud Provider（含货币、计费与详细成本模型）；
- Local Provider；
- API 认证、限流、重试与云 API 错误体系；
- 取消传播策略、timeout 与取消操作 API；
- Provider 成本记录的累计与历史（本任务只允许单次当前观测，见 D2）；
- 未来如需改变七状态模型，须通过后续设计变更流程（不得实施时临时决定）。
