# TASK-007：任务生成 Bootstrap、工作流驱动与最小 CLI（阶段 2 收尾 + 最小闭环接线）

> **状态：规划定稿（PLANNED）——batch milestone mode 第一阶段产物，
> 待整体 Codex 设计审查。** 完成本任务即达成第一阶段最小闭环
> （product_spec 成功标准 1–5 全部可一条命令验证）。

## 正式名称

Generation Task Bootstrap, Workflow Driver, and Minimal CLI

## 业务目标

补齐最小闭环缺失的应用层：读取故事与镜头数据 → 批量创建
`GenerationTask` 与 generation StepManifest → 驱动
`ProviderOrchestrator` 生成人工任务说明 → 用户放置文件后经显式
报告推进 collect → 调用校验与合成步骤——每步一条命令即可执行，
并补发 implementation_plan 阶段 2 遗留的三类 QCD 事件
（`task_created`、`task_status_changed`、
`manual_attempt_recorded`）。

## 前置依赖

- TASK-004（`ProviderOrchestrator` 七方法公开合同）；
- TASK-005（`qcd` 事件模块、校验步骤 API、staging 命名合同）；
- TASK-006（合成步骤 API）——仅 `compose` 子命令接线依赖；
  bootstrap/driver 部分可与 TASK-006 并行实施；
- ADR-0001 第二次增补（staging 命名 `staging/shots/<task-id>.mp4`
  为固定合同，由 `ProviderRequestFactory` 在 prepare 时按合同派生——
  不由 bootstrap 预写）。

## 范围内

1. `app` 包（应用层，architecture Workflow Orchestrator 角色的
   调用方侧）：
   - **bootstrap（确定性 task identity，定案）**：从显式加载的
     `ProjectData` 为每个 Shot 按**确定性 task identity**
     （`task-<shot-id>-1`，见 Data contracts）创建
     `GenerationTask`（PENDING、provider_id=None）与 generation
     StepManifest（满足 TASK-004 进入前置条件），原子落盘、发射
     `task_created`。bootstrap **只创建 task 与 manifest**——
     **不生成 instruction、不构造 ProviderRequest、不写 staging_ref、
     不预先写 provider binding**（这些都属于 prepare 时机，见下）。
     幂等/冲突规则：
     - **若该确定性身份的 task 已存在（无论 PENDING / DONE /
       FAILED / CANCELLED），一律不自动再创建另一个 task**——不得
       以「没有未完成 task」为由自动新建；
     - 已存在时校验其 companion 文件（generation manifest）与预期
       **等价**并只补齐缺失文件（partial-crash 重跑幂等）；bootstrap
       从不创建 instruction，故 companion 校验不含 instruction；
     - 已存在文件与预期**不等价** → 返回类型化冲突
       （`TaskAlreadyExistsError`），不覆盖非等价状态；
   - **redo（仅显式）**：为某 Shot 发起新尝试**只能**经
     `create-redo-task`：持久化新 `task_id`（`task-<shot-id>-<n+1>`）、
     记录 `redo_of_task_id`、创建新 generation StepManifest。
     `create-redo-task` **不创建、也不返回 orchestration
     operation_id**——后续每次 `prepare`/`submit` 各自接收调用方
     提供的 operation_id（driver 生成）。bootstrap **绝不**基于
     「无未完成 task」自动创建 redo；
   - **driver**：包装 `ProviderOrchestrator` 的调用方职责——
     系统时钟读取（应用层是唯一允许读时钟处）、operation_id 生成
     （uuid4，记录在输出中）、经 `ProviderRequestFactory` 在
     **prepare/submit 时机**构造 `ProviderRequest`（staging_ref 由
     factory 按 `staging/shots/<task-id>.mp4` 合同派生——不由
     bootstrap 预写）、`OrchestrationContext` 组装（从磁盘显式加载
     task/manifest/record）、把 APPLIED outcome 的
     updated_task/updated_manifest 状态变化映射为
     `task_status_changed` 事件、`manual_attempt_recorded` 记录
     入口、人工评分（`manual_quality_rating_recorded`）记录入口；
     **instruction 由 `prepare` 经 `ProviderOrchestrator` 生成并落盘**
     （TASK-004 内部 executor 渲染），bootstrap 不生成；
   - **产物确认**：用户以显式路径声明文件已放置；driver 仅对该
     显式路径做存在性检查（lstat，无扫描、无 glob），构造
     `ArtifactReference(user, staging)` 交给
     `report_artifact`/`collect`；
