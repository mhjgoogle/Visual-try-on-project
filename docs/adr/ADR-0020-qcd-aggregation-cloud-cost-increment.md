# ADR-0020: QCD 聚合纳入云端权威成本的受控增量

- Status: Accepted
- Date: 2026-08-02
- Scope tasks: TASK-021
- Amends: ADR-0003（QCD 事件与聚合合同）、TASK-009 聚合实现（冻结）
- Related: ADR-0008（`provider_cost_recorded` 事件）

## Context

ADR-0008 新增了第 8 类原始事实事件 `provider_cost_recorded`（云端权威
成本，整数原币最小单位）。预算 ledger（TASK-015/016）已消费它，但冻结的
官方 QCD 聚合（`qcd/aggregation.py`，TASK-009）仍只统计
`manual_attempt_recorded` 的成本——形成"预算已记账、报表漏报"的双口径。
TASK-021 卡要求先以 ADR 授权并限定聚合扩展。

## Decision — 唯一授权的增量

1. `qcd/aggregation.py` 的事件分派链**新增一个分支**：
   `PROVIDER_COST_RECORDED`（且 `task_id` 非空）时，把
   `payload.cost_minor_units` 按 `payload.currency` 累加到该 task 的
   `cost_by_currency`——与 `manual_attempt_recorded` 成本分支**同一口径、
   同一累加器**，从而自然进入既有 shot/project 汇总与报表。
2. **不改变**其它任何统计：不计 attempt_count、不影响状态/时长/校验
   计数；该事件不携带 elapsed。
3. **去重**沿用既有合同：`read_events` 首行去重 + 聚合内部 dedup；
   `provider_cost_recorded` 的确定性
   `event_id = provider_cost_recorded:{task_id}:{operation_id}` 保证等价
   重放只入账一次。
4. **派生一致性**：聚合输出的原币合计必须与预算 ledger 对同一事件流的
   原币合计一致（JPY 由各自锁定 FX 派生，非第二事实来源）；以测试锁定
   "事件重放 → 聚合与账本一致"。
5. 授权范围**仅此**：`aggregation.py` 一个 elif 分支 + 对应测试。
   `reporting.py`、summary schema、七类既有事件的统计口径一律不变
   （报表经既有 `cost_by_currency` 自动包含云端成本，无需改动）。

## Consequences

- 官方 QCD 报表首次完整覆盖 manual + cloud 成本，双口径消除；
- 冻结面变更集中、可对抗验证（去重/重放/一致性）。

## Not decided here

- 成本按 Provider/模型/阶段的细分维度报表（可由事件+reservation 派生，
  属未来只读 projection，不改聚合）。
