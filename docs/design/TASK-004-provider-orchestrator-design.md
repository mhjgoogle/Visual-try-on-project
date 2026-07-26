# TASK-004 设计文档：Provider Orchestrator 契约与基础编排

- Status: approved — implementation in progress; Steps M, A, B,
  and C completed; Step D pending new checkpoint
- Revision: r6（自包含版本；关闭 r5 复审的 3 个阻塞与 1 个重要
  问题；不依赖任何历史草案或聊天记录）+ 实施顺序补充（§24，
  docs-only，Codex 第三次复审通过）

**审批记录（Codex sequencing clarification review, 第三次）**：

- independent review: **passed**
- original important findings（三项全部关闭）：
  - current state vs historical snapshot conflict: **closed**
  - Step M pytest case count: **closed**
  - gate/whitespace/checkpoint discipline: **closed**
- blockers: 0；important findings: 0；suggestions: 0
- clarification docs: approved for independent docs-only commit
- technical allocation: unchanged from reviewed §24（A=5、B=44、
  C=3、D=14、E=11、F=20、G=34，合计 131；文件矩阵、模块归属、
  依赖顺序、public/internal 边界、durable recovery 语义均无
  变化）
- global coding gate: open
- Step B local gate: may open **only after** this docs-only
  commit completes, the worktree is clean, and a new explicit
  Step B checkpoint is issued
- 本提交只批准实施分配——不表示 Step B 已开始、不表示 Step B
  代码已实现、不表示 TASK-004 已完成、不表示全部 131 个设计
  测试项已实现；no Step B Python changes retained。

**实施顺序阻塞与补充范围（docs-only clarification）**：

- 阻塞事实：r6 批准正文只包含按文件划分的 ownership plan
  （§21）与 131 项测试计划（§22），未正式定义 Step B–G 的名称、
  文件分配与测试编号归属；Step B 实施因此停止，未保留任何
  Python 试验代码，工作区已恢复干净（HEAD `884081c`，
  899 passed）。
- 本补充只做"实施分步归属澄清"（§24）：一次性正式定义
  Step B–G 的名称、目标、文件范围、测试归属与进入/完成条件；
  **不改变** r6 已批准的公开 API、数据模型、enum、错误体系、
  13×7 生命周期矩阵、GenerationTask/StepManifest 矩阵、sticky
  merge、操作身份、NO_OP、Provider 调用协议、统一 record
  envelope、pending 两 variant、WAL/CAS/恢复、路径安全、
  instruction 逐字节契约、固定资产边界与 131 项测试的测试语义；
  不新增、删除或弱化验收标准。
- 复审范围：只复审新增的 §24 implementation allocation（含
  §21 的指向性说明），不重新开放全部技术设计。
- coding gate 整体保持 open；但 Step B 的局部进入门槛在本补充
  通过 Codex 复审**并作为独立 docs-only 提交完成、工作区恢复
  干净、新的 Step B checkpoint 明确发出**之前暂不满足，禁止
  Step B 实施。

**审批记录（Codex formal design review, r6）**：

- Codex formal design review: **passed**
- blockers: 0；important findings: 0；suggestions: 0
- design body approved
- Codex ADR-0001 narrow review: **passed**（ADR blockers: 0；
  important findings: 0；suggestions: 0）
- ADR-0001 synchronization: satisfied
- architecture synchronization: not required
- GenerationTaskStatus.CANCELLED design prerequisite: satisfied
- **implementation agent: Claude Code**
- **independent review agent: Codex**
- **coding gate: open**
- **Step M — GenerationTaskStatus.CANCELLED model evolution:
  completed — independently reviewed and approved**：
  - implementation: completed
  - first independent review: conditional pass（blockers 0 /
    important 1 / suggestions 0；important finding = legacy
    serialization compatibility coverage incomplete）
  - review fix: completed（四个旧状态参数化双路径覆盖）
  - second independent review: **passed**（blockers 0 /
    important 0 / suggestions 0）
  - tests: serialization pytest 56 passed；focused pytest 196
    passed；full pytest **775 passed**
  - Step M status: satisfied
- **Step A — orchestration errors / enums / canonical JSON /
  fingerprint / freeze utilities: completed — independently
  reviewed and approved**：
  - implementation: completed（生产文件：orchestration/
    __init__.py、errors.py、models.py、canonical.py；测试文件：
    tests/test_orchestration_models.py、
    tests/test_orchestration_canonical.py）
  - independent review: **passed**（blockers 0 / important 0 /
    suggestions 0）
  - tests（提交轮实际重新执行）：Step A focused pytest 124
    passed；related regression（providers/models/serialization
    套件随全量执行）；full pytest **899 passed**；Ruff
    format/lint passed；whitespace passed
  - Step A status: satisfied
- **Step B — durable record 数据合同与严格恢复解析: completed
  — independently reviewed and approved**：
  - implementation agent: Claude Code；independent review
    agent: Codex
  - implementation: completed（生产文件：orchestration/
    canonical.py（追加）、_models.py、recovery.py；测试文件：
    tests/test_orchestration_models.py、
    tests/test_orchestration_canonical.py）
  - independent review: **passed**（blockers 0 / important 0 /
    suggestions 0；第一轮不通过的三阻塞一重要——stable=null 未
    限定首次 prepare 动作、strict parser 接受语义无效日历时间、
    wrapper 未强制 nested JSON-only、stable schema version 未
    显式恢复——已逐项修复并关闭）
  - §22 设计测试条目：Step B 归属的 44 项已客观覆盖
  - tests：Step B focused pytest **368 passed**；Step A/M
    related regression **611 passed**；full pytest
    **1143 passed**；Ruff format 46 files already formatted；
    Ruff lint passed；whitespace passed
  - Step B status: satisfied
- **Step C — instruction 逐字节渲染器: completed —
  independently reviewed and approved**：
  - implementation agent: Claude Code；independent review
    agent: Codex
  - implementation: completed（生产文件：
    orchestration/instructions.py；测试文件：
    tests/test_orchestration_canonical.py）
  - independent review: **passed**（blockers 0 / important 0 /
    suggestions 0；第一轮有条件通过的两个重要问题——renderer
    过度拒绝合法文本（内部行尾空白/多行 step）、fence 注入测试
    未用真正三反引号载荷——已修复并关闭）
  - 独立审查确认：exact template、prompt/steps verbatim 语义、
    canonical JSON fenced block、UTF-8/无 BOM/LF-only、恰一
    尾部换行、Unicode/NFC/collision、input mutation isolation、
    pure-function/零副作用、public/internal export、
    import/cycle 全部通过；Step D–G 未实现
  - §22 设计测试条目：111–113 已客观覆盖
  - tests：Step C focused pytest **169 passed**；related
    regression **631 passed**；full pytest **1189 passed**；
    Ruff format 47 files already formatted；Ruff lint passed；
    whitespace passed
  - Step C status: completed, independently reviewed,
    committed by this commit
- next permitted step: **Step D**（not started；只能在本提交
  完成、工作区干净后经新的独立 checkpoint 启动）；Step E–G:
  not started；coding gate: open（全局）
- Step M 的 18 个、Step A 的 124 个、Step B 的 244 个与
  Step C 的 46 个新增 pytest case 已实现并包含在当前 1189 项
  中；r6 的 131 项分步实施测试计划尚未全部实现（当前已完成
  52/131：Step A 5 项 + Step B 44 项 + Step C 3 项，见
  §24.3）；Step M/A/B/C 完成不代表 TASK-004 完成；本提交不包含
  任何 Step D 代码。
- 当前事实（统一口径）：r6 technical design **approved**；
  implementation sequencing clarification（§24）**approved —
  第三次 Codex 复审通过**（此前两轮为历史记录：第一次/第二次
  复审各有条件通过，三个重要问题已逐项关闭）；Step M / Step A
  / Step B / Step C **completed, independently reviewed,
  committed**（当前仓库含四个 Step 的实现代码；CANCELLED code
  implementation 已在 Step M 完成）；Step D **not started;
  pending new checkpoint**（必须在新的独立 checkpoint 中
  启动）；Step E–G not started；global coding gate **open**；
  当前实际回归基线 **1189 passed**。coding gate open 不表示
  §22 的 131 项计划测试已全部实现或任何 acceptance criterion
  已由完整实现满足（D–G 未实施）。角色边界：Claude Code 按批准
  的 r6 设计与 §24 分步实施，不得替代 Codex 声称独立审查通过；
  Codex 在每个批准步骤后独立审查，不直接修改实现文件；每个
  Step 必须在前一步完成、测试通过并按计划审查后再开始。
- **r6 formal-design approval snapshot（历史快照，仅记录批准
  当时的事实，不代表当前状态）**：
  - coding gate was closed at that checkpoint；
  - CANCELLED code had not yet been implemented；
  - repository regression was **757 passed**（QA：Ruff format
    38 files already formatted；Ruff lint passed；whitespace
    passed）；
  - no TASK-004 implementation step had started。
- 说明：本文档 §22 的 131 项是**分步实施的测试计划**；r6 批准
  当时实际执行的是仓库当时已有的 757 项测试（历史快照）；当前
  已实现其中 Step A 归属的 10–14 共 5 项（见 §24.3），其余为
  planned，不声称已实现。
- Task: [TASK-004](../tasks/TASK-004-provider-orchestrator-foundation.md)
- Specification baseline:
  `47aeafc docs: approve TASK-004 orchestrator specification`
- TASK-003 completed baseline:
  `01ac984 docs: complete TASK-003 implementation`
- coding gate: **open**（全局；r6 批准时为 closed——见上方历史
  快照）；Step D 局部门槛：待本提交完成、工作区干净并发出新的
  Step D checkpoint
- 目标运行环境：WSL2 Ubuntu / Linux（POSIX `os.replace`；不测试
  Windows path 或 replace 语义）

**前置项状态**：

1. GenerationTaskStatus.CANCELLED design prerequisite approval:
   **satisfied**（代码变更已在 coding gate 打开后按 Step M
   实施）；
2. CANCELLED code implementation: **completed in Step M**
   （committed `8d691ba`；independently reviewed；历史：r6 批准
   时尚未实施，gate 前禁止）；
3. ADR-0001 prerequisite approval: **satisfied**；
4. ADR-0001 actual documentation synchronization: **satisfied**
   （经 Codex 窄范围复审通过。历史快照——"仍不实施
   CANCELLED、不开始任何 Python Step"是 ADR 窄范围复审当时的
   历史状态，不代表当前状态；该禁令已随 coding gate 打开与
   Step M/A 完成而失效）；
5. architecture synchronization: **not required**（executor 内部
   化方案已通过最终设计审查，见 §2）；
6. formal design review（r6）: **passed**；
7. implementation agent assignment: **satisfied — Claude Code**
   （independent review agent: Codex）；
8. coding gate: **open**（全局）——Step M、Step A、Step B 与
   Step C completed（independently reviewed and approved）；
   Step D: not started；pending new checkpoint；Step E–G not
   started。

## 1. 总览

- **无状态编排服务** `ProviderOrchestrator(provider)`：外部只见
  七个动作方法；planner、executor、layout resolver、可执行 plan
  全部内部化；
- **唯一顶层 record envelope**（§13.0）：所有 record 文件无论
  稳定或处理中都使用同一顶层结构
  `{record_schema, phase, stable, pending}`；stable 与 pending
  是两个不同事实来源，不得合并；
- **两段式 durable intent / WAL**（§11）：`_PendingProviderCall`
  与 `_PendingApply` 严格分离并带跨字段一致性不变量（§11.7）；
- **无环指纹计算**（§16）：plan_id 只依赖固定 core preimage
  （plan_preimage_schema_version = 1）；
- **统一版本化 snapshot wrapper**（§16.6）：全部嵌套 snapshot 不
  保存无版本裸 dict；
- **STABLE 自指纹复验**（§13.2）；
- **record 是 WAL 与恢复协议的唯一权威**（§13.5）；
- **公开操作身份**（§7.2）：response-loss 重放经公开 API 得到
  NO_OP；
- **固定资产边界**：不创建 VideoAsset、不转换/登记正式资产、不
  决定正式路径/版本/覆盖策略、不运行 FFmpeg/ffprobe、不写 QCD；
  collect 成功只输出显式 ArtifactReference handoff。

## 2. persistence 架构：方案比较与选择

**方案 A（直接执行）**：决策与 I/O 同层；纯 planning 同样可
抽取；缺点是 WAL/CAS/部分提交恢复散布于各动作方法，无单一执行层
可独立测试。**方案 B（纯 planning core + 边界内受控 executor，
选定）**：`_OrchestrationPlanner` 纯函数（零 I/O、零时钟）+
`_FileOrchestrationExecutor` 独占状态 I/O，恢复协议集中一处，
architecture "唯一写入者"经内部化结构性保持。**方案 C
（application service 持有 port）**：结构上可绕过 Orchestrator，
必须修订 architecture，恢复权威含糊，淘汰。

**architecture.md**：executor 内部化后不需要修改（no change
required, subject to final review）；若最终审查判定必须公开
executor/apply，则改判为需要修改。

## 3. 状态变更决策权和 I/O 边界

| 职责 | 组件（全部在 Orchestrator 边界内） |
| --- | --- |
| 状态变更决策权 | `_OrchestrationPlanner` |
| durable intent / phase 推进 | `_FileOrchestrationExecutor` |
| 多文件 before-fingerprint CAS | executor |
| plan 生成 / 执行 | planner / executor（仅接受内部 `_ExecutablePlan`） |
| 路径派生与安全校验 | `_LayoutResolver`（只派生验证，不执行 I/O） |
| 批准目录创建 | executor（§8.2） |
| 失败处理与部分提交恢复 | executor + resume 评估 |
| 外部调用方允许 | 构造 Orchestrator、提供显式输入、调用动作、读取输出 |
| 外部调用方禁止 | 直接写项目状态、获得/执行可执行 plan、绕过 executor、自行推进 version |

固定边界（全部有测试）：不扫描 artifact/媒体目录；不自动发现、
打开、检查、移动、复制、重命名 artifact；不创建 VideoAsset；不
转换/登记正式资产；不决定正式路径/版本/覆盖策略；不运行
FFmpeg/ffprobe；不写 QCD。executor 只写四个派生状态文件。

## 4. 公开 API

### 4.1 公开导出（最终清单）

公开：`ProviderOrchestrator`、`OrchestrationContext`、
`OrchestrationOutcome`、`OrchestrationPlan`（深度冻结摘要，不可
执行）、`ResumeAssessment`、`OrchestrationRecord`（只读快照）、
`OrchestrationAction`、`OutcomeKind`、`RecordPhase`、
`RecoveryDisposition`、`OrchestrationError` 及 §15 全部错误
子类。

不公开：`_OrchestrationPlanner`、`_FileOrchestrationExecutor`、
`_ExecutablePlan`、`_PendingProviderCall`、`_PendingApply`、
`_StableStateSnapshot`、`_LayoutResolver`、canonical/原子写入
工具。导出集合有测试锁定。

### 4.2 签名

```python
class ProviderOrchestrator:
    __slots__ = ("_provider", "_executor", "_planner")

    def __init__(self, provider: VideoProvider) -> None: ...

    def prepare(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
    ) -> OrchestrationOutcome: ...

    def submit(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
    ) -> OrchestrationOutcome: ...

    def poll(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
    ) -> OrchestrationOutcome: ...

    def report_artifact(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        artifact: ArtifactReference,
        observed_at: datetime,
    ) -> OrchestrationOutcome: ...

    def collect(
        self,
        context: OrchestrationContext,
        *,
        operation_id: str,
        observed_at: datetime,
        artifact: ArtifactReference | None = None,
        completed_at: datetime | None = None,
    ) -> OrchestrationOutcome: ...

    def replay_result(
        self,
        context: OrchestrationContext,
        result: ProviderResult,
        *,
        operation_id: str,
    ) -> OrchestrationOutcome: ...

    def resume(
        self,
        context: OrchestrationContext,
    ) -> ResumeAssessment: ...
```

