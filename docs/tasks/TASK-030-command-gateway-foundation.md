# TASK-030：Command Gateway、安全预检与命令回执（WSM2-C）

> **状态：Delivered（2026-08-03）。** 硬门槛已满足：ADR-0033 已 Accepted、TASK-023
> 完成且 WFM1 milestone review 2026-08-02 通过。交付统一 Gateway application service
> 基础——命令注册表（仅批准操作）、target ref+version+digest 绑定 fail-closed、只读
> preflight + 绑定 preflight-digest 的高风险二次确认、command_id 幂等 + WAL durable
> receipt（并发/崩溃安全、防重复付费、unknown→ambiguous 不重放）、fail-closed 准入；
> 唯一持久产物 `gateway/receipts/log.jsonl`（ADR-0001 第四次增补）。经 codex 5 轮独立
> 审查通过（6 条 blocking 修复）。**未接入任何真实写命令**（stub 测试），真实命令由
> TASK-031/038 注册。TASK-030 是 ADR-0033 的 decision owner。

## 目的

为 CLI 和 Workspace 提供统一、可审计、版本绑定、幂等的命令入口，集中执行审批、
预算、版本、并发、重复付费和恢复检查，而不重写 Orchestrator 或 Provider。

## 输入

- TASK-023 已验收的核心命令/状态和 data readiness；
- TASK-025 query/preflight 能力；TASK-028/029 application services；
- ADR-0010、ADR-0033 与既有资金安全、WAL/CAS、reservation 合同。

## 输出

- Accepted ADR-0033；
- versioned command envelope、preflight、confirmation、receipt/outcome 合同；
- Gateway application service 和 CLI adapter；
- 命令注册表，只注册已批准 application/Orchestrator 操作；
- 幂等、unknown-side-effect、并发、高风险确认和安全测试。

## 修改范围

ADR-0033 授权的新 gateway 模块、现有 CLI 的最小适配、测试与文档。Provider、
Orchestrator、approval、budget 等冻结合同只调用不修改。

## 明确不做

- 不直接调用 Provider、不直接写业务文件；
- 不暴露核心未支持的 pause/cancel/skip；
- 不实现分布式队列、远程多用户、RBAC 或跨主机锁；
- 不实现 Workspace 按钮（TASK-031）。

## 聚焦设计（Command Gateway 合同）

本节是 TASK-030 对 ADR-0033 的聚焦设计产出，只定路径拓扑、边界规格与守卫，不选
最终传输（进程内 vs 本地服务、HTTP vs IPC）、不定最终命令/preflight/receipt schema、
不定字段名/目录/Python 类型/DB、不含代码、不接入真实写命令。裁决结论见
[ADR-0033](../adr/ADR-0033-command-gateway-contract.md)。

- **拓扑**：按 ADR-0033 采用**统一 Gateway application service**——一套与传输无关的
  Gateway application API 作为所有写命令进入核心的**唯一应用路径**；CLI 与未来
  Workspace backend 共享同一 API，Gateway 集中做 preflight/审批/预算/版本绑定/并发/
  幂等/二次确认/防重复付费，再进入既有 Orchestrator 应用边界。
- **边界**：Gateway 只调用已批准 application/Orchestrator 入口，永不直连 Provider、
  不直接写业务文件；除自有 durable receipt/outcome（唯一写入者、原子发布）外不成为
  第二业务写入者；命令注册表只注册已批准操作；pause/cancel/skip 仅当核心合同支持时
  暴露，不由 UI 伪造。
- **不变量**：所有写命令绑定目标 `ref + version + content_digest`，stale/漂移即拒绝、
  绝不静默覆盖（fail-closed）；高风险命令先只读 preflight 展示输入/预计成本/阻断
  原因/下游影响，再要求绑定 preflight digest 的二次确认，过期或摘要变化即拒绝；重复/
  并发命令去重，submit 前后故障不重复付费，unknown side effect 禁止自动重放；未审批/
  超预算/provider unavailable/已运行/注册表外/ambiguous 全部 fail-closed；路径/secret/
  异常脱敏。
- **共享与生命周期**：CLI 与 Workspace 复用同一 Gateway application API；Gateway 不
  拥有核心执行生命周期，关闭 Workspace/客户端不取消/暂停/破坏已提交工作。
- **守卫（须有测试固化）**：无旁路——写命令不经 Gateway 无法进入核心；Gateway 不含
  Provider 直连或直接业务文件写入；stale target/preflight、重复/并发命令、确认过期、
  注册表外操作全部拒绝；关闭客户端不影响核心运行与恢复。
- **留待 Accepted 设计**：最终传输/部署形态、命令 envelope/preflight/receipt 的最终
  API 与 schema、durable receipt/outcome 精确路径与恢复规则（持久路径须经 ADR-0001
  授权）、同步/异步与轮询/取消边界、token 有效期与 actor/权限实现——见 ADR-0033
  「Not decided here」。

## 实施步骤

1. 在 TASK-023 完成并通过 WFM1 milestone review 后接受 ADR-0033，锁定
   command/outcome 和安全语义。
2. 建立命令注册表和 target ref/version/digest 准入。
3. 实现 preflight、下游影响、预算和确认 digest。
4. 实现幂等提交、receipt、poll/recovery 和 ambiguous 处理。
5. 让选定 CLI 命令复用 Gateway，验证行为不回归。

## 测试要求

- stale target/preflight、重复 command、并发 command 和确认过期；
- 未审批/超预算/provider unavailable/已有运行/ambiguous 全部 fail-closed；
- submit 前后故障不导致重复付费；
- 命令注册表外操作拒绝；路径/secret/异常脱敏；
- 原 M1/WFM1 CLI 与断点恢复全量回归。

## 验收标准

- [x] 所有 Gateway 命令均经过统一 preflight 与版本绑定；
- [x] 高风险操作必须二次确认且确认绑定当前影响摘要；
- [x] 重放、并发和未知副作用不重复执行/付费；
- [x] Gateway 只调用既有应用边界；
- [x] 硬门槛已满足（TASK-023 完成 + WFM1 milestone review 2026-08-02 通过）后才开工。
