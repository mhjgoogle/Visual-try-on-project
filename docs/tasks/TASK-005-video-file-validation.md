# TASK-005：视频文件校验、VideoAsset 登记与 QCD 事件日志基础（阶段 3）

> **状态：规划定稿（PLANNED）——batch milestone mode 第一阶段产物，
> 待整体 Codex 设计审查。** 本卡由原 DRAFT 定稿：原「待定案设计
> 问题」1–6 已按 batch milestone mode 授权逐条定案（见「设计定案」）。
> 编码在整体设计审查通过前不得开始。

## 背景

TASK-004 已交付 provider orchestrator：`GenerationTask` →
`VideoProvider`（阶段 1 为 `ManualVideoProvider`）→ `ProviderResult`，
编排器推进项目级状态，collect 成功时以显式 `ArtifactReference`
（`OrchestrationOutcome.artifact_handoff`，location=staging）交接。

阶段 3 承接其后一环：对用户放入 staging 的视频文件做文件级校验，
把通过校验的视频导入正式资产目录并登记为 `VideoAsset`，采集 QCD
原始事件。这是 TASK-004 固定资产边界明确排除的范围，在本任务首次
引入。同时，QCD append-only 事件日志（architecture.md §10）在全部
既有任务中均未实现，本任务作为首个事件写入方，一并交付事件日志
基础模块（schema 覆盖全部七种事件类型，本任务只发射其中三种）。

`VideoAsset` 模型已在 TASK-002 定义，本任务负责填充与登记，
不修改其字段。

## 正式名称

Video File Validation, VideoAsset Registration, and QCD Event Log
Foundation

## 业务目标

用户按任务说明把视频放入 staging 后，程序能校验出缺失、命名错误、
格式不符、参数越界的文件并给出明确的人类可读报告；通过校验的文件
被带版本、防覆盖地导入 `assets/media/` 并登记为 `VideoAsset`；
过程事实以 append-only QCD 事件落盘（product_spec 成功标准 2 的
完整实现，标准 4 的本步骤部分）。

## 前置依赖

- TASK-002（模型、persistence、ProjectData）——已完成；
- TASK-003（ArtifactReference 语义）——已完成；
- TASK-004（artifact_handoff 交接点、ADR-0001 增补布局）——实现已
  提交，Step G 最终审查随本次整体审查合并进行；
- ADR-0002（外部媒体工具抽象边界，Proposed）须随本任务定稿为
  Accepted；
- ADR-0003（QCD 事件日志格式，Proposed）须随本任务定稿为 Accepted；
- ADR-0001 第二次增补（`reports/` 目录、正式媒体命名、staging 命名
  合同）须在本任务实施前提交。

## 设计定案（原 DRAFT 待定案问题 1–6 的裁决）

1. **ffprobe 抽象**：采纳。新建 `MediaInspector` 抽象基类
   （`inspection` 包），核心校验逻辑只依赖该接口；
   `FfprobeMediaInspector` 为唯一生产实现（subprocess、固定 argv、
   无 shell、显式超时）。测试注入假 inspector。定案记录于 ADR-0002。
2. **VideoAsset 登记所有权**：由本任务新建的 `assets` 步骤组件承担
   （属架构意义上 Workflow Orchestrator 角色的一部分，但代码上独立
   于 TASK-004 的 `orchestration` 包，不修改其任何已审查合同）。
   architecture.md §3 的「唯一写入者」表述需最小同步：Workflow
   Orchestrator 是由多个步骤组件构成的应用层角色（见整体设计报告
   §7，须在实施前完成 doc 同步）。
3. **QCD 事件模型与存储**：本任务定义完整最小事件 schema（七种
   事件类型全部注册）与 append-only JSON Lines 日志写入器；汇总留
   阶段 6。格式定案于 ADR-0003。
4. **校验与编排层关系**：校验是独立步骤组件，不接入
   `ProviderOrchestrator`；以 StepManifest（`validation:<task-id>`）
   实现断点续跑，并首次定义 `input_digest` /
   `relevant_config_digest` 的计算算法（SHA-256，见 data contracts）。
