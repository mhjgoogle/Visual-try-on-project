# ADR-0034: 评价、实验比较与创作决定合同

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-028
- Implementation scope: TASK-028、TASK-031～TASK-033、TASK-039、TASK-040
- Depends on: ADR-0031（Accepted）、ADR-0032（Proposed）；TASK-018/020/022 source contracts

## Context

工作视窗需要比较提示词、模型、参数、参考图片、生成批次和后期方案，并记录用户
为何选择、放弃、改提示词、换模型、重做或接受不完美结果（统一需求 §5.2/§5.3、
数据可观察性 §3.5）。这些评价、实验与创作决定是**创作判断**，不是产物本身，也
不是 QC/发布/终审的准入事实。

风险在于：若把评价嵌入产物或 QCD 汇总、复用工作流审批或 GenerationTask 状态，
或让 AI 辅助评分替代用户终判，就会产生第二事实来源、跨越状态域并绕过人工判断
（ADR-0010 决策 4/6/7、数据可观察性 §3.2/§3.5、§7）。TASK-022 已在 WFM1 内维护
最小 QC/终审/决定证据，Workspace 评价层只能**引用**这些既有证据，不得复制或替代。

本 ADR 在既定约束内裁决评价/实验/决定的**领域模型与边界**（不含最终 schema）：

- ADR-0010 决策 4：进度、谱系、成本、评价、跨项目视图是权威文件/事件的派生
  projection，损坏或删除后必须可重建，不得成为第二事实来源。
- ADR-0010 决策 6：反馈、Action 和高风险命令至少绑定 `ref + version +
  content_digest`；绑定过期时 fail-closed。
- ADR-0010 决策 7：Action/评价/实验状态不得复用工作流审批、GenerationTask、
  StepManifest、Provider 或 reservation 状态。
- ADR-0031（Accepted）：带版本、UI 无关的只读 query contract，projection 不写回
  业务状态、不持凭据、区分 authoritative｜derived｜unavailable。
- ADR-0032（Proposed）：Command Gateway 前 Workspace 页面只读；写入仅经批准的
  CLI/app service，界面不直写文件、不直连 Provider。

## Candidates

1. **独立评价事实域 + 派生比较视图**：evaluation/experiment/decision 是自成一域的
   append-only/不可变事实，有独立唯一写入者（TASK-028 的 app service/CLI），按
   `ref + version + content_digest` 与 project goals 版本**引用**既有产物与 TASK-022
   证据；跨域比较/排名/成本关联只在 query/projection 层派生，可删除重建。
2. **扩展 TASK-022 QC/终审事实域承载新评价**：把评价/实验/决定并入既有 QC、发布
   准入或终审事实，复用其状态与写入者。省一套结构，但让 Workspace 的主观评价改写
   或增殖 WFM1 准入事实。
3. **纯 UI 派生、无持久新事实**：评价与决定完全作为查询期计算的视图呈现，不落任何
   新的持久事实。最轻，但用户的评分、理由、实验结论无处承载。

## Candidate Evaluation

对照 Required Decision Properties（P1–P6）评估。✅ 满足良好，△ 可满足但有代价，
⚠ 明显受限或违背约束。

| 属性 | P1 状态域分离（决策 7） | P2 非第二事实源（只读引用既有证据） | P3 target+goals 版本绑定与 stale 失效（决策 6） | P4 append-only 不可变历史 + 视图可重建（决策 4） | P5 用户终判 / AI 仅辅助 | P6 Gateway 前只读 / 批准 CLI 写（ADR-0032） |
|---|---|---|---|---|---|---|
| 独立评价事实域 + 派生比较视图 | ✅ 自成状态域，不复用审批/GenerationTask/StepManifest/Provider/reservation 枚举 | ✅ 只按 ref/version/digest 引用产物与 TASK-022 证据，不复制、不替代 | ✅ 每条记录绑 target 三元组与 goals 版本，漂移即 stale/fail-closed | ✅ 事实 append-only/不可变，旧决定保留；比较/排名/成本视图删除可重建 | ✅ AI 仅记为辅助证据，pass 与创作终判由用户确认，AI 不能形成终审批准 | ✅ 写入经批准 CLI/app service，Workspace 页面只读 |
| 扩展 TASK-022 QC/终审事实域 | ⚠ 复用既有准入状态与写入者，跨域污染 | ⚠ 主观评价增殖/改写 QC/发布/终审事实，形成第二源 | △ 可绑定，但与既有事实边界纠缠 | △ 可 append，但历史与准入事实混同，难独立重建 | ⚠ 评价与准入耦合，AI 辅助易被当作准入结论 | △ 仍可只读，但写路径与 QC 写入者冲突 |
| 纯 UI 派生、无持久新事实 | ✅ 无新状态 | ✅ 不复制事实 | ⚠ 无处绑定用户评分/理由的版本身份 | ⚠ 用户主观判断未持久化，删除后无从重建 | ⚠ 用户理由/实验结论无法留存追溯 | ✅ 无写入 |

