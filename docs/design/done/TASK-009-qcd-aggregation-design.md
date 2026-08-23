# TASK-009 Focused Design — QCD Aggregation, Metrics, Reporting

- 日期：2026-07-30
- 状态：聚焦设计定案（M2；随实施提交）
- 依据：TASK-009 卡、ADR-0003（事件 payload schema + §「TASK-009
  aggregation 使用方式」消费合同）、architecture.md §10。
- 约束：只读事件日志与业务记录；输出仅 `reports/qcd/`；派生数据可
  由事件日志重算；不修改事件 schema 或既有写入方；无 StepManifest
  （纯派生，重算即恢复）。

## 1. 公共 API

```python
# ai_video_workflow.qcd.aggregation
SUMMARY_SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class TaskMetrics:
    task_id: str
    shot_id: str
    created_at: datetime | None  # task_created.occurred_at
    origin: str | None  # "bootstrap" | "redo" | None
    first_asset_imported_at: datetime | None
    delivery_ms: int | None  # created_at → first_asset_imported_at
    attempt_count: int  # manual_attempt_recorded 计数
    attempts_elapsed_ms: int | None  # 非 null elapsed_ms 之和；全 null → None
    cost_by_currency: Mapping[str, int]  # currency → Σ cost_minor_units（键排序）
    validation_runs: int  # validation_completed 计数
    validation_failures: int  # 其中 passed=false 计数
    latest_status: str | None  # 末条 task_status_changed.new_status


@dataclass(frozen=True, slots=True)
class ShotMetrics:
    shot_id: str
    scene_id: str
    task_count: int  # 该 shot 的 task_created 计数
    redo_count: int  # origin="redo" 计数
    delivered: bool  # 该 shot 任一 task 有 asset_imported
    rating_count: int
    latest_rating: int | None  # 按 (occurred_at, event_id) 全序取末
    mean_rating: float | None  # 去重事件集算术平均
    attempt_count: int  # 该 shot 全 task 之和
    validation_failures: int


@dataclass(frozen=True, slots=True)
class ProjectMetrics:
    project_id: str
    task_count: int
    shot_count: int  # 有 task 的 shot 数
    redo_count: int
    delivered_shot_count: int
    composition_count: int  # composition_completed 计数
    latest_composition_at: datetime | None
    latest_output_version: int | None
    total_attempts: int
    total_attempts_elapsed_ms: int | None
    cost_by_currency: Mapping[str, int]
    rating_count: int
    mean_rating: float | None  # 全项目去重评分均值


@dataclass(frozen=True, slots=True)
class ReconciliationGap:
    kind: str  # 见 §4
    entity_id: str
    detail: str


@dataclass(frozen=True, slots=True)
class QcdSummary:
    summary_schema_version: int
    project_id: str
    event_count: int  # 去重后事件数
    per_task: tuple[TaskMetrics, ...]  # 按 task_id 排序
    per_shot: tuple[ShotMetrics, ...]  # 按 (scene_id, shot_id) 排序
    per_project: ProjectMetrics
    reconciliation: tuple[ReconciliationGap, ...]  # 按 (kind, entity_id) 排序


def aggregate_events(events: tuple[QcdEvent, ...], data: ProjectData) -> QcdSummary: ...


# ai_video_workflow.qcd.reporting
QCD_REPORT_SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class QcdReportOutcome:
    summary: QcdSummary
    version: int
    json_path: str  # reports/qcd/summary_v<N>.json
    md_path: str  # reports/qcd/summary_v<N>.md


def run_qcd_report_step(
    *, project_root: Path, data: ProjectData, observed_at: datetime
) -> QcdReportOutcome: ...
```

- `aggregate_events` 是**纯函数**（事件 + ProjectData → QcdSummary），
  不做 IO、不读时钟；调用方负责先 `read_events`（strict + first-wins
  去重，ADR-0003 §5/§7）。
- `run_qcd_report_step` 读事件日志与 ProjectData，产出 summary，
  版本化、防覆盖地写 `reports/qcd/summary_v<N>.{json,md}`；`observed_at`
  由调用方显式传入（写入报告 `generated_at`）。

## 2. 事件 → 指标映射（消费合同，锁定 ADR-0003 §4）

去重后按 event_type 分派（严格用 payload 键；不猜测缺失键）：