5. **目录与命名**：用户产物位置 = 任务说明中的 staging_ref（合同
   `staging/shots/<task-id>.mp4`，由 TASK-007 bootstrap 分配、
   ADR-0001 增补固定）；正式媒体
   `assets/media/s<scene-seq>_sh<shot-seq>_v<version>.mp4`；校验
   报告 `reports/validation/<task-id>_v<version>.{json,md}`。
6. **报告格式**：JSON 为事实来源 + 确定性渲染的 Markdown 人类可读
   版本，两者同时落盘，防覆盖、带版本。

## 范围内

1. `inspection` 包：`MediaInspector` ABC、`MediaProbeResult` 冻结
   数据结构、`FfprobeMediaInspector`、`MediaInspectionError` 错误
   子树（继承 `AiVideoWorkflowError`）。
2. `assets` 包：校验规则引擎（存在性、命名符合 staging 合同、容器
   格式、可解码性、时长/分辨率/帧率参数校验，容差由
   `ValidationPolicy` 冻结数据结构显式配置）；校验报告生成；媒体
   导入（staging → `assets/media/`，复用 TASK-002 原子发布策略）；
   `VideoAsset` 登记（版本化、防覆盖、幂等重跑）。
3. `qcd` 包：事件 envelope 与七种事件类型构造器（`task_created`、
   `task_status_changed`、`manual_attempt_recorded`、
   `asset_imported`、`validation_completed`、
   `composition_completed`、`manual_quality_rating_recorded`）、
   append-only 写入器、供测试与阶段 6 使用的读取器。本任务发射：
   `asset_imported`、`validation_completed`、
   `manual_quality_rating_recorded`（评分补记入口为库级 API，CLI
   入口属 TASK-007）。
4. 摘要工具：文件内容 SHA-256 与 canonical-JSON 配置摘要（供
   StepManifest `input_digest` / `relevant_config_digest` 使用；
   TASK-006 复用）。
5. 校验步骤的 StepManifest 断点续跑与幂等语义。
6. 单元测试与集成测试（见测试要求）。

## 范围外

- FFmpeg 合成（TASK-006）；
- 任务生成 bootstrap、CLI、阶段 2 QCD 事件发射（TASK-007）；
- QCD 汇总、指标、报表（TASK-009）；
- 自动/结构化内容质量检查（阶段 1 边界：仅文件级校验）；
- 字幕/配音/音频（TASK-008）；
- 目录扫描式产物发现（输入一律显式传入）；
- 修改 TASK-002/003/004 已审查的模型、providers 包、orchestration
  包、`serialization.py` 注册表既有条目；
- 云端/本地生成、浏览器自动化、数据库、Web UI。

## Production ownership（文件归属）

新增（本任务独占写入）：

- `src/ai_video_workflow/inspection/__init__.py`、`base.py`、
  `ffprobe.py`、`errors.py`
- `src/ai_video_workflow/assets/__init__.py`、`policy.py`、
  `validation.py`、`registration.py`、`reports.py`、`step.py`
- `src/ai_video_workflow/qcd/__init__.py`、`events.py`、`log.py`
- `src/ai_video_workflow/digests.py`
- `tests/test_inspection.py`、`tests/test_asset_validation.py`、
  `tests/test_asset_registration.py`、`tests/test_qcd_events.py`、
  `tests/test_qcd_log.py`、`tests/test_digests.py`、
  `tests/test_validation_step.py`

只读（禁止修改）：`models.py`、`manifest.py`、`serialization.py`、
`persistence.py`、`project_data.py`、`providers/*`、
`orchestration/*`。

文档：ADR-0002、ADR-0003 定稿；ADR-0001 第二次增补；
architecture.md §3 最小同步（实施前）。

## Public API（本任务新增公开名称）