replay_result 产生 persistence，同样要求 operation_id；resume
纯评估 + 受控自动补写，不引入新操作身份、不接受时间。

## 5. Orchestrator 对象状态

无状态服务。`__slots__` 仅三个协作者引用，无缓存、无生命周期
状态。Python 实例状态／项目持久状态（四文件）／Provider 外部
状态严格区分。内存对象不参与恢复。

## 6. 输入和输出模型

### 6.1 输入

```python
@dataclass(frozen=True, slots=True)
class OrchestrationContext:
    project_root: Path
    request: ProviderRequest
    task: GenerationTask
    manifest: StepManifest
```

入口验证：身份对齐（§7.1）；`manifest.step_name ==
f"generation:{task.task_id}"`；request 重建指纹与
stable.request_fingerprint 一致（首次操作无 stable 时跳过；不
一致 → ConflictingRequestError，禁止只比较三个 ID）；
operation_id 经 stable ID 规则验证；task/manifest 快照与磁盘
文件指纹一致（§9）。

### 6.2 输出

```python
class OutcomeKind(str, Enum):
    APPLIED = "applied"
    NO_OP = "no_op"


@dataclass(frozen=True, slots=True)
class OrchestrationOutcome:
    kind: OutcomeKind
    plan: OrchestrationPlan | None  # APPLIED 必有；NO_OP 必为 None
    no_op_reason: str | None  # NO_OP 必有；APPLIED 必为 None
    record: OrchestrationRecord
    legal_actions: tuple[OrchestrationAction, ...]
    preferred_next_action: OrchestrationAction | None
    provider_result: ProviderResult | None
    artifact_handoff: ArtifactReference | None
```

NO_OP 不变量：plan=None；version 不变；零写入；零 persistence；
no_op_reason 非空；携带当前 stable 摘要与 legal_actions。

```python
@dataclass(frozen=True, slots=True)
class ResumeAssessment:
    task_id: str
    shot_id: str
    provider_id: str
    phase: RecordPhase
    last_completed_action: OrchestrationAction | None
    legal_actions: tuple[OrchestrationAction, ...]
    preferred_next_action: OrchestrationAction | None
    is_terminal: bool
    requires_manual_reconciliation: bool
    disposition: RecoveryDisposition
```

legal_actions 按 Enum 定义序确定性排列；preferred 仅为建议。

## 7. 身份规则

### 7.1 provider_id 对齐

无 record 首次 PREPARE：provider.provider_id ==
request.provider_id 必须；**task.provider_id 必须为 None**
（收紧的初始前置条件——它同时是 §13.5 痕迹判定的基础；无
record 而 task.provider_id 非 None 属编排痕迹，按 §13.5 处理，
不进入 prepare）。prepare 的 after task 将 provider_id 设为
request.provider_id。有 record 后四方一致（此时
task.provider_id 非 None 且必须相等），违者
InvalidOrchestrationInputError。

### 7.2 公开操作身份（response-loss）

六个产生调用/persistence 的动作要求显式 `operation_id`：

1. 调用方生成并在重试时复用；无隐藏随机/时钟；
2. same identity = (operation_id, action, request_fingerprint,
   action_input_fingerprint)；action_input_fingerprint =
   canonical JSON of {observed_at, artifact 或 null,
   completed_at 或 null, result_fingerprint 或 null}——重试必须
   重用原 observed_at；
3. stable 保存 last committed operation 五元组；
4. 相同 identity 已提交 → NO_OP（committed_operation_replay）；
5. 相同 operation_id 异输入 → IdempotencyConflictError；
6. 新 operation_id → 按 §17 矩阵；
7. repeated submit：同 identity → NO_OP；异 id → 拒绝且不调
   Provider；
8. repeated poll：同 identity → NO_OP；新 id → 新 observation；
9. resume 不替代动作级 replay。

## 8. `_LayoutResolver`、目录创建与 artifact 比较路径

### 8.1 路径派生

| 目标 | 派生路径 | 依据 |
| --- | --- | --- |
| task | `records/generation-tasks/<task-id>.json` | ADR-0001 既有规则 |
| manifest | `manifests/generation-<task-id>.json` | 文件名规则 = ADR 增补项 |
| record | `records/orchestration/<task-id>.json` | ADR 增补项 |
| instruction | `tasks/instructions/<task-id>.md` | ADR 增补项 |

路径安全：project_root 显式、绝对化并规范化；四目标互异；文件名
与 task_id 匹配；全部目标位于 root 内；禁止 `..`/绝对子路径
逃逸；写前检查父目录与目标 symlink；symlink 出 root →
PersistenceExecutionError；instruction 路径不得与任何 artifact
比较路径等价；executor 写入集合闭合于四个派生路径。

### 8.2 目录创建与空目录残留

resolver 不执行 I/O；executor 首次写入前创建批准父目录（仅
`records/orchestration/`、`tasks/instructions/`、`manifests/`）；
`mkdir(parents=True, exist_ok=True)` 遵循 umask；不 chmod 已存在
目录；创建前后双重 containment/symlink 检查；创建失败 →
PersistenceExecutionError；不创建 artifact/media 目录；不扫描。
**空批准目录可安全残留**：部分创建失败后残留空目录不构成编排
状态、不代表 intent 已提交、无需回滚、可复用（复用时重新检查）；
不允许留下临时文件、半写 record 或半写 instruction。

### 8.3 本地 artifact 路径比较（逐组件 + 整目录保护）

只针对明确表示本地文件系统位置的 ArtifactReference。原值不变；
comparison path 只用于冲突判断。

逐组件规则：1. 从显式 project_root（相对）或绝对根开始；2. 对
每个已存在组件 lstat；3. 遇 symlink 受控 resolve；4. 每次
resolve 后重新检查（逃出允许根 / 等价于四类状态目标 / 落入禁止
目录）；5. 第一个不存在组件之后以已解析真实父路径为基准做 POSIX
lexical normalization；6. 已存在父组件无法安全解析 → 保守拒绝；
7. **整目录保护**：comparison path 等于或位于以下目录之下均
拒绝——`records/generation-tasks/`（**整个目录**，不限于当前
task 文件）、`manifests/`、`records/orchestration/`、
`tasks/instructions/`；不限于当前 task_id/manifest/record/
instruction；symlink resolve 后再次执行目录级拒绝；不存在
suffix 也基于已解析真实父路径判断；8. 只允许 lstat/resolve 路径
组件；9–12. 不打开媒体、不读内容、不媒体探测、不扫描目录。

lstat 组件检查不属于媒体内容探测；non-local ArtifactReference
不执行本地目录判断。

## 9. task/manifest 文件初始存在性

进入编排前必须已存在；传入快照必须与磁盘文件字节指纹一致；文件
缺失 → MissingProjectStateError；ABSENT marker 仅限 record 与
instruction；executor 不静默创建 task/manifest。

## 10. 深度不可变模型

### 10.1 统一冻结策略

dict/Mapping → 新 dict 包 MappingProxyType；list → tuple；set →
frozenset；递归；输入 defensive copy；输出 thaw；不保存调用方可
变引用。新增模型 frozen+slots；含 payload 的模型显式
`__hash__ = None`。覆盖：instruction 文档、全部 snapshot
wrapper、两个 pending variant、`_StableStateSnapshot`、
fingerprint maps、output_metadata 进度节、plan 摘要。

### 10.2 公开 OrchestrationPlan（深度冻结摘要，不可执行）

不暴露 GenerationTask/StepManifest/任何含可变 dict 的模型实例。
字段：plan_id、operation_id、action、三 ID、baseline_version、
request/result fingerprint、before/after fingerprint 映射、
task_after_snapshot（冻结 wrapper）、manifest_after_snapshot
（冻结 wrapper）、instruction_fingerprint（或 ABSENT）、
legal_actions、preferred_next_action、artifact_handoff、
to_json_dict。`__hash__ = None`。
`OrchestrationOutcome.updated_task/updated_manifest`：属性每次
访问经 §16.4 adapter 从冻结 snapshot 重建新实例。executor 只
使用内部 `_ExecutablePlan`。

## 11. durable intent / WAL 协议

### 11.1 相位

```python
class RecordPhase(str, Enum):
    STABLE = "stable"
    PROVIDER_CALL_INTENT = "provider_call_intent"
    PROVIDER_CALL_MAY_HAVE_STARTED = "provider_call_may_have_started"
    PROVIDER_RESULT_UNKNOWN = "provider_result_unknown"
    APPLYING = "applying"
    RECOVERY_REQUIRED = "recovery_required"


class RecoveryDisposition(str, Enum):
    NONE = "none"
    SAFE_AUTO_RETRY = "safe_auto_retry"
    MANUAL_RECONCILIATION = "manual_reconciliation"
    CONFLICT = "conflict"
```

record 文件 = §13.0 唯一顶层 envelope，位于
`records/orchestration/<task-id>.json`；无第三目录、无 journal。

### 11.2 `_PendingProviderCall`（pre-result variant）

required keys：pending_call_schema_version(=1)；
variant="provider_call"；operation_id；action；baseline_version；
request_snapshot（wrapper）；request_fingerprint；
action_input_snapshot（§16.6 action_input wrapper：observed_at、
artifact wrapper 或 null、completed_at 或 null、
result_fingerprint 或 null）；action_input_fingerprint（对该
wrapper 计算）；
original_observed_at；original_completed_at（或 null）；
artifact input（wrapper，或 null）；call_phase
（PROVIDER_CALL_INTENT / PROVIDER_CALL_MAY_HAVE_STARTED /
PROVIDER_RESULT_UNKNOWN）；call_may_have_started: bool；
started_at；recovery_policy。

**必须不存在**（strict parser 拒绝出现）：plan_id、
result_snapshot、result_fingerprint、after snapshots、
instruction_after_text、after fingerprints、planned stable
state。

### 11.3 `_PendingApply`（post-result executable variant）

required keys：pending_apply_schema_version(=1)；
variant="apply"；operation_id；action；baseline_version；
request_snapshot / request_fingerprint；action_input_snapshot /
action_input_fingerprint；result_snapshot（wrapper）/
result_fingerprint；plan_id；完整 before fingerprints（键集合：
task、manifest、instruction、stable_record——首次操作
stable_record = ABSENT）；task_after_snapshot（wrapper）/
task_after_fingerprint；manifest_after_snapshot（wrapper）/
manifest_after_fingerprint；instruction_after_text /
instruction_after_fingerprint（或 ABSENT 对）；
planned_stable_state_snapshot（`_StableStateSnapshot` wrapper，
非 envelope）/ planned_stable_state_wrapper_fingerprint；
confirmed_writes；recovery_disposition；original_observed_at；
post-commit legal_actions；post-commit preferred_next_action。

payload 表达与重建：task/manifest after 经 §16.4 adapter；
instruction_after_text 保存完整 Unicode 字符串（重编码 UTF-8 后
必须逐字节等于 expected bytes；after fingerprint 对该 bytes
计算；无 base64）。恢复时经公开构造函数/adapter 重建并重算
fingerprint 比对；不用 `object.__new__`。

### 11.4 多文件 CAS 与原子写入

执行前逐项校验：task/manifest/instruction 文件指纹 ==
before.*（instruction 可 ABSENT）；stable baseline（有 stable：
stable.version == baseline 且自指纹 == before.stable_record；无
stable：baseline == 0 且 before.stable_record == ABSENT）；
pending 与 plan_id 一致。失败 → BaselineMismatchError 或
PartialCommitConflictError。

原子写入协议：同目录临时文件 → 完整 UTF-8 → flush → fsync →
`os.replace` → 清理。persistence.py 核对（依据源码）：
`write_model_json(..., overwrite=True)` 满足该协议——task/
manifest 直接复用；envelope/instruction 由 executor 私有
`_atomic_write_bytes` 落盘。不修改 persistence.py。

写入顺序：1. 原子写 envelope（含 intent）；2. 校验 before
fingerprints；3. task；4. manifest；5. instruction；6. 提示性
更新 phase/confirmed_writes；7. 最后原子写 STABLE envelope
（stable = planned snapshot、pending = null）。

### 11.5 phase transition 表

| # | 转换 | 条件 | 原子落盘内容 | 可调 Provider | 可自动重试 | 恢复入口 | 返回 | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | STABLE → PROVIDER_CALL_INTENT | pre-call intent 落盘（submit/collect **必须基于既有 stable**；∅ 下二者为 E-state，不产生 intent） | envelope{INTENT, stable=既有（required）, pending=`_PendingProviderCall`} | 尚不允许 | 是 | §14 C1 | — | PersistenceExecutionError |
| 2 | INTENT → MAY_HAVE_STARTED | 紧邻调用前原子更新 | call_phase + 布尔 | **落盘成功后才允许调用** | — | §14 C2/C3 | — | 落盘失败（Provider 未调用） |
| 3 | MAY_HAVE_STARTED → RESULT_UNKNOWN | 重启后无法确认是否实际调用（保守窗口） | call_phase 标注 | 否 | 否 | resume | Assessment（manual） | 自动动作 → UnknownProviderSideEffectError |
| 4 | MAY_HAVE_STARTED → APPLYING | result 已取得；variant 原子切换 | envelope{APPLYING, pending=`_PendingApply`} | 已完成 | 是 | §14 P3 | — | 落盘失败按结果未知处理 |
| 5 | STABLE/∅ → APPLYING（直接路径） | prepare/poll/report_artifact/replay_result；首次 prepare 即原子创建 envelope（§13.0.2） | envelope{APPLYING, stable=既有或 null, pending=`_PendingApply`} | 调用先行 | 是 | §14 P3 | — | 返回后落盘前崩溃：无可恢复 result，仅因契约安全重试才允许重调（§12） |
| 6 | APPLYING → APPLYING | 某文件写入完成 | confirmed_writes（提示） | 否 | 是 | 指纹判定补写 | — | PartialCommitConflictError |
| 7 | APPLYING → STABLE | 全部文件 == after；STABLE envelope 最后写 | envelope{STABLE, stable=planned, pending=null} | 否 | — | — | Outcome(APPLIED) | 落盘失败 → 重试本转换 |
| 8 | 任意非 STABLE → RECOVERY_REQUIRED | 既非 before 也非 after / 指纹不一致 / 自指纹失败 / request 冲突 / schema 损坏 / 结果未知无法解除 | 评估态 | 否 | 否 | resume | Assessment | 按成因抛 §15 对应错误 |

### 11.6 planned stable state 不变量（两种指纹，独立定义）

`planned_stable_state_snapshot` 的类型是 `_StableStateSnapshot`
（wrapper kind = orchestration_stable_state），**不是 envelope**：
不含 phase；不含 pending；不含 record_schema。

**两种指纹严格分离——独立命名、独立计算、独立验证，二者之间
不存在相等不变量**：

1. **stable 自指纹**（payload 内嵌字段
   `stable_record_fingerprint`）：对 payload 中除该字段自身外的
   全部 stable 字段的 canonical JSON 计算（§13.1 规则）；恢复时
   按 §13.2 读取协议复验；
