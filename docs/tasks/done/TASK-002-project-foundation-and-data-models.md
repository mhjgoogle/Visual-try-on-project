# TASK-002：项目骨架与核心数据模型（Project Foundation and Data Models）

## 背景

TASK-001 已完成并通过 Codex 三轮独立审查，阶段 0 的规范与规划文档
（AGENTS.md、product_spec、architecture、implementation_plan）已提交为基线
（commit `ac8c5ff`）。项目进入实施规划的阶段 1：Python 项目骨架与核心数据模型。

本任务是仓库中第一个产出代码的任务。阶段 2 的 VideoProvider 接口、
ManualVideoProvider 与 Workflow Orchestrator 都将建立在本任务交付的数据模型
与持久化能力之上（见 [architecture.md](../../architecture.md) §2、§3、§8，
[implementation_plan.md](../../implementation_plan.md) 阶段 1）。

本任务工作分支：`feat/task-002-foundation`。

## 单一目标

建立可安装、可运行、可测试的 Python 项目骨架，并定义第一阶段需要的核心数据模型
和基础文件持久化能力，为阶段 2 的 VideoProvider 和 Workflow Orchestrator 提供
稳定基础。

## 范围内

1. Python src-layout 项目骨架；
2. `pyproject.toml`；
3. `README.md`（环境准备与可直接复制执行的安装/格式化/静态检查/测试命令，
   见"安装与导入验收流程"）；
4. `.gitignore`（边界见"持久化与覆盖保护要求"末节）；
5. 测试目录和测试命令；
6. 格式化和静态检查配置；
7. 六个核心数据模型：Project、Character、Scene、Shot、GenerationTask、VideoAsset；
8. 可恢复步骤 Manifest 数据模型；
9. 模型间必要的稳定 ID 和引用关系（见"引用关系与项目级验证"）；
10. JSON 确定性序列化、反序列化与验证（**只实现 JSON**，不实现 YAML，
    不为 YAML 引入依赖）；
11. 最小项目级数据加载与验证入口（统一检查跨模型引用完整性；它不是
    Workflow Orchestrator、工作流调度器、Provider 或数据库）；
12. 基础文件持久化（pathlib、原子写入、默认拒绝覆盖、明确错误、
    不静默修改用户数据）；
13. 一份最小示例项目数据（实体集合见"最小示例项目内容"；存放位置由
    ADR-0001 决定，本任务卡不预先写死路径）；
14. 单元测试和 JSON 往返测试（含专门的无效数据案例）；
15. 第一份 ADR：`docs/adr/ADR-0001-project-data-directory-contract.md`
    （边界见"目录契约要求"）。

## 范围外

- VideoProvider 精确接口；
- ProviderResult；
- Provider 标准化状态完整枚举；
- ManualVideoProvider；
- Workflow Orchestrator；
- 云端 API；
- 本地视频模型；
- 真实 LLM；
- FFmpeg；
- ffprobe 视频校验；
- QCD 事件写入；
- QCD 汇总与报告；
- YAML 读写与 YAML 依赖（是否支持 YAML 留到未来有明确使用场景时单独决定）；
- 数据库；
- Web UI；
- Docker；
- 云端部署；
- 浏览器自动化。

## 输入

- 基线文档：AGENTS.md、docs/product_spec.md、docs/architecture.md、
  docs/implementation_plan.md（commit `ac8c5ff`）；
- 本任务卡。

## 输出

- src-layout 的 Python 包与 `pyproject.toml`、`README.md`、`.gitignore`、
  格式化/静态检查/测试配置；
- 六个核心数据模型与 Manifest 模型的实现；
- JSON 序列化/反序列化（仅 JSON）、最小项目级加载/验证入口与基础文件
  持久化模块；
- 最小示例项目数据（路径遵循 ADR-0001）与测试用无效数据案例；
- 单元测试与 JSON 往返测试；
- `docs/adr/ADR-0001-project-data-directory-contract.md`；
- 实施说明（记录技术选型理由与状态集合设计理由，可写入本任务卡附录或
  ADR/PR 描述，位置由实施 Agent 决定并在本任务卡中留下指引）。

## 数据模型要求

模型清单与关系以 [architecture.md](../../architecture.md) §2 为准：
`Project 1—N Scene 1—N Shot 1—N GenerationTask 1—0..1 VideoAsset`，
Character 挂在 Project 下、被 Shot 引用。

### 引用关系与项目级验证

