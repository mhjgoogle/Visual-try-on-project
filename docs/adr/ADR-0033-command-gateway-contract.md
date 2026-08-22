# ADR-0033: Creation Workspace Command Gateway 合同

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-030
- Implementation scope: TASK-030～TASK-033、TASK-038～TASK-040
- Hard gate: TASK-023 completed and WFM1 milestone review passed
- Depends on: ADR-0010（Accepted）、ADR-0031（Accepted）
- Preserves: ADR-0010、Provider/Orchestrator/预算/审批/恢复冻结合同

## Context

工作视窗最终需要运行、重试、选择、审批和继续流程。如果每个按钮或 CLI 命令直接
调用 Provider、Orchestrator 内部或业务写入器，就会绕过版本绑定、预算、审批、并发
和防重复付费合同，形成第二写入者与旁路风险。本 ADR 在以下既定约束之内裁决变更
命令进入核心的**唯一应用路径类别**（不含最终协议/传输与最终 schema）：

- ADR-0010 决策 2：所有变更命令必须经未来的 Command Gateway，复用审批、预算、
  版本、并发、恢复和防覆盖检查，再进入 Workflow Orchestrator 应用边界；工作视窗
  永不直接调用 Provider。本 ADR 即该 Gateway 的合同裁决。
- ADR-0010 决策 3：唯一写入者不变——状态变化继续由 Orchestrator 应用边界内的既有
  指定组件写入；Provider 继续不写业务状态；Gateway 不得成为第二业务写入者。
- ADR-0010 决策 5：核心执行与恢复不依赖工作视窗进程存活；关闭界面不取消/暂停/
  破坏已提交工作。
- ADR-0010 决策 6：反馈、Action 和高风险命令至少绑定 `ref + version +
  content_digest`，绑定过期时 fail-closed；高风险命令须在执行前展示输入、预计成本
  与下游影响并二次确认。
- ADR-0030：分阶段交付与门槛；写能力受 TASK-023 完成且 WFM1 milestone review 通过
  的硬门槛约束。
- ADR-0031（Accepted）：带版本的只读 query contract 提供 preflight 所需的只读事实；
  projection 只读、不写回、不持凭据，Gateway 不复用它作为写路径。

本 ADR 不接入任何真实写命令：TASK-030 状态卡明确「不得提前接入真实写命令」，
生产实现受上述硬门槛约束。

## Required Decision Properties

Gateway 合同须同时满足以下属性（下文候选按此评估）：

- **P1 唯一写路径**：所有写命令只有一条应用入口，客户端无法绕过（ADR-0010 决策 2）。
- **P2 唯一写入者不变**：只调用已批准 application/Orchestrator 入口，不直连 Provider、
  不直接写业务文件（ADR-0010 决策 3）。
- **P3 版本绑定 fail-closed**：命令绑定 `ref + version + content_digest`，stale/漂移
  即拒绝，绝不静默覆盖（ADR-0010 决策 6、约束 13）。
- **P4 高风险 preflight + 二次确认**：先只读 preflight 展示输入/成本/下游影响，再要求
  绑定 preflight digest 的二次确认（ADR-0010 决策 6）。
- **P5 幂等/恢复/防重复付费**：重复与并发命令去重，submit 前后故障不重复付费，
  unknown side effect 不自动重放。
- **P6 生命周期分离且 CLI/Workspace 共享**：Gateway 不拥有核心执行生命周期，关闭
  客户端不影响核心；CLI 与 Workspace 复用同一 application API（ADR-0010 决策 5）。
- **P7 本地单用户最小安全模型**：未审批/超预算/provider unavailable/已运行/注册表外/
  ambiguous 全部 fail-closed，无远程多用户假设。

## Candidates

1. **统一 Gateway application service（进程内应用层 chokepoint）**：定义一套与传输
   无关的 Gateway application API 作为唯一写入口；CLI 与 Workspace backend 共享同一
   API 并在各自进程内调用；Gateway 集中执行 preflight/审批/预算/版本绑定/并发/幂等/
   确认/防重复付费，再进入既有 Orchestrator 应用边界。
2. **独立本地 Gateway 常驻服务**：Gateway 作为单独 loopback 服务进程常驻，所有客户端
   经本地协议（HTTP/IPC）提交命令。集中检查同样成立，但引入常驻进程生命周期、协议/
   序列化边界与本地监听面，且 WSM1 阶段尚无写端点，属过早锁定传输。
3. **各客户端直连应用边界（无统一 Gateway）**：CLI/Workspace 各自调用
   approval/budget/orchestrator 入口。作为对照淘汰项——直接违反 ADR-0010 决策 2 的唯一
   命令路径，产生绕过风险、检查逻辑复制与多写入者隐患。

