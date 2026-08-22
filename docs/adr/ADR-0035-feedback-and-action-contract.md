# ADR-0035: Feedback 与 Action 合同

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-029
- Implementation scope: TASK-029、TASK-031～TASK-033、TASK-039、TASK-040
- Depends on: ADR-0034 Accepted
- Preserves: ADR-0010（决策 2/3/6/7）、ADR-0033 Command Gateway、Provider/审批/GenerationTask/reservation 冻结合同
- Requirements: [AI 视频创作工作视窗统一需求](../ai_video_creation_workspace_requirements.md)（4.1 问题反馈与 Action、4.2 Action Center）
- Data readiness: [Creation Workspace 数据可观察性要求](../creation_workspace_data_observability_requirements.md)

## Context

用户需要从阶段、步骤、提示词、图片、视频、音频、成片、成本事件或错误事件创建
问题反馈，并由 Agent 或执行系统处理后返回新版本，形成「发现问题 → 反馈/Action →
处理 → 返回新版本 → 用户验证 → 确认解决或继续修改」的闭环（需求 4.1/4.2）。本
ADR 在以下既定约束之内裁决 **反馈与 Action 的领域边界与生命周期语义**（不含最终
schema、持久化路径与 Gateway 协议）：

- ADR-0010 决策 2（唯一命令路径）：所有变更命令须经未来 Command Gateway，复用
  审批、预算、版本、并发、恢复和防覆盖检查，再进入应用边界；Workspace 永不直接
  调用 Provider。Gateway 本身由 ADR-0033 裁决，不在此定义。
- ADR-0010 决策 3（唯一写入者不变）：Workspace 不直接修改核心业务文件；Action 不
  得成为绕开既有唯一写入者的第二写入者。
- ADR-0010 决策 6（版本绑定 + 二次确认）：反馈、Action 和高风险命令至少绑定
  `ref + version + content_digest`；绑定过期时 fail-closed；高风险命令执行前须展示
  输入、预计成本与下游影响并二次确认。
- ADR-0010 决策 7（状态域分离）：Action 状态不得复用工作流审批、GenerationTask、
  StepManifest、Provider 或 reservation 状态。
- ADR-0030：分阶段交付与门槛；WSM2 反馈/Action 与写操作实现须等待 TASK-023 通过，
  此前相关 UI 只能只读。
- ADR-0031（Accepted）：Action 引用的目标（提示词、产物、成本、错误、评价对象）
  经带版本的只读 query contract 观察；content digest 是版本绑定的确定性依据。
- ADR-0034：evaluation/experiment/decision 是独立事实；Action 可从评价对象派生，
  但不得复制或替代既有审批/QC/评价事实。

## Candidates

1. **合并「反馈即 Action」单记录模型**：一条记录同时承载问题描述与处理承诺，不区
   分 feedback 与 action。
2. **复用工作流状态承载 Action**：Action 复用审批/GenerationTask 状态机与既有写入
   器，由 Workspace 或 Agent 直接驱动处理。
3. **反馈与 Action 分离 + 版本绑定 fail-closed + 独立状态域 + 经 Gateway 应用**
   （选定）：feedback 描述问题，action 描述受控处理承诺；两者绑定
   `ref + version + content_digest`；Action 拥有独立状态域；一切写入经 Command
   Gateway（ADR-0033）应用；Agent 只经受控接口处理。

## Candidate Evaluation

对照 Required Decision Properties（P1–P6）评估。✅ 满足良好，△ 可满足但有代价，
⚠ 明显冲突。

