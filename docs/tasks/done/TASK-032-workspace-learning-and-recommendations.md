# TASK-032：项目复盘、跨项目学习与证据化推荐（WSM3-A）

> **状态：Delivered（2026-08-03）。** 账户级用户确认知识提升事实域（ADR-0001 第五次增补 `<account>/knowledge/events/log.jsonl`）+ WQ-17 跨项目派生指标 + WQ-18 证据化推荐（合同 v1.4）+ CLI 均已实施，codex 3 轮独立审查通过（3 blocking 修复）。派生 analytics/推荐 on-demand 无持久缓存；损坏源 source_corrupt fail-closed、无证据 insufficient_evidence，绝不伪造。原文：Planned（代码实施待 ADR-0036
> Accepted 与相应 gate）。** TASK-032 是 ADR-0036 的 decision owner，本轮已完成
> 聚焦设计并把裁决写入 ADR-0036（Proposed）；生产代码依赖 TASK-022、
> TASK-027～031、ADR-0036 Accepted 及 TASK-023 门槛。

## 目的

从权威运行、成本、评价和 Action 事实生成项目复盘与跨项目指标，将用户确认的
经验提升为可复用知识，并为新项目提供带历史依据的建议。

## 输入

- release/postmortem、lineage/cost、evaluation/experiment/decision、Action facts；
- TASK-025 projection、TASK-027/028/029 查询；
- ADR-0010、ADR-0036。

## 输出

- Accepted ADR-0036 及经授权的知识提升/快照路径；
- 项目复盘、跨项目 KPI、重复问题和模板表现查询/页面；
- reuse candidate → user-confirmed knowledge 的提升流程；
- 新项目类似案例、模板、Provider/模型、风险、预算和检查项推荐；
- evidence refs、范围、限制、insufficient_evidence 测试。

## 修改范围

ADR-0036 授权的派生 analytics/recommendation、知识提升 application service、
Gateway command（如需，仅限 ADR-0033 registry 已批准命令）、Workspace 页面和测试。

## 明确不做

- 不自动修改项目 profile、prompt、预算、Provider 或审批；
- 不训练模型、不决定向量数据库、不跨账户共享；
- 不把派生 KPI/推荐变为权威事实；
- 不隐藏样本不足、失败案例或不确定性。

## 聚焦设计（WSM3-A 学习与推荐合同）

本节是 TASK-032 对 ADR-0036 的聚焦设计产出，只定学习/推荐的合同边界与不变量，
不选具体模型/算法/schema/字段/目录/类型/DB、不引入持久 projection 路径、不含代码。
裁决结论见 [ADR-0036](../../adr/ADR-0036-cross-project-learning-and-recommendation.md)。

- **只读派生**：跨项目指标（首次通过率、平均返工、制作时间、项目/单镜头成本、
  质量评分、重复问题、提示词模板成功率、Action 解决率等）全部从版本化的运行、成本、
  评价与 Action 权威事实经 ADR-0031 只读查询合同派生，带稳定定义、时间范围与来源
  refs；可删除重建；源事实变化后旧报告标为**快照**。派生层不修复、不写回业务状态、
  不持凭据（守 ADR-0010 决策 4，不作第二事实来源）。
- **候选经验 vs 已提升知识分离**：“候选经验”从证据自动浮现，“已提升知识”须经用户
  确认 + 来源 digest 方可成为可复用知识；用户拒绝的候选不进入已验证知识，也不影响
  权威事实。
- **证据化推荐**：推荐返回建议、适用条件、历史 evidence refs、样本范围与已知限制，
  覆盖相似项目、模板、Provider/模型、风险、预算与检查项；只作建议，不自动替代用户
  创作决定。
- **推荐只读、变更经 Gateway**：推荐不自动修改 profile、Provider 选择、预算、prompt
  或审批；任何由推荐触发的变更须封装为 ADR-0033 Command Gateway 的 command
  envelope，经 preflight 与版本绑定二次确认后由已批准 application service 应用；
  Workspace 永不直连 Provider（守 ADR-0010 决策 2/3）。
- **状态域分离**：学习/推荐/知识提升状态独立，不复用工作流审批、GenerationTask、
  StepManifest、Provider、reservation 或 Action 运行状态（守 ADR-0010 决策 7）。
- **三分标注与 fail-closed**：延续 ADR-0031，派生结果区分 authoritative｜derived｜
  unavailable；数据/证据不足返回 `unavailable` / `insufficient_evidence`，不编造置信度、
  不隐藏失败案例与不确定性。
- **不越权（Not-decided-here）**：向量库、embedding、推荐算法、模型训练、跨账户共享、
  自动工作流优化，以及知识提升事实/派生快照的精确路径、唯一写入者、来源失效与重建
  规则和 schema/字段/目录/类型/DB，均留待 ADR-0036 Accepted 前的设计补齐；ADR-0031
  WSM1 为 on-demand、无持久缓存，本任务不引入任何持久 projection/知识存储路径，
  项目/账户持久路径须由 ADR-0001 授权。
- **守卫（须有测试固化）**：学习/推荐层不含任何业务写、Provider 直连或自动写命令；
  推荐不会自动触发任何写命令；关闭 Workspace 不影响核心运行与恢复。

## 实施步骤

1. 接受 ADR-0036，锁定指标定义、证据和知识提升边界。
2. 实现项目复盘和跨项目 KPI 的确定性派生。
3. 实现候选经验与用户确认提升流程。
4. 实现有证据的新项目推荐和限制说明。
5. 验证源事实变化后的重建、快照和过期行为。

## 测试要求

- 首次通过率、返工、时间、成本、质量、问题和 Action 解决率定义正确；
- 指标可重算、时间范围明确、排序确定；
- 推荐包含 evidence refs，数据不足不生成伪结论；
- 用户拒绝的候选不进入已验证知识；
- 推荐不会自动触发任何写命令。

## 验收标准

- [ ] 项目复盘可追溯到权威事实；
- [ ] 跨项目指标定义稳定且可重建；
- [ ] 经验提升必须经用户确认；
- [ ] 推荐说明历史依据、适用条件和限制；
- [ ] 推荐不替代用户创作决定。
