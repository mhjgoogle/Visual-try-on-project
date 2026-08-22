# TASK-012：基于 QCD 的自动模型路由（阶段 9）

> **状态：Outline（WFM3）。** 依赖现行 TASK-016/017 云 Provider、
> TASK-009/021 QCD 成本与 ADR-0040；若选择本地路线可再依赖 TASK-011。
> 路由策略的质量/成本/时限权重是产品级
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

TASK-009/021（QCD 与云成本汇总）；TASK-016/017（现行可插拔云 Provider）；
ADR-0040 Accepted 与 TASK-038 能力注册表；至少存在两个可用候选 Provider 或
模型时才启用自动路由。TASK-011 是可选候选，不是硬依赖。

## 当前状态

Outline for WFM3 — implementation is owned by TASK-038 after ADR-0040 Accepted；
不计入 WFM1/WFM2 回归门槛。
