# TASK-004 设计文档：Provider Orchestrator 契约与基础编排

- Status: approved — formal design review passed; ADR-0001
  synchronization pending; coding gate closed
- Revision: r6（自包含版本；关闭 r5 复审的 3 个阻塞与 1 个重要
  问题；不依赖任何历史草案或聊天记录）

**审批记录（Codex formal design review, r6）**：

- Codex formal design review: **passed**
- blockers: 0；important findings: 0；suggestions: 0
- design body approved
- architecture.md change: not required
- GenerationTaskStatus.CANCELLED design prerequisite: satisfied
- ADR-0001 actual synchronization: pending（本批准提交之后方可
  开始）
- implementation agent: pending
- coding gate: closed
- Python implementation: prohibited
- 批准时 QA 结果（当前仓库实际执行）：Ruff format 38 files
  already formatted；Ruff lint passed；full pytest **757
  passed**；whitespace passed
- 说明：本文档 §22 的 131 项是**未来实施的测试计划**；批准时
  实际执行的是当前仓库已有的 757 项测试，不声称 131 项计划测试
  已经实现。
- Task: [TASK-004](../tasks/TASK-004-provider-orchestrator-foundation.md)
- Specification baseline:
  `47aeafc docs: approve TASK-004 orchestrator specification`
- TASK-003 completed baseline:
  `01ac984 docs: complete TASK-003 implementation`
- coding gate: closed
- 目标运行环境：WSL2 Ubuntu / Linux（POSIX `os.replace`；不测试
  Windows path 或 replace 语义）

**前置项状态**：

1. GenerationTaskStatus.CANCELLED design prerequisite approval:
   **satisfied**（代码变更只在 coding gate 打开后按 Step M
   实施）；
2. CANCELLED code implementation: not implemented（gate 前
   禁止）；
3. ADR-0001 prerequisite approval: **satisfied in principle**；
4. ADR-0001 actual documentation synchronization: **pending**
   （r6 已通过复审并提交后方可开始；仍不实施 CANCELLED、不开始
   任何 Python Step）；
5. architecture synchronization: **not required**（executor 内部
   化方案已通过最终设计审查，见 §2）；
6. formal design review（r6）: **passed**；
7. implementation agent: **pending**；
8. coding gate: **closed**——Python implementation prohibited。

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
118. full regression（757 基线 + 新增）；Ruff format/lint；git
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

**不声称任何 AC 已由代码满足**（尚无实现代码）。