```python
# ai_video_workflow.inspection
class MediaInspector(ABC):
    @abstractmethod
    def probe(self, path: Path) -> MediaProbeResult: ...


@dataclass(frozen=True, slots=True)
class MediaProbeResult:
    container_format: str
    duration_seconds: float
    width: int
    height: int
    frame_rate: float


class FfprobeMediaInspector(MediaInspector): ...


class MediaInspectionError(AiVideoWorkflowError): ...


class MediaToolNotAvailableError(MediaInspectionError): ...


class UndecodableMediaError(MediaInspectionError): ...


class MediaProbeParseError(MediaInspectionError): ...


# ai_video_workflow.assets
@dataclass(frozen=True, slots=True)
class ValidationPolicy:
    allowed_containers: tuple[str, ...] = ("mp4",)
    duration_tolerance_ratio: float = 0.1
    frame_rate_tolerance: float = 0.5
    require_exact_resolution: bool = True


class ValidationCheckType(str, Enum):
    # 固定枚举与固定声明顺序（报告中的检查顺序 = 本顺序）
    FILE_EXISTS = "file_exists"  # 存在且为常规文件
    PATH_ALLOWED = "path_allowed"  # containment + symlink 策略
    FILE_READABLE = "file_readable"
    FILE_NON_EMPTY = "file_non_empty"
    SHA256_COMPUTED = "sha256_computed"
    METADATA_PARSED = "metadata_parsed"  # inspector probe 成功
    CONTAINER_ACCEPTED = "container_accepted"
    DURATION_WITHIN_TOLERANCE = "duration_within_tolerance"
    RESOLUTION_MATCHES = "resolution_matches"
    FRAME_RATE_WITHIN_TOLERANCE = "frame_rate_within_tolerance"


class ValidationCheckStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"  # 仅当前序检查 FAILED 导致未执行


@dataclass(frozen=True, slots=True)
class ValidationCheck:
    check_type: ValidationCheckType
    status: ValidationCheckStatus
    observed: str | None  # 观察值的确定性字符串表示；未观测为 None
    expected: str | None  # 约束的确定性字符串表示
    error_code: str | None  # 稳定机器可读失败码；非 FAILED 时为 None
    message: str | None  # 人类可读说明，仅展示用


@dataclass(frozen=True, slots=True)
class ValidationReport:  # 逐规则类型化结果
    task_id: str
    shot_id: str
    checked_path: str  # 项目根相对 POSIX 路径
    passed: bool
    checks: tuple[ValidationCheck, ...]
    probe: MediaProbeResult | None
    policy_digest: str
    observed_at: datetime  # 调用方显式传入


def validate_artifact(
    *,
    project_root: Path,
    shot: Shot,
    task: GenerationTask,
    artifact: ArtifactReference,
    inspector: MediaInspector,
    policy: ValidationPolicy,
    observed_at: datetime,
) -> ValidationReport: ...


def run_validation_step(
    *,
    project_root: Path,
    shot: Shot,
    scene: Scene,
    task: GenerationTask,
    artifact: ArtifactReference,
    inspector: MediaInspector,
    policy: ValidationPolicy,
    observed_at: datetime,
) -> ValidationStepOutcome: ...


# ValidationStepOutcome: report、registered_asset(VideoAsset|None)、
# manifest(StepManifest)、emitted_event_ids、skipped(bool)


class AssetRegistrationError(AiVideoWorkflowError): ...


class ValidationFailedError(AssetRegistrationError): ...


class AssetConflictError(AssetRegistrationError): ...


# ai_video_workflow.qcd
@dataclass(frozen=True, slots=True)
class QcdEvent:
    event_id: str  # 确定性派生，见 ADR-0003
    event_type: QcdEventType
    occurred_at: datetime
    project_id: str
    shot_id: str | None
    task_id: str | None
    payload: Mapping[str, JsonCompatibleValue]


class QcdEventType(str, Enum): ...  # 七种事件类型


def append_event(project_root: Path, event: QcdEvent) -> None: ...
def read_events(project_root: Path) -> tuple[QcdEvent, ...]: ...


# ai_video_workflow.digests
def file_sha256(path: Path) -> str: ...
def config_digest(value: JsonCompatibleValue) -> str: ...
```

本卡列出的名称、参数形态、字段集与语义**即为合同**，实施不得
偏离，也不得在首个代码 commit 时再临时发明字段。

**ValidationCheck durable schema 补充合同**：

- `ValidationCheck` / `ValidationReport` 为 `frozen=True,
  slots=True` 冻结数据结构；
- 报告 JSON 携带 `report_schema_version: 1`，键集固定（所列键
  全部出现，可空为显式 `null`）；
