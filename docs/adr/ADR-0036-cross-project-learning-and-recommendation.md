# ADR-0036: 跨项目学习、知识提升与证据化推荐

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-032
- Implementation scope: TASK-032、TASK-033、TASK-039、TASK-040
- Depends on: ADR-0031、ADR-0034、ADR-0035 Accepted
- Change path: 推荐触发的任何变更须经 ADR-0033 Command Gateway，Workspace 永不直连 Provider
- Preserves: ADR-0010（决策 2/3/4/7）、Provider/Orchestrator/预算/审批/恢复冻结合同
- Requirements: [创作工作视窗统一需求 §6 学习层](../ai_video_creation_workspace_requirements.md)
- Data readiness: [数据可观察性要求](../creation_workspace_data_observability_requirements.md)

## Context

项目复盘需要沉淀提示词、模型、镜头模式、检查清单和常见问题（需求 §6.1/6.2/6.3），
并在新项目提供带历史证据的建议。这类学习信号与推荐若被当作独立事实存储、或被
允许自动改动创作选择，就会形成第二事实来源、绕过资金/审批守门，或替代用户判断。
本 ADR 在以下既定约束之内裁决**跨项目学习与推荐的合同边界**（不含最终模型/算法/
schema/存储）：

- ADR-0010 决策 4（可重建观察层）：进度、谱系、成本、评价与跨项目视图是权威文件/
  事件的**派生 projection**，损坏或删除后必须可重建，**不得成为第二事实来源**。
- ADR-0010 决策 2/3（唯一命令路径、唯一写入者不变）：所有变更命令经 Command
  Gateway 复用审批/预算/版本/并发/恢复/防覆盖检查后进入 Orchestrator 应用边界；
  Workspace 不直接写业务文件、永不直接调用 Provider。
- ADR-0010 决策 7（状态域分离）：Action/评价/实验状态不得复用工作流审批、
  GenerationTask、StepManifest、Provider 或 reservation 状态。
- ADR-0031（Accepted）：带版本的只读 query 合同（WQ-01～WQ-14），WSM1 采用
  **on-demand 求值、无持久缓存**；projection 输出排序确定、来源可追踪、可删除重建，
  区分 **authoritative / derived / unavailable/legacy**；source 异常时 fail-closed。
- ADR-0030：分阶段交付与门槛；只读观察/学习设计可提前，生产验收仍受 TASK-023
  约束。ADR-0033/0034/0035 分别裁决 Gateway、评价/实验/决定、Feedback/Action，
  为学习层提供权威事实与唯一写命令路径。

学习层只消费上述权威事实与 ADR-0031 只读查询，本身不产生任何写操作，也不引入
新的持久事实源。

## Required Decision Properties（任何设计必须满足）

- **P1 只读派生、可重建、不作第二事实源**：学习指标与推荐全部从版本化的运行/成本/
  评价/Action 权威事实派生，可删除重建；源事实变化后旧报告明确标为快照。（ADR-0010
  决策 4）
- **P2 状态域分离**：学习/推荐/知识提升状态不复用工作流审批、GenerationTask、
  StepManifest、Provider、reservation 或 Action 运行状态。（ADR-0010 决策 7）
- **P3 推荐不自动写、变更经 Gateway**：推荐只读，不自动修改 profile、Provider 选择、
  预算、prompt 或审批；任何由推荐触发的变更须经 Command Gateway（ADR-0033）并二次
  确认，Workspace 永不直连 Provider。（ADR-0010 决策 2/3）
- **P4 证据化与可追溯**：推荐必带建议、适用条件、历史 evidence refs、样本范围与
  已知限制；派生指标带稳定定义、时间范围与来源。（需求 §6.2/6.3）
- **P5 知识提升须用户确认**：区分“候选经验”与“已提升知识”，提升须用户确认与来源
  digest；用户拒绝的候选不进入已验证知识。
- **P6 数据不足 fail-closed**：样本/证据不足时返回 `unavailable` / `insufficient_evidence`，
  不编造置信度，不隐藏失败案例与不确定性。（ADR-0031 三分标注）
- **P7 不持凭据、不越权**：学习层不持有 Provider 凭据、不训练模型、不选向量库、
  不跨账户共享、不自动优化工作流，不引入持久 projection 路径。