## Proposed Decision（待独立审查后 Accept）

采用 **候选 1：独立评价事实域 + 派生比较视图**——唯一在全部 P1–P6 上均为 ✅ 的
候选。evaluation、experiment 与 creative-decision 构成一个**独立的、append-only/
不可变**的观察证据域，有自己的唯一写入者，只按稳定引用关联既有事实；一切跨域
比较、排名、成本/时间关联在 ADR-0031 query/projection 层派生并可重建。候选 2 让
主观评价增殖或改写 TASK-022 的 QC/发布/终审准入事实（违背决策 4/7 与数据可观察性
§8.4/§8.5）；候选 3 无法承载用户评分、理由与实验结论，删除视图后无从重建。

### Decided here（本 ADR 裁决，概念/边界层）

- **状态域分离（P1）**：evaluation/experiment/decision 是**独立状态域**，其
  criterion、score/tag、pass、结论、experiment 状态、decision 类型（选择／放弃／
  改提示词／换模型／重做／接受不完美结果）等语义**不得复用**工作流审批、
  GenerationTask、StepManifest、Provider 或 reservation 的枚举或生命周期
  （ADR-0010 决策 7、数据可观察性 §3.2.2）。
- **只读引用既有证据、非第二事实源（P2）**：本域只按 `ref + version +
  content_digest` **引用**产物、TASK-022 的 QC/发布准入/终审证据与成本/谱系事实；
  **不复制、不改写、不替代**任何既有审批/QC/发布/终审事实。TASK-022 既有证据继续
  由其原 owner 维护，本域对它只读可见（数据可观察性 §8.4/§8.5）。
- **版本绑定与 stale 失效（P3）**：每条 evaluation/experiment/decision 记录须绑定
  评价目标的 `ref + version + content_digest` 与所依据的 project goals 版本；目标或
  目标版本漂移、digest 不匹配、目标缺失时 **fail-closed**，标为 `stale`/结构化
  problem，不静默作用于错误版本（ADR-0010 决策 6、数据可观察性 §7、§3.5.1）。
- **append-only 不可变历史 + 视图可重建（P4）**：本域事实一经写入即 append-only/
  不可变；对同一目标的新评价形成新记录，**旧决定不因新版本被删除或原地改写**
  （数据可观察性 §3.5、§3.3.4）。跨域比较、排名、增量成本/时间等**是派生视图**，
  须能在删除 projection/cache 后从本域事实 + 权威运行/成本/谱系事实确定性重建
  （ADR-0010 决策 4、数据可观察性 §6.7/§6.9）。
- **actor 分离与用户终判（P5）**：每条评价须标注 `actor = user | AI`；AI 辅助评分/
  建议只作为**辅助证据**呈现，**最终 pass 与创作判断必须由用户确认**，AI 输出不得
  自动形成通过、终审批准或优胜者选择（统一需求 §5.2、数据可观察性 §3.5.1）。
- **experiment / decision 语义最小集（概念层）**：experiment 概念上须能表达比较对象
  （variants）、改变的因素、预期改善、实际结果、增量时间/成本与复用结论；creative
  decision 概念上须能表达“改了什么、为什么、预期、实际、增量成本/时间”与选择／
  放弃／改提示词／换模型／重做／接受不完美结果的理由（统一需求 §5.3、数据可观察性
  §3.5.3）。增量成本/时间**从权威成本/运行事实派生**，本域不自建第二份成本事实。
- **写入姿态（P6）**：Command Gateway 之前，本域写入仅经**批准的 CLI/app service**，
  写入须原子且防覆盖；Workspace 页面对本域**只读**，不提供直接写评价的界面入口
  （ADR-0032、统一需求 §8.2）。