| 属性 | P1 唯一命令路径（经 Gateway、不直连 Provider、不做第二写入者） | P2 版本绑定 fail-closed（ref+version+digest，漂移 stale） | P3 状态域分离（不复用审批/任务/Provider/reservation） | P4 反馈↔Action 分离与问题→处理→验证闭环 | P5 可重建 + 凭据隔离（派生自权威事实，凭据/私有 URL 不入） | P6 Agent 边界（受控接口，无任意文件写权限） |
|---|---|---|---|---|---|---|
| 1. 合并单记录模型 | △ 仍可经 Gateway，但问题与承诺同体易诱导直接写 | △ 可绑定，但无处理的纯反馈被迫携带执行语义 | △ 可独立，但记录语义混淆易漂移到工作流状态 | ⚠ 问题与处理纠缠，反馈无法在无 Action 时独立存在 | △ 可做，但混合记录更易夹带上下文与凭据 | △ 边界可定，但语义不清易被当作可写句柄 |
| 2. 复用工作流状态承载 Action | ⚠ 复用既有写入器即绕过 Gateway 与版本绑定守门 | △ | ⚠ 直接违反 ADR-0010 决策 7 状态域分离 | △ | ⚠ 与既有唯一写入者/审批事实耦合，形成第二来源风险 | ⚠ Agent 直接驱动工作流状态，越权 |
| 3. 分离 + 版本绑定 + 独立状态域 + 经 Gateway（选定） | ✅ 一切写入经 Command Gateway，Workspace 不直连 Provider、不做第二写入者 | ✅ 绑定 ref+version+content_digest，digest 漂移自动 stale，fail-closed | ✅ Action 独立状态域，与审批/任务/Provider/reservation 分离 | ✅ feedback 与 action 分离，闭环各环节可追溯 | ✅ Action 是经受控入口的权威事实，凭据/私有 URL 不入 | ✅ Agent 只经仓库任务/受控 application service 处理 |

## Proposed Decision（待独立审查后 Accept）

采用 **候选 3：反馈与 Action 分离 + 版本绑定 fail-closed + 独立状态域 + 经 Command
Gateway 应用**。理由：唯一在全部 P1–P6 上均为 ✅ 的候选；合并模型让纯反馈被迫携带
执行语义、问题与处理纠缠（P4 ⚠）；复用工作流状态直接违反 ADR-0010 决策 7 并绕过
Gateway 守门、形成第二写入者（P1/P3/P5 ⚠）。分离模型使问题可独立记录、处理承诺可
受控应用、闭环可追溯，同时不引入第二事实来源。

### Decided here（本 ADR 裁决）

- **反馈与 Action 分离**：feedback 只描述问题（谁、在哪个对象版本上、发现了什么），
  可在没有任何处理时独立存在；action 描述受控处理承诺（对哪个绑定做什么、当前状态、
  结果）。二者不合并为同一条既描述问题又直接执行的记录。
- **版本绑定与 fail-closed**：feedback、action 与由其派生的高风险命令，至少绑定目标
  的 `ref + version + content_digest` 及自动带入的上下文快照（项目、阶段、步骤、任务、
  Provider/模型、对象版本）。目标 digest 漂移时 Action 自动进入 `stale`；重新执行必须
  创建新绑定或留下显式 rebind 记录，绝不静默作用于错误版本（ADR-0010 决策 6、需求 4.1）。
- **独立状态域**：Action 状态固定为 `pending`、`in_progress`、`waiting_for_user`、
  `completed`、`blocked`、`cancelled`、`stale`，是独立管理语义，不复用工作流审批、
  GenerationTask、StepManifest、Provider 或 reservation 状态（ADR-0010 决策 7、需求 4.2）。
- **唯一命令路径经 Gateway**：Action 触发的任何变更（重跑、修复、返回新版本等）一律经
  Command Gateway（ADR-0033）应用，复用其版本绑定、预算、并发、恢复与防覆盖守门；
  Workspace 永不直连 Provider，Action 不得成为绕开既有唯一写入者的第二写入者
  （ADR-0010 决策 2/3）。本 ADR 不定义 Gateway 协议或 command envelope。
- **处理与验证闭环**：Action 保留问题、处理者（actor=user/Agent/执行系统）、执行记录、
  新旧产物引用、成本变化、验证证据和用户确认，支撑「发现 → 处理 → 返回新版本 → 用户
  验证 → 确认解决/继续修改」闭环；旧 Action 不因 rebind 或新版本被覆盖或冒充已解决。
- **Agent 边界**：Agent 或执行系统只通过仓库正式任务或受控 application service 处理
  handoff，不获得对任意项目文件的写权限，也不绕过核心合同；本 ADR 不引入自动调度。