2. **wrapper 指纹**（`_PendingApply` 字段
   `planned_stable_state_wrapper_fingerprint`）：对完整 wrapper
   （snapshot_kind + snapshot_version + 含已内嵌自指纹的
   payload）的 canonical JSON 计算（§16.5 snapshot 通则）；恢复
   时按 §16.4 adapter 规则复验。

其余不变量：version = baseline_version + 1；committed file
fingerprints == pending 的 after fingerprints；last committed
operation/action/input/plan 与 pending 一致；legal_actions /
preferred 与 pending post-commit 值一致。

### 11.7 跨字段一致性不变量（strict parser 强制）

**`_PendingProviderCall`**：

- 所在 envelope 的 stable 必须非 null（submit/collect 必须基于
  既有 stable，§13.0）；
- call_phase == INTENT ⇔ call_may_have_started == False；
- call_phase == MAY_HAVE_STARTED ⇒ call_may_have_started ==
  True；
- call_phase == RESULT_UNKNOWN ⇒ call_may_have_started ==
  True；
- action 只能是需要 pre-call intent 的动作（submit、collect）；
- request_snapshot 的 wrapper fingerprint ==
  request_fingerprint；
- action_input_snapshot 的 fingerprint ==
  action_input_fingerprint；
- snapshot 中的 observed_at == original_observed_at；
- snapshot 中的 completed_at == original_completed_at；
- snapshot 中的 artifact input == 独立 artifact 字段；
- 不允许包含 result、plan 或 after payload。

**`_PendingApply`**：

- result_snapshot fingerprint == result_fingerprint；
- task snapshot fingerprint == task_after_fingerprint；
- manifest snapshot fingerprint == manifest_after_fingerprint；
- instruction UTF-8 bytes fingerprint ==
  instruction_after_fingerprint；
- planned stable snapshot 的 **wrapper 指纹** ==
  planned_stable_state_wrapper_fingerprint（§11.6 指纹 2）；
- planned stable payload 的**内嵌自指纹**按 §13.1 规则独立复验
  （§11.6 指纹 1；两种指纹无相等不变量）；
- planned stable state：不含 pending；不含 record envelope；
  version = baseline + 1；committed fingerprints == after
  fingerprints；committed operation/action/input/plan 与
  pending 一致；
- post-commit legal_actions == planned stable legal_actions；
- preferred_next_action ∈ legal_actions 或 None；
- 所在 envelope phase 只能是 APPLYING；
- pending apply 不能递归包含自身。

任何不一致：InvalidRecoveryRecordError（保留底层 cause）；不
进入自动恢复。

## 12. Provider 动作的最终 pre-call 决定

| 动作 | 路径 | TASK-003 契约依据 | 崩溃于调用后/落盘前 | disposition |
| --- | --- | --- | --- | --- |
| prepare | 直接路径 | architecture.md §3 prepare="准备输入"，不创建远端任务；TASK-003 测试锁定确定性 | 同输入可安全重调 | SAFE_AUTO_RETRY |
| poll | 直接路径 | architecture.md §3 poll="查询任务进展"（只读）；TASK-003 docstring | 同输入可安全重调 | SAFE_AUTO_RETRY |
| report_artifact | 直接路径（poll 变体） | 同 poll | 同上 | SAFE_AUTO_RETRY |
| replay_result | 直接路径（不调 Provider） | 不适用 | 未落盘即无事发生 | SAFE_AUTO_RETRY |
| collect | **pre-call intent** | 契约未提供 collect 重试安全性保证（architecture §5 允许向 staging 落格） | **进入 RESULT_UNKNOWN / manual** | MANUAL_RECONCILIATION |
| submit | **pre-call intent** | 契约不接收 operation_id、不保证远端去重、无 reconcile | RESULT_UNKNOWN；**绝不自动 resubmit** | MANUAL_RECONCILIATION |

submit/collect 序列：envelope{INTENT} → MAY_HAVE_STARTED →
调用 → 规范化 + result_fingerprint → variant 切换
`_PendingApply` → 写入序列 → STABLE。本地 operation_id ≠ 远端
幂等键，不能阻止远端重复计费；解除 unknown 属后续任务。

## 13. OrchestrationRecord

### 13.0 唯一顶层 envelope

```json
{
  "record_schema": {
    "kind": "orchestration_record",
    "version": 1
  },
  "phase": "<RecordPhase value>",
  "stable": "<_StableStateSnapshot wrapper | null>",
  "pending": "<_PendingProviderCall | _PendingApply | null>"
}
```

`record_schema.kind` = 固定字符串 `"orchestration_record"`；
`record_schema.version` = 固定整数 `1`。strict parser 拒绝：
unknown keys；missing keys；unknown kind；unknown version；
phase 与 stable/pending 不一致；同时出现两个 pending variant；
STABLE 时 pending 非 null；APPLYING 时 pending 不是
`_PendingApply`；INTENT/MAY_HAVE_STARTED/RESULT_UNKNOWN 时
pending 不是 `_PendingProviderCall`；**Provider-call 三相位
（INTENT/MAY_HAVE_STARTED/RESULT_UNKNOWN）携带 stable=null**；
RECOVERY_REQUIRED 下无法识别的 pending 内容。

**phase × envelope 不变量表**：

| phase | stable | pending | 允许场景 |
| --- | --- | --- | --- |
| STABLE | required | null | 已提交稳定状态 |
| PROVIDER_CALL_INTENT | **required** | `_PendingProviderCall` | pre-call intent（submit/collect 必须基于既有 stable） |
| PROVIDER_CALL_MAY_HAVE_STARTED | **required** | `_PendingProviderCall` | 可能已调用 |
| PROVIDER_RESULT_UNKNOWN | **required** | `_PendingProviderCall` | 结果未知 |
| APPLYING | null（**仅首次 prepare**）或 required | `_PendingApply` | 正在应用 |
| RECOVERY_REQUIRED | null（**仅源自首次 prepare 的 APPLYING 分支**）或 required | nullable / 保留原 pending | 禁止自动动作 |

- `stable=null` **只允许首次 prepare 的 APPLYING 及其
  RECOVERY_REQUIRED 分支**（首个 STABLE 提交前）；三个
  Provider-call 相位一律要求 stable——`_PendingProviderCall.
  action` 仅允许 submit/collect，而二者必须基于既有 stable，
  因此 Provider-call 相位携带 stable=null 的 envelope 无法
  成立，strict parser 一律拒绝；首个 STABLE 提交后，后续非
  STABLE record 必须保留此前 stable snapshot；**首次/后续的
  判定依据是 envelope 中 stable 是否为 null，不得用 version=0
  猜测**；
- pending 不能覆盖或替代 stable；stable = 最后已提交状态、
  pending = 下一操作的 durable intent，两个事实来源不得合并。

#### 13.0.1 首次操作 baseline（定案）

首次操作前：record 文件不存在；概念上 stable=null、
pending=null、conceptual baseline version = **0**、conceptual
stable-record before fingerprint = **ABSENT**；ABSENT 与整数 0
不得混用。不合成虚假空 STABLE；不构造 version=0 伪稳定状态；
pending 不直接成为顶层；envelope 永不省略。

submit/collect 需要既有 stable——首次操作必然是 prepare 的直接
路径；∅ 下的 submit/collect 为 E-state（§17.2），不产生任何
intent envelope；Provider-call 相位 stable=null 的 envelope 由
strict parser 拒绝（§13.0）。

#### 13.0.2 首次 prepare 的 record 创建与恢复

首次 prepare 完成调用并形成 `_PendingApply` 后**原子创建**
record 文件：phase=APPLYING、stable=null、
pending=`_PendingApply`、baseline_version=0、
before_fingerprints["stable_record"]=ABSENT、task/manifest
before 来自已存在文件（§9）、instruction before 可 ABSENT。

**首次操作的初始前置条件（收紧，构成痕迹判定基础）**：
task.provider_id 必须为 None（§7.1）；manifest.output_metadata
不含 `"orchestration"` 键；instruction 文件不存在。由此首次写入
序列的每一步都建立可明确识别的持久痕迹（task 写入 →
provider_id 置位；manifest 写入 → orchestration 键出现；
instruction 写入 → 文件存在），record 在任一切点后丢失均可被
§13.5 痕迹集合保守识别，不会误判为全新基线。

首次 `_PendingApply` 落盘后的恢复：task 未写 → 按 after
snapshot 补写；task 已写、manifest 未写 → 跳过 task 补写
manifest；manifest 已写、instruction 未写 → 补写 instruction；
所有文件为 after → 提交首个 STABLE；任一既非 before 也非
after → RECOVERY_REQUIRED；record 丢失 → §13.5（每个切点均有
痕迹可识别），不反向重建。

首次成功提交的 STABLE：**version=1**；pending=null；committed
三文件指纹写入；last committed operation/action/input/plan
identity 写入；stable_record_fingerprint 重算；phase=STABLE。
stable version 从 1 开始；baseline 0 只表示"此前没有 STABLE
record"；后续 baseline 使用现有 stable.version。

后续操作：stable snapshot 必须存在；baseline =
stable.version；pending 与 stable 并存；pending 成功后替换
stable；pending 失败不破坏 previous stable。

### 13.1 `_StableStateSnapshot` 字段

（wrapper kind = orchestration_stable_state，§16.6。）

身份与版本：task_id、shot_id、provider_id、
stable_schema_version(=1)、version（≥1，单调）。操作身份：
last_committed_plan_id、last_committed_operation{operation_id,
action, request_fingerprint, action_input_fingerprint,
observed_at}。committed fingerprints：committed_task_
fingerprint、committed_manifest_fingerprint、
committed_instruction_fingerprint（或 ABSENT）、
committed_request_fingerprint、committed_result_fingerprint。
自指纹：stable_record_fingerprint（对除自身外全部 stable 字段的
canonical JSON 计算；不参与 plan_id）。权威快照（wrapper 形
式）：request_snapshot、request_fingerprint、
instruction_snapshot（prepare 后固化）、
instruction_fingerprint、authoritative_external_task_ref、
authoritative_artifact、authoritative_error_summary、
authoritative_completed_at、last_result_snapshot、
last_result_fingerprint。导航：last_completed_action、
legal_actions、preferred_next_action、updated_at。（pending 是
envelope 平级字段，不在 snapshot 内。）

### 13.2 STABLE 读取协议（自指纹先行）

1. 取出持久化 stable_record_fingerprint；2. 排除该字段；3. 其余
stable 字段 canonical JSON；4. 重算 SHA-256；5. 比较。不一致：
不解析、不调用 Provider、不写任何状态文件；resume 返回
RECOVERY_REQUIRED（legal=()、requires_manual=True）；自动动作抛
**CorruptStableRecordError**。通过后才验证三个 committed file
fingerprints；不符 → PartialCommitConflictError。

### 13.3 sticky merge 矩阵

| 情形 | instruction | external_task_ref | artifact | error info | completed_at |
| --- | --- | --- | --- | --- | --- |
| 1 None←None | preserve | preserve | preserve | preserve | preserve |
| 2 None←value | set（仅 PREPARE 合法产生，否则 IllegalProviderTransitionError） | set | set | set（仅 failed 结果） | set（仅终态结果） |
| 3 value←None | preserve | preserve | preserve | preserve | preserve |
| 4 value←same | no-op | no-op | no-op | no-op | no-op |
| 5 value←different | conflict → ConflictingProviderResultError | legal replacement 仅当非终态且随 newer observed_at 合法转换；否则 conflict | conflict | conflict | conflict |
| 6 terminal 下变更 | conflict | conflict | conflict | conflict | conflict |
| 7 replay 下变更 | 不可能（同 fingerprint 即同字段），字段异按行 5/6 | 同左 | 同左 | 同左 | 同左 |

### 13.4 request 一致性

重算调用方 request 指纹与 stable.request_fingerprint 比较
（首次无 stable 跳过）；不一致 → ConflictingRequestError（不是
"record 损坏"）。

### 13.5 record 丢失

record 是唯一权威。丢失/不可读不反向重建、不扫描猜测、不生成新
record、不调用 Provider、不自动写入。

**编排痕迹集合（保守判定，任一命中即有痕迹）**：

- task.provider_id 非 None（首次前置条件收紧为必须 None，§7.1，
  故任何 orchestrated task 写入后该项必然命中——首次 task 已写
  而 record 丢失的切点由此可识别）；
- task.status 非 pending；
- current_artifact_ref / external_task_ref / completed_at 任一
  非空；
- manifest.output_metadata 含 `"orchestration"` 键（首次
  manifest 已写切点由此可识别）；
- instruction 文件存在（首次 instruction 已写切点由此可识别）。

有痕迹 → resume 返回 RECOVERY_REQUIRED；自动动作抛
MissingRecoveryRecordError。**无痕迹（上述全部不命中）= 正常
初始态，不是错误**，进入正常 PREPARE（ABSENT CAS 纵深防护）。
写入顺序 task→manifest→instruction 的**每个部分提交切点**都被
该集合覆盖：record 在任一切点后丢失均判为有痕迹，不会被误判为
全新基线而重复 prepare。人工修复属后续运维。

## 14. 恢复矩阵

| # | 观察 | 判定 | 自动行为 | disposition |
| --- | --- | --- | --- | --- |
| C1 | `_PendingProviderCall`，INTENT | Provider 确定未调用 | 同 identity 重入合法；resume=assessment(legal=(pending.action,)) | SAFE_AUTO_RETRY |
| C2 | pending(submit)，MAY_HAVE_STARTED | 结果未知 | 绝不 resubmit；自动动作 → UnknownProviderSideEffectError | MANUAL_RECONCILIATION |
| C3 | pending(collect)，MAY_HAVE_STARTED | 结果未知 | 同 C2 | MANUAL_RECONCILIATION |
| P3 | `_PendingApply`（stable 可为 null——首次 prepare；stable 非 null——后续操作） | 继续执行 | 重建 after → 指纹判定补写 → STABLE（首次生成 version=1；后续替换 stable） | SAFE_AUTO_RETRY |
| P4–P7 | 部分/全部写入完成 | 按文件指纹（==before 补写、==after 跳过、STABLE 未写补提交） | 补写 | SAFE_AUTO_RETRY |
| P8 | phase/confirmed_writes 未更新但文件已写 | 以实际指纹为准 | 同 P4–P7 | SAFE_AUTO_RETRY |
| P9 | 某文件既非 before 也非 after | 外部篡改 | 自动动作 → PartialCommitConflictError | CONFLICT |
| S0 | stable 自指纹不一致 | record 不可信 | 自动动作 → CorruptStableRecordError | MANUAL_RECONCILIATION |
| S1 | 自指纹正确但 committed file fingerprint 不一致 | 外部改动 | 自动动作 → PartialCommitConflictError | CONFLICT |
| E1 | envelope schema 违规（unknown key/kind/version、phase 不一致、双 variant、STABLE 带 pending、跨字段不变量违规） | 恢复数据无效 | InvalidRecoveryRecordError（保留 cause） | MANUAL_RECONCILIATION |
| R1 | record 丢失 + 编排痕迹 | 权威缺失 | 不重建；自动动作 → MissingRecoveryRecordError | MANUAL_RECONCILIATION |
| R2 | record 丢失 + 无痕迹 | 正常初始态 | 进入正常 prepare | NONE |
| R3 | request fingerprint 不一致 | 请求漂移 | ConflictingRequestError | CONFLICT |
| R4 | 响应丢失后同 identity 重放 | 已提交 | NO_OP | NONE |

## 15. 错误体系