2. `cli.py`：argparse console script `ai-video-workflow`，生命周期
   子命令（定案）：`init-tasks`、`prepare`、`submit`、
   `report-artifact`、`collect`、`validate`、`compose`、`status`、
   `create-redo-task`、`run`；辅助子命令 `show-instruction`、
   `record-attempt`、`rate`（映射 driver 的说明展示 /
   `record_attempt` / `record_rating`）；`--project-root` 显式必填；
   退出码 0/非 0 区分成功与类型化失败；错误信息人类可读；
   - **`run`（一条命令闭环）** 的固定顺序：
     `bootstrap → prepare → submit → report-artifact → collect →
     validate → compose`；ManualVideoProvider 下 `run` **必须接收
     显式 artifact 参数**（`--staged-path`），因为手工模式无法自动
     发现产物；**不得**从 `NOT_SUBMITTED` 直接 `report-artifact`
     （必须先 `submit` 进入 `waiting_for_user`），顺序由 `run`
     强制；任一步类型化失败 → 停止并以非零退出码报告，已完成的
     前序步骤保持其幂等落盘（重跑 `run` 从断点续跑）；
3. 端到端最小闭环集成测试（示例项目 + 假 inspector/composer）；
4. README 增补最小闭环操作流程（可复制命令序列，含 `run`）。

## 范围外

- 修改 `ProviderOrchestrator`、providers、models、serialization、
  persistence、TASK-005/006 交付物的任何既有合同；
- 交互式 TUI/Web UI、并发调度、后台队列；
- 自动目录扫描发现产物（只接受显式路径声明）；
- LLM/云端 API；
- QCD 汇总报表（TASK-009）。

## Production ownership

新增（本任务独占写入）：

- `src/ai_video_workflow/app/__init__.py`、`bootstrap.py`、
  `driver.py`、`requests.py`（`ProviderRequestFactory` Protocol +
  `DefaultProviderRequestFactory`，TASK-007 唯一 owner）、
  `clock.py`、`ids.py`、`contracts.py`
  （`STAGING_CONTRACT_VERSION` 等稳定合同常量的唯一 owner）
- `src/ai_video_workflow/cli.py`
- `pyproject.toml`（仅新增 `[project.scripts]` 入口——冻结文件的
  一次性授权修改，范围仅此一行）
- `README.md`（增补操作流程章节）
- `tests/test_bootstrap.py`、`tests/test_driver.py`、
  `tests/test_cli.py`、`tests/test_minimal_loop.py`

只读：其余全部既有模块。

## Public API