- 报告中 `checks` 的顺序固定为 `ValidationCheckType` 的声明
  顺序；未执行的检查以 `SKIPPED` 占位，不省略；
- `passed == true` 当且仅当全部检查为 `PASSED`（任一 `FAILED`
  即 `false`；`SKIPPED` 仅可作为 `FAILED` 的后果出现）；
- `error_code` 为稳定机器可读码：每个 check_type 的失败码等于
  其枚举值（如 `"duration_within_tolerance"`）；业务判断只允许
  依赖 `check_type`/`status`/`error_code`，**禁止依赖人类可读
  `message` 文本**（不做本地化承诺）；
- `observed`/`expected` 为确定性字符串表示（同输入逐字节一致），
  数值按固定小数位格式化。

## Data contracts

- **输入**：显式传入的 `Shot`、`Scene`、`GenerationTask`、
  `ArtifactReference`（location=staging，reference 解释为项目根
  相对 POSIX 路径）；不扫描目录、不自动发现。
- **正式媒体路径**：
  `assets/media/s<scene.sequence:02d>_sh<shot.sequence:03d>_v<version>.mp4`；
  version 从 1 递增；同名文件存在即拒绝覆盖（no-replace 发布）。
- **VideoAsset 记录**：`records/video-assets/<asset-id>.json`；
  `asset_id = "asset-<task-id>-v<version>"`；字段全部来自 probe
  结果与显式输入；`validated_at` 为显式传入时间。
- **StepManifest**：`manifests/validation-<task-id>.json`；
  `step_name = "validation:<task-id>"`；
  `input_digest = file_sha256(staged file)`；
  `relevant_config_digest = config_digest({"schema":
  "m1-validation-config-v1", "policy": <ValidationPolicy 全字段>})`
  ——schema 常量的唯一 owner 为本任务 `assets/policy.py`，其他
  组件不得自行拼写；
  `output_paths` = 报告 JSON 路径 + 正式媒体路径 + VideoAsset 记录
  路径；跳过条件遵循 architecture.md §8 五条件。
- **校验报告**：`reports/validation/<task-id>_v<version>.json`
  （事实来源，确定性 JSON）+ 同名 `.md`（确定性渲染）；防覆盖。
- **QCD 事件**：`qcd/events/log.jsonl`，append-only，一行一事件，
  UTF-8；本任务发射的 `asset_imported`、`validation_completed`、
  `manual_quality_rating_recorded` 三类事件的 **payload 字段集、
  event_id 派生、None 语义与单位以 ADR-0003 §4/§5 为准**（本卡
  不复制 schema，实施不得偏离）；`elapsed_ms` 由调用方显式传入
  （核心库不读时钟）；重复 append 允许存在，消费方按 event_id
  去重；写入器的 torn-tail 防护与 strict 读取语义遵循
  ADR-0003 §7。
- **失败的校验**：产出 `passed=false` 报告 + FAILED manifest
  （error_summary 非空）+ `validation_completed` 事件
  （payload.passed=false）；不创建 VideoAsset、不导入媒体。

## Failure / recovery semantics

- 落盘顺序：报告 → 媒体导入 → VideoAsset 记录 → QCD 事件 →
  manifest COMPLETED（commit 标记）。任一步失败：manifest 不进入
  COMPLETED，重跑走幂等路径。
- staged 文件去留（ADR-0001 第二次增补合同）：登记成功**不**立即
  删除调用方原始源文件；项目管理的 staging 副本仅在 VideoAsset
  登记 + 正式媒体 + QCD 事件全部成功后**可**清理（COMPLETED 之后
  的可选收尾）；清理失败不回滚登记、只作 warning/diagnostic；
  绝不删除项目根外的用户源文件。
- 幂等重跑：manifest COMPLETED 且 digest 匹配且输出全部存在且
  VideoAsset 可加载 → 整步 no-op（不重复登记、不重复导入）；QCD
  事件可能重复，由 event_id 去重语义兜底。
- 输入变化（staged 文件内容变化 → input_digest 不匹配）：不复用
  旧结果，登记为新 version（旧版本保留），绝不静默覆盖。
- 半成品防护：媒体导入与全部 JSON 写入复用 TASK-002 原子发布
  （临时文件 + fsync + no-replace link）；崩溃不留半成品正式文件。
