# TASK-003 设计文档：VideoProvider 契约与 ManualVideoProvider

- Status: approved — ready for implementation
- Revision: r2（逐项关闭 Codex 第一轮设计审查的 2 个阻塞与 5 个重要问题）
- Task: [TASK-003](../tasks/TASK-003-video-provider-contract-and-manual-provider.md)
- Baseline: branch `feat/task-003-video-provider`, HEAD `0e581d1`
  （architecture.md §4 已同步"Provider 不扫描目录"边界）

审查记录：

- review agent: Codex
- review result: passed
- design revision: r2
- approved design baseline:
  `cc9ae6a docs: approve TASK-003 provider contract design`
- implementation may begin
- implementation agent: Claude Code
- final implementation review agent: Codex

本文档是 TASK-003 编码门槛第 3 项要求的正式预实施设计记录。持久性设计
决定以本文档为准；PR 描述只作补充，不构成正式设计记录。本文档已通过
Codex 预实施审查，实施可以开始。

## 1. 接口形式：abc.ABC

最终选择：标准库 `abc.ABC` 抽象基类。

理由：

- **契约是名义性的**：TASK-003 要求 Provider 显式实现契约并可独立验收。
  ABC 在实例化时强制全部抽象方法存在（缺失即 `TypeError`）；
  `typing.Protocol` 的结构化约束只在静态类型检查时生效，而本项目质量
  门槛是 Ruff + pytest，没有 mypy，Protocol 的约束实际不会被执行。
- **覆盖三类 Provider**：抽象方法只约定语义生命周期与参数/返回类型，
  不约定实现手段。Manual 纯内存实现；未来 Cloud 在 submit/poll 中做
  远程调用；未来 Local 触发本地推理。同一签名均可实现。
- **运行时 isinstance**：需要。未来 Orchestrator 与本任务测试均使用
  `isinstance(provider, VideoProvider)` 验证实现关系，ABC 原生支持。
- **无无意义抽象方法**：四个方法对 ManualVideoProvider 各有真实职责
  （见 §11），不为凑数而空转。
- **零新依赖**：`abc` 是标准库，符合 AGENTS.md 规则 7 与任务卡
  "不引入重量级框架"的要求。

## 2. 模块结构

```
src/ai_video_workflow/providers/__init__.py   # 公共导出
src/ai_video_workflow/providers/base.py       # VideoProvider ABC
src/ai_video_workflow/providers/models.py     # 数据结构、枚举、类型别名
src/ai_video_workflow/providers/errors.py     # ProviderError 子树
src/ai_video_workflow/providers/manual.py     # ManualVideoProvider
tests/test_provider_models.py                 # 数据结构/矩阵/时间/参数
tests/test_provider_contract.py               # 接口/错误树/类型分离
tests/test_manual_provider.py                 # 四阶段行为/文件系统禁令
```

命名与边界理由：

- `models.py` 与顶层 `models.py` 命名对齐；不用 `types.py`——它遮蔽
  标准库模块名（Ruff 有对应检查项），含义也更模糊；
- `providers/errors.py` 独立成模块，只 import 顶层
  `errors.AiVideoWorkflowError`，不修改现有 `errors.py`；
- `providers/__init__.py` 导出全部公共类型：`VideoProvider`、
  `ManualVideoProvider`、`ProviderRequest`、`ProviderResult`、
  `ProviderInstruction`、`ProviderCostObservation`、
  `ArtifactReference`、`ArtifactOrigin`、`ArtifactLocation`、
  `ProviderStatus`、`ProviderError`、`InvalidProviderRequestError`、
  `InvalidProviderStateError`、`MissingArtifactReferenceError`、
  `ProviderOperationError`；
- **不修改顶层 `ai_video_workflow/__init__.py`**：它只含
  `__version__`，现有模块也不经它转出，保持一致；
- **不修改 `pyproject.toml`**：`[tool.setuptools.packages.find]
  where = ["src"]` 自动发现新子包；无新依赖、无新工具；
- 测试拆三个文件（任务卡候选为两个，候选非固定设计）：模型不变量测试
  规模大（七状态 × 多字段矩阵参数化），与接口契约、Manual 行为分开
  可读性与维护性更好。

## 3. Provider 身份规则

- `provider_id` 精确类型为 `str`，是 `VideoProvider` 的抽象只读属性
  （`@property` + `@abstractmethod`）；
- 验证使用现有 `validate_stable_id`（非空、非纯空白、拒绝前后空白、
  拒绝控制字符），通过后原样保存，不允许空白值；
- `provider_id` 同时进入 ProviderRequest（调用方指定目标 Provider）与
  ProviderResult（结果归属）；
- `ManualVideoProvider.provider_id` 固定为 `"manual"`，实现为**真正的
  只读 property**（精确实现见 §11.0，不使用可覆盖的普通类属性）；
- 一致性保证：每个方法先执行身份对齐验证（见 §9.2）；Provider 构造
  返回结果时三个 ID 恒取自 `self.provider_id`、`request.task_id`、
  `request.shot_id`，测试断言返回结果与实际 Provider 一致。

## 4. JSON 输入类型、冻结存储与 thaw 策略

### 4.1 类型别名（定义于 providers/models.py）

```python
JsonInputValue: TypeAlias = (
    None | bool | int | float | str
    | list["JsonInputValue"] | dict[str, "JsonInputValue"]
)
FrozenJsonValue: TypeAlias = (
    None | bool | int | float | str
    | tuple["FrozenJsonValue", ...] | Mapping[str, "FrozenJsonValue"]
)
```

- **输入类型** `JsonInputValue`：公开构造入口**只接受普通 dict/list**
  JSON 输入，不接受任意 Mapping。理由：与现有
  `validate_json_compatible` 的运行时接受范围一致（它按
  `isinstance(value, dict)` 判定）；避免自定义 Mapping 行为进入验证；
  避免把 MappingProxyType 再送入现有验证器。float 必须有限；禁止
  NaN、Infinity、Path、datetime、Enum、tuple、set、bytes、任意自定义
  对象、非字符串 key、循环结构——全部由 `validate_json_compatible`
  在构造时拒绝；
- **冻结类型** `FrozenJsonValue`：构造后的内部存储形态，list 已转
  tuple、mapping 已包 `types.MappingProxyType`。

### 4.2 ProviderRequest 的构造方案（可实现、注解与存储一致）