```python
# ai_video_workflow.app
def bootstrap_generation_tasks(
    *,
    project_root: Path,
    data: ProjectData,
    provider_id: str,
    now: datetime,
) -> BootstrapOutcome: ...


# BootstrapOutcome: created(tuple[task_id,...])、skipped、
# emitted_event_ids


def create_redo_task(
    *,
    project_root: Path,
    data: ProjectData,
    shot_id: str,
    provider_id: str,
    now: datetime,
) -> BootstrapOutcome: ...


@dataclass(frozen=True, slots=True)
class DriverOutcome:
    # 精确字段与顺序（本卡即合同，实施不得增删改序）：
    task_id: str  # 1. 目标任务
    action: OrchestrationAction  # 2. prepare/submit/poll/report_artifact/collect
    operation_id: str  # 3. driver 生成的 uuid4 操作身份
    outcome: OrchestrationOutcome  # 4. 公开编排结果原样嵌入
    emitted_event_ids: tuple[str, ...]  # 5. 本次发射的 QCD event_id（可为空）
    instruction_path: str | None  # 6. prepare 后说明文档路径，否则 None
    staged_path: str | None  # 7. report_artifact/collect 的声明路径回显，否则 None


class ProviderRequestFactory(Protocol):
    """Formal request-construction port; TASK-007 is its sole owner.

    Builds a ProviderRequest from explicitly passed public models. It
    MUST NOT read files, scan directories, touch the executor, or read
    cwd / environment / any global registry; it MUST NOT mutate its
    inputs; it returns a formal ProviderRequest built from the current
    public Project / Shot / GenerationTask types (no parallel Project
    DTO is introduced).
    """

    def build(
        self,
        *,
        project: Project,
        shot: Shot,
        task: GenerationTask,
        provider_id: str,
    ) -> ProviderRequest: ...


class DefaultProviderRequestFactory:
    """The M1 default `ProviderRequestFactory` (structural conformance).

    Maps Shot.prompt / duration / width / height / frame_rate into the
    ProviderRequest, derives staging_ref from the staging contract, and
    leaves provider_parameters empty. Pure and side-effect-free.
    """


class WorkflowDriver:
    def __init__(
        self,
        *,
        provider_id: str,
        provider: VideoProvider,
        request_factory: ProviderRequestFactory,
        project_root: Path,
        inspector: MediaInspector,
        composer: VideoComposer,
        clock: Callable[[], datetime] = utc_now,
    ): ...
    # The driver constructs `ProviderOrchestrator(provider)` internally; the
    # explicit provider_id / request_factory / inspector / composer are the
    # approved dependencies for request construction, validation, and
    # composition. No dependency is discovered from cwd / env / a registry.
    def prepare(self, task_id: str) -> DriverOutcome: ...
    def submit(self, task_id: str) -> DriverOutcome: ...
    def poll(self, task_id: str) -> DriverOutcome: ...
    def report_artifact(self, task_id: str, staged_path: str) -> DriverOutcome: ...
    def collect(self, task_id: str) -> DriverOutcome: ...
    def resume(self, task_id: str) -> ResumeAssessment: ...
    def status(self, task_id: str) -> ResumeAssessment: ...  # 只读，见下
    def record_attempt(self, task_id: str, note: str | None) -> str: ...  # event_id
    def record_rating(
        self, *, shot_id: str, task_id: str | None, score: int, note: str | None
    ) -> str: ...


class BootstrapError(AiVideoWorkflowError): ...


class TaskAlreadyExistsError(BootstrapError): ...


class StagedFileMissingError(AiVideoWorkflowError): ...
```

**DriverOutcome 合同**（从 WorkflowDriver 六方法与既有
BootstrapOutcome / ValidationStepOutcome / CompositionStepOutcome /
OrchestrationOutcome / ResumeAssessment 机械确定）：

- `frozen=True, slots=True`；深度冻结（`emitted_event_ids` 为
  tuple，嵌套 `OrchestrationOutcome` 自身已深度冻结）；与 TASK-004
  §6.2 公开模型相同的「深度冻结、不保证可哈希」合同（嵌套 mapping
  快照使 hash 不可用，不得依赖）；
- 每种方法的字段出现规则：`prepare` → `instruction_path` 非
  None、`staged_path` 为 None；`report_artifact`/`collect` →
  `staged_path` 非 None（collect 未显式声明路径时为 None）、
  `instruction_path` 为 None；`submit`/`poll` → 两者均 None；
- task/manifest 身份与更新后快照经 `outcome.plan` /
  `outcome.record` 提供，**不**重复嵌入；QCD 身份经
  `emitted_event_ids`（NO_OP 不发事件 → 空 tuple）；
- 成功 = `outcome.kind is APPLIED`；no-op = `NO_OP` +
  `outcome.no_op_reason`；manual/conflict/校验失败一律为**类型化
  异常**（不进入 DriverOutcome），CLI 把异常映射为非零退出码；