- 校验失败不回写 GenerationTask（任务在编排层已 done；重做 = 经
  TASK-007 bootstrap 为同一 Shot 创建新 GenerationTask）。

## Security boundaries

- 全部目标路径经项目根 containment 校验（拒绝 `..`、绝对路径替换、
  symlink 逃逸；对齐 ADR-0001 TASK-004 增补的路径安全原则）；
- staged 文件按不可信数据处理：只经 ffprobe 解析元数据，不执行、
  不加载；ffprobe 以固定参数列表 subprocess 调用，禁用 shell，显式
  超时，非零退出/超时映射为类型化错误；
- 不访问网络；无凭据；`assets/media/`、`records/`、`reports/`、
  `qcd/` 之外零写入。

## Focused tests（单元测试）

1. `MediaInspector` 假实现注入下：逐规则通过/失败（缺失、命名
   错误、容器不符、不可解码、时长/分辨率/帧率越界，容差边界值）；
2. `FfprobeMediaInspector`：ffprobe 输出解析（正常、字段缺失、
   非 JSON、非零退出、超时→类型化错误）；不在单元测试中真实调用
   ffprobe（subprocess 打桩）；
3. `ValidationPolicy` 不变量与 digest 稳定性；
4. `VideoAsset` 登记：版本递增、防覆盖、asset_id/路径派生、字段
   来自 probe、幂等重登记 no-op、内容冲突 → `AssetConflictError`；
5. QCD：七种事件构造器合法/非法载荷、append-only（不truncate、不
   重写）、event_id 确定性、读取器逐行 strict 解析与去重；
6. digest：文件/配置摘要确定性与差异敏感性；
7. 报告：JSON 确定性输出、Markdown 渲染确定性、防覆盖；
8. 路径安全：containment、symlink、`..` 拒绝。

## Integration tests

1. 端到端成功路径：staging 放置 fixture 文件（假 inspector 返回
   合格参数）→ run_validation_step → 报告 + 媒体导入 + VideoAsset
   + 三类事件 + COMPLETED manifest 全部落盘且可被 ProjectData 加载
   验证；
2. 失败路径：参数越界 → passed=false 报告 + FAILED manifest +
   事件，无 VideoAsset、无媒体导入；
3. 断点续跑：步骤中途注入失败 → 重跑幂等完成，无重复登记；
   COMPLETED 后重跑 → 全程 no-op；
4. 内容变化重做：替换 staged 文件 → 登记 v2，v1 记录与媒体保留；
5. 可选真实 ffprobe 冒烟测试（生成最小合法 MP4 fixture），
   `pytest.mark.skipif` ffprobe 不可用时跳过，不作为回归门槛必需。

## 验收标准

1. 校验器逐规则可验证，错误被类型化拒绝，容差显式可配置；
2. ffprobe 经 `MediaInspector` 抽象接入，核心校验逻辑零 ffprobe
   直接依赖（grep 边界检查）；ADR-0002 已 Accepted；
3. `VideoAsset` 登记带版本与防覆盖，禁止静默覆盖，幂等重跑，有
   测试；
4. QCD 七种事件类型 schema 落地、三类事件采集落盘、append-only
   语义与 event_id 去重合同有测试；ADR-0003 已 Accepted；
5. StepManifest 断点续跑遵循 architecture.md §8 五条件，
   digest 算法首次定案并有测试；
6. 校验报告 JSON+Markdown 双格式确定性落盘、防覆盖；
7. 未越界：无 FFmpeg 合成、无自动质量检查、无 QCD 汇总、未修改
   冻结包；`git diff` 范围检查通过；
8. 质量门槛：全部测试通过、Ruff format/lint 全绿。

## 实施 Agent / 审查 Agent

- 实施 Agent：Claude Code（单一实施 Agent）。
- 审查方式：batch milestone mode——本卡随整体设计报告经一次 Codex
  架构审查；实施后审查合并到 Milestone 1 回归门槛（见
  `docs/design/remaining-roadmap-design-report.md` §6），不再逐
  Step 外部审查。

## 当前状态

Remaining roadmap design complete —
single Codex architecture review pending