不使用自动生成的 `__init__`（自动 `__init__` 无法做到"公开参数接受
输入 JSON 类型、字段保存冻结类型"而注解不撒谎）。采用：

```python
@dataclass(frozen=True, slots=True, init=False)
class ProviderRequest:
    provider_id: str
    task_id: str
    shot_id: str
    prompt: str
    duration_seconds: float
    width: int
    height: int
    frame_rate: float
    staging_ref: str | None
    _provider_parameters: Mapping[str, FrozenJsonValue]

    def __init__(
        self,
        provider_id: str,
        task_id: str,
        shot_id: str,
        prompt: str,
        duration_seconds: float,
        width: int,
        height: int,
        frame_rate: float,
        staging_ref: str | None = None,
        provider_parameters: dict[str, JsonInputValue] | None = None,
    ) -> None: ...

    @property
    def provider_parameters(self) -> Mapping[str, FrozenJsonValue]: ...
```

自定义 `__init__` 的构造流程（全部字段验证在 `__init__` 末尾完成，
不依赖 `__post_init__`）：

1. 逐字段验证（stable ID / 非空文本 / 有限正数 / 正整数 /
   opaque reference，见 §5、§6）；
2. `provider_parameters` 为 None 时转为新的空 dict；
3. 对普通 dict 调用现有 `validate_json_compatible` 整体验证；
4. 递归创建**全新**冻结结构：dict → 新 dict → `MappingProxyType`；
   list → 新 tuple；标量原样保存；不保留调用方原始 dict/list 引用；
5. 全部字段经 `object.__setattr__` 写入（含私有字段
   `_provider_parameters`）。

公开只读属性 `provider_parameters` 返回私有冻结 mapping
（`Mapping[str, FrozenJsonValue]`，实际为 MappingProxyType），
**不得返回原始输入容器**，对外无法取得可修改内部状态的原始容器。

### 4.3 ProviderInstruction 的构造方案

与 ProviderRequest 完全相同的方案：
`@dataclass(frozen=True, slots=True, init=False)`；私有字段
`_suggested_parameters: Mapping[str, FrozenJsonValue]`；公开构造参数
`suggested_parameters: dict[str, JsonInputValue] | None = None`；
公开只读属性 `suggested_parameters`。

### 4.4 request → instruction 的参数传递（固定方案）

`ManualVideoProvider.prepare` **不得**把 MappingProxyType 直接传给
ProviderInstruction 的公开构造函数。本设计固定使用私有 thaw 辅助函数：

```python
suggested = _thaw_json_mapping(request.provider_parameters)
```

`_thaw_json_mapping`（providers/models.py 模块级私有函数）递归转换：
Mapping → 新 dict；tuple → 新 list；标量原样复制。得到普通 dict 后
传入 ProviderInstruction 构造函数（构造函数内再次验证并重新冻结）。
不提供第二种传递途径，不留给实施时决定。

### 4.5 相等性与哈希

- 两个由**值相同但容器不同**的输入构造的对象按值相等：dataclass 生成
  `__eq__` 逐字段比较；MappingProxyType 使用 mapping 值相等；嵌套
  tuple 使用序列值相等；同输入必然产生相同冻结结构；
- ProviderRequest 与 ProviderInstruction **不保证可哈希**：类中显式
  设置 `__hash__ = None`，避免 frozen dataclass 对含不可哈希 mapping
  的字段生成误导性哈希行为；
- 测试断言 `hash(instance)` 抛 `TypeError`。

### 4.6 thaw 与 to_json_dict

`to_json_dict()` 必须：thaw MappingProxyType 为普通 dict、thaw tuple
为普通 list（复用 `_thaw_json_mapping`）；datetime → 现有序列化格式
（`isoformat(timespec="microseconds")`，`+00:00` 后缀）；Enum →
`.value`；**不把 MappingProxyType 直接交给 `json.dumps`**；输出为
可直接被 `json.dumps` 处理的全新普通 dict/list 结构（修改返回值不
影响对象内部）。

## 5. 验证规则：stable ID 与 opaque reference

两套字符串验证规则，语义分离：

| 规则 | 函数 | 适用字段 |
| --- | --- | --- |
| stable ID | 现有 `validate_stable_id`（validation.py） | provider_id、task_id、shot_id |
| opaque reference | 新增私有辅助函数（providers/models.py） | ArtifactReference.reference、ProviderRequest.staging_ref、ProviderResult.external_task_ref、ProviderCostObservation.unit（复用同一字符规则） |

**opaque reference 验证函数**：

- 放在 `providers/models.py`，作为 Provider 数据结构内部使用的私有
  轻量辅助函数（如 `_validate_opaque_reference(value, *, field_name)`）；
- **不修改顶层 validation.py**；
- 规则：必须是 `str`；不得为空；不得仅包含空白；**拒绝**前后空白
  （不静默 strip——项目一贯原则是拒绝并报告，绝不静默修正）；拒绝
  NUL 与控制字符（unicodedata `Cc` 类别）；其余字符（含 `/`、`:`、
  `?`、`#` 等合法路径/URL 字符）原样保留；
- 只验证字符串形态：不调用 Path、URL parser、`resolve`、`expanduser`
  或文件系统；不判断引用是否真实存在。

引用字段不得使用 `validate_stable_id`：两者当前检查项相近，但作为独立
函数保证语义分离——未来若 stable ID 收紧字符集（如限制为标识符字符），
不会误伤路径/URL 形态的引用值。

## 6. 数据结构

除 §4 说明的两个 `init=False` 类型外，其余数据结构为
`@dataclass(frozen=True, slots=True)`，风格对齐 TASK-002 现有模型
（构造时验证、错误消息 `字段名: 说明` 格式）。

### 6.1 ArtifactOrigin 与 ArtifactLocation（str Enum）

```python
class ArtifactOrigin(str, Enum):
    USER = "user"          # 用户人工产生
    PROVIDER = "provider"  # Provider 自动产生

class ArtifactLocation(str, Enum):
    EXTERNAL = "external"  # 外部系统或外部工具中的引用
    STAGING = "staging"    # 调用方分配的 staging 位置
```

来源与位置是不同概念，两维正交，不压成同一维度的互斥值。

### 6.2 ArtifactReference

| # | 字段 | 类型 | 默认 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | reference | str | 无 | opaque reference |
| 2 | origin | ArtifactOrigin | 无 | isinstance，否则 FieldTypeError |
| 3 | location | ArtifactLocation | 无 | isinstance，否则 FieldTypeError |