## Candidate Evaluation

对照 Required Decision Properties（P1–P7）评估。✅ 满足良好，△ 可满足但有代价，
⚠ 明显受限或违约。

| 属性 | P1 唯一写路径 | P2 唯一写入者/不直连 Provider | P3 版本绑定 fail-closed | P4 preflight+二次确认 | P5 幂等/恢复/防重复付费 | P6 生命周期分离+CLI/Workspace 共享 | P7 本地最小安全模型 |
|---|---|---|---|---|---|---|---|
| 统一 Gateway application service | ✅ 单一 application API 为唯一写入口，客户端无从旁路 | ✅ 只调已批准 application/Orchestrator，绝不直连 Provider | ✅ 绑定检查集中在一处强制 | ✅ 集中生成 preflight 并绑定 digest 二次确认 | ✅ 幂等键/durable receipt 单一写入者、原子发布、unknown 不重放 | ✅ 不持有核心执行生命周期，CLI 与 Workspace 共享同一进程内 API | ✅ 无网络面，最小 actor 模型即可 fail-closed |
| 独立本地 Gateway 常驻服务 | ✅ 也可为唯一路径 | ✅ | ✅ | ✅ | △ receipt 唯一写入者仍成立，但常驻进程多一处崩溃/恢复面 | △ 多一个需独立运行/恢复的常驻生命周期；WSM1 尚无写端点，过早 | △ 引入本地监听面（origin/CSRF/鉴权），单用户下收益不明、成本更高 |
| 各客户端直连（无 Gateway） | ⚠ 违反 ADR-0010 决策 2，客户端可绕过、易漏检查 | ⚠ 多写入者风险，检查逻辑分散复制 | ⚠ 绑定分散、易不一致 | ⚠ 确认逻辑各自实现、难保证 | ⚠ 幂等/防重放无统一收口 | △ 无独立进程但耦合分散 | ⚠ 准入分散、fail-closed 难保证 |

## Proposed Decision（待独立审查后 Accept）

采用 **统一 Gateway application service** 类别：定义一套**与传输无关的 Gateway
application API**，作为所有写命令进入核心的**唯一应用路径**。CLI 与未来 Workspace
backend 共享同一 API（进程内调用），Gateway 在其中集中执行 preflight、审批、预算、
版本绑定、并发、幂等、二次确认与防重复付费检查，只调用已批准的
application/Orchestrator 入口，永不直连 Provider、永不成为第二业务写入者。理由：
唯一在全部 P1–P7 上均为 ✅ 的候选；把 ADR-0010 决策 2/3/6 的检查收口到单一 chokepoint，
天然满足唯一写路径与唯一写入者；不引入常驻服务进程与本地监听面，避免过早锁定
HTTP/IPC 传输；CLI 与 Workspace 共享同一 application API，既复用又不复制。独立常驻
服务与「无 Gateway 直连」分别带来过早的传输/生命周期负担与直接的边界违约。

### Decided here（本 ADR 裁决）

- **路径类别**：统一 Gateway application service = 与传输无关的唯一写命令应用入口，
  集中做全部准入检查后进入既有 Orchestrator 应用边界。
- **唯一命令路径（P1，ADR-0010 决策 2）**：所有写命令只有此一条应用入口；不存在
  客户端直连 Provider、Orchestrator 内部或业务写入器的旁路。
- **唯一写入者不变（P2，ADR-0010 决策 3）**：Gateway 只调用已批准 application/
  Orchestrator 操作；Provider 继续不写业务状态；Gateway 自身除其 durable
  receipt/outcome 外不写业务文件，该产物须有唯一写入者并原子发布。
- **版本绑定 fail-closed（P3，ADR-0010 决策 6）**：每条写命令绑定目标
  `ref + version + content_digest`；stale/digest 漂移即拒绝，绝不静默覆盖。
- **preflight 与二次确认（P4，ADR-0010 决策 6）**：Gateway 先产出只读 preflight，
  展示输入、预计成本、阻断原因与下游影响；高风险命令须提交绑定 preflight digest 的
  二次确认，确认过期或影响摘要变化即拒绝。
- **幂等/恢复/防重复付费（P5）**：重复与并发命令经幂等键去重；submit 前后故障不导致
  重复付费；unknown side effect 禁止自动重放，转 ambiguous/人工处理；command
  receipt/outcome 可恢复、可审计。
- **fail-closed 准入（P7）**：未审批、超预算、provider unavailable、已有运行、命令
  注册表外、ambiguous 一律拒绝，不猜测；路径/secret/异常须脱敏。