```
AiVideoWorkflowError
└── OrchestrationError
    ├── InvalidOrchestrationInputError
    ├── InvalidOrchestrationStateError
    ├── IllegalProviderTransitionError
    ├── StaleResultError
    ├── ConflictingProviderResultError
    ├── ConflictingRequestError
    ├── IdempotencyConflictError
    ├── BaselineMismatchError
    ├── PartialCommitConflictError
    ├── UnknownProviderSideEffectError
    ├── MissingRecoveryRecordError
    ├── MissingProjectStateError
    ├── InvalidRecoveryRecordError
    │   └── CorruptStableRecordError
    ├── CanonicalizationError
    ├── PersistencePlanningError
    └── PersistenceExecutionError
```

envelope/schema/跨字段错误 → InvalidRecoveryRecordError（保留
cause）；STABLE 自指纹错误 → CorruptStableRecordError；首次无
record 且无痕迹 → 不是错误（正常 prepare）；无 record 但有
痕迹 → MissingRecoveryRecordError。resume 一律返回 Assessment
（除 context 非法）；ProviderError 原样传播；正常状态经
OutcomeKind 表达。

## 16. canonical JSON、无环指纹与模型适配

### 16.1 canonical JSON

单一 `_canonical_json_bytes`：key 必须 str → NFC → 排序前检测
NFC 后重复 key → 碰撞拒绝（CanonicalizationError）→ 递归；key
按 code point 排序；`separators=(",", ":")`；
`ensure_ascii=False`；`allow_nan=False`；UTF-8 无 BOM；字符串值
NFC；datetime aware UTC 固定
`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`；Enum→value；tuple→array；
MappingProxyType→thaw；非有限 float 拒绝；`-0.0`→`0.0`；bool
优先于 int；unknown type → CanonicalizationError。

### 16.2 无环计算顺序（固定九步）

1. operation_id 调用方提供；2. request_fingerprint；3.
result_fingerprint（取得结果后）；4. 构造 task/manifest after
snapshot；5. 计算 task/manifest after fingerprint；6.
**plan_id 只基于 core preimage**；7. plan_id 完成后渲染
instruction bytes；8. 计算 instruction_after_fingerprint；9.
最后构造 planned stable state payload → 计算并内嵌其**自指纹**
（排除自身字段，§13.1 规则）→ 包装 wrapper → 计算
**planned_stable_state_wrapper_fingerprint**（§16.5 snapshot
通则）。instruction_after_fingerprint 不反向参与 plan_id；两种
planned stable 指纹均不参与 plan_id；自指纹不参与自身。

### 16.3 plan_id core preimage（精确固定）

```json
{
  "plan_preimage_schema_version": 1,
  "operation_id": "...",
  "action": "...",
  "baseline_version": "...",
  "request_fingerprint": "...",
  "result_fingerprint": "...",
  "task_before_fingerprint": "...",
  "task_after_fingerprint": "...",
  "manifest_before_fingerprint": "...",
  "manifest_after_fingerprint": "...",
  "instruction_before_fingerprint": "...",
  "observed_at": "...",
  "completed_at": "...",
  "artifact_input_fingerprint": "..."
}
```

**PLAN_PREIMAGE_SCHEMA_VERSION = 1**（独立常量，字段名固定为
plan_preimage_schema_version，避免泛化 schema_version）：类型
必须 int；bool 不允许；当前唯一支持值 1；**不复用** record
envelope version、stable snapshot version、pending variant
versions、project model serialization version；plan_id 算法升级
时必须递增；unknown plan schema version 拒绝。

明确排除：plan_id 自身；instruction_after_fingerprint；
instruction after bytes；planned stable state fingerprint；任何
包含 plan_id 的数据。fingerprint map 键集合：
before_fingerprints = {task, manifest, instruction,
stable_record}（首次 stable_record=ABSENT）；after_fingerprints
= {task, manifest, instruction}。

### 16.4 模型 adapter 与 wrapper 的关系（精确定义）

`_snapshot_generation_task(task)`：调用 `model_to_dict(task)` →
验证结果是 JSON Mapping → 包装为 generation_task snapshot
wrapper → canonical freeze → 计算 **wrapper fingerprint**。
`_restore_generation_task(snapshot)`：验证 wrapper
kind/version → 取出 payload → `model_from_dict(payload,
GenerationTask)` → 验证精确类型为 GenerationTask（重跑现有模型
不变量）→ 重新 snapshot 并比较 canonical fingerprint → 不一致
InvalidRecoveryRecordError。StepManifest 同规则。
ProviderRequest / ProviderResult：经 orchestration recovery
adapter 调用对应公开构造函数，恢复后重新 snapshot，fingerprint
必须一致。不修改 serialization registry。

### 16.5 指纹输入定义

| 指纹 | 输入 |
| --- | --- |
| request_fingerprint | provider_request **wrapper** 的 canonical JSON |
| result_fingerprint | provider_result wrapper 的 canonical JSON |
| instruction_fingerprint | provider_instruction wrapper 的 canonical JSON |
| task/manifest after fingerprint | 对应 snapshot wrapper 的 canonical JSON |
| task/manifest/instruction 文件指纹 | 文件精确字节 sha256 |
| instruction_after_fingerprint | 渲染后最终 UTF-8 bytes |
| stable_record_fingerprint（自指纹，含 planned payload 内嵌值） | stable 字段（除自身）canonical JSON |
| planned_stable_state_wrapper_fingerprint | orchestration_stable_state **完整 wrapper** 的 canonical JSON（§11.6 指纹 2，与自指纹无相等不变量） |
| plan_id | §16.3 core preimage 的 canonical JSON |
| action_input_fingerprint | action_input **wrapper** 的 canonical JSON（§16.6 第八种 kind） |
| artifact_input_fingerprint | artifact 输入 wrapper 的 canonical JSON（无则 "absent"） |

snapshot 类指纹一律对**完整 wrapper**（kind + version +
payload）计算——wrapper 版本升级自然改变指纹，属预期演进。

### 16.6 嵌套 snapshot wrapper（统一版本化）

全部嵌套 snapshot 一律使用显式版本化 wrapper，不保存无版本裸
dict：

```json
{
  "snapshot_kind": "<kind>",
  "snapshot_version": 1,
  "payload": {}
}
```

kind 清单：

| snapshot_kind | payload | restore |
| --- | --- | --- |
| provider_request | ProviderRequest.to_json_dict() | recovery parser（公开构造函数） |
| provider_result | ProviderResult.to_json_dict() | recovery parser |
| provider_instruction | ProviderInstruction.to_json_dict() | recovery parser |
| artifact_reference | ArtifactReference.to_json_dict() | recovery parser |
| generation_task | model_to_dict(task) | `_restore_generation_task` |
| step_manifest | model_to_dict(manifest) | `_restore_step_manifest` |
| orchestration_stable_state | `_StableStateSnapshot` 字段 | §20 strict parser |
| action_input | {observed_at, artifact（artifact_reference wrapper 或 null）, completed_at 或 null, result_fingerprint 或 null} | §20 strict parser |

每种 wrapper 必须：kind 固定；version 固定整数 1；required
keys 精确；unknown keys 拒绝；unknown kind/version 拒绝；
payload 类型严格；restore 后重新计算 fingerprint；fingerprint
与 wrapper 内容一致；**不复用** record envelope version、
pending variant version、plan preimage version。

## 17. 完整生命周期矩阵（13 状态 × 7 动作 = 91 格）

### 17.1 状态集合

1. ∅；2. not_submitted；3. waiting_for_user；4. processing；
5. artifact_available；6. succeeded；7. failed；8. cancelled
（2–8 = STABLE 相位按 stable.last_result.status）；
9. PROVIDER_CALL_INTENT；10. PROVIDER_CALL_MAY_HAVE_STARTED；
11. PROVIDER_RESULT_UNKNOWN；12. APPLYING；
13. RECOVERY_REQUIRED。相位行 9–10 携带 pending.action 参数；两
CALL 相位不合并。

### 17.2 准入表（91 格）

| 状态 \ 动作 | prepare | submit | poll | report_artifact | collect | replay_result | resume |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ∅ | CALL-D(prepare)⑦ | E-state | E-state | E-state | E-state | E-state | A: legal=(PREPARE,), pref=PREPARE |
| not_submitted | NOOP(repeated_prepare) | CALL-I(submit) | E-state | E-state | E-state | APPLY§18 | A: legal=(SUBMIT,), pref=SUBMIT |
| waiting_for_user | E-state | E-state① | CALL-D(poll) | CALL-D(poll+artifact) | CALL-I(collect) | APPLY§18 | A: legal=(POLL, REPORT_ARTIFACT, COLLECT), pref=POLL |
| processing | E-state | E-state | CALL-D(poll) | CALL-D(poll+artifact) | E-state | APPLY§18 | A: legal=(POLL, REPORT_ARTIFACT), pref=POLL |
| artifact_available | E-state | E-state | CALL-D(poll)② | CALL-D(poll+artifact)② | CALL-I(collect) | APPLY§18 | A: legal=(POLL, REPORT_ARTIFACT, COLLECT), pref=COLLECT |
| succeeded | E-state | E-state | E-state | E-state | NOOP(already_collected)③ | NOOP(terminal_replay)④ | A: terminal, legal=() |
| failed | E-state | E-state | E-state | E-state | E-state | NOOP(terminal_replay)④ | A: terminal, legal=() |
| cancelled | E-state | E-state | E-state | E-state | E-state | NOOP(terminal_replay)④ | A: terminal, legal=() |
| PROVIDER_CALL_INTENT | REDRIVE⑤ 或 E-state | REDRIVE⑤ 或 E-state | E-state | E-state | REDRIVE⑤ 或 E-state | E-state | A: legal=(pending.action,), pref=pending.action, disposition=SAFE_AUTO_RETRY |
| PROVIDER_CALL_MAY_HAVE_STARTED | E-unknown | E-unknown | E-unknown | E-unknown | E-unknown | E-unknown | A: manual, legal=(), disposition=MANUAL_RECONCILIATION |
| PROVIDER_RESULT_UNKNOWN | E-unknown | E-unknown | E-unknown | E-unknown | E-unknown | E-unknown | A: manual, legal=(), disposition=MANUAL_RECONCILIATION |
| APPLYING | REPAIR⑥ | REPAIR⑥ | REPAIR⑥ | REPAIR⑥ | REPAIR⑥ | REPAIR⑥ | A: disposition=SAFE_AUTO_RETRY（补写后返回 STABLE 评估） |
| RECOVERY_REQUIRED | E-recovery | E-recovery | E-recovery | E-recovery | E-recovery | E-recovery | A: manual, legal=(), disposition 按 §14 成因 |

单元格定义：

- **CALL-D(x)**：先操作身份判定（§7.2）；调 x → 校验返回状态
  （§17.3）→ §18 判定 → 原子写 `_PendingApply` → 写入序列 →
  STABLE；APPLIED、plan 存在；⑦ ∅ 下首次 prepare 按 §13.0.2
  原子创建 envelope（stable=null、baseline=0、
  before.stable_record=ABSENT）；后续动作 envelope 必含既有
  stable（baseline=stable.version）；
- **CALL-I(x)**：同上，先 envelope{INTENT} →
  MAY_HAVE_STARTED → 调用 → `_PendingApply` → STABLE（§12）；
- **NOOP(reason)**：不调 Provider、零 persistence、plan=None；
  ③ artifact 与权威 handoff 等价 → NO_OP，不等价 →
  ConflictingProviderResultError；④ equal result fingerprint →
  NO_OP，不同 → ConflictingProviderResultError；
- **E-state**：InvalidOrchestrationStateError；① 含重复 submit
  防护；
- **E-unknown**：UnknownProviderSideEffectError；需人工；
- **E-recovery**：按成因抛 PartialCommitConflictError /
  CorruptStableRecordError / MissingRecoveryRecordError /
  InvalidRecoveryRecordError；需人工；
- **REDRIVE⑤**：仅当动作 == pending.action 且 identity 完全
  一致 → 重入；不一致 → IdempotencyConflictError；其他动作 →
  E-state；
- **REPAIR⑥**：入口先按 §14 P3–P8 自动补写至 STABLE（首次
  stable=null 时补写生成首个 version=1 STABLE；后续替换既有
  stable），随后按新 STABLE 状态重新评估该动作；遇 P9 →
  PartialCommitConflictError；
- **A**：resume 返回 ResumeAssessment；
- ② 幂等确认，newer observed_at 合法刷新。

### 17.3 动作 × Provider 合法返回状态（依据 TASK-003 实际契约）

TASK-003 批准设计明文允许未来 Provider 从 submit 或 poll 返回
processing / failed / cancelled，submit 亦可直达
artifact_available / succeeded。

| 动作 | 合法返回状态 | 非法返回 → 异常 |
| --- | --- | --- |
| prepare | not_submitted | 其余六种 → IllegalProviderTransitionError |
| submit | waiting_for_user、processing、artifact_available、succeeded、failed、cancelled | not_submitted → IllegalProviderTransitionError |
| poll | 同 submit 六种 | not_submitted → 同上 |
| report_artifact | 同 submit 六种 | not_submitted → 同上 |
| collect | succeeded | 其余六种 → 同上（终态失败观察授权给 submit/poll） |
| replay_result | 与 §18 相容的任何七状态 | 倒退 → IllegalProviderTransitionError；冲突 → ConflictingProviderResultError；陈旧 → StaleResultError |

### 17.4 GenerationTask 七字段矩阵

映射：not_submitted→pending；waiting/processing/available→
in_progress；succeeded→done；failed→failed；cancelled→cancelled
（Step M 前置）。

| 字段 \ ProviderStatus | not_submitted | waiting_for_user | processing | artifact_available | succeeded | failed | cancelled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| status | set(pending) | set(in_progress) | set(in_progress) | set(in_progress) | set(done) | set(failed) | set(cancelled) |
| updated_at | set·source=result.observed_at·required·必须 > 原值（equal 仅 NO_OP）·冲突=StaleResultError | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 |
| completed_at | forbidden | forbidden | forbidden | forbidden | set·required | set·required | set·required |
| provider_id | set（首次；source=request.provider_id；已有值必须相等，冲突=InvalidOrchestrationInputError） | preserve | preserve | preserve | preserve | preserve | preserve |
| external_task_ref | forbidden（Provider 矩阵禁止） | sticky | sticky | sticky | sticky | sticky | sticky |
| current_artifact_ref | preserve(None) | preserve | preserve | set·source=result.artifact.reference（sticky） | set/preserve（sticky） | preserve | preserve |
| error_summary | forbidden | forbidden | forbidden | forbidden | forbidden | set·required | **forbidden** |

补充：首次 task.provider_id=None 合法；terminal replay / NO_OP
不修改任何字段；stale/conflict 不产生 after task；clear 永不
发生。

### 17.5 StepManifest 五字段矩阵

| 字段 \ ProviderStatus | not_submitted | waiting_for_user | processing | artifact_available | succeeded | failed | cancelled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| status | preserve(PENDING) | preserve(PENDING) | preserve(PENDING) | preserve(PENDING) | **preserve(PENDING)**（COMPLETED 归后续资产任务） | set(FAILED)·required | preserve(PENDING)+取消标记 |
| output_paths | preserve·**永不新增** | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 |
| output_metadata | set：替换 `"orchestration"` 键，保留其他键 | 同左 | 同左 | 同左+artifact 元数据 | 同左+handoff 元数据 | 同左 | 同左+cancellation 标记 |
| completed_at | forbidden | forbidden | forbidden | forbidden | forbidden | set·required | forbidden |
| error_summary | forbidden | forbidden | forbidden | forbidden | forbidden | set·required | forbidden |