模型之间**只使用稳定、可序列化的 ID 引用**，不在一个模型中嵌入完整的关联
模型对象。最小引用关系：

- Character 通过 `project_id` 归属 Project；
- Scene 通过 `project_id` 归属 Project；
- Shot 通过 `scene_id` 归属 Scene；
- Shot 可通过 `character_ids` 引用 Character；
- GenerationTask 通过 `shot_id` 引用 Shot；
- VideoAsset 通过 `shot_id` 引用 Shot；
- VideoAsset 可通过 `source_task_id` 引用产生它的 GenerationTask；
- Manifest 通过 `step_name` 和输出路径描述步骤结果，不直接嵌入其他模型。

GenerationTask 与 VideoAsset 之间**不建立双向正式引用**，避免循环引用和
双重事实来源：

- GenerationTask 的 `current_artifact_ref` 只表示当前外部或 staging 产物引用，
  **不表示正式 VideoAsset ID**；
- `VideoAsset.source_task_id` 是正式资产追溯生成任务的**单向**引用；
- 未来如需从 Task 查询正式资产，通过项目级索引或查询**派生**，
  不在 GenerationTask 内重复保存 asset_id。

验证分两层：

- 单个模型只验证自身字段、类型和局部不变量；
- 跨模型引用完整性由**最小项目级数据加载/验证入口**统一检查。该入口不是
  Workflow Orchestrator、工作流调度器、Provider，也不是数据库。

项目级验证入口至少检查：

- 所有 `project_id` 引用存在；
- 所有 `scene_id` 引用存在；
- 所有 `character_ids` 引用存在；
- 所有 `shot_id` 引用存在；
- `VideoAsset.source_task_id` 存在；
- VideoAsset 的 `shot_id` 与其 `source_task_id` 对应任务的 `shot_id` 一致；
- ID 在各自实体类型中唯一。

错误必须按类别明确区分（可区分的错误类型或错误码）：

- JSON 语法或结构错误；
- 字段缺失；
- 字段类型错误；
- 局部模型不变量错误；
- 跨模型引用不存在或不一致。

### GenerationTask 边界

GenerationTask 只保存当前任务的业务和运行状态，例如：

- task_id；
- shot_id；
- provider 标识或待选 provider 标识；
- 输入参数引用；
- 当前状态；
- 外部任务引用；
- 当前产物引用；
- 当前错误摘要；
- 必要的编排时间戳。

GenerationTask **不得包含**：

- 人工评分历史；
- 重做历史；
- 成本明细历史；
- QCD 原始事件；
- QCD 汇总指标。

（append-only QCD 事件日志是原始 QCD 事实的唯一来源，见 architecture.md §10；
本任务不实现 QCD 事件写入。）

### VideoAsset 边界

- 只表示**已经被校验并正式登记**的媒体资产；
- 本任务只定义数据结构；
- 不实现媒体校验、导入或 Orchestrator。

### Manifest 边界

Manifest 至少包含以下字段（语义见 architecture.md §8）：

- `step_name`
- `input_digest`
- `relevant_config_digest`
- `output_paths`
- `output_metadata`
- `status`
- `created_at`
- `completed_at`
- `error_summary`
- `schema_version`

类型要求：

- `output_metadata` 必须是 **JSON-compatible mapping**。JSON-compatible 值
  仅允许：null、boolean、number、string、JSON-compatible list、以及键为
  string且值为 JSON-compatible value 的 mapping；**不得**接受 Path、datetime、
  Enum 或任意 Python 对象而不先转换为 JSON 表示；
- Manifest 状态与 GenerationTask 状态属于**不同语义域和不同类型**，不得复用
  同一个枚举类型；Manifest 状态集合必须至少包含 `completed`，其余最小状态由
  实施 Agent 提出并说明理由；architecture.md §8 的跳过规则使用 Manifest 的
  `completed`，不代表 GenerationTask 必须使用相同状态值。

最低不变量：

- `created_at` 和 `completed_at` 如存在，必须是带时区的 UTC 时间；
- `completed_at` 不得早于 `created_at`；
- `status` 为 `completed` 时：`completed_at` 必须存在，`error_summary`
  必须为空；
- `status` 为 `failed` 时：`error_summary` 必须为非空字符串；
- 非终态时：`completed_at` 必须为空；
- `output_paths` 中的值必须能稳定序列化为字符串路径；
- 所有 `output_metadata` 必须可直接序列化为 JSON。