无 None 字段，无默认值，无派生属性。两维组合语义：

| 场景 | origin | location |
| --- | --- | --- |
| 用户在外部工具中生成的产物 | user | external |
| 用户放入调用方分配 staging 的产物 | user | staging |
| 未来 Cloud Provider 的远端引用 | provider | external |
| 未来 Local Provider 写入 staging | provider | staging |

约束：ProviderResult 最多保存一个 artifact（多字段保存同一产物必然
产生漂移与双事实来源）；不调用 `exists`/`resolve`/`expanduser`/`open`
（Provider 无权访问文件系统，引用真实性由未来 Orchestrator 校验）；
不转换为正式 VideoAsset（正式登记是 Orchestrator 独占职责）。

### 6.3 ProviderStatus（str Enum，独立类型）

```python
class ProviderStatus(str, Enum):
    NOT_SUBMITTED = "not_submitted"
    WAITING_FOR_USER = "waiting_for_user"
    PROCESSING = "processing"
    ARTIFACT_AVAILABLE = "artifact_available"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
```

- 恰好七个状态，不增删、不合并（任务卡固定；变更须走后续设计变更
  流程）；
- 独立类型，不复用 `GenerationTaskStatus` 或 `ManifestStatus`，三个
  枚举的语义域互不混用；
- 派生属性放在 ProviderStatus 上（规则属于状态语义本身，单一定义点）：
  - `is_terminal` → `self in {SUCCEEDED, FAILED, CANCELLED}`；
  - `requires_user_action` → `self is WAITING_FOR_USER`（仅它为 True：
    其余状态要么无需人工——未开始/机器处理，要么产物已就绪或已进
    终态）；
- ProviderResult 提供同名只读透传属性；
- `requires_user_action` 不作为持久字段保存，纯派生。

### 6.4 ProviderCostObservation（单次成本观测）

```python
@dataclass(frozen=True, slots=True)
class ProviderCostObservation:
    amount: float
    unit: str
```

不变量：

- `amount` 必须**严格是 float**：`type(amount) is not float` 即抛
  FieldTypeError——bool 和 int 不得作为 float 静默接受
  （`isinstance` 检查不足以排除 bool/int 的隐式接受，采用精确类型
  判定，风格与 serialization.py 的 `_require_float` 一致）；
- `amount` 必须有限（math.isfinite）且 `>= 0`（0 合法）；
- `unit` 必须严格是 str；不得为空或只有空白；不得有前后空白；不得
  包含 NUL 或控制字符；不静默 strip；原样保存（复用 §5 opaque
  字符规则）。

语义：

- `amount` 是本次 Provider 操作的**单次当前成本观测值**；
- `unit` 可以是 USD、credits 或其他 Provider 明确报告的单位；
- 本任务不解释汇率、税费、账单、累计成本或重试成本；
- 它不是成本历史，也不写入 QCD；
- ManualVideoProvider 没有成本来源，**始终返回 None**；
- 未来 Cloud Provider 可提供该字段；复杂货币和计费模型仍留给后续
  任务。

ProviderCostObservation 从 `providers/__init__.py` 公共导出，提供
`to_json_dict()`（输出 `{"amount": ..., "unit": ...}`）。

### 6.5 ProviderInstruction（公共结构）

面向用户展示的结构化 Provider 操作说明。公共类型（不叫
ManualInstruction）——通用 ProviderResult 不得依赖 Manual 专属类型；
未来 Provider 可以不提供 instruction。构造方案见 §4.3
（`init=False` + 私有冻结字段 + 公开只读属性）。

| # | 构造参数 | 类型 | 默认 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | provider_id | str | 无 | stable ID |
| 2 | task_id | str | 无 | stable ID |
| 3 | shot_id | str | 无 | stable ID |
| 4 | prompt | str | 无 | 非空文本 |
| 5 | expected_duration_seconds | float | 无 | 严格 float、有限正数（拒绝 bool/int） |
| 6 | expected_width | int | 无 | 正整数（拒绝 bool） |
| 7 | expected_height | int | 无 | 正整数（拒绝 bool） |
| 8 | expected_frame_rate | float | 无 | 严格 float、有限正数（拒绝 bool/int） |
| 9 | staging_ref | str | 无 | opaque reference（必填） |
| 10 | steps | tuple[str, ...] | 无 | 非空 tuple，逐条非空文本 |
| 11 | suggested_parameters | dict[str, JsonInputValue] \| None | None | §4 冻结策略；属性返回 Mapping[str, FrozenJsonValue] |

- 一致性：ProviderResult 携带 instruction 时验证其
  provider_id/task_id/shot_id 与结果自身一致（不一致抛
  InvalidProviderRequestError）；Manual prepare 构造 instruction 时
  ID 取自 request，天然一致；
- 内容由 request 确定性推导（无时钟、无随机），同一 request 产生相同
  instruction；
- Provider 不写说明文件；未来 Orchestrator 可将其落盘为任务说明文件。

### 6.6 ProviderRequest

构造方案见 §4.2。构造参数与验证：

| # | 构造参数 | 类型 | 默认 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | provider_id | str | 无 | stable ID |
| 2 | task_id | str | 无 | stable ID |
| 3 | shot_id | str | 无 | stable ID |
| 4 | prompt | str | 无 | 非空文本 |
| 5 | duration_seconds | float | 无 | 严格 float、有限正数（拒绝 bool/int） |
| 6 | width | int | 无 | 正整数（拒绝 bool） |
| 7 | height | int | 无 | 正整数（拒绝 bool） |
| 8 | frame_rate | float | 无 | 严格 float、有限正数（拒绝 bool/int） |
| 9 | staging_ref | str \| None | None | 存在时 opaque reference |
| 10 | provider_parameters | dict[str, JsonInputValue] \| None | None | §4 冻结策略；属性返回 Mapping[str, FrozenJsonValue] |

- 第 5–8 项是所有视频 Provider 共同需要的期望输出规格（镜面 Shot 的
  对应字段），供 ProviderInstruction 生成"预期输出要求"——不嵌入
  Shot 对象本身；
- 不嵌入 ProjectData / GenerationTask / VideoAsset；不含凭据；不含
  QCD；staging_ref 原样保存、不做任何路径操作；
- Provider 不得修改请求对象（frozen + 冻结参数保证）。

### 6.7 ProviderResult（13 个字段）