## Candidates

1. **只读派生 analytics + 证据化推荐 + 用户确认知识提升**：学习信号纯粹从版本化事实
   派生，推荐为携带 evidence 的只读输出，知识提升需用户确认，任何变更经 Gateway。
2. **独立持久知识库作为学习事实源**：把复盘/指标/提升知识物化为独立权威存储，供
   推荐直接读取与更新。
3. **自动优化 / 主动写回**：推荐自动应用到 profile / Provider 选择 / 预算 / prompt，
   或自动触发运行以“优化”工作流。

## Candidate Evaluation

对照 Required Decision Properties（P1–P7）评估。✅ 满足良好，△ 可满足但有代价，
⚠ 明显违背。

| 属性 | 候选 1 只读派生+证据化推荐+确认提升 | 候选 2 独立持久知识库为事实源 | 候选 3 自动优化/写回 |
|---|---|---|---|
| P1 只读派生、可重建、不作第二源 | ✅ 全从版本化事实派生、可删可重建 | ⚠ 物化存储成为第二事实来源，违背 ADR-0010 决策 4 | △ 派生可保留但被写回污染来源 |
| P2 状态域分离 | ✅ 独立派生/提升状态，不复用运行状态 | △ 易与运行/Action 状态耦合 | ⚠ 自动写回复用并污染工作流状态 |
| P3 不自动写、变更经 Gateway | ✅ 推荐只读，变更走 Gateway 二次确认 | △ 存储本身只读则可，但诱导直写 | ⚠ 绕过 Gateway/审批/预算，违背决策 2/3 |
| P4 证据化与可追溯 | ✅ evidence refs+范围+条件+限制 | △ 可携带但来源随物化漂移 | ⚠ 自动应用掩盖证据链 |
| P5 知识提升须用户确认 | ✅ 候选/已提升分离，拒绝不入库 | △ 物化易跳过确认 | ⚠ 无确认即生效 |
| P6 数据不足 fail-closed | ✅ 返回 insufficient_evidence，不编造 | △ 缓存旧结论掩盖不足 | ⚠ 以伪结论驱动自动动作 |
| P7 不持凭据、不越权 | ✅ 不训练/不选库/不跨账户/无持久路径 | ⚠ 引入持久路径与存储选型越权 | ⚠ 自动优化越权且不安全 |

## Proposed Decision（待独立审查后 Accept）

采用**候选 1**：跨项目学习为**只读派生 analytics**，推荐为**携带历史证据的只读输出**，
可复用知识通过**用户确认的知识提升**沉淀。理由：唯一在 P1–P7 上均为 ✅ 的候选；
最契合 ADR-0010 决策 4（派生、可重建、不作第二事实源）与决策 2/3（变更经 Gateway、
不直连 Provider）；候选 2 引入持久事实源与存储选型越权、诱导第二来源，候选 3 自动
写回绕过审批/预算并替代用户创作判断，均与需求 §6 和边界相悖。

### Decided here（本 ADR 裁决）

- **只读派生（P1）**：跨项目指标（首次通过率、平均返工、制作时间、项目/单镜头成本、
  质量评分、重复问题、提示词模板成功率、Action 解决率等）全部从版本化的运行、成本、
  评价与 Action 权威事实派生，带稳定定义、时间范围和来源 refs；可删除重建；源事实
  变化后派生指标/推荐可重建，旧报告明确标为**快照**。派生层不修复、不写回业务状态。
- **候选经验 vs 已提升知识分离（P5）**：“候选经验”从证据自动浮现，“已提升知识”须
  经**用户确认 + 来源 digest**方可成为可复用知识；用户拒绝的候选不进入已验证知识，
  也不影响权威事实。
- **证据化推荐（P4）**：推荐返回建议、适用条件、历史 evidence refs、样本范围与已知
  限制；覆盖需求 §6.3 的相似项目、模板、Provider/模型、风险、预算与检查项，但只作
  建议，不自动替代用户创作决定。
- **推荐只读、变更经 Gateway（P3）**：推荐不自动修改 profile、Provider 选择、预算、
  prompt 或审批；任何由推荐触发的变更须封装为 ADR-0033 Command Gateway 的 command
  envelope，经只读 preflight 与版本绑定二次确认后由已批准 application service 应用；
  Workspace 永不直连 Provider、不持有凭据。
