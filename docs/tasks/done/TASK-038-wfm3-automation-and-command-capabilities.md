# TASK-038：WFM3 固定职责自动化与命令能力收口

> **状态：Delivered（合同层，2026-08-04）。** ADR-0040 Accepted 后实施合同层交付：
> `src/ai_video_workflow/automation/`（版本化单一事实来源 capability registry）。
> 交付内容：8 项固定自动化职责（project_create/stage_validate/task_packet/submit/
> collect/proxy/qc/package）作为 capability，每项绑定一个 ADR-0033 Gateway 命令
> （同源 `verify_same_source`，缺一即 SecondSourceError）+ 一个真实 L0–S7 baseline
> step（跨 creative/postproduction catalog + S4 allowlist 校验）+ 输入/输出合同
> 描述 + 恢复语义 + 风险等级 + human_gate 标记；未注册即拒绝、version drift 后
> snapshot fail-closed（ADR-0010 决策 6）；pause/cancel/skip 一律 UNSUPPORTED+依据、
> 不伪造状态。**合同层不含真实 apply handler、TASK-012 路由执行与 CLI**（ADR-0040
> 「Not decided here」/「TASK-038 Must Decide」，留作后续细化）；无新持久路径，
> 无 ADR-0001 增补。TASK-011 Local Provider 仍为可选、非硬依赖。

## 目的

自动化短剧工作流中的重复职责，并形成 Gateway/Workspace 可消费的核心命令能力
注册表，同时保留人工创作判断和资金安全。

## 输入

- WFM2 已验收 application services；TASK-012 自动路由设计；
- [L0–S7 工作层级输入输出合同](../../design/workflow-stage-step-io-contract.md)；
- TASK-030 Gateway 合同；Proposed ADR-0040；
- 工作流 WFM3 固定职责清单和统一命令能力矩阵。

## 输出

- Accepted ADR-0040；
- capability registry 和项目创建、阶段校验、任务包、submit/collect、proxy、QC、
  package 等自动化组合命令；
- capability → step id → input/output/Gate/recovery 的可查询映射；
- TASK-012 可审计路由实施；若可用候选不足则本任务不能完成，只能保持 blocked，
  不得用延期记录替代 WFM3 验收；
- pause/cancel/skip 的支持/不支持裁决和对抗测试；
- WFM3 E2E、恢复、资金安全和人工批准测试。

## 修改范围

ADR-0040 授权的 automation/application/Gateway registry 增量、TASK-012 受控实施、
CLI、测试和文档；核心 Provider/Orchestrator 合同只调用不重写。

## 明确不做

- 不自动形成创意批准、不无人值守发布商业平台；
- 不实现分布式队列、多用户调度或跨主机锁；
- 不把 unsupported 操作伪装成 UI 状态；
- 不要求 TASK-011 Local Provider。

## 聚焦设计（WFM3 自动化职责与命令能力合同）

本节是 TASK-038 对 ADR-0040 的聚焦设计产出，只定自动化编排职责与 command
capability 合同的边界规格，不定命令/能力的最终 schema、字段、映射清单最终形态、
目录、类型或 DB、不含代码。裁决结论见
[ADR-0040](../../adr/ADR-0040-wfm3-automation-and-command-capability-contract.md)。

- **编排定位**：WFM3 自动化是 Command Gateway（ADR-0033）之上的编排层，只**组合**
  已批准的 application service / Orchestrator 命令，逐条经 Gateway → Orchestrator
  应用边界应用；不直连 Provider、不直接写业务文件，不新增执行层（ADR-0010
  决策 1/2/3）。
- **capability 合同边界**：核心以版本化 capability registry 声明命令、合法状态、
  风险与恢复语义，与 ADR-0033 Gateway command registry **同源**，不建立第二事实
  来源；每个 capability 声明其实现的 step id、输入合同、输出合同、Gate 与恢复语义，
  绑定 [L0–S7 I/O baseline](../../design/workflow-stage-step-io-contract.md) 中的真实
  步骤与已批准 application service。
- **固定职责范围**（对应「输出」自动化组合命令）：项目创建、阶段校验、任务包
  生成、submit/collect、proxy、QC 与发布打包，每一项都映射到既有安全 application
  service，只作组合，不重写核心 Provider/Orchestrator 合同。
- **命令安全姿态**：自动组合的每条命令仍走 Gateway 只读 preflight 与
  预算/审批/版本绑定检查；高风险命令绑定 preflight digest 二次确认，资金安全
  fail-closed；capability 未注册即拒绝，version drift 后旧能力快照 fail-closed
  失效（ADR-0010 决策 6）。
- **不发明状态**：pause、vendor cancel、allowlisted skip 默认 unsupported，只有
  核心合同明确定义计费、状态与下游影响后才暴露，UI 与自动化都不得把 unsupported
  操作伪造成状态；本任务对其做支持/不支持裁决而非发明状态（AGENTS.md 红线）。
- **人工优先与自动路由**：创作/创意判断与最终批准由用户完成，自动化不替代；
  TASK-012 自动路由输出可审计决定与理由，默认云生产路线但保持 Provider 中立，
  人工覆盖优先；TASK-011 Local Provider 为可选升级、非硬依赖。
- **状态域分离与恢复**：自动化编排状态不复用工作流审批/GenerationTask/
  StepManifest/Provider/reservation 状态（ADR-0010 决策 7）；每个自动职责返回可
  恢复、可审计的 durable receipt/outcome，unknown side effect 禁止自动重放，批量
  恢复不破坏已批准资产。
- **守卫（须有测试固化）**：自动化不含 Provider 直连或业务文件直接写入；关闭
  UI/Gateway 不影响 worker 与核心执行、恢复。

## 实施步骤

1. 完成 command/capability 设计并接受 ADR-0040。
2. 将每个 WFM3 固定职责映射到既有安全 application service。
3. 实施/收口 TASK-012 可审计自动路由和人工覆盖。
4. 对 pause/cancel/skip 做计费、状态和下游影响裁决。
5. 完成批量恢复、重放、资金安全和人工 gate E2E。

## 测试要求

- capability 未注册即拒绝，版本漂移后旧能力快照失效；
- 自动组合不绕过审批/预算，不重复执行或付费；
- 路由理由可审计，人工覆盖优先；
- UI/Gateway 关闭不影响 worker；全量历史回归通过。

## 验收标准

- [ ] WFM3 列出的固定重复职责均已通过批准 application/Gateway 路径自动化；
- [ ] 创意判断与最终批准仍由用户完成；
- [ ] Gateway 与核心 capability 使用同一事实来源；
- [ ] 每个自动职责均绑定 I/O baseline 中的真实步骤和已批准 application service；
- [ ] pause/cancel/skip 不再处于无 owner 的模糊状态；
- [ ] 自动化失败可恢复且不破坏已批准资产。
