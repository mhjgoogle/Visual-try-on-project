# TASK-009：QCD 汇总、指标计算与报告（阶段 6）

> **状态：Implemented。** 原 M1/M2 聚合已完成；云端权威成本分支随后由
> ADR-0020/TASK-021 增量加入。TASK-008 已转入 WFM2，不再作为本任务的审查门槛。

## 正式名称

QCD Aggregation, Metrics, and Reporting

## 业务目标

消费阶段 2–4 采集的 append-only QCD 事件日志，按
GenerationTask / Shot / Project 三个粒度计算质量、成本、交付周期
指标，输出可比较的人类可读报告，为未来 Provider 性价比比较与
阶段 9 自动路由提供数据（architecture.md §10、implementation_plan
阶段 6）。

## 前置依赖

- TASK-005（`qcd` 事件模块与日志格式 ADR-0003）；
- TASK-007（阶段 2 事件已实际采集，日志中有完整事件流）。
- 与 TASK-008 无依赖关系，可并行实施。

## 范围内

1. `qcd/aggregation.py`：事件流读取（strict 解析 + event_id
   去重，torn-final-line 语义遵循 ADR-0003 §7）→ 三粒度指标。
   **输入合同 = ADR-0003 §4 的七类 payload schema 与「TASK-009
   aggregation 使用方式」节**（本任务不得要求写入方提供 schema
   之外的字段，也不得修改事件 schema）：
   - Delivery：`task_created.occurred_at` → 同 task 的
     `asset_imported.occurred_at` 时长；
     `composition_completed.occurred_at` 为项目级成片时点；
   - Quality：人工评分（`score`/`scale`，最新值按 occurred_at +
     event_id 全序，均值按去重后事件集）、重做次数（同 Shot 的
     `task_created` 计数与 `origin="redo"`）、校验失败率
     （`validation_completed.passed`/`checks_failed`）；
   - Cost：人工尝试次数与 `elapsed_ms` 合计
     （`manual_attempt_recorded`）；`cost_minor_units`/`currency`
     合计（M1 人工模式通常为 null，付费 Provider 接入后填充；
     不同货币不得跨币种相加，按 currency 分组）；
2. `qcd/reporting.py`：`reports/qcd/summary_v<N>.{json,md}`，
   版本化、防覆盖、确定性输出；
3. 事件↔业务记录对账检查（发现事件缺失/孤儿事件时在报告中列出，
   见 ADR-0003 已知边界，不自动修复）；
4. CLI 接线：`ai-video-workflow qcd-report` 子命令（`cli.py` 的
   一次性授权扩展）；
5. 单元测试与集成测试。

## 范围外

- 修改事件 schema 或既有事件写入方；
- 自动模型路由（TASK-012）；
- 汇总结果作为第二事实来源（全部派生数据必须可由事件日志重算，
  报告标注 derived）；
- 反向修改任何业务状态（QCD 模块只读业务数据）。

## Production ownership

- 新增：`src/ai_video_workflow/qcd/aggregation.py`、
  `qcd/reporting.py`、`tests/test_qcd_aggregation.py`、
  `tests/test_qcd_reporting.py`；
- 一次性授权修改：`cli.py`（新增子命令）、`qcd/__init__.py`
  （导出扩展）。

## Public API（合同级草案）

```python
def aggregate_events(
    events: tuple[QcdEvent, ...],
    data: ProjectData,
) -> QcdSummary: ...


# QcdSummary: per_task / per_shot / per_project 三层冻结结构


def run_qcd_report_step(
    *,
    project_root: Path,
    data: ProjectData,
    observed_at: datetime,
) -> QcdReportOutcome: ...
```

指标字段全集由聚焦设计文档定案（本卡锁定三粒度与
Quality/Cost/Delivery 维度）。

## Failure / recovery / security

- 只读事件日志与业务记录；输出仅 `reports/qcd/`；
- 损坏事件行 → 类型化错误并在报告中定位行号（strict，不静默
  跳过）；
- 版本化输出、防覆盖；无 StepManifest（纯派生计算，重算即恢复）。

## 测试与验收（合同级）

- 焦点测试：去重、三粒度聚合正确性（构造事件序列）、重做计数、
  时长计算（跨事件配对）、对账缺口报告、损坏行拒绝；
- 集成测试：最小闭环集成测试产出的真实事件日志 → 报告数值与
  预期一致；
- 验收：汇总可由事件日志重算（同输入重跑输出逐字节一致）；报告
  版本化落盘；QCD 模块零业务写入（守卫测试）；全部测试与静态
  检查通过。

## 实施 Agent / 审查方式

Claude Code 实施；batch milestone mode——实施审查合并到
Milestone 2 回归门槛。

## 当前状态

implemented (M2 batch, branch `feat/m1-minimal-loop`) — focused design
([TASK-009-qcd-aggregation-design](../../design/done/TASK-009-qcd-aggregation-design.md)),
`qcd/aggregation.py` (pure `aggregate_events` → `QcdSummary`) +
`qcd/reporting.py` (versioned, byte-stable `run_qcd_report_step`) +
`qcd-report` CLI subcommand, delivered across 2 commits; 13 focused
tests; full pytest 1896 passed / 2 skipped, ruff + git diff --check
clean。后续 `provider_cost_recorded` 聚合增量见 ADR-0020/TASK-021；本卡不再
等待 TASK-008，也不覆盖 WFM2 多媒体成本合同。