本任务只实现 Manifest 的结构和基础读写，**不实现**：

- input digest 计算；
- 摘要算法；
- 自动断点续跑；
- 缓存框架；
- 工作流调度；
- 复杂版本管理。

（`input_digest` / `relevant_config_digest` 的具体计算算法由阶段 2 或首个
实际使用该摘要的工作流步骤确定，见 architecture.md §8。）

### 状态枚举边界

- 实施 Agent 应根据持久化模型的实际需要提出**最小状态集合**；
- 状态必须支持明确验证和 JSON 序列化；
- 不得把持久化模型状态与阶段 2 的 Provider 标准化状态混为一谈
  （`waiting_for_user`、`asset_available` 等 Provider 标准化状态属于阶段 2，
  本任务不定义）；
- architecture.md 中出现的 `pending / in_progress / done / failed` 只是
  **说明性示例**，不是本任务已批准的固定枚举；如最终状态集合与该示例不同，
  不视为架构偏离，但必须在实施说明中解释理由；
- 本任务卡不列出强制枚举值。

### 最小示例项目内容

示例项目的最终文件路径由 ADR-0001 决定，但最小实体集合固定为：

- 1 个 Project；
- 至少 1 个 Character；
- 至少 1 个 Scene；
- 至少 2 个 Shot；
- 每个 Shot 至少有 1 个对应 GenerationTask；
- 至少 1 个正式 VideoAsset；
- 至少 1 个 Step Manifest。

示例必须满足全部项目级引用校验。

另须提供至少一个**专门用于测试的无效数据案例**，例如：

- Shot 引用了不存在的 Scene；
- 或 `VideoAsset.source_task_id` 不存在；
- 或 Task 与 Asset 的 `shot_id` 不一致。

无效案例只存放在测试数据中，**不得混入正式示例项目目录**。

## 持久化与覆盖保护要求

- 使用 pathlib 处理所有路径；
- 原子写入（写临时文件后原子替换或等价手段）；写入失败不得留下半成品正式文件；
- 默认拒绝覆盖已有文件，覆盖必须由调用方显式声明（见 architecture.md §9）；
- 文件不存在、数据无效（缺字段、类型错误、引用失效等）时返回**明确的、
  可区分的错误**，不得静默吞错或静默修正；
- 不静默修改用户数据。

### .gitignore 边界

至少考虑排除：

- `.venv/`；
- `__pycache__/`；
- Python 构建产物；
- 测试和静态检查缓存；
- 本地环境变量文件；
- API 密钥和凭据；
- 生成媒体；
- 临时文件。

对 Agent 工具目录（`.claude/`、`.codex/`、`.agents/` 等）的约束：

- 可以排除其中的**本地工具状态、会话文件和个人配置**
  （如个人专用的 settings.local.json、缓存、会话状态）；
- **不得在未检查实际内容的情况下把整个目录一概排除**——这些目录未来可能
  同时包含应忽略的本地状态和应纳入版本管理的共享项目配置；
- 具体忽略规则由实施 Agent 检查实际内容后决定，并在实施说明中记录。

空目录 `ai-video-workflow/`、`.agents/`、`.codex/` 本任务不处理
（Git 不跟踪空目录，也不属于本任务范围）。

## 目录契约要求

创建 `docs/adr/ADR-0001-project-data-directory-contract.md`。

ADR **只定义长期持久化数据目录契约**，包括：

- 项目数据根目录；
- 原始输入；
- staging；
- 正式媒体资产；
- manifests；
- QCD 原始事件；
- 最终输出。

ADR **不规定**：

- Python 模块内部拆分；
- tests 目录结构；
- 普通代码文件命名；
- 具体 Provider 接口。

目录契约须遵循 architecture.md §7 的原则（代码与数据分离、按领域分区、
可排序可追溯的命名、相对项目根的 POSIX 路径）。示例项目数据的存放位置
由本 ADR 决定。

## 技术选择原则

- 优先使用 Python 标准库；
- 如使用第三方数据验证库，必须在实施说明中说明必要性；
- 不引入重量级框架；
- 使用 pathlib 处理路径；
- 所有时间使用带时区的 UTC；
- 所有 ID 稳定且可序列化；
- JSON 输出必须确定性排序（键序稳定），便于 Git diff 和测试；
- Python 最低版本、dataclasses 或第三方库、ruff/pytest 等工具选型由实施 Agent
  在实施时决定，但必须说明理由；
