# TASK-028：评价、实验比较与创作决定（WSM2-A）

> **状态：Ready（ADR-0034 已 Accepted 2026-08-02，2026-08-03 用户复核确认；代码
> 实施已解禁，尚未开始）。** TASK-028 是 ADR-0034 的 decision owner，聚焦设计已写入
> ADR-0034（Accepted）；生产代码依赖已满足（ADR-0034 Accepted、TASK-018/020/022 与
> TASK-026/027），可开工。在 Command Gateway 前，写入仅通过批准的 CLI/app service，
> Workspace 页面只读；完整验收仍受 TASK-023 readiness 与独立审查约束。

## 目的

在 TASK-022 的 WFM1 最小 QC/终审证据之上，建立通用、版本绑定的评价、实验和
创作决定能力，使用户能比较方案、记录修改原因和结果，并始终保留最终人工判断。

## 输入

- project goals、prompt/artifact versions、TASK-022 QC/终审/决定证据；
- TASK-027 比较与成本查询；
- ADR-0010、ADR-0034 和数据可观察性要求。

## 输出

- ADR-0034 裁决及经 ADR-0001 增补授权的持久化路径/唯一写入者；明确
  TASK-022 既有证据的兼容读取和非重复归属；
- evaluation/experiment/decision application service 与安全 CLI；
- 只读评价、实验、决定历史和比较结果页面；
- 用户/AI 来源、目标 digest 失效、增量成本/时间测试。

## 修改范围

ADR-0034 授权的新评价/实验/决定模块、CLI、query adapter、只读 UI 与测试；
不修改产物、QCD 或审批事实合同。

## 明确不做

- 不让 Workspace 直接写评价；
- 不实现 AI 自动批准、自动优胜者或评分模型 API；
- 不复用 QCD/approval/Action 状态；
- 不改写或复制 TASK-022 的 QC、发布准入和终审事实；
- 不实现 Command Gateway 或跨项目推荐。

## 聚焦设计（评价 / 实验 / 决定域）

本节是 TASK-028 对 ADR-0034 的聚焦设计产出，只定领域模型与边界规格，不选最终
schema/字段名/目录/DB、不含代码。裁决结论见
[ADR-0034](../adr/ADR-0034-evaluation-experiment-and-decision-contract.md)。

- **领域模型**：按 ADR-0034 采用「独立评价事实域 + 派生比较视图」——evaluation、
  experiment、creative-decision 构成一个独立的、append-only/不可变观察证据域，有
  自己的唯一写入者，只按稳定引用关联既有事实；比较、排名、增量成本/时间在
  ADR-0031 query/projection 层派生并可重建。
- **状态域分离（ADR-0010 决策 7）**：本域的 criterion、score/tag、pass、experiment
  状态、decision 类型等语义**不复用**工作流审批、GenerationTask、StepManifest、
  Provider 或 reservation 状态，也不被它们复用。
- **非第二事实源**：只按 `ref + version + content_digest` **引用**产物与 TASK-022 的
  QC/发布准入/终审证据及成本/谱系事实；**不复制、不改写、不替代**既有审批/QC/发布/
  终审事实。TASK-022 既有证据由其原 owner 维护，本域对它只读可见。
- **版本绑定与 stale 失效（ADR-0010 决策 6）**：每条记录绑定评价目标的
  `ref + version + content_digest` 与所依据的 project goals 版本；目标/目标版本漂移、
  digest 不匹配或目标缺失时 fail-closed，标为 `stale`/结构化 problem，不作用于错误
  版本。
- **append-only 可重建**：本域事实一经写入即不可变，新评价形成新记录，旧决定与未选
  候选不被删除或原地改写；跨域比较/排名/成本时间为 derived，删除 projection 后可从
  本域事实与权威运行/成本/谱系事实确定性重建，三分标注 authoritative｜derived｜
  unavailable。
- **actor 分离与用户终判**：每条评价标注 `actor = user | AI`；AI 辅助评分/建议仅作
  辅助证据，最终 pass 与创作判断必须由用户确认，AI 不形成通过、终审批准或自动
  优胜者。
- **写入姿态**：Command Gateway 前本域写入仅经批准的 CLI/app service，原子且防覆盖；
  Workspace 页面对本域只读，不提供直接写评价入口。
- **待 Accepted 前补齐（Not decided here）**：最终 schema/字段名/目录/DB、评分量表
  全集、AI 评价 Provider 与统计显著性、持久化路径与唯一写入者、TASK-022 既有证据的
  精确兼容读取映射，由 TASK-028 在 ADR-0034 Accepted 前补齐；任何项目/账户持久路径
  须经 ADR-0001 明确授权。

## 实施步骤

1. 聚焦设计并接受 ADR-0034，明确路径、owner、版本语义及 TASK-022 兼容边界。
2. 实现绑定 target/goals digest 的 application service 与 CLI。
3. 实现实验 variants、改变因素、预期/实际和成本时间关联。
4. 扩展 query 与只读 UI 展示评价、决定和比较。
5. 覆盖 stale target、AI 辅助和用户最终确认。

## 测试要求

- ref/version/digest 绑定、不可变历史和 stale 失效；
- user/AI actor 分离，AI 不能形成最终批准；
- experiment 成本/时间由权威事实派生；
- TASK-022 既有终审证据只读可见，且不会被复制为第二份批准事实；
- CLI 写入原子、防覆盖，UI 只读；
- legacy 和目标删除/损坏错误路径。

## 验收标准

- [ ] 用户可追溯为什么选择、放弃、修改、重做或接受结果；
- [ ] 实验记录预期、实际、成本/时间和复用结论；
- [ ] 最终创作判断只能由用户确认；
- [ ] 评价事实不嵌入产物或 QCD 汇总；
- [ ] Gateway 前 Workspace 保持只读。