| # | 字段 | 类型 | 默认 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | provider_id | str | 无 | stable ID |
| 2 | task_id | str | 无 | stable ID |
| 3 | shot_id | str | 无 | stable ID |
| 4 | status | ProviderStatus | 无 | isinstance |
| 5 | observed_at | datetime | 无 | `validate_utc_datetime` |
| 6 | external_task_ref | str \| None | None | 存在时 opaque reference |
| 7 | artifact | ArtifactReference \| None | None | isinstance |
| 8 | instruction | ProviderInstruction \| None | None | isinstance + ID 一致 |
| 9 | message | str \| None | None | 存在时非空文本 |
| 10 | error_summary | str \| None | None | 存在时非空文本 |
| 11 | completed_at | datetime \| None | None | 存在时 UTC 且 ≤ observed_at |
| 12 | elapsed_seconds | float \| None | None | 存在时严格 float、有限且 ≥ 0（拒绝 bool/int） |
| 13 | cost_observation | ProviderCostObservation \| None | None | isinstance |

- `task_id`、`shot_id` 是关联字段：证明结果属于哪个请求，使
  submit/poll/collect 能验证前一步结果与当前请求的对应关系；
- 派生只读属性：`is_terminal`、`requires_user_action`（透传
  `status` 的同名属性）；
- 构造时验证：字段级验证 + §7 状态矩阵验证（矩阵违规抛
  InvalidProviderStateError）+ instruction ID 一致性；
- ProviderResult 无冻结 mapping 字段，使用常规
  `@dataclass(frozen=True, slots=True)` 与 `__post_init__`；
- **external_task_ref 与 artifact 是不同概念**：前者是外部系统中的
  任务标识，后者是生成产物引用，互不替代；
- **不得包含**：正式 VideoAsset 对象、正式资产 ID、QCD 历史、成本
  历史（单次当前观测 `cost_observation` 除外）、重做历史、工作流状态
  迁移历史、Orchestrator 持久化结果。

## 7. 状态与结果矩阵（规范性）

ProviderResult 构造时强制执行；违规抛 `InvalidProviderStateError`。

| status | artifact | external_task_ref | instruction | error_summary | completed_at | terminal | requires_user_action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| not_submitted | 禁止 | 禁止 | 允许 | 禁止 | 禁止 | 否 | False |
| waiting_for_user | 禁止 | 允许 | 禁止 | 禁止 | 禁止 | 否 | True |
| processing | 禁止 | 允许 | 禁止 | 禁止 | 禁止 | 否 | False |
| artifact_available | 必须 | 允许 | 禁止 | 禁止 | 禁止 | 否 | False |
| succeeded | 必须 | 允许 | 禁止 | 禁止 | 必须，≤ observed_at | 是 | False |
| failed | 禁止 | 允许 | 禁止 | 必须非空 | 必须，≤ observed_at | 是 | False |
| cancelled | 禁止 | 允许 | 禁止 | 禁止 | 必须，≤ observed_at | 是 | False |

- `message`、`elapsed_seconds`、`cost_observation`：**所有七个状态
  均可选允许**（描述本次操作，与任务状态无关，不要求存在）；
- `observed_at`：所有状态必须存在；
- `external_task_ref` 在 not_submitted 禁止：尚未提交不可能有外部
  任务；终态允许携带以便追溯；
- `instruction` 仅 not_submitted 允许：说明数据只由 prepare 产出一次，
  不在后续结果中重复（避免双事实来源）；
- 任务卡固定的四列（artifact / error_summary / completed_at /
  terminal）与七状态集合原样保留；instruction、external_task_ref、
  message、elapsed_seconds、cost_observation 列为本设计文档职责范围内
  的补充。

## 8. 时间设计

### 8.1 observed_at

- 精确类型：`datetime`（带时区 UTC，`validate_utc_datetime` 验证；
  naive 与非 UTC offset 一律拒绝）；
- 所有结果必须存在；
- 四个方法均由**调用方显式提供**（keyword-only 参数）；Provider
  **不调用 `datetime.now()`**、不读任何时钟——纯函数、可确定性测试、
  无隐藏时间来源；
- 调用方显式提供是唯一来源；不允许 Provider 自取当前时间。

### 8.2 completed_at

- 精确类型：`datetime | None`（带时区 UTC）；
- 语义：底层 Provider 任务进入终态的时间；
- 仅终态（succeeded / failed / cancelled）必须存在；非终态必须为
  None——任务尚未进终态，任何完成时间都是虚构；
- Manual 流程中仅 collect 产生终态；获得方式与优先关系：
  1. 调用方显式传入 `completed_at` → 严格验证（UTC、非 naive、
     ≤ observed_at）后**原样使用**；非法直接拒绝
     （InvariantViolationError），**不静默修正、不改写成
     observed_at**；
  2. 调用方未传入 → Manual collect 使用 `observed_at` 作为"本次
     collect 确认终态的已知时间"。这是**明确定义的缺省规则**（缺省值
     选择），不是对非法输入的静默修正——两者在本设计中严格区分；
- 不从文件时间、目录内容或媒体元数据推断（§13 文件系统禁令使其在
  实现上也不可能）。

### 8.3 验证清单

UTC 强制；拒绝 naive datetime；拒绝非 UTC offset；终态
`completed_at <= observed_at`；不静默修正任何调用方时间；不从文件
系统推断任何时间。

## 9. VideoProvider 精确接口

### 9.1 签名（可直接复制到代码）

```python
class VideoProvider(ABC):
    """Stateless provider contract for one generation lifecycle."""

    @property
    @abstractmethod
    def provider_id(self) -> str:
        """Stable non-empty identifier of this provider."""

    @abstractmethod
    def prepare(
        self,
        request: ProviderRequest,
        *,
        observed_at: datetime,
    ) -> ProviderResult:
        ...

    @abstractmethod
    def submit(
        self,
        request: ProviderRequest,
        prepared: ProviderResult,
        *,
        observed_at: datetime,
    ) -> ProviderResult:
        ...

    @abstractmethod
    def poll(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        observed_at: datetime,
        reported_artifact: ArtifactReference | None = None,
    ) -> ProviderResult:
        ...

    @abstractmethod
    def collect(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        artifact: ArtifactReference | None = None,
        observed_at: datetime,
        completed_at: datetime | None = None,
    ) -> ProviderResult:
        ...
```