- 依赖只安装在项目 venv 内（AGENTS.md 规则 7）。

### 安装与导入验收流程

README 必须提供一套可直接复制执行的 WSL2 Ubuntu 命令，最低验收流程为：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
```

随后必须依次执行：

1. 使用**最终实际包名**的 import smoke test，例如：
   `python -c "import <actual_package_name>; print(<actual_package_name>.__name__)"`
   ——README 和交接报告中必须将 `<actual_package_name>` 替换为真实包名，
   **不得保留占位符**（本任务卡不提前决定包名）；
2. 格式检查命令；
3. 静态检查命令；
4. 完整测试命令。

验收要求：不能只依靠当前源码目录直接运行；editable install 必须成功；
安装后必须能从虚拟环境导入实际包；src-layout 打包错误必须导致验收失败。

## 测试要求

- 每个数据模型有单元测试；
- 六个核心模型与 Manifest 均有 JSON 序列化往返测试（对象 → JSON → 对象，
  语义等价）；
- 覆盖保护有测试：默认写入已存在的文件必须失败；
- 无效数据的错误路径有测试，且覆盖"引用关系与项目级验证"定义的错误类别
  （JSON 语法/结构、字段缺失、类型错误、局部不变量、跨模型引用不存在或
  不一致）；
- 项目级引用校验有测试（使用专门的无效数据案例：引用不存在、`shot_id`
  不一致等）；
- 原子写入的失败路径有测试（失败后正式文件不存在或保持原状）；
- 示例项目数据能被读取与验证（含全部项目级引用校验）的集成测试；
- 全部测试、格式化、静态检查通过后方可交付（AGENTS.md 规则 19、20）。

## 验收标准

以下标准客观可运行，审查 Agent 不读取任何聊天记录即可独立验收：

1. 项目可在 WSL2 Ubuntu 环境完成安装并导入：按"安装与导入验收流程"执行，
   editable install（`pip install -e ".[dev]"`）必须成功，安装后能从虚拟环境
   用实际包名完成 import smoke test；不能只依靠当前源码目录直接运行，
   src-layout 打包错误（如安装后无法导入）导致验收失败；
2. 格式化、静态检查和测试命令可执行（README 中列出的命令逐条可复制运行，
   无占位符残留）；
3. 六个核心模型和 Manifest 可完成 JSON 序列化往返；
4. 无效数据产生明确且类别可区分的错误（JSON 语法/结构、字段缺失、类型错误、
   局部不变量、跨模型引用五类，见"引用关系与项目级验证"）；
5. 默认写入不会覆盖已有文件；
6. 原子写入失败不会留下半成品正式文件；
7. Manifest 包含 architecture.md §8 要求的全部字段，且满足本任务卡定义的
   类型要求与最低不变量；
8. GenerationTask 不包含 QCD 历史或汇总数据；
9. 示例项目满足"最小示例项目内容"的实体集合，能被程序读取并通过全部
   项目级引用校验；
10. ADR-0001 只约束长期数据目录契约（不涉及模块拆分、tests 结构、
    代码命名、Provider 接口）；
11. 没有实现 VideoProvider、Orchestrator、API 或 FFmpeg；
12. 全部测试通过；
13. 没有修改 TASK-002 范围外文件。

## 预计影响文件

- 新增：`pyproject.toml`、`README.md`、`.gitignore`、`src/` 下的 Python 包、
  `tests/` 下的测试、`docs/adr/ADR-0001-project-data-directory-contract.md`、
  最小示例项目数据（路径由 ADR-0001 决定）；
- 修改：本任务卡（状态更新与实施说明指引）；
- 不修改：AGENTS.md、CLAUDE.md、docs/product_spec.md、docs/architecture.md、
  docs/implementation_plan.md、docs/tasks/done/TASK-001-project-foundation.md。

## 实施 Agent

Codex

## 审查 Agent

Claude Code（独立审查，不直接修改实施文件，审查意见记录到本文件或新文档）

## 审查记录

- reviewer: Codex
- review result: passed（两轮预实施审查：第一轮有条件通过——JSON/YAML 范围、
  引用与项目级验证、示例内容、Manifest 类型与不变量、安装验收流程等修正已
  实施；第二轮复审通过）
- blocking findings: 0
- important findings: 0
- implementation agent: Codex
- review agent: Claude Code

## 实施记录

- implementation agent: Codex
- review agent: Claude Code
- Python minimum version: 3.10
- distribution name: `ai-video-workflow`
- import package: `ai_video_workflow`
- data model approach: 标准库 `dataclasses`，模型间仅通过稳定 ID 引用
- build backend: `setuptools.build_meta`
- quality tools: Ruff and pytest
- deterministic JSON contract: UTF-8、`ensure_ascii=False`、键排序、两空格缩进、
  禁止非有限浮点，末尾恰好一个换行；UTC datetime 固定六位微秒和 `+00:00`
- atomic persistence strategy: 同目录临时文件写入、flush 与 fsync；默认通过
  POSIX hard link 原子 no-replace 发布，显式覆盖通过 `os.replace` 原子替换；
  临时文件清理为不掩盖主要结果的 best-effort
- ProjectData validation boundary: 单项目内存快照；检查各实体类型 ID 唯一性、
  项目归属、跨模型引用和 Task–Asset `shot_id` 一致性；显式路径加载，不扫描、
  不写入、不承担 Orchestrator 职责
- ADR-0001 and example project location:
  `docs/adr/ADR-0001-project-data-directory-contract.md`（Accepted）与
  `examples/projects/minimal/`
- actual final test count: 414 passed；示例项目专项 48 passed
- final acceptance result: passed（Python 3.10.12 全新临时 venv 中 editable install、
  仓库外 import、pip check、Ruff format、Ruff lint 和完整测试全部通过）
- scope boundary: 未实现 Provider、ProviderResult、Orchestrator、API、FFmpeg、
  digest、缓存、自动断点续跑、数据库、Web UI、Docker、QCD 写入或 YAML
- review status: awaiting Claude Code independent final review

### 实施提交

- `7ffeff6 chore: establish Python project foundation`
- `1ad19de feat: add core validation and error types`
- `e6249c3 feat: add core project data models`
- `19cc1e1 feat: add step manifest data model`
- `4fcf1b6 feat: add deterministic JSON persistence`
- `aefa58a feat: add project-level reference validation`
- `0923947 docs: define project data directory contract`

### 最终验收结果

1. passed — WSL2 Ubuntu 的全新 Python 3.10 venv 可完成 editable install，并可从
   仓库外导入当前仓库 `src/ai_video_workflow`。
2. passed — README 的 Ruff format、Ruff lint 和 pytest 命令可直接执行。
3. passed — 六个核心模型与 StepManifest 的 dict、JSON 字符串及文件往返测试通过。
4. passed — JSON、缺失字段、字段类型、局部不变量和跨模型引用错误类别可区分。
5. passed — 默认文件发布使用 no-replace 语义，已有文件保持不变。
6. passed — 写入、fsync、link 和 replace 失败路径不会发布半成品正式文件。
7. passed — StepManifest 包含 architecture.md §8 的全部字段及最低不变量。
8. passed — GenerationTask 不包含 QCD 事件、历史或汇总字段。
9. passed — 最小示例项目可显式加载并通过全部项目级引用验证。
10. passed — ADR-0001 只定义长期项目数据目录契约。
11. passed — 未实现 VideoProvider、Orchestrator、API 或 FFmpeg。
12. passed — 全量 414 项测试通过。
13. passed — 从规格基线审计的改动均在 TASK-002 预计影响范围内。

## 最终审查记录

- final reviewer: Claude Code
- final review result: passed
- blocking findings: 0
- important findings: 0
- final acceptance tests: 414 passed
- ADR-0001 status: Accepted
- completed after independent final review

## 当前状态

completed

## 尚待阶段 2 决定的事项

以下事项明确**不在本任务解决**，由阶段 2（或首个实际使用方）基于本任务交付的
数据模型确定：

- VideoProvider 精确接口（方法、参数、返回类型）；
- ProviderResult 的精确定义；
- Provider 标准化状态的完整枚举（`waiting_for_user`、`asset_available` 等）；
- ManualVideoProvider 与 Workflow Orchestrator 的调用契约；
- `input_digest` / `relevant_config_digest` 的具体计算算法；
- staging 路径的分配逻辑（目录契约由 ADR-0001 定义，分配行为属 Orchestrator）；
- QCD 原始事件的写入逻辑与事件日志文件格式；
- 是否支持 YAML（留到未来有明确使用场景时单独决定，届时另行评估依赖）；
- 从 GenerationTask 查询正式资产的项目级索引/查询派生方式（如未来需要）。