补充：terminal replay / NO_OP 不修改；stale/conflict 不生成
after manifest；partial recovery 只补写既定 after；已终态
manifest 拒绝再更新。

## 18. 时间权威规则

stable.version + durable operation 是提交顺序权威；observed_at
是 observation 验证字段。同一 baseline 内：older → Stale；
equal+equal fingerprint → NO_OP；equal+different →
ConflictingProviderResultError；newer+合法 → apply；newer+倒退
→ IllegalProviderTransitionError。状态秩：∅(-1) <
not_submitted(0) < {waiting, processing}(1，组内双向) <
artifact_available(2) < terminal(3)。clock skew 不洗白；重放同
fingerprint 不受当前时间影响。

## 19. instruction Markdown 契约（逐字节）

UTF-8、无 BOM、LF、末尾恰好一个换行。模板（顺序固定；缺失可选
值呈现 `none`；plan_id 已先行计算）：

```markdown
# Manual Video Generation Task

- schema_version: 1
- task_id: {task_id}
- shot_id: {shot_id}
- provider_id: {provider_id}
- operation_id: {operation_id}
- plan_id: {plan_id}
- request_fingerprint: {request_fingerprint}

## Prompt

{prompt 原文，独立纯文本节}

## Expected Output

- duration_seconds: {value}
- width: {value}
- height: {value}
- frame_rate: {value}
- staging_ref: {value}

## Steps

{instruction.steps 按 1. 2. 3. 编号}

## Suggested Parameters

```json
{suggested_parameters 的 canonical JSON}
```
```

覆盖规则：不存在 → 写入；== after → NO_OP；== before → 允许
替换；其余 → PartialCommitConflictError；不同 plan 触碰同一
路径即冲突。

## 20. strict recovery schema

envelope 与全部嵌套解析：输入必须 Mapping；required/unknown
keys 精确；record_schema.kind/version 精确；phase × envelope
不变量按 §13.0 表强制；三个内层 schema_version 与全部
snapshot_version 各自精确校验（互不复用、unknown 拒绝）；
variant discriminator 精确；§11.7 跨字段一致性全部强制；
Enum/datetime 精确；bool/int 严格；provider 模型经公开构造函数
重建、task/manifest 经 adapter 重建、重算指纹比对。底层错误统一
包装 InvalidRecoveryRecordError 保留 cause；stable 自指纹失败 →
CorruptStableRecordError；request 指纹不一致 →
ConflictingRequestError。

## 21. 文件计划（完整披露）

**Step M（gate 后）**：models.py、tests/test_models.py、
tests/test_serialization.py。**ADR 同步（复审通过后）**：
ADR-0001 实际文件。

**新增源文件与唯一归属**：

- `orchestration/__init__.py`——公开导出；
- `orchestration/errors.py`——§15 错误树；
- `orchestration/models.py`——公开摘要模型与 Enum；
- `orchestration/_models.py`——`_PendingProviderCall`、
  `_PendingApply`、`_ExecutablePlan`、`_StableStateSnapshot`、
  envelope 构造；
- `orchestration/canonical.py`——plan preimage
  （PLAN_PREIMAGE_SCHEMA_VERSION）、canonical JSON、NFC
  collision、全部指纹、stable self fingerprint、snapshot
  wrapper 工具；
- `orchestration/recovery.py`——envelope/variant strict
  parser、跨字段一致性、self-fingerprint verification、
  model_from_dict adapter、phase recovery；
- `orchestration/planning.py`——无环 plan 计算、after payload
  构造、矩阵/映射/sticky/时间判定；
- `orchestration/layout.py`——per-component symlink
  resolution、nonexistent suffix handling、整目录级
  state-directory rejection；
- `orchestration/executor.py`——phase writes、CAS、approved
  parent creation、empty directory residue、
  `_atomic_write_bytes`、partial recovery；
- `orchestration/instructions.py`——exact bytes renderer；
- `orchestration/orchestrator.py`——公开操作身份与七个动作
  入口。

**新增测试文件**：test_orchestration_models、
test_orchestration_canonical、test_orchestration_planning、
test_orchestration_layout、test_orchestration_executor、
test_orchestrator。

**不修改**：persistence.py、serialization.py、manifest.py、
validation.py、顶层 errors.py、providers 包五文件、
project_data.py、README、pyproject.toml；architecture.md 不修改
的条件 = 内部化 executor 通过最终审查。

**分步实施归属由 §24 正式定义**（本节只固定按文件划分的
ownership；每个 Step 允许创建/修改哪些文件、对应哪些 §22 测试
编号，以 §24 为准）。

## 22. 测试计划（完整、自包含、连续编号）

契约与模型：

1. 公开 API 签名逐参数（含 operation_id）；
2. 公开导出集合精确；
3. 公开 plan 不暴露 StepManifest/GenerationTask 实例；
4. Outcome.updated_task/manifest 每次访问新实例；
5. 公开 snapshot 防御复制；
6. 新增模型 frozen/slots/`__hash__ = None` 契约；
7. 嵌套可变输入 defensive copy；MappingProxyType 深度冻结；
8. NO_OP 不变量；
9. 无隐藏时间/无隐藏状态；

canonical/指纹：

10. canonical JSON 确定性；
11. NFC 顶层 key collision 拒绝；
12. NFC 嵌套 key collision 拒绝；
13. 无 collision 的 Unicode 稳定排序；
14. allow_nan=False；NaN/Infinity 拒绝；`-0.0`→`0.0`；bool 不作
    int；
15. 各指纹输入与确定性（§16.5，含"snapshot 指纹对完整 wrapper
    计算"）；
16. request 重建指纹一致；prompt/dimensions/parameters/staging
    改变各触发 ConflictingRequestError；
17. plan_id 无环计算；
18. instruction 含 plan_id 后 fingerprint 稳定；
19. planned stable fingerprint 不参与 plan_id；
20. **plan preimage version 固定 int 1；bool 拒绝；unknown plan
    version 拒绝**；

envelope：

21. **envelope kind/version round-trip**（全相位）；
22. envelope unknown key / missing key 拒绝；
23. envelope unknown kind / unknown version 拒绝；
24. **phase × stable/pending 不一致拒绝**（STABLE 带 pending、
    APPLYING 带 `_PendingProviderCall`、INTENT 带
    `_PendingApply`、双 variant、RECOVERY_REQUIRED 无法识别
    pending 逐一）；
25. **首次 prepare record**：文件不存在 → 原子创建
    envelope{APPLYING, stable=null, baseline=0,
    before.stable_record=ABSENT}；
26. **首次 partial apply 恢复**（task 未写 / task 已写 manifest
    未写 / instruction 已写 STABLE 未写各分支）；
27. **首次 successful commit：version=1**、pending=null、
    committed fingerprints/identity 写入、自指纹重算；
28. ABSENT 与整数 0 不混用；
29. **后续 pending record 保留 previous stable**（stable=null
    仅限首次；违规拒绝）；
30. STABLE 时 pending 必须 null；APPLYING 时 pending 必须
    `_PendingApply`；CALL_INTENT 时 pending 必须
    `_PendingProviderCall`；

pending variants 与跨字段一致性：

31. `_PendingProviderCall` strict round-trip；
32. `_PendingApply` strict round-trip；
33. pre-call schema 禁止 plan_id/result/after；
34. post-result schema 要求 plan_id/after；
35. pending/stable/snapshot unknown version、unknown variant
    拒绝；
36. **pending call phase/boolean mismatch 拒绝**（INTENT 而
    call_may_have_started=True 等）；
37. **duplicated observed_at mismatch 拒绝**（snapshot 与
    original 不等）；
38. **duplicated completed_at mismatch 拒绝**；
39. **duplicated artifact mismatch 拒绝**；
40. **pending apply result fingerprint mismatch 拒绝**；
41. **pending apply task fingerprint mismatch 拒绝**；
42. **pending apply manifest fingerprint mismatch 拒绝**；
43. **pending apply instruction fingerprint mismatch 拒绝**；
44. **planned stable committed fingerprint mismatch 拒绝**；
45. **planned stable operation identity mismatch 拒绝**；
46. **planned_stable_state_snapshot 不变量**：不含
    phase/pending/record_schema；version=baseline+1；post-commit
    legal == planned legal；preferred ∈ legal 或 None；

snapshot wrapper：

47. 八种 kind 各自 round-trip（action_input 见 124–126；
    provider_request /
    provider_result / provider_instruction /
    artifact_reference / generation_task / step_manifest /
    orchestration_stable_state 的 kind/version）；
48. nested snapshot unknown version 拒绝；
49. nested snapshot wrong kind 拒绝；
50. restore 后重算 fingerprint 与 wrapper 一致（各 kind）；
51. task after payload 经 model_from_dict 重建 + 类型验证 +
    指纹复验；
52. manifest after payload 同上；
53. instruction after 文本重编码 UTF-8 逐字节等于 expected
    bytes；
54. after snapshot 与持久化指纹不一致 → 拒绝；
55. model_to_dict/model_from_dict adapter 双向（非 Mapping
    结果拒绝、类型不符拒绝）；

WAL/CAS/恢复：

56. phase transition 表逐行（§11.5 八行，原子落盘内容与顺序）；
57. submit：INTENT 落盘 → MAY_HAVE_STARTED 落盘 → 才调用
    Provider；
58. MAY_HAVE_STARTED 但 Provider 实际未调用的保守恢复；
59. submit MAY_HAVE_STARTED 未知结果 → 绝不 resubmit、
    UnknownProviderSideEffectError；
60. collect MAY_HAVE_STARTED → manual reconciliation；
61. PROVIDER_CALL_INTENT 的 REDRIVE（同 identity 重入；异
    identity → IdempotencyConflictError）；
62. prepare/poll/report_artifact 的 direct-to-APPLYING 路径；
63. 直接路径调用后、`_PendingApply` 落盘前崩溃 → 同输入安全
    重调；
64. 多文件 before fingerprint 逐项校验（含首次 ABSENT
    stable_record 分支）；
65. 部分写入补写全分支（后续操作组）；
66. confirmed_writes/phase 未更新但文件已写 → 指纹判定；
67. task/manifest 既非 before 也非 after →
    PartialCommitConflictError；
68. stable 自指纹正确路径（读取协议顺序断言）；
69. stable 内容篡改（指纹未更新）→ CorruptStableRecordError；
70. stable_record_fingerprint 字段篡改 → 同上；
71. 自指纹正确但 committed task fingerprint 不一致 →
    PartialCommitConflictError；
72. record schema 合法但自指纹错误 → CorruptStableRecordError；
73. STABLE committed manifest/instruction fingerprint 校验；
74. record 丢失 + 编排痕迹 → MissingRecoveryRecordError；
75. record 丢失 + 无痕迹 → 正常 PREPARE；
76. strict record：wrong Enum、wrong datetime 拒绝；
77. partial commit recovery 端到端；

操作身份/幂等：

78. response-loss 后同 operation identity → NO_OP；
79. response-loss 后不同 operation_id 不重复 submit；
80. same operation_id + different input →
    IdempotencyConflictError；
81. poll 新 operation_id 产生新 observation；
82. repeated prepare NO_OP；
83. equal terminal replay NO_OP；
84. succeeded 后相同 artifact collect NO_OP；冲突 artifact →
    ConflictingProviderResultError；
85. older/equal/newer observed_at 三分支；equal + conflicting
    payload → ConflictingProviderResultError；
86. baseline mismatch；

矩阵/映射：

87. §17.2 准入表全组合参数化（13×7=91，组合数记录为 91）；
88. §17.3 返回状态表全覆盖（含 **submit 返回 failed**、
    **submit 返回 cancelled**、submit 返回
    succeeded/artifact_available）；
89. §17.4 GenerationTask 七字段矩阵逐格；
90. §17.5 StepManifest 五字段矩阵逐格（含 output_paths 永不
    写入锁定）；
91. §13.3 sticky merge 矩阵逐格；
92. cancelled：completed_at required、error_summary forbidden
    （Step M 后启用）；
93. waiting legal_actions 多值；
94. 首次 task.provider_id=None 合法；四方一致性拒绝；

路径/目录/文件系统：

95. 四个派生路径互异且与 task_id 匹配；
96. `..`/绝对子路径逃逸拒绝；
97. symlink 指向 root 外拒绝（创建前后复核）；
98. existing parent symlink + nonexistent artifact suffix；
99. **artifact 指向当前 task 文件 → 拒绝**；
100. **artifact 指向同目录其他 task 文件 → 拒绝**；
101. **artifact 指向 generation-tasks 子目录/整目录 → 拒绝**；
102. artifact 指向 manifests / records/orchestration /
     tasks/instructions 目录 → 各自拒绝；
103. **symlink alias 指向任一禁止目录 → 拒绝**；
104. 已存在父组件无法安全解析 → 保守拒绝；
105. non-local ArtifactReference 不执行本地目录判断；
106. approved parent 不存在时安全创建；非批准目录不创建；
107. 空批准目录安全残留；
108. 目录创建失败 → PersistenceExecutionError；
109. task/manifest 文件缺失 → MissingProjectStateError；
110. artifact/媒体路径 tripwire 禁令与四个状态路径白名单 I/O
     区分；

instruction 契约：

111. exact Markdown 字节；
112. 末尾恰好一个换行；
113. canonical JSON fenced block 不依赖插入序；
114. instruction 冲突覆盖拒绝；

端到端与回归：

115. Manual Provider 全生命周期端到端（含首次 envelope 创建与
     handoff）；
116. resume 全 13 状态返回；
117. 无 VideoAsset/FFmpeg/QCD；
118. full regression（r6 批准时基线 757——历史快照；当前基线
     899——随各 Step 递增 + 新增）；Ruff format/lint；git
     diff 文件范围审计；

r6 新增（关闭 r5 复审发现）：

119. **Provider-call 三相位携带 stable=null 的 envelope 拒绝**
     （INTENT/MAY_HAVE_STARTED/RESULT_UNKNOWN 各一）；
120. APPLYING 的 stable=null 仅首次 prepare 合法；非首次场景
     stable=null 拒绝；
121. **两种 planned stable 指纹独立计算与独立复验**（payload
     内嵌自指纹按 §13.1、wrapper 指纹按 §16.4；无相等断言）；
122. planned stable **wrapper 指纹 mismatch** 拒绝；
123. planned stable **内嵌自指纹 mismatch** 拒绝（与 122 分别）；
124. **action_input wrapper round-trip**（kind/version）；
125. action_input wrapper unknown version 拒绝；
126. action_input wrapper wrong kind 拒绝；
127. 首次前置收紧：无 record 且 task.provider_id 非 None → 按
     痕迹处理（MissingRecoveryRecordError），不进入 prepare；
128. 痕迹集合逐项判定（provider_id 置位 / status 非 pending /
     三引用 / orchestration 键 / instruction 文件各一）；
129. **首次 task 已写后 record 丢失** →
     MissingRecoveryRecordError（不重复 prepare）；
130. **首次 task+manifest 已写后 record 丢失** → 同上；
131. **首次 instruction 已写后 record 丢失** → 同上。

环境注明：WSL2/Linux；不测试 Windows path/replace 语义。

## 23. 验收标准映射（对任务卡 20 条）