### 9.2 显式状态快照传递与 `_validate_alignment`

- Provider **不在 `self` 上保存工作流状态**（无实例状态字段）；
- `prepared` / `current` 是调用方显式传入的**不可变前一步结果快照**；
  submit 由此取得 prepare 结果，poll/collect 由此取得
  external_task_ref（未来 Cloud Provider 用它查询远端任务；Manual
  不需要它，但遵守同一接口）；
- `_validate_alignment(request, result)`：`VideoProvider` 基类上的
  **受保护非抽象辅助方法**，各 Provider 复用。验证：
  - `request.provider_id == self.provider_id`；
  - `result.provider_id == self.provider_id`；
  - `result.task_id == request.task_id`；
  - `result.shot_id == request.shot_id`；
  - result 携带 instruction 时，instruction 的三个 ID 与
    request/result 一致；
  - 不修改传入对象；任一不匹配抛 `InvalidProviderRequestError`，
    **不静默重写 ID**——把其他任务的 ProviderResult 传入当前请求是
    调用方错误，必须显式失败；
- prepare 没有前一步结果，只验证
  `request.provider_id == self.provider_id`；
- Provider 返回的新结果三个 ID 恒取自 `self.provider_id`、
  `request.task_id`、`request.shot_id`，不从前一步结果复制。

### 9.3 设计约束

- 四个方法返回类型统一为 ProviderResult（未来 Orchestrator 对每步
  结果统一处理），但**参数不机械相同**：poll 多出
  `reported_artifact`（调用方已知的产物证据），collect 多出
  `artifact` 与 `completed_at`；
- 每个方法对 Manual 有真实职责（§11），非空操作；
- Provider 不依赖具体 Orchestrator；所有 I/O 引用由调用方提供；
  不自动发现项目目录。

## 10. 错误体系

### 10.1 类树

```
AiVideoWorkflowError (现有, src/ai_video_workflow/errors.py)
└── ProviderError                        (providers/errors.py, 新增)
    ├── InvalidProviderRequestError      # 无效或不支持请求
    ├── InvalidProviderStateError        # Provider 状态组合/前置状态无效
    ├── MissingArtifactReferenceError    # collect 缺少显式人工产物引用
    └── ProviderOperationError           # 方法执行本身失败
```

出现位置：

- `InvalidProviderRequestError`：全部四个方法（provider_id 不匹配、
  前一步结果 ID 不对齐、Manual 缺 staging_ref、poll/collect 的
  artifact 与已有 artifact 不一致、前一步快照含 Manual 不可能产生的
  字段值——见 §11.1）；
- `InvalidProviderStateError`：ProviderResult 构造（矩阵违规）；
  submit/poll/collect（前置状态不在允许集合）；
- `MissingArtifactReferenceError`：collect（current 为
  waiting_for_user 且未显式传入 artifact）；
- `ProviderOperationError`：仅当方法执行本身失败、无法可靠形成合法
  ProviderResult 时使用。ManualVideoProvider 纯内存操作，本任务预期
  不触发；该类型是契约的一部分，为 Cloud/Local 保留，测试验证其存在
  与类型可区分性。

### 10.2 构造参数缺失的错误渠道（固定规则）

本任务**不为** dataclass 或自定义 `__init__` 缺少 Python 必填参数
建立 MissingFieldError 转换层：

- 直接调用构造函数时缺少必填参数：**Python 原生 `TypeError`**
  （不包装、不转换）；
- 提供了参数但类型错误：`FieldTypeError`；
- 提供了参数但值违反局部不变量：`InvariantViolationError`；
- Provider 生命周期或跨对象状态错误：ProviderError 子树；
- `MissingFieldError` 仍属于 TASK-002 JSON 文件读取边界
  （serialization.py 的 from_dict 路径），**不用于 TASK-003 Provider
  类型的直接构造**；本任务不提供 from_dict，也不新增无消费方的
  from_dict 来制造 MissingFieldError 入口。

### 10.3 状态不通过异常表达

以下均为正常可表达状态，**不抛异常**，通过 ProviderStatus 表达：
waiting_for_user、processing、artifact_available、cancelled，以及
已确认的底层任务终态失败（返回 `status=failed` 的结果）。错误不暴露
凭据或敏感参数。网络、限流、认证错误体系留给 Cloud Provider 任务。

### 10.4 FAILED 结果与异常决策表

| 情形 | 行为 | 理由 |
| --- | --- | --- |
| 构造函数缺少必填参数 | Python 原生 TypeError | §10.2 固定规则，不建转换层 |
| 请求字段类型错误（含 bool 冒充 int/float） | 抛 FieldTypeError | 与 TASK-002 字段验证一致 |
| 请求字段值违反局部不变量 | 抛 InvariantViolationError | 与 TASK-002 字段验证一致 |
| provider_id 不匹配（request 或前一步结果） | 抛 InvalidProviderRequestError | 请求/快照不属于该 Provider |
| 前一步结果 task_id/shot_id 不对齐 | 抛 InvalidProviderRequestError | 禁止跨任务传递快照，不静默重写 |
| 前一步快照含 Manual 不可能产生的字段值 | 抛 InvalidProviderRequestError | 不是合法 Manual 生命周期快照，不静默丢弃（§11.1） |
| Manual prepare/submit 缺 staging_ref | 抛 InvalidProviderRequestError | 人工说明必须有目标位置 |
| 方法调用前置状态错误 | 抛 InvalidProviderStateError | 生命周期契约违规 |
| ProviderResult 状态组合违反矩阵 | 抛 InvalidProviderStateError | 状态矩阵是硬不变量 |
| collect 缺少 artifact（current 为 waiting_for_user） | 抛 MissingArtifactReferenceError | 显式引用是 collect 的前置输入 |
| poll/collect 传入的 artifact 与已有不一致 | 抛 InvalidProviderRequestError | 防止静默替换产物事实 |
| 底层 Provider 任务明确失败 | 返回 ProviderResult(status=failed, error_summary=...) | 操作本身成功完成，失败是任务终态（Manual 本任务无此输入渠道，模型层完整支持） |
| 等待人工操作 | 返回 waiting_for_user 结果 | 正常状态，非失败 |
| 用户取消 | 返回 cancelled 结果（Manual 本任务无取消输入渠道，模型层完整支持） | 正常终态，非失败，不借用 error_summary |
| Provider 方法内部执行失败 | 抛 ProviderOperationError | 无法可靠形成合法结果 |
| 输入时间非法（naive / 非 UTC / completed_at > observed_at） | 抛 InvariantViolationError / FieldTypeError | 复用 TASK-002 验证词汇，不静默修正 |
| ArtifactReference 非法（空引用、前后空白、控制字符、错误枚举类型） | 抛 InvariantViolationError / FieldTypeError（构造时） | 字段级验证 |
| ProviderCostObservation 非法（bool/int 冒充 float、负数、非有限、非法 unit） | 抛 FieldTypeError / InvariantViolationError（构造时） | 字段级验证 |
| provider_parameters 含禁止类型 / 循环 / 非有限 float | 抛 FieldTypeError / InvariantViolationError（构造时） | validate_json_compatible 既有行为 |
| 传入非 ArtifactReference 类型给 artifact 参数 | 抛 FieldTypeError | 类型错误非缺失 |