- `resume`/`status` 不返回 DriverOutcome（原样返回公开
  `ResumeAssessment`）；`record_attempt`/`record_rating` 返回
  event_id 字符串；
- DriverOutcome 不落盘、不序列化为 durable JSON（非持久模型；CLI
  只做人类可读渲染）；不暴露 executor 或任何内部 durable model。

CLI 子命令与上述 API 一一对应；`validate`/`compose` 子命令直接
接线 TASK-005/006 的 step API（真实 `FfprobeMediaInspector` /
`FfmpegVideoComposer` 作为默认实现）。

## Data contracts

- **task_id 派生**：`task-<shot-id>-<n>`（同一 Shot 第 n 次任务，
  n 从 1 递增；确定性、可排序、满足 stable ID 规则）；
- **generation StepManifest**：`manifests/generation-<task-id>.json`、
  `step_name = "generation:<task-id>"`、PENDING（TASK-004 进入
  前置条件所需的既存文件由此满足）。两个 digest 的**精确输入**
  （canonical JSON + SHA-256，经 TASK-005 `config_digest`）：
  - `input_digest = config_digest({...})`，投影字段集**完整列举**
    如下（全部来自既有模型，只含改变生成语义的输入）：
    - `"schema": "m1-generation-input-v1"`（常量）；
    - `"shot_id": shot.shot_id`；
    - `"scene_id": shot.scene_id`；
    - `"character_ids": list(shot.character_ids)`（模型内既有
      顺序）；
    - `"prompt": shot.prompt`；
    - `"description": shot.description`；
    - `"duration_seconds": shot.duration_seconds`；
    - `"width": shot.width`；
    - `"height": shot.height`；
    - `"frame_rate": shot.frame_rate`。
    **显式排除**：当前时间、created_at、scene/shot sequence（只
    影响合成顺序不影响单镜头生成）、绝对 project root、临时/输出
    路径、mutable 任务状态、运行期重试计数；
  - `relevant_config_digest = config_digest({"schema":
    "m1-generation-config-v1", "provider_id": <选定 provider_id>,
    "staging_contract": STAGING_CONTRACT_VERSION})`；
    `STAGING_CONTRACT_VERSION = "m1-staging-v1"` 为固定常量，
    **唯一 owner 为本任务新增模块 `app/contracts.py`**，任何步骤
    不得自行拼写该字符串；
- **ProviderRequest 组装（prepare 时机，`ProviderRequestFactory`）**：
  prompt/duration/width/height/frame_rate 取自 Shot；staging_ref 按
  `staging/shots/<task-id>.mp4` 合同派生；provider_parameters 留空。
  **bootstrap 不构造 ProviderRequest、不写 staging_ref**——请求在每次
  prepare/submit 由 driver 经 factory 现场构造；
- **bootstrap `provider_id` 落点（定案）**：
  - 用于选择/绑定 Provider 与 ProviderRequest 组装；
  - 纳入 `relevant_config_digest`（见上）；
  - **不写入初始 GenerationTask.provider_id**——初始任务必须为
    `provider_id=None`（TASK-004 首次 prepare 前置条件）；
  - provider binding 由首次成功 PREPARE 按 TASK-004 合同落入
    后续状态；bootstrap 不提前伪造 prepared/provider 状态；
  - provider_id 保存在 CLI/driver 的调用配置中，不新增 durable
    配置文件；
- **QCD 事件**：本任务发射 `task_created`、`task_status_changed`、
  `manual_attempt_recorded`（评分事件 CLI 入口写
  `manual_quality_rating_recorded`）——payload 字段集、event_id
  派生、单位与 None 语义以 **ADR-0003 §4.1–§4.3/§4.5/§5 为准**；
  `task_status_changed` 仅在 APPLIED 且状态实际变化时发射（NO_OP
  不发事件）；评分事件可随时补记，不绑定任务状态；