### Not decided here（延期至 TASK-028 Accepted 设计或后续 ADR）

- 最终 schema、字段名、目录/文件拆分、schema version、Python 类型或数据库；
- 评分量表全集、criterion 枚举、问题标签体系与 pass/fail 判定细则；
- AI 评价 Provider、评分模型 API、统计显著性与自动优胜者选择（明确不做）；
- 持久化路径与唯一写入者的**物理定位**：由 TASK-028 在本 ADR Accepted 前补齐并
  锁定，任何项目/账户持久路径须经 **ADR-0001** 明确授权；
- TASK-022 既有证据与本域新事实的**精确兼容读取映射**（结构层）：由 TASK-028 在
  Accepted 设计内给出，须保持非重复归属；
- 比较/排名的具体 UI 布局与视觉（受 ADR-0032 只读 shell 与其 Accepted 设计约束）；
- Command Gateway 协议与 Action schema（ADR-0033～0036）；跨项目复盘/推荐
  （TASK-032/ADR-0036）。

## Security & Boundary Invariants（下游 028/031～033/039/040 必须遵守）

1. 状态域分离：本域枚举/生命周期不得复用审批、GenerationTask、StepManifest、
   Provider、reservation 状态；也不得反向被它们复用。
2. 非第二事实源：只按 ref/version/digest 引用既有产物与 TASK-022 QC/发布/终审证据，
   永不复制、改写或替代；既有证据的唯一写入者不变。
3. 版本绑定 fail-closed：目标/ goals 版本漂移、digest 不匹配或目标缺失时置 stale/
   结构化 problem，不作用于错误版本、不静默补值。
4. 不可变历史：本域事实 append-only；旧决定与未选候选不得静默消失或原地改写。
5. 派生可重建：比较、排名、增量成本/时间为 derived，删除 projection 后可从本域事实
   与权威运行/成本/谱系事实确定性重建；三分标注 authoritative｜derived｜unavailable。
6. 用户终判：AI 仅辅助证据，最终 pass 与创作判断由用户确认；AI 不形成终审批准或
   自动优胜者。
7. 只读界面：Gateway 前 Workspace 页面对本域只读；写入仅经批准 CLI/app service，
   原子且防覆盖。
8. 安全与隐私：本域及其 projection 不得写入 credential、Authorization header、私有
   下载 URL 或敏感响应；面向用户错误脱敏且可定位（数据可观察性 §3.6）。

## Consequences

- 评价/实验/决定获得独立、可追溯、版本绑定的证据域，用户可回答“为什么选择／放弃／
  改提示词／换模型／重做／接受不完美结果”，且不污染 QC/发布/终审准入事实；
- 比较、排名与成本/时间关联复用 ADR-0031 query 层，无需新执行层或第二成本源；
- 只读观察可先落地，写入在 Gateway 前经批准 CLI，界面写能力等待 ADR-0033 与
  TASK-023 门槛；
- 本 ADR 只裁决领域边界与状态域分离，不锁死 schema/路径/DB，为 TASK-028 Accepted
  设计与 WFM2/WFM3（TASK-039/040）扩展留出空间；
- 代价：本域引入独立唯一写入者与版本绑定校验，须承担 stale 失效、append-only 与
  与 TASK-022 证据非重复归属的一致性责任。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 评价/实验/决定裁决只落在领域边界与状态域分离层，未定最终 schema/字段名/
      目录/Python 类型/数据库，未创建代码；
- [ ] 与 ADR-0010 决策 4/6/7、ADR-0031 只读合同、ADR-0032 只读姿态一致，未越权定义
      Gateway/Action/推荐；
- [ ] 状态域分离明确：本域不复用审批/GenerationTask/StepManifest/Provider/reservation
      状态；
- [ ] 非第二事实源明确：只 by-ref 引用 TASK-022 QC/发布/终审证据，不复制/替代；
- [ ] 版本绑定 + stale fail-closed、append-only 不可变历史、派生视图可重建三点齐备；
- [ ] 用户终判 / AI 仅辅助边界明确，无自动批准或自动优胜者；
- [ ] 持久化路径、唯一写入者与 TASK-022 兼容映射列入 Not decided here，交 TASK-028
      在 Accepted 前补齐，且项目/账户路径须经 ADR-0001 授权；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