## 11. ManualVideoProvider

### 11.0 只读 provider_id（固定实现）

```python
class ManualVideoProvider(VideoProvider):
    __slots__ = ()

    @property
    def provider_id(self) -> str:
        return "manual"
```

使用真正的只读 property，**不使用普通可覆盖的类属性**；`__slots__ =
()` 阻止实例属性覆盖固定身份。测试要求：
`provider.provider_id == "manual"`；`isinstance(provider,
VideoProvider)`；对 `provider.provider_id` 赋值抛 AttributeError；
多次读取始终返回 `"manual"`；返回结果中的 provider_id 始终为
`"manual"`；无法通过实例属性覆盖。

### 11.1 完整字段传播表（规范性）

全部方法先执行身份对齐验证（§9.2），全程不访问文件系统、不调 API、
不开浏览器、不读时钟。

**所有方法的通用来源规则**：

- provider_id：从 `self.provider_id` 取得；
- task_id：从 `request.task_id` 取得；
- shot_id：从 `request.shot_id` 取得；
- observed_at：使用当前方法的显式参数；
- **不从前一步结果复制三个 ID**；不静默修正不一致 ID；
- message：始终为 None；
- error_summary：始终为 None；
- elapsed_seconds：始终为 None；
- cost_observation：始终为 None（Manual 无成本来源）；
- external_task_ref：始终为 None。

**意外值拒绝规则（不静默丢弃）**：submit、poll、collect 接收的
prepared/current 如果包含 `external_task_ref`、`message`、
`elapsed_seconds`、`cost_observation` 中任一非 None 值，则抛
`InvalidProviderRequestError`——这些值不可能由 TASK-003 的
ManualVideoProvider 产生，说明传入快照不是合法的 Manual 生命周期
快照。Manual 不得静默丢弃前一步中的意外值。

**逐方法传播表（13 个结果字段）**：

| 字段 | prepare | submit | poll（等待，无报告） | poll（等待，有报告） | poll（幂等） | collect |
| --- | --- | --- | --- | --- | --- | --- |
| provider_id | self | self | self | self | self | self |
| task_id | request | request | request | request | request | request |
| shot_id | request | request | request | request | request | request |
| status | not_submitted | waiting_for_user | waiting_for_user | artifact_available | artifact_available | succeeded |
| observed_at | 参数 | 参数 | 参数 | 参数 | 参数 | 参数 |
| external_task_ref | None | None | None | None | None | None |
| artifact | None | None | None | reported_artifact | current.artifact | 唯一选择规则（§11.2.4） |
| instruction | 新生成 | None（不继承 prepared.instruction） | None | None | None | None |
| message | None | None | None | None | None | None |
| error_summary | None | None | None | None | None | None |
| completed_at | None | None | None | None | None | 显式值或 observed_at 缺省（§8.2） |
| elapsed_seconds | None | None | None | None | None | None |
| cost_observation | None | None | None | None | None | None |

实施者不需要猜测任何字段是继承、清空还是重新生成。

### 11.2 方法级状态迁移与行为

| 方法 | 前一步输入 | 允许的前置状态 | 返回状态 | 关键规则 |
| --- | --- | --- | --- | --- |
| prepare | 无 | —— | not_submitted | instruction 必须存在；artifact 禁止；staging_ref 缺失抛 InvalidProviderRequestError |
| submit | prepared | not_submitted | waiting_for_user | prepared.instruction 必须存在，否则抛 InvalidProviderStateError |
| poll | current | waiting_for_user、artifact_available | waiting_for_user 或 artifact_available | 见 11.2.3 |
| collect | current | waiting_for_user、artifact_available | succeeded | 见 11.2.4；其他前置状态抛 InvalidProviderStateError |

**11.2.1 prepare**：接收 request（staging_ref 必须存在，否则
InvalidProviderRequestError）与 observed_at；经
`_thaw_json_mapping(request.provider_parameters)` 得到普通 dict 后
构造 ProviderInstruction（§4.4）；instruction 由 request 确定性推导
（同一 request 产生相同 instruction，无时钟、无随机）；按 §11.1
prepare 列返回 not_submitted 结果；不写任何文件。

**11.2.2 submit**：不是远程提交——Manual 没有远端，submit 的真实
职责是表达"任务已发布给人、进入等待用户操作"这一生命周期迁移；需要
前一步结果（prepared 必须是 not_submitted 且携带 instruction）；按
§11.1 submit 列返回 waiting_for_user 结果（requires_user_action
派生为 True）；不修改 GenerationTask、不假装调用 API。

**11.2.3 poll**：接收 current 快照与可选 reported_artifact；

- current 为 waiting_for_user 且无 reported_artifact → 返回
  waiting_for_user（基于已提供信息可确认的状态，不伪造进度）；
- current 为 waiting_for_user 且有 reported_artifact → 返回
  artifact_available（artifact = reported_artifact）；
- current 为 artifact_available：reported_artifact 为 None 时幂等
  返回已有 current.artifact；reported_artifact 存在且**等于**
  current.artifact 时同样返回（允许）；**不等于**时抛
  InvalidProviderRequestError——不得替换已有 artifact；
- 不调用 exists、glob、walk，不访问网页，不扫描目录。

**11.2.4 collect**：artifact 唯一选择规则：

1. current 为 **artifact_available**：矩阵保证 current.artifact
   存在；参数 artifact 未传 → 使用 current.artifact；同时传入 →
   必须与 current.artifact 相等，不一致抛
   InvalidProviderRequestError；