- **状态呈现（定案，ResumeAssessment-only）**：`status` 子命令
  **只输出公开 `ResumeAssessment`**（经 `WorkflowDriver.status` →
  内部调用 `orchestrator.resume`）。展示字段严格限于：`phase`、
  `disposition`、`legal_actions`、`preferred_next_action`、
  `requires_manual_reconciliation`，以及一行人类可读
  message/diagnostic。**明确删除「展示资产登记 / 合成状态」的
  承诺**：`status` **不**推断或展示 VideoAsset / composition 状态，
  **不**扫描目录，**不**读取 private executor，**不**新增
  OrchestrationRecord public accessor / durable-record read API /
  internal model export。只读派生，不落盘。

## Failure / recovery semantics

- bootstrap 幂等：确定性身份的 task/manifest 已存在 → 校验其与预期
  等价并只补齐缺失文件（不静默覆盖、不新建第二个 task）；部分创建后
  崩溃 → 重跑补齐缺失文件；已存在文件与预期不等价 →
  `TaskAlreadyExistsError`；
- driver 每次调用均从磁盘重新加载上下文（无内存会话状态）；
  编排层的 NO_OP/冲突/恢复语义原样透传并以人类可读方式呈现；
  `resume` 暴露 `RecoveryDisposition`，MANUAL_RECONCILIATION 时
  指示用户操作，不自动修复；
- `task_status_changed` 事件在 persistence 之后发射；崩溃在两者
  之间 → 事件缺失可由阶段 6 从任务记录对账（记录为 ADR-0003 已知
  边界），不作双写事务；
- CLI 任何类型化错误 → 非零退出码 + 错误类别名 + 消息；未知异常
  原样冒泡（不吞错）。

## Security boundaries

- 项目根显式传入；全部读写限于项目根内既有合同路径；
- 时钟与 uuid 只在 `app.clock` / `app.ids` 产生（核心库保持显式
  时间输入原则）；
- 不执行用户提供的字符串；staged 路径必须解析于 staging/ 之内
  （containment + symlink 校验）；
- 无网络、无凭据。

## Focused tests

1. bootstrap：确定性 task identity 创建、`task_id` 派生、
   `task_created` 事件、manifest 满足 TASK-004 进入前置条件（用
   真实 orchestrator prepare 验证可进入）；**确定性身份幂等**：
   已存在同身份 task（PENDING / DONE / FAILED / CANCELLED 各态）时
   不再自动创建第二个 task；**部分创建后崩溃**：为部分 Shot 创建
   task/manifest 后中断 → 重跑验证已有文件与预期等价并只补齐缺失
   文件；已有文件与预期**不等价** → `TaskAlreadyExistsError`，不
   覆盖；
2. redo：`create-redo-task` 分配新 `task_id`（`-<n+1>`）、记录
   `redo_of_task_id`、新 manifest；验证 `create-redo-task` **不创建、
   也不返回 operation_id**（后续 prepare/submit 各自接收调用方提供的
   operation_id）；验证 bootstrap **不**基于「无未完成 task」自动
   redo；
3. driver：显式依赖构造（provider_id / provider / request_factory
   / inspector / composer / project_root / clock，无 cwd/env/
   registry 发现）；`ProviderRequestFactory.build` 纯函数（不读文件
   /不扫描/不碰 executor/不改输入/返回正式 ProviderRequest，输入用
   真实 Project/Shot/GenerationTask 类型）；上下文组装、operation_id
   传递、状态变化 → `task_status_changed` 映射（含 NO_OP 不发
   事件）、record_attempt/record_rating 事件、StagedFileMissingError、
   staging containment；
4. `status` ResumeAssessment-only：只暴露 5 个评估字段 + 一行
   诊断；**不**读 executor、**不**扫描、**不**推断资产/合成状态、
   **不**新增 record accessor（守卫测试）；