- `task_created`：建 TaskMetrics 骨架，`created_at`/`origin` 取
  occurred_at/payload.origin；shot 归属取 envelope.shot_id；
- `task_status_changed`：按 (occurred_at, event_id) 全序取末条的
  `new_status` 作 `latest_status`；
- `manual_attempt_recorded`：`attempt_count += 1`；`elapsed_ms` 非
  null 累加；`cost_minor_units`/`currency` 非 null 按币种累加；
- `asset_imported`：记录该 task 的最早 `occurred_at` 为
  `first_asset_imported_at`；`delivery_ms = first_asset_imported_at −
  created_at`（毫秒整数；任一端 None → None；负值 → None 且记
  reconciliation gap `negative_delivery`）；
- `validation_completed`：`validation_runs += 1`；`passed=false` →
  `validation_failures += 1`；
- `manual_quality_rating_recorded`：按 shot 归组（envelope.shot_id）；
  latest 按 (occurred_at, event_id)，mean 为算术平均；
- `composition_completed`：项目级计数与 `latest_composition_at`/
  `latest_output_version`（按 output_version 取最大）。

排序全序：涉及“最新”一律 `(occurred_at, event_id)` 字典序，保证
确定性（同 occurred_at 时用 event_id 破平）。

## 3. 三粒度装配

- per_task：每个**出现过 task_created 或任何 task 归属事件**的
  task_id 一条；按 task_id 升序。
- per_shot：对 ProjectData.shots 中每个 shot + 事件中出现的 shot_id
  取并集；`scene_id` 优先取自 ProjectData.shots，缺失记
  reconciliation gap；按 (scene_id, shot_id) 升序。
- per_project：ProjectData.project.project_id 单条聚合。

金额一律按币种分组求和（`cost_by_currency`，键排序），**不跨币种
相加**（ADR-0003）。

## 4. 对账（reconciliation，只报告不修复）

检查并列出（kind）：

- `task_without_created_event`：ProjectData 有 GenerationTask 但事件流
  无对应 `task_created`；
- `done_task_without_asset`：task 状态 DONE 但无 `asset_imported`；
- `asset_without_import_event`：ProjectData 有 VideoAsset 但无对应
  `asset_imported`（按 asset_id）；
- `event_for_unknown_shot`：事件 shot_id 不在 ProjectData.shots；
- `event_for_unknown_task`：事件 task_id 不在 ProjectData.generation_tasks；
- `negative_delivery`：asset 导入早于 task_created（时钟/顺序异常）。

对账是 ADR-0003 §9 已知“事件缺失窗口”的暴露手段，不做双写事务、
不反写业务状态。

## 5. 确定性输出

- JSON 为事实来源：固定键集 + `summary_schema_version`；顺序如上；
  时间 `isoformat(timespec="microseconds")`；float 均值保留原值
  （由 JSON 序列化决定）——为逐字节确定性，`mean_rating` 以
  `round(x, 6)` 归一后输出。
- Markdown 为确定性人类可读渲染，标注 “derived — recomputable from
  the event log”。
- 版本化 `summary_v<N>`（N 从 1 递增）+ 防覆盖（reuse-if-equal /
  conflict-on-diff，复用既有 no-replace publish 语义）；相同输入重跑
  逐字节一致（验收要求）。
- 版本选择：扫描 `reports/qcd/summary_v<N>.json` 显式路径（不扫描
  目录内容之外），取最大已存在 N；若最大版本内容与本次 summary 逐
  字节一致 → 复用该版本（no-op）；否则发布 N+1。

## 6. Ownership / CLI

- 新增：`src/ai_video_workflow/qcd/aggregation.py`、`qcd/reporting.py`、
  `tests/test_qcd_aggregation.py`、`tests/test_qcd_reporting.py`；
- 一次性授权修改：`qcd/__init__.py`（导出扩展）、`cli.py`（新增
  `qcd-report` 子命令）；
- CLI `qcd-report --project-root <p>`：加载 ProjectData + read_events →
  run_qcd_report_step(observed_at=utc_now()) → 打印 json/md 路径与
  reconciliation 计数；退出码 0/非 0。
- 守卫测试：`reports/qcd/` 之外零写入（QCD 模块只读业务数据）。
