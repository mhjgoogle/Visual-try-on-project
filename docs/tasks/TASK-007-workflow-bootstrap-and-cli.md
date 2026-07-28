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
  由本任务的 bootstrap 分配）。

## 范围内

1. `app` 包（应用层，architecture Workflow Orchestrator 角色的
   调用方侧）：
   - **bootstrap**：从显式加载的 `ProjectData` 为每个无未完成
     任务的 Shot 创建 `GenerationTask`（PENDING、provider_id=None）
     与 generation StepManifest（满足 TASK-004 进入前置条件），
     原子落盘、防覆盖、幂等重跑（已有未完成任务的 Shot 跳过）；
     支持为指定 Shot 显式创建重做任务（新 task_id，同 shot_id）；
     发射 `task_created`；
   - **driver**：包装 `ProviderOrchestrator` 的调用方职责——
     系统时钟读取（应用层是唯一允许读时钟处）、operation_id 生成
     （uuid4，记录在输出中）、`OrchestrationContext` 组装（从磁盘
     显式加载 task/manifest/record）、把 APPLIED outcome 的
     updated_task/updated_manifest 状态变化映射为
     `task_status_changed` 事件、`manual_attempt_recorded` 记录
     入口、人工评分（`manual_quality_rating_recorded`）记录入口；
   - **staging 分配**：`staging/shots/<task-id>.mp4`（合同固定，
     bootstrap 写入 ProviderRequest.staging_ref 与说明文档）；
   - **产物确认**：用户以显式路径声明文件已放置；driver 仅对该
     显式路径做存在性检查（lstat，无扫描、无 glob），构造
     `ArtifactReference(user, staging)` 交给
     `report_artifact`/`collect`；
2. `cli.py`：argparse console script `ai-video-workflow`，
   子命令：`init-tasks`、`status`、`show-instruction`、
   `record-attempt`、`report-artifact`、`collect`、`validate`、
   `rate`、`compose`；`--project-root` 显式必填；退出码 0/非 0
   区分成功与类型化失败；错误信息人类可读；
3. 端到端最小闭环集成测试（示例项目 + 假 inspector/composer）；
4. README 增补最小闭环操作流程（可复制命令序列）。

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
  `driver.py`、`clock.py`、`ids.py`
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
    *, project_root: Path, data: ProjectData, provider_id: str,
    now: datetime,
) -> BootstrapOutcome: ...
# BootstrapOutcome: created(tuple[task_id,...])、skipped、
# emitted_event_ids

def create_redo_task(
    *, project_root: Path, data: ProjectData, shot_id: str,
    provider_id: str, now: datetime,
) -> BootstrapOutcome: ...

class WorkflowDriver:
    def __init__(self, orchestrator: ProviderOrchestrator,
                 project_root: Path,
                 clock: Callable[[], datetime] = utc_now): ...
    def prepare(self, task_id: str) -> DriverOutcome: ...
    def submit(self, task_id: str) -> DriverOutcome: ...
    def poll(self, task_id: str) -> DriverOutcome: ...
    def report_artifact(self, task_id: str,
                        staged_path: str) -> DriverOutcome: ...
    def collect(self, task_id: str) -> DriverOutcome: ...
    def resume(self, task_id: str) -> ResumeAssessment: ...
    def record_attempt(self, task_id: str,
                       note: str | None) -> str: ...   # event_id
    def record_rating(self, *, shot_id: str, task_id: str | None,
                      score: int, note: str | None) -> str: ...

class BootstrapError(AiVideoWorkflowError): ...
class TaskAlreadyExistsError(BootstrapError): ...
class StagedFileMissingError(AiVideoWorkflowError): ...
```

CLI 子命令与上述 API 一一对应；`validate`/`compose` 子命令直接
接线 TASK-005/006 的 step API（真实 `FfprobeMediaInspector` /
`FfmpegVideoComposer` 作为默认实现）。

## Data contracts

- **task_id 派生**：`task-<shot-id>-<n>`（同一 Shot 第 n 次任务，
  n 从 1 递增；确定性、可排序、满足 stable ID 规则）；
- **generation StepManifest**：`manifests/generation-<task-id>.json`、
  `step_name = "generation:<task-id>"`、PENDING、
  `input_digest = config_digest(shot 生成输入投影)`、
  `relevant_config_digest = config_digest(provider_id + staging 合同
  版本)`（TASK-004 进入前置条件所需的既存文件由此满足）；
- **ProviderRequest 组装**：prompt/duration/width/height/frame_rate
  取自 Shot；staging_ref 按合同派生；provider_parameters 留空；
- **QCD 事件**：`task_created:<task-id>`、
  `task_status_changed:<task-id>:<operation_id>`、
  `manual_attempt_recorded:<task-id>:<uuid>`、
  `manual_quality_rating_recorded:<shot-id>:<uuid>`（评分事件可
  随时补记，不绑定任务状态）；
- **状态呈现**：`status` 子命令输出每 Shot 的任务链、编排 record
  摘要（`OrchestrationRecord`）、资产登记与合成状态——只读派生，
  不落盘。

## Failure / recovery semantics

- bootstrap 幂等：目标 task/manifest 文件已存在 → 跳过该 Shot
  （不静默覆盖）；部分创建后崩溃 → 重跑补齐缺失文件；
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

1. bootstrap：创建/跳过/重做任务、task_id 派生、幂等、防覆盖、
   `task_created` 事件、manifest 满足 TASK-004 进入前置条件（用
   真实 orchestrator prepare 验证可进入）；
2. driver：上下文组装、operation_id 传递、状态变化 →
   `task_status_changed` 映射（含 NO_OP 不发事件）、
   record_attempt/record_rating 事件、StagedFileMissingError、
   staging containment；
3. CLI：每个子命令的参数解析、退出码、错误呈现（driver 打桩）；
4. 时钟/uuid 边界：核心模块无 `datetime.now` 调用（复用既有守卫
   测试模式）。

## Integration tests

`tests/test_minimal_loop.py` —— 最小闭环端到端（假
inspector/composer + fixture 文件，真实 orchestrator/manual
provider/持久化）：

1. 示例项目复制到 tmp → `init-tasks` → 说明文档生成、task_created
   落盘；
2. 放置 fixture 文件 → `report-artifact` → `collect` →
   artifact_handoff；
3. `validate` → VideoAsset v1 + 报告 + 事件；
4. `compose` → final_v1.mp4 + 报告 + 事件；
5. 全流程任意步骤后中断重跑 → 幂等；
6. 事件日志包含全部七类中本流程应出现的事件且 event_id 可去重。

## 验收标准

1. product_spec 成功标准 1–5 全部由集成测试客观验证（标准 5 的
   venv 约束由 CI 命令与 README 验证）；
2. bootstrap 创建的 task/manifest 满足 TASK-004 全部进入前置
   条件，有测试；
3. 阶段 2 三类 QCD 事件采集落盘，有测试；
4. CLI 九个子命令可执行、退出码正确、错误人类可读；
5. 无目录扫描式产物发现（守卫测试）；
6. 未越界（未修改冻结合同；pyproject 仅新增 scripts 入口）；
7. 全部测试通过、Ruff format/lint 全绿、`git diff` 范围检查通过。

## 实施 Agent / 审查 Agent

- 实施 Agent：Claude Code。
- 审查方式：batch milestone mode——设计随整体报告一次审查；实施
  审查合并到 Milestone 1 回归门槛。

## 当前状态

Remaining roadmap design complete —
single Codex architecture review pending