5. CLI：每个子命令的参数解析、退出码、错误呈现（driver 打桩）；
   `run` 生命周期顺序（bootstrap→prepare→submit→report-artifact→
   collect→validate→compose）；Manual 下 `run` 缺 `--staged-path`
   报错；不得从 NOT_SUBMITTED 直接 report-artifact；
6. 时钟/uuid 边界：核心模块无 `datetime.now` 调用（复用既有守卫
   测试模式）。

## Integration tests

`tests/test_minimal_loop.py` —— 最小闭环端到端（假
inspector/composer + fixture 文件，真实 orchestrator/manual
provider/持久化）：

1. 示例项目复制到 tmp → `init-tasks` → **只**创建 task/manifest 并
   落盘 `task_created`（**不**生成 instruction、**不**构造
   ProviderRequest、**不**写 staging_ref）；
2. 完整生命周期 `prepare`（经 orchestrator 生成 instruction 落盘）
   → `submit` → `report-artifact`（显式路径，放置 fixture 文件后）
   → `collect` → artifact_handoff；
3. `validate` → VideoAsset v1 + 报告 + 事件；
4. `compose` → final_v1.mp4 + 报告 + 事件；
5. `run` 一条命令走完整生命周期（bootstrap→prepare→submit→
   report-artifact→collect→validate→compose，Manual 下带
   `--staged-path`），产物与逐步执行等价；
6. 全流程任意步骤后中断重跑（含 `run` 重跑）→ 幂等；
7. 事件日志包含全部七类中本流程应出现的事件且 event_id 可去重。

**Optional real CLI smoke test（本任务拥有，ADR-0002 第 4 条）**：
`tests/test_minimal_loop.py` 内独立测试——真实
`FfprobeMediaInspector` + `FfmpegVideoComposer` 走**完整生命周期
一条命令序列**（init-tasks → prepare → submit → report-artifact →
collect → validate → compose；不得跳过 prepare/submit），使用最小
受控媒体 fixture，仅验证完整命令可跑通与产物存在，不做脆弱的
编码字节等价断言；`pytest.mark.skipif`
（ffmpeg/ffprobe 不可用即跳过）+ 显式环境开关
`AI_VIDEO_WORKFLOW_REAL_TOOLS=1`；**不属于默认 CI 回归门槛**，
CI 不要求安装真实 FFmpeg；真实工具手工执行流程保留在 README。

## 验收标准

1. product_spec 成功标准 1–5 全部由集成测试客观验证（含 `run`
   一条命令闭环；标准 5 的 venv 约束由 CI 命令与 README 验证）；
2. bootstrap 用确定性 task identity；同身份 task 已存在（任一态）
   不自动新建；new attempt 仅经 `create-redo-task`（记录
   `redo_of_task_id` + 新身份），有测试；
3. bootstrap 创建的 task/manifest 满足 TASK-004 全部进入前置
   条件，有测试；
4. 阶段 2 三类 QCD 事件采集落盘，有测试；
5. `WorkflowDriver` 经显式依赖（provider_id/provider/
   request_factory/inspector/composer）构造，`ProviderRequestFactory`
   为 TASK-007 拥有的正式 Protocol、纯函数、用现有公开模型类型、无
   平行 DTO，有测试；
6. CLI 生命周期子命令（含 `run` 固定顺序、`create-redo-task`）可
   执行、退出码正确、错误人类可读；Manual 下 `run` 需显式 artifact；
7. `status` 只输出 `ResumeAssessment`，不推断资产/合成状态、不扫描、
   不读 executor、不新增 record accessor（守卫测试）；
8. 无目录扫描式产物发现（守卫测试）；
9. 未越界（未修改冻结合同；pyproject 仅新增 scripts 入口）；
10. 全部测试通过、Ruff format/lint 全绿、`git diff` 范围检查通过。

## 实施 Agent / 审查 Agent

- 实施 Agent：Claude Code。
- 审查方式：batch milestone mode——设计随整体报告一次审查；实施
  审查合并到 Milestone 1 回归门槛。

## 当前状态

Remaining roadmap design complete —
single Codex architecture review pending
