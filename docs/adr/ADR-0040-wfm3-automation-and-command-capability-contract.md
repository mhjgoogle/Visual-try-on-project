# ADR-0040: WFM3 自动化职责与核心命令能力合同

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-038
- Implementation scope: TASK-012、TASK-038～040
- Depends on: TASK-037 WFM2 milestone gate passed、ADR-0033 Accepted
- Must preserve: 人工创作批准、Provider/Orchestrator、预算、恢复、防覆盖和 Gateway 边界
- Workflow I/O source: [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md)

## Context

WFM3 要自动化短剧工作流中的固定重复职责：创建项目、校验阶段、生成任务包、
submit/collect、proxy、QC 与发布打包。Workspace 与自动化脚本还需要一个权威答案：
pause/cancel/skip 等命令是否真实受核心合同支持。若 UI 或每个自动化脚本各自解释
「有哪些命令、合法状态、风险与恢复语义」，就会形成第二套状态机、重复付费风险，
以及绕过审批/预算/版本绑定的旁路。

本 ADR 在 Command Gateway（ADR-0033）之上、以下既定约束之内，裁决 WFM3 **自动化
编排的职责边界**与**核心 command capability 合同的角色**（不定命令/能力的最终
schema）：

- ADR-0010 决策 1/2/3：Workspace 与自动化是核心之上的表现/编排层，不是新
  Orchestrator，不拥有 Provider 生命周期，不直接修改核心业务文件；所有变更命令
  须经 Command Gateway → Workflow Orchestrator 应用边界，永不直连 Provider。
- ADR-0010 决策 6：反馈、Action 与高风险命令至少绑定 `ref + version +
  content_digest`，绑定过期时 fail-closed；高风险命令执行前须展示输入、预计成本与
  下游影响并二次确认。
- ADR-0010 决策 7：Action/评价/实验状态不复用工作流审批、GenerationTask、
  StepManifest、Provider 或 reservation 状态。
- ADR-0033（Depends on）：统一 command envelope、只读 preflight、二次确认、
  durable receipt/outcome、unknown side effect 禁止自动重放，且 pause/cancel/skip
  仅在核心合同明确支持时暴露、不能由 UI 伪造。本 ADR 建立在 Gateway 之上，只引用
  其编号与合同，不重复定义 Gateway。

## Proposed Decision（待独立审查后 Accept）

### Decided here（本 ADR 在合同层裁决）

- **自动化是 Gateway 之上的编排层**：WFM3 自动化只**组合**已批准的 application
  service / Orchestrator 命令，逐条经 Command Gateway（ADR-0033）→ Orchestrator
  应用边界应用，不直连 Provider、不直接写业务文件（ADR-0010 决策 1/2/3）。
- **capability registry 为单一事实来源**：核心以版本化 capability registry 声明命令、
  合法状态、风险与恢复语义；该 registry 与 ADR-0033 Gateway command registry **同源**，
  不建立第二事实来源。每个 capability 必须声明其实现的 step id、输入合同、输出合同、
  Gate 与恢复语义，并绑定 [L0–S7 I/O baseline](../design/workflow-stage-step-io-contract.md)
  中的真实步骤与已批准 application service。
- **未注册即拒绝、漂移即失效**：capability 未在 registry 注册即拒绝执行；发生
  version drift 后旧 capability snapshot 按 ADR-0010 决策 6 fail-closed 失效，不得以
  过期绑定继续自动执行。
- **不发明状态**：pause、vendor cancel、allowlisted skip 默认 unsupported，只有核心
  合同明确定义其计费、状态与下游影响后才暴露；UI 与自动化都不得把 unsupported 操作
  伪造成状态（AGENTS.md 红线；ADR-0033）。
- **不绕过资金与审批安全**：自动组合的每一条命令仍走 Gateway 只读 preflight +
  预算/审批/版本绑定检查，高风险命令须绑定 preflight digest 二次确认，资金安全
  fail-closed；创作/创意判断与最终批准不得被自动替代，由用户完成，人工覆盖优先。
- **自动路由可审计、人工优先**：TASK-012 自动路由输出可审计的决定与理由，默认云
  生产路线，但保持 Provider 中立；人工覆盖优先于自动决定。TASK-011 Local Provider
  为可选升级、非硬依赖。
