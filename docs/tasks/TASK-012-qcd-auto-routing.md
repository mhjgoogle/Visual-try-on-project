# TASK-012：基于 QCD 的自动模型路由（阶段 9）

> **状态：大纲（OUTLINE，Milestone 3——依赖 TASK-010/011 至少
> 其一 + TASK-009）。** 路由策略的质量/成本/时限权重是产品级
> 取舍，实施前须用户裁决。

## 正式名称

QCD-based Automatic Provider Routing

## 业务目标

基于 TASK-009 汇总的 QCD 数据，按质量/成本/时限要求自动为每个
Shot 选择 Provider，并支持人工覆盖路由决策
（implementation_plan 阶段 9）。

## 边界合同（已可锁定的部分）

- 路由是 bootstrap 层的决策扩展（为新 GenerationTask 选
  provider_id），不修改 `VideoProvider` / `ProviderOrchestrator`
  合同；
- 输入只读：QcdSummary（派生数据）+ 显式路由策略配置；输出：
  带理由的路由决策记录（落盘，可审计）；
- 人工覆盖：显式 CLI 参数优先于自动决策，覆盖行为写入决策记录；
- Provider 注册表（配置驱动的 provider 选择）在此任务或其前置
  小任务中定案——TASK-004 明确遗留项。

## 依赖

TASK-009（QCD 汇总）；TASK-010 或 TASK-011 至少其一（存在第二个
Provider 才有路由意义）；用户裁决路由策略权重。

## 当前状态

Outline only — blocked on TASK-010/011 and user product
decisions；不计入 Milestone 1–2 回归门槛
