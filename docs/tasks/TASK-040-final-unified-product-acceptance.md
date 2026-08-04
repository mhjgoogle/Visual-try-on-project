# TASK-040：AI 短剧工作流与 Creation Workspace 最终统一验收

> **状态：Evidence Ready — 等用户签字（2026-08-04）。** 最终产品 milestone gate；
> TASK-037（WFM2 gate，证据已备齐等签字）、TASK-038/039 已实现过审。本任务不新增
> 功能，只备齐最终联合验收证据：`tests/test_final_unified_acceptance.py`（闭环
> 目标→运行→观察→评价/Action→复盘→学习/复用 + 跨切面不变量）+
> [最终追踪矩阵](../design/final-unified-acceptance-traceability.md) +
> [runbook](../design/final-unified-acceptance-runbook.md) +
> [里程碑评审](../design/final-unified-milestone-review.md)。里程碑 PASS 属用户
> （runbook §5），实施 Agent 不代判。TASK-037 与本门两处签字共同构成最终产品验收。

## 目的

以两份顶层需求为唯一验收源，证明完整短剧生产工作流和统一创作工作视窗形成
“目标→运行→观察→评价→Action→确认→复盘→学习→复用”的真实闭环。

## 输入

- `ai_shortfilm_pipeline_workflow.md`；
- `ai_video_creation_workspace_requirements.md`；
- [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md)；
- 统一追踪矩阵、Accepted ADR、实现、测试和用户 runbook。

## 输出

- 逐需求 requirement→ADR→task→code→test→evidence 最终矩阵；
- 完整项目、运行/失败项目和跨项目历史数据验收集；
- 全链安全、资金、恢复、重建、凭据和人工创作验收报告；
- 正式文档状态、已知限制和后续升级清单。

## 修改范围

验收测试、fixtures、runbook、追踪矩阵和正式状态文档；缺陷回归 owner task 修正。

## 明确不做

- 不新增 Provider、工作流步骤、UI 页面、schema 或算法；
- 不用 unavailable 关闭明确要求的最终能力；
- 不把真实付费 API 设为默认 CI；
- 不降低人工批准、预算、版本、恢复或凭据安全标准。

## 实施步骤

1. 冻结两份需求的逐条验收清单和证据位置。
2. 贯穿完整 L0～S7、多媒体生成、正式后期、Workspace 操作和 Action。
3. 验证复盘、跨项目指标、知识提升和新项目推荐。
4. 注入崩溃、重放、预算、stale、projection 损坏和 secret 攻击场景。
5. 完成独立架构/实现审查和用户创作验收。

## 测试要求

- 两份需求每一条均有通过证据或经用户批准的显式范围变更；
- 真实 query/Gateway/Orchestrator 协调链，不以纯函数 mock 替代；
- 全媒体成本、谱系、版本和 Action 可审计；
- UI 关闭/重建不影响核心，重复命令不重复执行/付费；
- 全量测试、静态检查、文档链接/编号/状态一致。

## 验收标准

- [ ] 两份顶层需求无未解释缺口；
- [ ] I/O baseline 全部步骤均有最终 requirement→schema→owner→code→test→evidence；
- [ ] 完整工作流与 Workspace 均可跨项目复用；
- [ ] 自动化不替代用户创作决定；
- [ ] 所有业务事实有唯一写入者且 projection 可重建；
- [ ] 独立审查和用户验收通过后方可宣布最终产品基线完成。