- **状态域分离（P2）**：学习/推荐/知识提升状态独立，不复用工作流审批、GenerationTask、
  StepManifest、Provider、reservation 或 Action 运行状态。
- **三分标注与 fail-closed（P6）**：延续 ADR-0031，派生结果区分 authoritative / derived /
  unavailable；数据/证据不足返回 `unavailable` / `insufficient_evidence`，不编造置信度、
  不隐藏失败案例与不确定性。
- **边界姿态（P7）**：学习层不持凭据、不训练模型、不跨账户共享，遵循 ADR-0031 WSM1
  on-demand、无持久缓存；本 ADR 不引入任何持久 projection/知识存储路径。

### Not decided here（延期至 TASK-032 Accepted 设计或后续 ADR）

- 向量数据库、embedding、推荐算法、模型训练、跨账户共享、自动工作流优化；
- 具体指标 schema/字段名、知识/推荐数据结构、目录与 Python 类型、DB/存储产品；
- 知识提升事实与派生快照的**精确路径、唯一写入者、来源失效与重建规则**——由
  TASK-032 在本 ADR Accepted 前补齐；
- **持久 projection/知识存储路径**：ADR-0031 WSM1 为 on-demand、无持久缓存，本 ADR
  不引入任何持久路径；如后续证明必须物化，须回到后续 ADR 锁定路径/生命周期/原子
  替换/唯一写入者，且任何项目/账户持久路径须由 ADR-0001 明确授权；
- Command Gateway 协议与 Action schema（由 ADR-0033/0034/0035 裁决）；UI 布局与视觉。

## Security & Boundary Invariants（下游 032/033/039/040 必须遵守）

1. **派生只读**：学习指标/推荐只从 ADR-0031 公开查询合同与授权权威事实派生，不写
   业务状态、不修复数据、不持凭据。
2. **不作第二事实源**：源事实变化后派生结果可删除重建；旧报告标为快照；source
   损坏/缺失/证据不足时 fail-closed，返回结构化 unavailable/insufficient_evidence，
   不伪装成空数据或伪结论。
3. **状态域分离**：学习/推荐/知识提升状态与工作流审批、GenerationTask、StepManifest、
   Provider、reservation、Action 运行状态相互独立，不复用。
4. **推荐不自触发写**：任何由推荐引出的变更经 Command Gateway command envelope +
   preflight + 版本绑定二次确认后应用；Workspace 永不直连 Provider。
5. **证据化**：推荐必带 evidence refs、样本范围、适用条件与已知限制；派生指标带
   稳定定义与时间范围。
6. **知识提升须用户确认**：候选经验与已提升知识分离；用户拒绝的候选不进入已验证
   知识；提升记录来源 digest。
7. **不越权**：不训练模型、不选向量库/DB、不跨账户共享、不自动优化工作流、不引入
   持久 projection/知识存储路径。

## Consequences

- 复用 ADR-0031 版本化查询合同与既有权威事实，无需新事实源或新执行层；
- 学习/推荐只读层设计可先落地，写能力等待 ADR-0033 Gateway 与 TASK-023 门槛；
- 裁决合同边界但不锁定模型/schema/算法/DB/持久路径，为 TASK-032 Accepted 设计与
  后续演进留出空间；
- 推荐承担解释与证据责任：须显式给出 evidence refs、样本范围与限制，数据不足时以
  insufficient_evidence 呈现，不得输出伪置信度或自动动作。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 跨项目指标全部可追溯到权威事实、定义稳定且可删除重建，未成为第二事实来源；
- [ ] 候选经验与已提升知识分离，知识提升须用户确认并记录来源 digest；
- [ ] 推荐带 evidence refs / 样本范围 / 适用条件 / 限制，数据不足返回
      insufficient_evidence，不编造置信度；
- [ ] 推荐只读、不自动写；任何变更经 Command Gateway，Workspace 不直连 Provider；
- [ ] 学习/推荐状态与工作流/Action/审批/Provider/reservation 状态域分离；
- [ ] 未定模型/schema/算法/DB/持久 projection 路径，未越权 Accept 下游 ADR；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