- **生命周期分离与共享（P6，ADR-0010 决策 5）**：Gateway 不拥有核心执行生命周期；
  关闭 Workspace/客户端不取消、暂停或破坏已提交工作；CLI 与 Workspace 复用同一
  Gateway application API。
- **最小暴露**：命令注册表只注册已批准 application/Orchestrator 操作；pause/cancel/skip
  仅当核心合同明确支持时才暴露，不能由 UI 伪造。

### Not decided here（延期至 TASK-030 Accepted 设计或后续 ADR）

- **最终传输/部署形态**：进程内 adapter vs 独立本地服务、HTTP vs 本地 IPC vs 纯进程内
  调用（须满足上面唯一路径 + 边界 + fail-closed 约束）；
- 命令 envelope、preflight、confirmation、receipt/outcome 的最终 API 与 schema、
  字段名；`command_id`/幂等键/digest 的具体类型与编码；
- durable command receipt/outcome 的精确路径、保留期、目录、原子发布与重建/恢复的
  实现（任何落入项目/账户持久路径者须由 ADR-0001 明确授权）；
- 同步/异步提交、轮询与取消的最终边界；
- preflight 与确认 token 的有效期具体值与失效判定实现；
- actor、权限与本地单用户安全模型的具体实现；
- CLI 与 Workspace 共享同一 Gateway application API 的落地形式与模块/Python 类型/
  数据库选型；
- 远程多用户、RBAC、分布式队列、跨主机锁与 Provider 厂商取消计费策略。

## Security & Boundary Invariants（下游 030～033/038～040 必须遵守）

1. **唯一写路径**：所有写命令必经 Gateway application API → Orchestrator 应用边界；
   无任何旁路；Workspace/CLI 永不直连 Provider、不直接写业务文件。
2. **唯一写入者不变**：Gateway 只调用已批准 application/Orchestrator 入口；Provider
   继续不写业务状态；Gateway 除自有 durable receipt/outcome（唯一写入者、原子发布）
   外不成为第二业务写入者。
3. **版本绑定 fail-closed**：每条写命令绑定 `ref + version + content_digest`；stale/
   漂移即拒绝，绝不静默覆盖已有生成结果。
4. **高风险二次确认**：先只读 preflight（输入/预计成本/阻断原因/下游影响），再要求
   绑定 preflight digest 的二次确认；确认过期或摘要变化即拒绝。
5. **幂等与恢复**：重复/并发 command 去重；submit 前后故障不重复付费；unknown side
   effect 禁止自动重放，转 ambiguous/人工。
6. **fail-closed 准入**：未审批/超预算/provider unavailable/已运行/注册表外/ambiguous
   全部拒绝，不猜测；路径/secret/异常脱敏。
7. **生命周期分离**：Gateway 不拥有核心执行生命周期；关闭 Workspace/客户端不取消/
   暂停/破坏已提交工作（须守卫测试）。
8. **最小暴露**：命令注册表只含已批准操作；pause/cancel/skip 仅在核心合同支持时暴露，
   不由 UI 伪造。

## Consequences

- 复用既有审批、预算、版本、并发、恢复与防覆盖能力，无需新执行层或第二写入者；
- 把 ADR-0010 决策 2/3/6 的检查收口到单一应用 chokepoint，唯一写路径与唯一写入者
  在合同层即被固定；
- 选定路径类别但不锁死传输（进程内 vs 本地服务、HTTP vs IPC）与最终 schema，为
  TASK-030 Accepted 设计留出空间；
- CLI 与 Workspace 共享同一 Gateway application API，写能力可在门槛通过后统一落地，
  界面按钮（TASK-031）只调用此 API，不发明新写路径；
- durable receipt/outcome 引入一处需唯一写入者与原子发布的持久产物，其路径与恢复
  规则留待 TASK-030 Accepted 设计并受 ADR-0001 授权约束。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 裁决只落类别层（统一 Gateway application service 作为唯一写路径），未选定
      HTTP/IPC/进程内的最终传输，未定最终命令/preflight/receipt schema 与字段名/
      目录/Python 类型/DB，未创建 Gateway 代码；
- [ ] 与 ADR-0010 决策 2/3/5/6 一致：唯一命令路径、唯一写入者不变、生命周期分离、
      版本绑定 fail-closed 与高风险二次确认均在合同层固定；
- [ ] 未授权接入任何真实写命令；实现受 TASK-030 硬门槛（TASK-023 完成 + WFM1
      milestone review 通过）约束；
- [ ] 幂等/并发/unknown side effect/防重复付费/fail-closed 准入语义明确；
- [ ] durable receipt/outcome 的精确路径、唯一写入者、原子发布与恢复留待 TASK-030
      Accepted 设计，且任何项目/账户持久路径须经 ADR-0001 授权；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