- **durable receipt 与安全重放**：每个自动职责返回可恢复、可审计的 durable
  receipt/outcome；unknown side effect 禁止自动重放；批量恢复不得破坏已批准资产
  （与 ADR-0033 一致）。
- **状态域分离**：自动化编排自身的状态不复用工作流审批、GenerationTask、
  StepManifest、Provider 或 reservation 状态（ADR-0010 决策 7）。

### Not decided here（延期至 TASK-038 Accepted 设计或后续 ADR）

- capability registry 与 command envelope 的最终协议、字段、能力清单最终形态、
  命令 schema、目录、类型与存储/DB（沿用 ADR-0033，不在本 ADR 定型）；
- WFM3 固定职责到具体命令的最终映射清单的最终形态；
- pause / vendor cancel / allowlisted skip 的精确计费、状态与失效语义的最终裁决
  （结论只能在核心合同已支持的范围内，由 TASK-038 给出）；
- durable receipt/outcome 的精确路径、保留期与重建/恢复边界（由 ADR-0033 与
  ADR-0001 授权，不在此定义）；
- 分布式队列、多用户调度、跨主机锁、无人值守创作批准，以及自动发布到商业平台。

### TASK-038 Must Decide（owner 任务在 Accepted 前锁定）

- WFM3 固定职责到现有/新增命令的映射；
- capability registry 与 ADR-0033 Gateway registry 的唯一来源关系；
- pause、vendor cancel、allowlisted skip 与批量恢复的支持/不支持结论及对抗测试；
- TASK-012 路由、可选 TASK-011 Local Provider 与默认云路线的关系。

## Security & Boundary Invariants（下游 TASK-012/038～040 必须遵守）

1. 自动化只组合已批准命令，经 Gateway → Orchestrator 应用边界应用，绝不直连
   Provider、绝不直接写业务文件。
2. capability registry 与 Gateway command registry 单一事实来源；未注册即拒绝，
   version drift 后旧能力快照 fail-closed。
3. 每条自动命令仍走 Gateway preflight 与预算/审批/版本绑定检查；高风险须二次确认；
   自动化不绕过资金安全，也不重复执行或重复付费。
4. pause/cancel/skip 默认 unsupported，只有核心合同支持时才暴露，不由 UI 或自动化
   伪造成状态。
5. 创作/创意批准与最终批准由用户完成，自动化不替代；人工覆盖优先于自动路由。
6. durable receipt/outcome 可恢复、可审计；unknown side effect 禁止自动重放；批量
   恢复不破坏已批准资产。
7. 自动化编排状态与工作流审批/GenerationTask/StepManifest/Provider/reservation
   状态域分离。
8. 关闭 UI/Gateway 不影响 worker 与核心执行、恢复（须有守卫测试）。

## Consequences

- 复用文件式核心、CLI、Provider、QCD、恢复与防覆盖能力，自动化不新增执行层，只在
  Gateway 之上做受控编排；
- capability 合同一次声明、Gateway 与自动化共用，避免 UI 与脚本各自解释命令而产生
  第二状态机与重复付费；
- 固定为「命令经 Gateway、不发明状态、不绕过审批/预算/版本绑定 fail-closed」的
  红线，但不锁死命令/能力的最终 schema、映射清单与存储，为 TASK-038 Accepted 设计
  留出空间；
- pause/cancel/skip 从无 owner 的模糊态转为「默认 unsupported，支持须由核心合同
  明确定义」的确定态；
- 自动路由引入可审计决定与人工覆盖的双轨，需承担理由留痕与恢复责任。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 合同裁决只落在自动化职责与 capability 合同边界层，未定命令/能力的最终
      schema、字段、映射清单最终形态、目录、类型或 DB，未创建代码；
- [ ] 与 ADR-0010 决策 1/2/3/6/7 及 ADR-0033 一致，命令经 Gateway → Orchestrator，
      未越权重复定义 Gateway，未直连 Provider；
- [ ] pause/cancel/skip 默认 unsupported、不由 UI/自动化伪造的红线明确；
- [ ] 自动化不绕过审批/预算/版本绑定 fail-closed，人工创作批准与覆盖优先明确；
- [ ] capability registry 与 Gateway registry 单一事实来源、未注册即拒绝、version
      drift fail-closed 明确；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