| AC | 设计章节 | 计划测试 |
| --- | --- | --- |
| 1 职责分离 | §2–§4 | 1–3 |
| 2 文件系统边界 | §8（含 **generation-tasks 整目录拒绝**） | 95–110 |
| 3 无隐藏时间 | §4、§7.2 | 9 |
| 4 无隐藏可变状态 | §5 | 9 |
| 5 编排矩阵 | §17.2、§11.5、§14、§13.0（**首次与后续 envelope 均有确定状态；Provider-call 相位一律要求 stable**） | 25–30、56、87、119–120 |
| 6 不可倒退/时间 | §18 | 85、86 |
| 7 关联关系 | §6.1、§9、§13.4 | 16、64、109 |
| 8–11 四状态映射 | §17.4/§17.5 | 89–90 |
| 12 cancelled 表达 | §17.4/§17.5（Step M 前置） | 92 |
| 13 层次 1 幂等 | §12、§13.0.2（**首次痕迹建立使各切点 record 丢失不致重复 prepare**） | 56–63、78–81、127–131 |
| 14 层次 2 幂等 | §16（plan preimage version 固定 1、NFC、**action_input wrapper**） | 10–20、47–50、82–85、124–126 |
| 15 层次 3 幂等 | §11、§13.0（envelope + 嵌套 snapshot version + 两 variant + committed fingerprints + CAS + **两种 planned stable 指纹分离**） | 21–55、64–77、121–123 |
| 16 映射完整 | §17.4/§17.5 | 89–91 |
| 17 persistence 边界 | §2、§3 | 2、110 |
| 18 恢复与失败边界 | §13、§14（首次 partial recovery、nested strict schema、**各切点 record-loss 保守识别**） | 26、36–55、68–77、116、127–131 |
| 19 无越界 | §1、§3 | 117 |
| 20 质量门槛 | §22（**含 r6 全部故障路径测试**） | 118–131 |

**不声称任何 AC 已由完整实现满足**（当前仓库含 Step M 与
Step A 实现代码；编排主体 Step B–G 未实施；r6 批准当时尚无任何
实现代码——历史快照）。

## 24. 实施步骤分配（Step M、Step A–G 正式定义）

本节是 docs-only implementation sequencing clarification：为
§21 的按文件 ownership plan 补充**按 Step 的正式归属**。本节不
改变任何已批准技术合同；文件职责、schema、矩阵与测试语义一律
以 §1–§23 原文为准。

### 24.0 已完成步骤（记录，不重开）

- **Step M — GenerationTaskStatus.CANCELLED model evolution**：
  completed（生产：`src/ai_video_workflow/models.py`；测试：
  `tests/test_models.py`、`tests/test_serialization.py`；已提交
  `8d691ba`；独立审查通过）。Step M 的 18 个 pytest case 属于
  模型/序列化层，不占用 §22 的 1–131 编号。
- **Step A — orchestration errors / enums / canonical JSON /
  fingerprint / freeze utilities**：completed（生产：
  `orchestration/__init__.py`、`errors.py`、`models.py`、
  `canonical.py`；测试：`tests/test_orchestration_models.py`、
  `tests/test_orchestration_canonical.py`；已提交 `884081c`；
  独立审查通过）。§22 编号 10–14 由 Step A 完成（标记
  completed）。
- **Step B — durable record 数据合同与严格恢复解析**：
  completed（生产：`orchestration/canonical.py`（追加）、
  `orchestration/_models.py`、`orchestration/recovery.py`；
  测试：`tests/test_orchestration_models.py`、
  `tests/test_orchestration_canonical.py`；已提交 `261ebbd`；
  独立审查通过——第一轮三阻塞一重要已逐项修复关闭）。§22 中
  Step B 归属的 44 项（21–24、28、30–55、68–70、72、76、
  119–126）由 Step B 完成（标记 completed）。
- **Step C — instruction 逐字节渲染器**：completed（生产：
  `orchestration/instructions.py`；测试：
  `tests/test_orchestration_canonical.py`；独立审查通过——
  第一轮两个重要问题已修复关闭）。§22 编号 111–113 由 Step C
  完成（标记 completed）。

**计数单位说明**："§22 测试项"与"pytest case 数"不是相同计数
单位：一个 §22 设计测试项通常展开为多个参数化 pytest case
（Step A 的 124 个 case 覆盖 §22 的 10–14 共 5 项，并为后续
步骤提供 canonical/freeze/fingerprint 工具层断言基础）。§22 某
编号标记为某 Step 的归属，含义是：该项的全部设计断言在该 Step
的测试中最终完备；前序步骤可先行覆盖其子断言，不改变归属。

**Test-count chronology（固定记录）**：

- formal-design approval baseline: **757 pytest cases**；
- after Step M: **775 pytest cases**（Step M added
  **18 pytest cases**）；
- after Step A: **899 pytest cases**（Step A added 124 pytest
  cases）；
- after Step B: **1143 pytest cases**（Step B added
  **244 pytest cases**，其中最后一次审查缺口修复增加 56 个）；
- after Step C / current repository baseline:
  **1189 pytest cases**（Step C added **46 pytest cases**：
  初次实现 35 个 + 独立审查缺口修复 11 个）。

§22 的 131 项是设计级测试条目（design-level test
requirements），与 pytest 运行器收集执行的 case 不是同一计数
单位；不得由 `775 − 757 = 18` 推断 Step M 对应 18 个 §22 测试
编号（Step M 的 case 不占用 1–131 编号）；Step B 的 244 个与
Step C 的 46 个新增 pytest case 与各自归属的 44 项/3 项 §22
设计条目也不是同一计数单位；不声称 131 项设计测试已经全部实现
（当前完成 52/131：Step A 5 项 + Step B 44 项 + Step C
3 项）。

### 24.1 未实施文件 ownership 分析

| 文件 | 已批准职责（§21） | 依赖（模块级） | 被依赖 | 纯数据/schema | 纯 planning | 文件系统 I/O | Provider 调用 | public facade |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orchestration/_models.py` | `_PendingProviderCall`、`_PendingApply`、`_ExecutablePlan`、`_StableStateSnapshot`、envelope 构造 | errors、enums、canonical、核心 validation | recovery、planning、executor、orchestrator | 是 | 否 | 无 | 无 | 否 |
| `orchestration/recovery.py` | envelope/variant strict parser、跨字段一致性、self-fingerprint verification、model_from_dict adapter、phase recovery | _models、canonical、errors、enums、核心 models/serialization、providers models | executor、orchestrator、（models.py 公开摘要经函数级导入） | 解析为主 | 否 | 无（分类纯函数） | 无 | 否 |
| `orchestration/instructions.py` | exact bytes renderer（§19） | canonical、errors、providers models | planning（§16.2 第 7 步）、executor（写入字节由 plan 携带） | 是（纯字节） | 否 | 无 | 无 | 否 |
| `orchestration/planning.py` | 无环 plan 计算、after payload 构造、矩阵/映射/sticky/时间判定 | _models、canonical、instructions、errors、enums、核心 models、providers models | orchestrator | 否 | 是 | 无 | 无 | 否 |
| `orchestration/layout.py` | per-component symlink resolution、nonexistent suffix handling、整目录级 state-directory rejection | errors（+ pathlib/os lstat） | executor、orchestrator | 否 | 否 | 仅 lstat/受控 resolve（§8.3；不 open、不扫描） | 无 | 否 |
| `orchestration/executor.py` | phase writes、CAS、approved parent creation、empty directory residue、`_atomic_write_bytes`、partial recovery | _models、recovery、layout、canonical、persistence、errors、enums | orchestrator | 否 | 否 | 是（唯一写入者，四个派生路径） | 无 | 否 |
| `orchestration/orchestrator.py` | 公开操作身份与七个动作入口 | planning、executor、layout、recovery、models（公开摘要）、_models、providers base | 外部调用方 | 否 | 否 | 经 executor | 是（唯一调用点） | 是 |
| `orchestration/models.py`（追加公开摘要） | 公开摘要模型（OrchestrationContext / OrchestrationOutcome / OrchestrationPlan / ResumeAssessment / OrchestrationRecord）与既有 Enum | enums（自身）、errors、canonical、核心 models、providers models；updated_task/updated_manifest 属性经**函数级导入** recovery adapter | orchestrator、外部调用方 | 是 | 否 | 无 | 无 | 是（公开类型） |
| `orchestration/canonical.py`（追加） | snapshot wrapper 工具（§16.6）、stable 自指纹计算（§13.1）、plan preimage（§16.3、PLAN_PREIMAGE_SCHEMA_VERSION） | 既有 Step A 依赖不变 | _models、recovery、planning、executor | 是 | 否 | 无 | 无 | 否 |
| `orchestration/__init__.py`（最终导出） | §4.1 最终公开导出集合 | models、errors | 外部调用方 | — | — | 无 | 无 | 是 |

未实施测试文件：`tests/test_orchestration_planning.py`、
`tests/test_orchestration_layout.py`、
`tests/test_orchestration_executor.py`、`tests/test_orchestrator.py`
（§21 清单固定，不新增测试文件；`tests/test_orchestration_models.py`
与 `tests/test_orchestration_canonical.py` 按 §24.2 允许扩展）。

### 24.2 Step B–G 正式定义

分步原则（全部满足）：依赖单向；每步可独立测试；每步文件范围
唯一；同一生产文件只归属一个首次实施 Step，后续回改仅在本节
明文允许的符号范围内；纯模型/schema（B）早于 planning（D）；
instruction 渲染（C）早于 planning（§16.2 第 7 步依赖渲染）与
写入集成（F）；layout/path safety（E）早于文件执行（F）；
planning（D）早于 executor（F）；public facade（G）最后；
Provider 副作用调用与 durable recovery 协议各自完整落在单一
Step（调用协议整体在 G、恢复分类+执行整体在 F），不拆成不可
测试的半实现；步骤体量不均是技术边界的结果，不做均分。

**checkpoint 纪律（适用于全部 Step B–G）**：下一 Step 必须在
**新的独立 checkpoint** 中明确启动，不得在当前 Step 的提交轮
直接继续；各 Step 的"前置条件"中"已提交"一律指该 Step 的独立
提交已完成且工作区干净。

**统一完成清单（适用于全部 Step B–G；各步"完成条件"一律指
本清单 1–12 全部满足）**：

1. 本步"必须实现"内容全部完成；
2. 本步聚焦测试通过（按本步"聚焦测试命令"）；
3. related regression 通过：全部前序 Step 的测试文件（含
   Step M 的 `tests/test_models.py`、`tests/test_serialization.py`
   与 Step A 起的各 orchestration 测试文件）随全量执行复验，
   无回归；
4. 先执行 `ruff format <本步全部允许生产与测试文件>`，随后
   `.venv/bin/python -m ruff format --check .` 通过；
5. `.venv/bin/python -m ruff check .` 通过；
6. full pytest 通过（不低于进入本步时的基线，并包含本步新增
   pytest case）；
7. `git diff --check` 通过（无 whitespace 错误）；
8. 执行字面命令 `git status --short`，核验变更仅限本步允许
   文件（范围检查）；
9. Codex 独立审查通过，且审查结果为 **blockers = 0、
   important findings = 0**；
10. 状态文档（设计文档、任务卡）在提交轮准确同步本步状态，
    不得声称未完成的内容；
11. 本步作为独立提交完成；
12. 提交后再次执行字面命令 `git status --short`，确认工作区
    干净。

#### Step B — durable record 数据合同与严格恢复解析

##### 目标

实现 record 层全部纯数据合同与严格解析能力：三个内部持久化
模型、统一 envelope 构造、八种 snapshot wrapper 工具、stable
自指纹计算与复验、strict recovery parser 与模型 restore
adapter。全部为零 I/O、零时钟、零 Provider 的纯数据/解析层。

##### 前置条件

Step B 只有在以下条件**全部满足**后才能开始：

1. Step M 已完成；
2. Step M 已通过 Codex 独立审查；
3. Step M 已独立提交；
4. Step A 已完成；
5. Step A 已通过 Codex 独立审查；
6. Step A 已独立提交；
7. §24 sequencing clarification 草案已完成；
8. sequencing clarification 已通过 Codex 独立复审；
9. sequencing clarification 的 docs-only 变更已独立提交；
10. clarification 提交后工作区干净；
11. 新的独立 Step B checkpoint 已明确发出。

gate 状态区分（不得混同）：

- global coding gate: **open**；
- Step B local gate: **suspended until clarification review
  passes and the docs-only clarification commit is completed**。

**不得**把以下任一状态解释为 Step B 已获准开始：
clarification 草案完成；clarification 复审正在进行；
clarification 复审通过但尚未提交；global coding gate 已开启；
Codex 允许提交 clarification 文档。

固定规则：

```text
Step B may start only after the sequencing clarification has:

1. passed independent Codex review;
2. been committed as an independent docs-only commit;
3. left the worktree clean; and
4. been followed by a new explicit Step B checkpoint.
```

##### 允许生产文件

- create：`src/ai_video_workflow/orchestration/_models.py`
- create：`src/ai_video_workflow/orchestration/recovery.py`
- modify：`src/ai_video_workflow/orchestration/canonical.py`
  （仅追加：§16.6 snapshot wrapper 工具、§13.1 stable 自指纹
  计算辅助、ABSENT 相关常量所需的规范化支持；不改动 Step A 已
  审查通过的既有符号语义）

##### 允许测试文件

- modify：`tests/test_orchestration_models.py`
- modify：`tests/test_orchestration_canonical.py`

##### 必须实现

- `_models.py`：`_StableStateSnapshot`（§13.1 字段、自指纹
  构造时派生）、`_PendingProviderCall`（§11.2）、
  `_PendingApply`（§11.3）、envelope 构造（§13.0 顶层结构与
  phase × stable/pending 不变量）、record/pending schema
  常量（`record_schema.kind/version`、两个 variant 的
  schema_version 与 discriminator、ABSENT marker）；§11.6 两种
  planned stable 指纹的构造侧不变量；§11.7 全部跨字段一致性
  （构造侧）。
- `canonical.py` 追加：§16.6 wrapper（八种 kind、
  snapshot_version=1、unknown kind/version 拒绝）、stable 自
  指纹计算（对除自身外全部 stable 字段的 canonical JSON）。
- `recovery.py`：§20 strict parser（envelope、两 variant、
  §11.7 解析侧强制、§13.0 phase 不变量、§13.2 自指纹先行
  复验）、§16.4 restore adapter（`_restore_generation_task`、
  `_restore_step_manifest`、provider 模型经公开构造函数重建、
  重算指纹比对）；错误包装规则（InvalidRecoveryRecordError 保留
  cause；自指纹失败 CorruptStableRecordError）。

##### 明确禁止

`_ExecutablePlan`（Step D）；§14 phase recovery 分类与 §13.5
痕迹集合判定（Step F）；恢复执行/补写（Step F）；任何文件系统
I/O（含 record 读写）；Provider 调用；lifecycle/准入判定
（§17.2）；plan 计算与 plan preimage（Step D）；instruction
渲染（Step C）；路径派生（Step E）；公开导出变更（Step G）。

##### Public/internal 边界

- 新增 public symbols：无。
- internal symbols：本步全部符号（`_StableStateSnapshot`、
  `_PendingProviderCall`、`_PendingApply`、envelope 构造、
  wrapper 工具、parser、adapter、常量）均不导出。
- `orchestration/__init__.py`：不允许修改；测试锁定导出集合与
  Step A 一致（22 个名称）。

##### §22 测试归属

21、22、23、24、28、30、31、32、33、34、35、36、37、38、39、
40、41、42、43、44、45、46、47、48、49、50、51、52、53、54、
55、68、69、70、72、76、119、120、121、122、123、124、125、
126（共 44 项；envelope round-trip「全相位」在纯数据层以
dict↔模型双向断言实现，不涉及文件）。

##### 聚焦测试命令

`.venv/bin/python -m pytest tests/test_orchestration_models.py
tests/test_orchestration_canonical.py`

##### 完成条件

按 §24.2 统一完成清单（1–12）全部满足；本步进入时基线为
899 pytest cases。

##### 下一步进入条件

仅在 Step B 完成条件全部满足并独立提交后，且**在新的独立
checkpoint 中明确启动**，才允许进入 Step C；不得在 Step B 的
提交轮直接继续。

#### Step C — instruction 逐字节渲染器

##### 目标

实现 §19 instruction Markdown 契约的确定性渲染：给定显式输入
（含已计算的 plan_id）输出精确 UTF-8 字节。纯函数、零 I/O。

##### 前置条件

Step B 已完成、通过 Codex 独立审查并独立提交；提交后工作区
干净；Step C 的新独立 checkpoint 已明确发出。

##### 允许生产文件

- create：`src/ai_video_workflow/orchestration/instructions.py`

##### 允许测试文件

- modify：`tests/test_orchestration_canonical.py`

##### 必须实现

§19 模板逐字节渲染（UTF-8、无 BOM、LF、末尾恰好一个换行；
字段顺序固定；缺失可选值呈现 `none`；prompt 独立纯文本节；
steps 编号；suggested_parameters 使用 canonical JSON fenced
block）。渲染器接受显式参数，不读取任何状态。

##### 明确禁止

instruction 文件写入与覆盖规则（Step F）；plan_id 计算
（Step D——渲染器只接受已计算的 plan_id 字符串）；路径派生
（Step E）；任何 I/O。

##### Public/internal 边界

- 新增 public symbols：无；渲染函数 internal。
- `orchestration/__init__.py`：不允许修改。

##### §22 测试归属

111、112、113（共 3 项；114 的覆盖/冲突规则属 Step F）。

##### 聚焦测试命令

`.venv/bin/python -m pytest tests/test_orchestration_canonical.py`

##### 完成条件

按 §24.2 统一完成清单（1–12）全部满足。

##### 下一步进入条件

仅在 Step C 完成条件全部满足并独立提交后，且在新的独立
checkpoint 中明确启动，才允许进入 Step D；不得在 Step C 的
提交轮直接继续。

#### Step D — 纯 planning core

##### 目标

实现 `_OrchestrationPlanner`：零 I/O、零时钟的状态变更决策核心
——§16.2 无环九步 plan 计算、§16.3 plan preimage、
`_ExecutablePlan`、§17.3/§17.4/§17.5 矩阵的 after payload
构造、§13.3 sticky merge、§18 时间权威、§7.1/§13.4 身份与
request 一致性判定。

##### 前置条件

Step C 已完成、通过 Codex 独立审查并独立提交；提交后工作区
干净；Step D 的新独立 checkpoint 已明确发出。

##### 允许生产文件

- create：`src/ai_video_workflow/orchestration/planning.py`
- modify：`src/ai_video_workflow/orchestration/_models.py`
  （仅追加 `_ExecutablePlan` 及其不变量；不改动 Step B 已审查
  符号语义）
- modify：`src/ai_video_workflow/orchestration/canonical.py`
  （仅追加 §16.3 plan preimage 构造与
  `PLAN_PREIMAGE_SCHEMA_VERSION`；不改动既有符号语义）

##### 允许测试文件

- create：`tests/test_orchestration_planning.py`

##### 必须实现

`_OrchestrationPlanner`（纯函数式决策）；§16.2 固定九步顺序
（渲染调用 Step C 渲染器）；§16.3 preimage（字段集精确、
version 严格 int 1、bool 拒绝、unknown 拒绝、明确排除项）；
`_ExecutablePlan`；§17.3 Provider 返回状态校验；§17.4/§17.5
after payload 逐格规则（含 cancelled 列）；§13.3 sticky merge
逐格；§18 older/equal/newer 判定与状态秩；§7.1 provider_id
对齐与首次 task.provider_id=None 前置；§13.4 request 指纹比较
（ConflictingRequestError）；§7.2 操作身份五元组与
action_input_fingerprint 计算；STABLE 状态行的 legal_actions /
preferred_next_action 计算。

##### 明确禁止

record 文件读写、CAS、WAL 相位推进（Step F）；路径派生
（Step E）；Provider 调用与七动作入口（Step G）；phase 状态行
（9–13）的准入执行（REDRIVE/REPAIR 的执行属 F/G；planner 只
提供决策数据）；公开摘要模型与导出（Step G）。

##### Public/internal 边界

- 新增 public symbols：无；`_OrchestrationPlanner`、
  `_ExecutablePlan`、preimage 工具均 internal。
- `orchestration/__init__.py`：不允许修改。

##### §22 测试归属

15、16、17、18、19、20、85、88、89、90、91、92、93、94
（共 14 项）。

##### 聚焦测试命令

`.venv/bin/python -m pytest tests/test_orchestration_planning.py`

##### 完成条件

按 §24.2 统一完成清单（1–12）全部满足。

##### 下一步进入条件

仅在 Step D 完成条件全部满足并独立提交后，且在新的独立
checkpoint 中明确启动，才允许进入 Step E；不得在 Step D 的
提交轮直接继续。

#### Step E — `_LayoutResolver` 路径派生与安全校验

##### 目标

实现 §8.1 四路径派生、§8.3 逐组件 symlink 受控 resolve、
nonexistent suffix 处理与整目录级 state-directory 拒绝。只做
派生与校验（lstat/受控 resolve），不执行写入类 I/O。

##### 前置条件

Step D 已完成、通过 Codex 独立审查并独立提交；提交后工作区
干净；Step E 的新独立 checkpoint 已明确发出。

##### 允许生产文件

- create：`src/ai_video_workflow/orchestration/layout.py`

##### 允许测试文件

- create：`tests/test_orchestration_layout.py`（本步测试按
  §8.3 需要使用 tmp_path 构造真实目录/symlink——这是设计明确
  要求的 lstat/resolve 校验，属批准的文件系统访问）

##### 必须实现

§8.1 派生表与路径安全（root 绝对化/规范化、四目标互异、
文件名与 task_id 匹配、containment、`..`/绝对子路径拒绝、
symlink 出 root 拒绝）；§8.3 逐组件规则 1–12（含整目录保护
四类、symlink alias 拒绝、不存在 suffix 基于已解析真实父路径、
保守拒绝、non-local 不判断）。

##### 明确禁止

目录创建（Step F §8.2）；文件读写（Step F）；record/instruction
落盘；Provider 调用；媒体探测/扫描（永久禁止）。

##### Public/internal 边界

- 新增 public symbols：无；`_LayoutResolver` internal。
- `orchestration/__init__.py`：不允许修改。

##### §22 测试归属

95、96、97、98、99、100、101、102、103、104、105（共 11 项）。

##### 聚焦测试命令

`.venv/bin/python -m pytest tests/test_orchestration_layout.py`

##### 完成条件

按 §24.2 统一完成清单（1–12）全部满足。

##### 下一步进入条件

仅在 Step E 完成条件全部满足并独立提交后，且在新的独立
checkpoint 中明确启动，才允许进入 Step F；不得在 Step E 的
提交轮直接继续。

#### Step F — `_FileOrchestrationExecutor`（WAL/CAS/恢复执行）

##### 目标

实现唯一状态写入者：§11.4 多文件 CAS 与原子写入、§11.5 相位
推进落盘、§13.0.2 首次 record 创建、§14 恢复分类与补写执行、
§8.2 批准目录创建、§13.5 痕迹集合判定、§19 覆盖规则执行。

##### 前置条件

Step E 已完成、通过 Codex 独立审查并独立提交；提交后工作区
干净；Step F 的新独立 checkpoint 已明确发出。

##### 允许生产文件

- create：`src/ai_video_workflow/orchestration/executor.py`
- modify：`src/ai_video_workflow/orchestration/recovery.py`
  （仅追加：§14 恢复矩阵的 phase recovery 分类函数与 §13.5
  编排痕迹集合分类函数——均为纯分类，I/O 观察由 executor 提供；
  不改动 Step B 已审查的 parser/adapter 语义）

##### 允许测试文件

- create：`tests/test_orchestration_executor.py`

##### 必须实现

`_atomic_write_bytes`（临时文件→flush→fsync→`os.replace`）；
task/manifest 复用 `write_model_json(..., overwrite=True)`；
§11.4 CAS（含首次 ABSENT 分支）与写入顺序 1–7；§11.5 八行相位
转换的原子落盘内容；§13.0.2 首次 prepare record 原子创建与首次
partial apply 补写全分支、首个 STABLE version=1 提交；后续
pending 保留 previous stable；§14 P3–P9/S0/S1/E1 分类与
SAFE_AUTO_RETRY 补写执行；§13.5 record 丢失痕迹判定（分类）；
§8.2 批准父目录创建、空目录残留语义、创建失败
PersistenceExecutionError；§9 task/manifest 存在性与
MissingProjectStateError；§19 instruction 覆盖规则执行；I/O
白名单闭合于四个派生路径。

##### 明确禁止

Provider 调用（executor 永不接触 VideoProvider——调用顺序保证
在 Step G 集成）；七动作入口/操作身份入口判定（Step G）；自动
resubmit（永久禁止）；扫描/媒体访问（永久禁止）；公开导出变更
（Step G）。

##### Public/internal 边界

- 新增 public symbols：无；`_FileOrchestrationExecutor` 与全部
  写入工具 internal。
- `orchestration/__init__.py`：不允许修改。

##### §22 测试归属

25、26、27、29、56、64、65、66、67、71、73、77、86、106、
107、108、109、110、114、128（共 20 项）。

##### 聚焦测试命令

`.venv/bin/python -m pytest tests/test_orchestration_executor.py`

##### 完成条件

按 §24.2 统一完成清单（1–12）全部满足。

##### 下一步进入条件

仅在 Step F 完成条件全部满足并独立提交后，且在新的独立
checkpoint 中明确启动，才允许进入 Step G；不得在 Step F 的
提交轮直接继续。

#### Step G — 公开 orchestrator facade 与端到端集成

##### 目标

实现 `ProviderOrchestrator` 七动作入口与公开摘要模型，完成
§4.1 最终公开导出，将 planner/executor/layout/recovery 组装为
端到端行为（含 Provider 调用顺序保证、操作身份/NO_OP、resume
全 13 状态、record 丢失动作级行为、91 格准入矩阵）。

##### 前置条件

Step F 已完成、通过 Codex 独立审查并独立提交；提交后工作区
干净；Step G 的新独立 checkpoint 已明确发出。

##### 允许生产文件

- create：`src/ai_video_workflow/orchestration/orchestrator.py`
- modify：`src/ai_video_workflow/orchestration/models.py`
  （仅追加公开摘要模型：`OrchestrationContext`、
  `OrchestrationOutcome`、`OrchestrationPlan`、
  `ResumeAssessment`、`OrchestrationRecord`；不改动 Step A 已
  审查的四个 Enum）
- modify：`src/ai_video_workflow/orchestration/__init__.py`
  （更新为 §4.1 最终公开导出集合）

##### 允许测试文件

- create：`tests/test_orchestrator.py`

##### 必须实现

§4.2 全部签名；§6.1 入口验证；§6.2 输出模型与 NO_OP 不变量；
§10.2 公开 plan（深度冻结摘要、`__hash__ = None`、
updated_task/updated_manifest 经 §16.4 adapter 重建——模块级
不导入 recovery，属性体内函数级导入为唯一批准的延迟导入点）；
§7.2 操作身份全规则；§11.5/§12 调用顺序（INTENT→
MAY_HAVE_STARTED 落盘成功后才调用 Provider；绝不自动
resubmit）；§17.2 91 格准入（含 REDRIVE/REPAIR/E-unknown/
E-recovery 端到端）；§13.5 动作级 record 丢失行为与 127/129–131
首次痕迹场景；resume 全 13 状态 Assessment；§4.1 导出集合测试
锁定；固定资产边界 tripwire。

##### 明确禁止

VideoAsset/正式资产/FFmpeg/QCD（永久边界）；扩大顶层
`ai_video_workflow` 包 API（设计未要求）；修改 providers 包
既有 15 个公开导出。

##### Public/internal 边界

- 新增 public symbols：`ProviderOrchestrator`、
  `OrchestrationContext`、`OrchestrationOutcome`、
  `OrchestrationPlan`、`ResumeAssessment`、
  `OrchestrationRecord`（加入 `orchestration/__init__.py`，与
  既有 4 Enum + 18 错误名合并为 §4.1 最终集合）。
- internal 保持：全部 `_` 前缀类型与工具。

##### §22 测试归属

1、2、3、4、5、6、7、8、9、57、58、59、60、61、62、63、74、
75、78、79、80、81、82、83、84、87、115、116、117、118、127、
129、130、131（共 34 项）。

##### 聚焦测试命令

`.venv/bin/python -m pytest tests/test_orchestrator.py`

##### 完成条件

按 §24.2 统一完成清单（1–12）全部满足；另加：TASK-004 全部
131 项测试归属闭合核对、§23 验收标准映射复核。

##### 下一步进入条件

Step G 为最后实施步骤。**Step G 通过独立审查并提交不等于
TASK-004 完成**。TASK-004 最终验收轮必须在 Step G 独立提交、
工作区干净后，在**新的独立 checkpoint** 中启动，且不引入新
实现；只有以下最终验收清单全部满足并独立裁决后，才允许宣告
TASK-004 completed：

1. 任务卡 20 条验收标准逐条实现核验（对照 §23 映射，逐条给出
   实现与测试证据）；
2. §22 全部 131 项设计测试逐项覆盖核验（对照 §24.3 映射，
   1–131 全部标记 completed，无遗漏）；
3. 先执行 `ruff format`（全部 TASK-004 文件），随后
   `.venv/bin/python -m ruff format --check .` 与
   `.venv/bin/python -m ruff check .` 通过；
4. full pytest 通过；`git diff --check` 无 whitespace 错误；
   执行字面命令 `git status --short` 核验范围与工作区状态；
5. §4.1 公开 API 导出集合与固定边界（§1/§3：无 VideoAsset、
   无正式资产转换、无 FFmpeg/ffprobe、无 QCD、不扫描媒体
   目录）复核；
6. Codex 最终独立审查通过（blockers = 0、important
   findings = 0）；
7. 最终状态文档（设计文档、任务卡状态区）作为独立提交完成，
   提交后工作区干净；
8. 独立完成裁决：由用户在最终审查通过后明确宣告；实施 Agent
   不得自行声称 TASK-004 completed。

### 24.3 §22 测试编号 → Step 完整映射（1–131）

Step A 行标记 completed；Step B 归属的 44 项与 Step C 归属的
3 项（111–113）已分别由 Step B/C 完成（见 §24.0 记录，表内行
标注保持原分配不变）；其余 planned。测试主题为 §22 原文的
压缩指称，语义以 §22 原文为准。

| 编号 | 测试主题 | Step | 测试文件 |
| --- | --- | --- | --- |
| 1 | 公开 API 签名逐参数 | G | test_orchestrator |
| 2 | 公开导出集合精确（§4.1 最终集合） | G | test_orchestrator |
| 3 | 公开 plan 不暴露模型实例 | G | test_orchestrator |
| 4 | updated_task/manifest 每次新实例 | G | test_orchestrator |
| 5 | 公开 snapshot 防御复制 | G | test_orchestrator |
| 6 | 新增模型 frozen/slots/`__hash__` 契约（全量收口） | G | test_orchestrator |
| 7 | 嵌套可变输入 defensive copy / MappingProxyType（全量收口） | G | test_orchestrator |
| 8 | NO_OP 不变量 | G | test_orchestrator |
| 9 | 无隐藏时间/无隐藏状态 | G | test_orchestrator |
| 10 | canonical JSON 确定性 | A（completed） | test_orchestration_canonical |
| 11 | NFC 顶层 key collision 拒绝 | A（completed） | test_orchestration_canonical |
| 12 | NFC 嵌套 key collision 拒绝 | A（completed） | test_orchestration_canonical |
| 13 | 无 collision Unicode 稳定排序 | A（completed） | test_orchestration_canonical |
| 14 | allow_nan/NaN/`-0.0`/bool 严格 | A（completed） | test_orchestration_canonical |
| 15 | §16.5 各指纹输入与确定性 | D | test_orchestration_planning |
| 16 | request 重建指纹一致 / ConflictingRequestError 四触发 | D | test_orchestration_planning |
| 17 | plan_id 无环计算 | D | test_orchestration_planning |
| 18 | instruction 含 plan_id 后 fingerprint 稳定 | D | test_orchestration_planning |
| 19 | planned stable fingerprint 不参与 plan_id | D | test_orchestration_planning |
| 20 | plan preimage version 固定 1 / bool / unknown 拒绝 | D | test_orchestration_planning |
| 21 | envelope kind/version round-trip（全相位） | B | test_orchestration_models |
| 22 | envelope unknown/missing key 拒绝 | B | test_orchestration_models |
| 23 | envelope unknown kind/version 拒绝 | B | test_orchestration_models |
| 24 | phase × stable/pending 不一致拒绝 | B | test_orchestration_models |
| 25 | 首次 prepare record 原子创建 | F | test_orchestration_executor |
| 26 | 首次 partial apply 恢复分支 | F | test_orchestration_executor |
| 27 | 首次 successful commit version=1 | F | test_orchestration_executor |
| 28 | ABSENT 与整数 0 不混用 | B | test_orchestration_models |
| 29 | 后续 pending record 保留 previous stable | F | test_orchestration_executor |
| 30 | 相位 × pending 类型强制 | B | test_orchestration_models |
| 31 | `_PendingProviderCall` strict round-trip | B | test_orchestration_models |
| 32 | `_PendingApply` strict round-trip | B | test_orchestration_models |
| 33 | pre-call 禁止 plan_id/result/after | B | test_orchestration_models |
| 34 | post-result 要求 plan_id/after | B | test_orchestration_models |
| 35 | unknown version/variant 拒绝 | B | test_orchestration_models |
| 36 | call phase/boolean mismatch 拒绝 | B | test_orchestration_models |
| 37 | duplicated observed_at mismatch 拒绝 | B | test_orchestration_models |
| 38 | duplicated completed_at mismatch 拒绝 | B | test_orchestration_models |
| 39 | duplicated artifact mismatch 拒绝 | B | test_orchestration_models |
| 40 | result fingerprint mismatch 拒绝 | B | test_orchestration_models |
| 41 | task fingerprint mismatch 拒绝 | B | test_orchestration_models |
| 42 | manifest fingerprint mismatch 拒绝 | B | test_orchestration_models |
| 43 | instruction fingerprint mismatch 拒绝 | B | test_orchestration_models |
| 44 | planned stable committed fingerprint mismatch 拒绝 | B | test_orchestration_models |
| 45 | planned stable operation identity mismatch 拒绝 | B | test_orchestration_models |
| 46 | planned stable snapshot 不变量 | B | test_orchestration_models |
| 47 | 八种 wrapper kind round-trip | B | test_orchestration_canonical |
| 48 | nested snapshot unknown version 拒绝 | B | test_orchestration_canonical |
| 49 | nested snapshot wrong kind 拒绝 | B | test_orchestration_canonical |
| 50 | restore 后重算 fingerprint 一致（各 kind） | B | test_orchestration_models |
| 51 | task after payload 重建+类型+指纹复验 | B | test_orchestration_models |
| 52 | manifest after payload 同上 | B | test_orchestration_models |
| 53 | instruction 文本重编码逐字节等于 expected | B | test_orchestration_models |
| 54 | after snapshot 与持久化指纹不一致拒绝 | B | test_orchestration_models |
| 55 | model_to_dict/model_from_dict adapter 双向 | B | test_orchestration_models |
| 56 | §11.5 相位转换表逐行原子落盘 | F | test_orchestration_executor |
| 57 | submit：INTENT→MAY_HAVE_STARTED→才调用 | G | test_orchestrator |
| 58 | MAY_HAVE_STARTED 未实际调用的保守恢复 | G | test_orchestrator |
| 59 | submit 未知结果绝不 resubmit | G | test_orchestrator |
| 60 | collect MAY_HAVE_STARTED → manual | G | test_orchestrator |
| 61 | INTENT 的 REDRIVE / IdempotencyConflictError | G | test_orchestrator |
| 62 | direct-to-APPLYING 路径 | G | test_orchestrator |
| 63 | 直接路径落盘前崩溃 → 安全重调 | G | test_orchestrator |
| 64 | 多文件 before fingerprint 逐项（含 ABSENT） | F | test_orchestration_executor |
| 65 | 部分写入补写全分支（后续操作组） | F | test_orchestration_executor |
| 66 | confirmed_writes/phase 未更新 → 指纹判定 | F | test_orchestration_executor |
| 67 | 既非 before 也非 after → PartialCommitConflictError | F | test_orchestration_executor |
| 68 | stable 自指纹正确路径（读取协议顺序） | B | test_orchestration_models |
| 69 | stable 内容篡改 → CorruptStableRecordError | B | test_orchestration_models |
| 70 | 自指纹字段篡改 → 同上 | B | test_orchestration_models |
| 71 | 自指纹正确但 committed task 指纹不一致 | F | test_orchestration_executor |
| 72 | schema 合法但自指纹错误 | B | test_orchestration_models |
| 73 | committed manifest/instruction 指纹校验 | F | test_orchestration_executor |
| 74 | record 丢失 + 痕迹 → MissingRecoveryRecordError | G | test_orchestrator |
| 75 | record 丢失 + 无痕迹 → 正常 PREPARE | G | test_orchestrator |
| 76 | strict record wrong Enum/datetime 拒绝 | B | test_orchestration_models |
| 77 | partial commit recovery 端到端 | F | test_orchestration_executor |
| 78 | response-loss 同 identity → NO_OP | G | test_orchestrator |
| 79 | response-loss 异 operation_id 不重复 submit | G | test_orchestrator |
| 80 | 同 operation_id 异输入 → IdempotencyConflictError | G | test_orchestrator |
| 81 | poll 新 operation_id 新 observation | G | test_orchestrator |
| 82 | repeated prepare NO_OP | G | test_orchestrator |
| 83 | equal terminal replay NO_OP | G | test_orchestrator |
| 84 | succeeded 后 collect NO_OP/冲突 | G | test_orchestrator |
| 85 | older/equal/newer observed_at 三分支 | D | test_orchestration_planning |
| 86 | baseline mismatch | F | test_orchestration_executor |
| 87 | §17.2 准入表 91 格参数化 | G | test_orchestrator |
| 88 | §17.3 返回状态表全覆盖 | D | test_orchestration_planning |
| 89 | §17.4 GenerationTask 矩阵逐格 | D | test_orchestration_planning |
| 90 | §17.5 StepManifest 矩阵逐格 | D | test_orchestration_planning |
| 91 | §13.3 sticky merge 矩阵逐格 | D | test_orchestration_planning |
| 92 | cancelled：completed_at required / error_summary forbidden | D | test_orchestration_planning |
| 93 | waiting legal_actions 多值 | D | test_orchestration_planning |
| 94 | 首次 provider_id=None 合法 / 四方一致拒绝 | D | test_orchestration_planning |
| 95 | 四派生路径互异且匹配 task_id | E | test_orchestration_layout |
| 96 | `..`/绝对子路径逃逸拒绝 | E | test_orchestration_layout |
| 97 | symlink 出 root 拒绝（前后复核） | E | test_orchestration_layout |
| 98 | parent symlink + nonexistent suffix | E | test_orchestration_layout |
| 99 | artifact 指向当前 task 文件拒绝 | E | test_orchestration_layout |
| 100 | artifact 指向同目录其他 task 文件拒绝 | E | test_orchestration_layout |
| 101 | generation-tasks 子目录/整目录拒绝 | E | test_orchestration_layout |
| 102 | 三个状态目录各自拒绝 | E | test_orchestration_layout |
| 103 | symlink alias 指向禁止目录拒绝 | E | test_orchestration_layout |
| 104 | 已存在父组件无法安全解析 → 保守拒绝 | E | test_orchestration_layout |
| 105 | non-local 不执行本地目录判断 | E | test_orchestration_layout |
| 106 | approved parent 安全创建 / 非批准不创建 | F | test_orchestration_executor |
| 107 | 空批准目录安全残留 | F | test_orchestration_executor |
| 108 | 目录创建失败 → PersistenceExecutionError | F | test_orchestration_executor |
| 109 | task/manifest 缺失 → MissingProjectStateError | F | test_orchestration_executor |
| 110 | tripwire 禁令与白名单 I/O 区分 | F | test_orchestration_executor |
| 111 | exact Markdown 字节 | C | test_orchestration_canonical |
| 112 | 末尾恰好一个换行 | C | test_orchestration_canonical |
| 113 | canonical JSON fenced block 插入序无关 | C | test_orchestration_canonical |
| 114 | instruction 冲突覆盖拒绝 | F | test_orchestration_executor |
| 115 | Manual Provider 全生命周期端到端 | G | test_orchestrator |
| 116 | resume 全 13 状态返回 | G | test_orchestrator |
| 117 | 无 VideoAsset/FFmpeg/QCD | G | test_orchestrator |
| 118 | full regression + Ruff + 范围审计 | G | test_orchestrator |
| 119 | Provider-call 三相位 stable=null 拒绝 | B | test_orchestration_models |
| 120 | APPLYING stable=null 仅首次合法 | B | test_orchestration_models |
| 121 | 两种 planned stable 指纹独立计算复验 | B | test_orchestration_models |
| 122 | wrapper 指纹 mismatch 拒绝 | B | test_orchestration_models |
| 123 | 内嵌自指纹 mismatch 拒绝 | B | test_orchestration_models |
| 124 | action_input wrapper round-trip | B | test_orchestration_canonical |
| 125 | action_input unknown version 拒绝 | B | test_orchestration_canonical |
| 126 | action_input wrong kind 拒绝 | B | test_orchestration_canonical |
| 127 | 无 record 且 provider_id 非 None → 痕迹处理 | G | test_orchestrator |
| 128 | 痕迹集合逐项判定 | F | test_orchestration_executor |
| 129 | 首次 task 已写后 record 丢失 | G | test_orchestrator |
| 130 | 首次 task+manifest 已写后 record 丢失 | G | test_orchestrator |
| 131 | 首次 instruction 已写后 record 丢失 | G | test_orchestrator |

归属核对：A=5（10–14，completed）；B=44；C=3；D=14；E=11；
F=20；G=34；合计 5+44+3+14+11+20+34=131；无重复、无遗漏。
不声称 planned 项已实现。

### 24.4 文件归属矩阵

标记：create=本步创建；modify=本步允许修改（限定符号见
§24.2）；test=本步允许新增测试；forbidden=本步禁止触碰；
—=与该步无关（同 forbidden，列示以便审计）。状态文档
（设计文档、任务卡）只在每步完成轮更新状态，不属于实现主体。

| 文件 | M | A | B | C | D | E | F | G |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `src/ai_video_workflow/models.py` | modify | forbidden | forbidden | forbidden | forbidden | forbidden | forbidden | forbidden |
| `orchestration/__init__.py` | — | create | forbidden | forbidden | forbidden | forbidden | forbidden | modify |
| `orchestration/errors.py` | — | create | forbidden | forbidden | forbidden | forbidden | forbidden | forbidden |
| `orchestration/models.py` | — | create | forbidden | forbidden | forbidden | forbidden | forbidden | modify |
| `orchestration/canonical.py` | — | create | modify | forbidden | modify | forbidden | forbidden | forbidden |
| `orchestration/_models.py` | — | — | create | forbidden | modify | forbidden | forbidden | forbidden |
| `orchestration/recovery.py` | — | — | create | forbidden | forbidden | forbidden | modify | forbidden |
| `orchestration/instructions.py` | — | — | — | create | forbidden | forbidden | forbidden | forbidden |
| `orchestration/planning.py` | — | — | — | — | create | forbidden | forbidden | forbidden |
| `orchestration/layout.py` | — | — | — | — | — | create | forbidden | forbidden |
| `orchestration/executor.py` | — | — | — | — | — | — | create | forbidden |
| `orchestration/orchestrator.py` | — | — | — | — | — | — | — | create |
| `tests/test_models.py` | test | forbidden | forbidden | forbidden | forbidden | forbidden | forbidden | forbidden |
| `tests/test_serialization.py` | test | forbidden | forbidden | forbidden | forbidden | forbidden | forbidden | forbidden |
| `tests/test_orchestration_models.py` | — | create | test | forbidden | forbidden | forbidden | forbidden | forbidden |
| `tests/test_orchestration_canonical.py` | — | create | test | test | forbidden | forbidden | forbidden | forbidden |
| `tests/test_orchestration_planning.py` | — | — | — | — | create | forbidden | forbidden | forbidden |
| `tests/test_orchestration_layout.py` | — | — | — | — | — | create | forbidden | forbidden |
| `tests/test_orchestration_executor.py` | — | — | — | — | — | — | create | forbidden |
| `tests/test_orchestrator.py` | — | — | — | — | — | — | — | create |
| 设计文档 / 任务卡（状态更新） | 提交轮 | 提交轮 | 提交轮 | 提交轮 | 提交轮 | 提交轮 | 提交轮 | 提交轮 |

§21 "不修改"清单（persistence/serialization/manifest/
validation/顶层 errors/providers 五文件/project_data/README/
pyproject.toml）对 B–G 全部 Step 均为 forbidden。

### 24.5 模块依赖顺序与循环检查

依赖方向（→ 表示"被依赖"，全部单向）：

```
core（errors/validation/models/serialization/persistence/providers）
  → orchestration.errors → orchestration.models（Enum）
  → orchestration.canonical
  → orchestration._models（B）
  → orchestration.recovery（B；F 限定追加）
  → orchestration.instructions（C，仅依赖 canonical/errors/providers）
  → orchestration.planning（D，依赖 _models/canonical/instructions）
  → orchestration.layout（E，仅依赖 errors）
  → orchestration.executor（F，依赖 _models/recovery/layout/
    canonical/persistence）
  → orchestration.models 公开摘要（G）
  → orchestration.orchestrator（G，依赖以上全部）
```

约束：Step A 基础工具（errors/models/canonical）不得导入
B–G 模块；core 包不得反向导入 orchestration；layout 不依赖任何
orchestration 数据模型；executor 不导入 planning（只接受
`_ExecutablePlan` 实例）；instructions 不导入 _models/recovery。
唯一潜在环：`orchestration/models.py`（公开摘要）↔
`orchestration/recovery.py`（recovery 模块级导入 Enum；公开
摘要的 updated_task/updated_manifest 需要 §16.4 adapter）——
解决方案已固定：公开摘要模块级**不导入** recovery，两个属性体
内使用函数级导入（本设计唯一批准的延迟导入点，Step G 有 import
无环测试锁定）。其余依赖图为 DAG，无循环。
