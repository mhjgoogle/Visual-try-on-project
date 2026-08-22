# TASK-028：评价、实验比较与创作决定（WSM2-A）

> **状态：Delivered（步骤 1–5，2026-08-03）。** 地基 records+log（0c08bf7）、
> application service 绑定/stale/actor（21f8c72）、写入 CLI
> eval/experiment/decision-record（f60127f）、WQ-15 只读查询 + 合同 v1.2（1830799）
> 均已实施并各经 codex 独立审查通过。experiment 的**增量成本/时间**已在 WQ-15 派生
> （每 variant 经 asset_imported→source_task_id 关联权威 cost_by_currency +
> attempts_elapsed_ms，并给出对首个 variant 的 delta；无付费成本的手动 variant 为空
> 成本/None，不伪造；用户已确认口径）。写入仅经批准 CLI/app service，Workspace 对本域
> 只读。仓库无 UI 框架（WFM1 Workspace 仅 query+CLI），「只读页面」即 WQ-15 查询输出。
> 完整验收仍受 TASK-023 readiness 与独立审查约束（TASK-023 已过）。
>
> TASK-028 是 ADR-0034 的 decision owner，聚焦设计已写入 ADR-0034（Accepted）。

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

## 实现设计（本轮补齐：路径 / schema / 写入者 / 版本语义）

ADR-0034 把最终 schema、持久化路径与唯一写入者延给本卡在 Accepted 后锁定。裁决如下，
硬性偏好为**镜像既有 append-only QCD 范式、最少新依赖**：

- **持久化路径（经 ADR-0001 授权）**：`evaluation/events/log.jsonl`——单一 append-only
  JSON Lines 日志，与 `qcd/events/log.jsonl` 同构；经 ADR-0004 `resolve_within_root`
  containment 接纳，符号链接组件拒绝。**唯一写入者**为本域 application service，写入
  `O_APPEND`+flush+`fsync`、torn-tail 守卫、读取按 `record_id` 去重 first-wins（照
  `qcd/log.py`）。
- **一域三类型**：同一日志承载 `record_type ∈ {evaluation, experiment,
  creative_decision}`，统一 envelope + 每类型固定 payload key 集（照 `qcd/events.py`
  的 `_PAYLOAD_KEYS` 范式）。
- **统一 envelope（固定键）**：`schema_version`、`record_id`（确定性派生）、
  `record_type`、`occurred_at`（调用方提供，不读时钟）、`project_id`、
  `actor ∈ {user, ai}`、`target`（`ref + version + content_digest`）、`goals_version`、
  `payload`。
- **各类型 payload**：
  - `evaluation`：`{criterion, score, tag, pass, rationale}`；
  - `experiment`：`{variants[], changed_factor, expected_improvement, actual_result,
    reuse_conclusion}`；
  - `creative_decision`：`{decision_type ∈ (select｜abandon｜change_prompt｜switch_model｜
    redo｜accept_imperfect), changed, why, expected, actual}`。
- **版本绑定 / stale fail-closed**：service 与 query 读取时校验 `target` 的
  ref+version+content_digest 与 `goals_version` 对应权威事实；漂移/digest 不符/目标缺失
  → 标 `stale`/结构化 problem，不作用于错误版本（原始日志只存事实，stale 为读取期派生）。
- **actor 分离 / 用户终判**：`actor = ai` 的记录仅辅助证据，service **拒绝**由 AI 记录
  形成 `pass=true` 的终判或自动优胜者；最终 pass/创作决定须 `actor = user`。
- **非第二事实源**：只按 ref+version+digest 引用 TASK-022 QC/发布/终审证据，只读可见，
  绝不复制/改写；增量成本/时间在 ADR-0031 query 层从权威成本/运行事实派生，本域不存。
- **写入姿态**：Gateway 前写入仅经批准 CLI/app service；Workspace 页面对本域只读。

代码落点（后续增量按此照抄 QCD 范式）：`src/ai_video_workflow/evaluation/`
（`records.py` 模型+codec、`log.py` append/read、`service.py` 绑定+stale+actor 校验）、
CLI 子命令、`workspace` query adapter + 新 WQ 只读查询、只读 UI 页；测试
`tests/test_evaluation_*.py`。

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

- [x] 用户可追溯为什么选择、放弃、修改、重做或接受结果（creative_decision 记录 +
  WQ-15 历史）；
- [x] 实验记录预期、实际、成本/时间和复用结论（预期/实际/复用结论入 experiment
  payload；增量成本/时间由 WQ-15 从权威成本/运行事实派生，见状态说明）；
- [x] 最终创作判断只能由用户确认（service 拒绝 AI 的 pass=true 与 select 优胜者）；
- [x] 评价事实不嵌入产物或 QCD 汇总（独立 append-only `evaluation/events/log.jsonl`）；
- [x] Gateway 前 Workspace 保持只读（WQ-15 只读查询；写入仅经批准 CLI/app service）。