- **凭据隔离**：credential 与私有 URL 不得进入 feedback/action 记录、日志、异常或
  上下文快照（需求安全约束、ADR-0010 决策 4 派生观察层）。

### Not decided here（延期至 TASK-029 Accepted 前设计或对应 ADR）

- feedback/action 的**精确 schema、字段、枚举取值集合、目录/文件布局、数据类型或
  数据库**；本 ADR 只固定语义与状态名，不锁定存储形态。
- feedback/action 的**持久化路径、唯一写入者、原子状态转移和保留/归档策略**，由
  TASK-029 在本 ADR Accepted 前补齐；若落入项目/账户目录，须由 ADR-0001 授权。
- 合法/非法**状态转换图**的最终定义（cancel、blocked、waiting_for_user、stale/rebind
  的精确前置条件与幂等语义），由 TASK-029 设计。
- **Command Gateway 协议、command envelope、preflight 与确认 token**（ADR-0033）。
- **Agent 调度协议、外部 issue tracker、通知系统、多人分派、权限模型与 SLA**。
- 跨项目 Action 效果聚合/推荐（ADR-0036）与 WFM2 多媒体对象类型的 Action 扩展
  （ADR-0037～0040 Accepted 后由 TASK-039 承接）。

## Security & Boundary Invariants（下游 TASK-029/031～033 必须遵守）

1. **经 Gateway 写入**：Action 触发的任何变更一律经 Command Gateway（ADR-0033）
   应用；Workspace 不直连 Provider、不直接修改核心业务文件、不做第二写入者。
2. **版本绑定 fail-closed**：无有效 `ref + version + content_digest` 绑定不得执行；
   digest 漂移自动 `stale`，stale Action 不能继续执行或冒充已解决，重执行须新绑定或
   显式 rebind 记录。
3. **状态域分离**：Action 状态独立管理，不复用审批、GenerationTask、StepManifest、
   Provider 或 reservation 状态，也不反向驱动这些状态。
4. **反馈可独立存在**：feedback 不依赖 action 而成立；纯反馈不携带执行/写入语义。
5. **凭据零泄漏**：credential、私有 Authorization 与私有 URL 不进入 feedback/action、
   上下文快照、日志或异常。
6. **可重建**：feedback/action 是由受控入口写入的权威事实，其派生视图（Action Center）
   损坏或删除后可从权威事实重建，不成为第二事实来源。
7. **Agent 无越权**：Agent/执行系统只经受控接口处理 handoff，无任意文件写权限；
   query/展示错误 fail-closed，按 ADR-0031 结构化 problem 呈现，不伪装成空数据。

## Consequences

- 复用文件式核心、审批、预算、digest、恢复与防覆盖能力，无需新执行层；Action 写入
  统一收敛到 Command Gateway，避免第二写入者。
- 反馈可先于处理独立记录，问题闭环可追溯，旧决定/旧 Action 不被新版本静默覆盖。
- 只读 Action Center 可先落地（观察既有 feedback/action），写能力等待 ADR-0033
  Gateway 与 TASK-023 门槛。
- 固定语义与状态域但不锁死 schema/路径/DB/状态转换图，为 TASK-029 Accepted 设计与
  ADR-0037～0040 的多媒体扩展留出空间。
- 版本绑定 + stale/rebind 增加实现复杂度，但确保 Agent/执行系统绝不作用于错误版本。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 裁决只落在领域边界与生命周期语义层，未选定最终 schema/字段/目录/类型/DB，
      未定义 Gateway 协议，未写代码；
- [ ] 与 ADR-0010 决策 2/3/6/7、ADR-0033 Gateway 与 ADR-0031 只读合同一致，Action
      经 Gateway、不直连 Provider、不做第二写入者；
- [ ] 版本绑定 `ref + version + content_digest` 与 digest 漂移自动 stale、fail-closed
      语义明确，stale/rebind 不覆盖旧 Action；
- [ ] Action 状态域与审批/GenerationTask/Provider/reservation 分离，reduced/复用被
      明确排除；
- [ ] feedback 与 action 分离、凭据零泄漏、Agent 无越权与可重建姿态明确；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