2. current 为 **waiting_for_user**：允许调用方直接显式传入
   artifact（跳过 poll 的路径）；未传入 → 抛
   MissingArtifactReferenceError；
3. 其他状态 → 抛 InvalidProviderStateError。

最终结果只在 ProviderResult.artifact 保存一个引用；方法参数中的
瞬时比较不构成第二个持久事实来源。completed_at 按 §8.2 规则确定。
按 §11.1 collect 列返回 succeeded 结果。不打开、验证或移动真实文件；
不 ffprobe；不创建 VideoAsset；不决定版本号；不覆盖正式资产；对
artifact 只做数据类型/引用格式验证，不构成媒体校验。

### 11.3 Manual 主动产生的状态集合

TASK-003 中 ManualVideoProvider 只主动产生：

- not_submitted、waiting_for_user、artifact_available、succeeded。

不主动产生：

- processing（Manual 没有远端或本地后台处理）；
- failed、cancelled（TASK-003 未定义用户报告失败或取消的输入渠道；
  取消传播明确延期到后续任务）。

但 ProviderStatus 与 ProviderResult **完整支持七状态**；
processing / failed / cancelled 的模型不变量必须测试；未来
Cloud/Local Provider 可以从 submit 或 poll 返回这些状态。

## 12. 序列化边界

- `ArtifactReference`、`ProviderInstruction`、`ProviderRequest`、
  `ProviderResult`、`ProviderCostObservation` 提供 `to_json_dict()`：
  纯 JSON-compatible dict（§4.6 thaw 规则），`json.dumps` 可直接
  运行；
- **不提供 from_dict**：本任务无反序列化消费方（Orchestrator 未
  实现），无使用场景的解析器是空设计；未来首个需要方（Orchestrator
  任务）自行设计并审查；
- 不使用 `model_to_json` / `model_from_json`；**不修改
  `serialization.py` 的七模型注册表**——ProviderResult 不是第八个
  项目核心模型；
- 不创建 ProviderResult 文件仓储；不创建持久化 API；不创建数据库；
  不创建项目级 Provider 状态保存机制；
- 不使用 pickle；不使用 YAML。

## 13. 四阶段文件系统访问禁令

设计层保证：ManualVideoProvider 四个方法的实现是纯内存数据变换——
不 import `glob`，不调用 `Path.exists` / `os.path.exists` /
`Path.glob` / `Path.rglob` / `os.walk` / `os.scandir` /
`os.listdir` / `open` / `Path.open`，无媒体探测，无自动目录扫描。
staging_ref 与 reference 均为原样字符串，实现中没有任何把它们转成
Path 并访问的路径。

测试层保证（`tests/test_manual_provider.py`）：使用 pytest
`monkeypatch` 的**局部作用域**：

```python
with monkeypatch.context() as scoped:
    scoped.setattr(...)  # 被禁止函数一经调用立即 pytest.fail
    result = provider.prepare(request, observed_at=ts)
```

要求：

- patch 只包围**单次 Provider 方法调用**；离开 context 后立即恢复；
- **不在整个测试或 pytest 收集期间永久 patch `builtins.open`**
  （避免破坏 pytest 自身的文件访问）；
- prepare、submit、poll、collect **各自独立验证**（四个阶段分别在
  各自的 patch 作用域内执行）；
- patch 命中任何被禁止函数（上述清单全部）时立即失败；
- 不依赖脆弱的源码字符串搜索作为唯一手段。

## 14. 测试计划

### 14.1 tests/test_provider_models.py

- 各 dataclass / Enum 合法与非法构造；
- **构造错误渠道**：缺少必填构造参数断言 Python 原生 TypeError
  （不包装为 MissingFieldError）；类型错误（FieldTypeError）与局部
  不变量错误（InvariantViolationError）保持可区分；
- **数值 bool 陷阱**：`width=True`、`height=False`、
  `duration_seconds=True`、`frame_rate=False`、
  `elapsed_seconds=True`、`ProviderCostObservation(amount=True)`
  全部被拒绝；int 不得静默作为严格 float 字段接受
  （如 `duration_seconds=5`、`amount=3` 被拒绝）；
- 七状态 × 字段矩阵全组合参数化（§7 每行的必须/禁止全覆盖，含
  cost_observation 全状态可选）；
- `is_terminal`、`requires_user_action` 派生（七状态逐一断言）；
- 时间字段十项：observed_at 必填、UTC、naive observed_at 拒绝、
  naive completed_at 拒绝、非 UTC offset 拒绝、非终态拒绝
  completed_at、终态缺 completed_at 失败、completed_at > observed_at
  失败、`<` 与 `==` 合法组合通过、不静默修正调用方时间；
- elapsed_seconds：有限非负验证（0 合法、负数/NaN/Infinity 拒绝）；
- ProviderCostObservation：amount 严格 float / 有限 / ≥ 0（0 合法）；
  unit 空、纯空白、前后空白、NUL/控制字符拒绝且原样保存；
  to_json_dict 输出正确；
- ArtifactReference：opaque reference 规则（空、纯空白、前后空白、
  NUL/控制字符拒绝；`/` `:` `?` `#` 等合法字符通过且原样保存）、
  两维枚举类型验证；
- provider_parameters / suggested_parameters：JSON-compatible 拒绝
  清单（NaN、Infinity、Path、datetime、Enum、tuple、set、bytes、
  自定义对象、非字符串 key、循环结构）；公开构造入口只接受普通
  dict（MappingProxyType 等任意 Mapping 输入被拒绝）；
- **冻结和相等性**：两个由相等但不同 dict/list 构造的
  ProviderRequest 相等；两个相等 ProviderInstruction 相等；
  `provider_parameters` / `suggested_parameters` 属性返回只读
  MappingProxyType；直接赋值 mapping key 失败（TypeError）；嵌套
  list 已转为 tuple、不能修改；修改原始嵌套 dict/list 不影响内部；
  to_json_dict 返回**新的**普通 dict/list、修改返回值不影响内部；
  `hash(instance)` 抛 TypeError（`__hash__ = None`）；
- instruction 与 result 的 ID 一致性验证。

### 14.2 tests/test_provider_contract.py

- ABC 实现关系：不完整实现不可实例化；
  `isinstance(ManualVideoProvider(), VideoProvider)`；
- **provider_id 只读契约**：`provider.provider_id == "manual"`；对
  `provider.provider_id` 赋值抛 AttributeError；多次读取始终返回
  `"manual"`；无法通过实例属性覆盖（`__slots__ = ()`）；
