# ADR-0003: QCD Append-only Event Log Format

- Status: Proposed
- Date: 2026-07-28
- Scope tasks: TASK-005 (module + 3 events), TASK-006 (1 event),
  TASK-007 (3 events), TASK-009 (consumer)

## Context

architecture.md §10 规定 append-only QCD 事件日志是原始 QCD 事实
的唯一来源，第一阶段采集七类事件，阶段 6 做汇总。ADR-0001 已预留
`qcd/events/` 目录但未定义文件格式。事件由多个步骤组件在不同任务
中写入，需要一个跨任务稳定的写入合同。

## Decision

1. **位置与形态**：单文件 `qcd/events/log.jsonl`（项目根相对）。
   JSON Lines：UTF-8、无 BOM、一行一个事件对象、`\n` 结尾、键
   排序、`ensure_ascii=False`（对齐 TASK-002 确定性 JSON 合同的
   单行变体）。
2. **append-only 语义**：只允许 `O_APPEND` 追加 + flush + fsync；
   任何组件不得截断、重写或删除既有行。追加不属于「覆盖已有
   文件」，不受默认防覆盖约束（本 ADR 显式授权）。
3. **事件 envelope**（全部事件统一）：

   ```json
   {
     "schema_version": 1,
     "event_id": "<deterministic-or-uuid-id>",
     "event_type": "<七类之一>",
     "occurred_at": "<UTC ISO-8601，与 TASK-002 时间格式一致>",
     "project_id": "...",
     "shot_id": "... | null",
     "task_id": "... | null",
     "payload": { "...": "JSON-compatible，键排序" }
   }
   ```

   事件类型固定七种：`task_created`、`task_status_changed`、
   `manual_attempt_recorded`、`asset_imported`、
   `validation_completed`、`composition_completed`、
   `manual_quality_rating_recorded`。新增类型须修订本 ADR。
4. **event_id 与去重**：可确定性派生的事件使用确定性 id（如
   `validation_completed:<task-id>:v<version>`），天然幂等；随机
   事件（人工尝试、评分）使用 uuid4。**日志中允许出现重复
   event_id 行**（断点续跑重放造成）；一切消费方必须按 event_id
   去重（保留首行）。这是「写入方简单、读取方去重」的显式取舍。
5. **strict 读取**：读取器逐行 strict 解析；损坏行、未知
   event_type、schema_version 不支持 → 类型化错误并报告行号，
   不静默跳过（数据完整性优先于可用性）。
6. **单一事实来源**：GenerationTask 等业务文件不嵌入 QCD 数据
   （architecture.md §2/§10 既有边界）；汇总（TASK-009）是派生
   数据，必须可由本日志重算。
7. **已知边界（记录，不在第一阶段解决）**：
   - 事件在业务 persistence 之后发射，两写入间崩溃会造成事件
     缺失；TASK-009 的对账检查负责暴露缺口，不做双写事务；
   - 单文件在极大项目下的体积问题留待真实出现时再分片（届时修订
     本 ADR），第一阶段不预先设计。

## Consequences

- 所有写入方共享一个小而稳定的 `append_event` API（TASK-005
  交付）；
- 消费方（阶段 6、未来路由）获得可重放、可去重、可对账的事实流；
- 成本：读取方必须去重；缺失事件需对账发现。

## Not decided here

- 指标定义与汇总算法（TASK-009）；
- 货币成本的字段细化（首个付费 Provider 任务，TASK-010）。