- ProviderStatus 与 GenerationTaskStatus、ManifestStatus 是三个不同
  类型（类型不等、成员互不隶属）；
- 错误树：五个异常的继承关系（根为 AiVideoWorkflowError）与类型
  可区分性；ProviderOperationError 存在且可导入；
- `_validate_alignment` 行为：ID 不匹配抛
  InvalidProviderRequestError、不修改传入对象。

### 14.3 tests/test_manual_provider.py

- 四阶段行为：prepare 返回稳定 instruction（同一 request 两次调用
  结果相等）；submit 表达 waiting_for_user；poll 三分支
  （等待无报告、等待有报告、幂等）；collect 三条前置状态路径与
  artifact 唯一选择规则；
- **artifact 幂等**：`current.artifact == reported_artifact` 时
  poll 成功；`current.artifact != reported_artifact` 时抛
  InvalidProviderRequestError；`reported_artifact=None` 时
  artifact_available 幂等返回已有 artifact；
- **字段传播**：每个 Manual 方法（含 poll 三分支）的 **13 个结果
  字段**逐一符合 §11.1 传播表；前一步快照含 Manual 不可能产生的
  external_task_ref / message / elapsed_seconds / cost_observation
  非 None 值时抛 InvalidProviderRequestError（不静默清空）；
- MissingArtifactReferenceError 实际触发（waiting_for_user +
  无 artifact）；
- InvalidProviderStateError 触发（错误前置状态的 submit/poll/
  collect）；
- InvalidProviderRequestError 触发（provider_id 不匹配、跨任务快照、
  缺 staging_ref、artifact 不一致、意外字段值）；
- completed_at 缺省规则与显式传入规则；
- **四阶段文件系统禁令**（§13 局部作用域 monkeypatch，四方法各自
  独立验证）；
- 不调用外部 API、不访问浏览器（实现无相应 import/调用 + 禁令测试
  环境下全流程可运行）；
- 输入对象不被修改（request、prepared/current 快照前后相等）；
- 返回结果 provider_id/task_id/shot_id 与实际 Provider 和 request
  一致（provider_id 始终为 `"manual"`）；
- 不创建 VideoAsset、不修改 GenerationTask（Manual 模块不 import
  这些模型的写路径；测试断言结果类型与副作用不存在）；
- 全量现有测试回归（TASK-002 的 414 项 + 新增全部通过；Ruff format
  与 Ruff lint 通过）。

## 15. 14 条验收标准映射

| # | 验收标准（摘要） | 设计章节 | 验证方式 |
| --- | --- | --- | --- |
| 1 | 接口有文档与类型契约，且与本设计文档一致 | §9 | 文件检查 + test_provider_contract |
| 2 | Manual 完整生命周期 | §11 | test_manual_provider |
| 3 | 七状态独立类型 + 矩阵与时间不变量 + requires_user_action 派生 | §6.3、§7、§8 | test_provider_models |
| 4 | 结果无 VideoAsset/资产 ID；D4 两维引用；external_task_ref 与 artifact 分离 | §6.2、§6.7 | test_provider_models + 文件检查 |
| 5 | Provider 不修改 GenerationTask | §11、§14.3 | test_manual_provider |
| 6 | Provider 不写正式项目状态 | §11、§12、§13 | test_manual_provider + 文件检查 |
| 7 | 不调 API/浏览器；四阶段文件系统禁令（局部 monkeypatch） | §13 | test_manual_provider |
| 8 | 人工操作说明可读取展示 | §6.5、§11.2.1 | test_manual_provider |
| 9 | 产物引用只能显式传入；缺失抛类型化异常；D5 分工 | §10、§11.2.4 | test_manual_provider |
| 10 | 参数 JSON-compatible 与不可变（含构造后修改测试） | §4 | test_provider_models |
| 11 | 观测值边界：elapsed 非负有限；**cost_observation 结构合法且 Manual 恒为 None**；无历史、不写 QCD | §6.4、§6.7、§11.1 | test_provider_models + test_manual_provider |
| 12 | 不实现 Orchestrator/媒体校验/FFmpeg/QCD | §12、任务卡范围外 | 文件检查 |
| 13 | 全部新增与现有测试通过、格式化与静态检查全绿 | §14 | pytest + Ruff |
| 14 | 未修改 TASK-003 范围外文件 | §2、§12、§16 | git diff 审计 |

不增加第 15 条。

## 16. 预计实施文件

新增：

- `src/ai_video_workflow/providers/__init__.py`
- `src/ai_video_workflow/providers/base.py`
- `src/ai_video_workflow/providers/models.py`
- `src/ai_video_workflow/providers/errors.py`
- `src/ai_video_workflow/providers/manual.py`
- `tests/test_provider_models.py`
- `tests/test_provider_contract.py`
- `tests/test_manual_provider.py`

修改：

- `docs/tasks/TASK-003-video-provider-contract-and-manual-provider.md`
  （实施阶段允许且必须更新：实施状态、实施记录、测试结果、独立审查
  交接）。

继续禁止修改：

- TASK-001、TASK-002 任务卡；
- TASK-002 核心模型（`models.py`、`manifest.py`）；
- `serialization.py` 七模型注册表；
- `persistence.py`；
- ProjectData（`project_data.py`）；
- 顶层 `validation.py`、`errors.py`、`__init__.py`；
- README、`pyproject.toml`；
- ADR-0001、architecture.md。

如实施过程中发现必须修改上述禁止文件，必须**停止并汇报**，不得自行
扩大范围。

## 17. 延期到后续任务的事项

- Workflow Orchestrator（含最小实现）；
- ProviderResult 到 GenerationTask 状态的映射；
- 用户任务说明文件的写入；
- staging 路径分配与文件发现（Provider 不扫描目录是架构基线）；
- 正式 VideoAsset 登记；
- 媒体校验与 ffprobe；
- FFmpeg；
- QCD 事件写入；
- Cloud Provider；
- 货币、汇率、税费、账单、累计成本与重试成本模型
  （本任务只定义单次当前观测 ProviderCostObservation）；
- Local Provider；
- API 认证、限流和重试；
- 用户失败报告与取消输入渠道、取消传播、超时策略；
- digest 计算、缓存命中和自动断点续跑；
- ProviderResult 的 from_dict / 正式序列化（首个需要方设计并审查）。
