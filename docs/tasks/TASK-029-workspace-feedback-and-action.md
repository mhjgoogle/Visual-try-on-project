# TASK-029：Feedback、Action 合同与只读 Action Center（WSM2-B）

> **状态：Planned（聚焦设计草案已产出，见下「聚焦设计」；代码实施待 ADR-0035
> Accepted 与相应 gate）。** TASK-029 是 ADR-0035 的 decision owner，本轮已完成聚焦
> 设计并把裁决写入 ADR-0035（Proposed）；生产代码依赖 ADR-0035 Accepted、
> TASK-025/026/028。Gateway 前 feedback/action 仅由批准的 CLI/app service 写入，
> Workspace Action Center 只读。

## 目的

让用户从具体阶段、步骤、提示词、媒体、成本或错误创建版本绑定问题，形成可追踪
Action，并观察处理、新旧产物、成本变化和用户验证闭环。

## 输入

- TASK-028 评价/决定合同与各类 observable refs；
- ADR-0010、ADR-0034、ADR-0035；
- workspace query contract 和统一需求中的 Action 状态。

## 输出

- ADR-0035 裁决及经 ADR-0001 增补授权的持久化路径/唯一写入者；
- feedback/action application service 与安全 CLI；
- Agent/执行系统可消费的版本绑定 handoff 与结果回执边界，不含自动调度；
- Action query、状态筛选、详情和上下文完整性检查；
- 只读 Action Center 页面；
- stale/rebind、处理记录、验证证据和成本变化测试。

## 修改范围

ADR-0035 授权的 feedback/action 模块、CLI、query adapter、只读 UI 与测试；
Agent 集成只定义边界，不授予任意文件写入。

## 明确不做

- 不由 Workspace 直接创建/更新 Action；
- 不实现 Agent 自动调度、外部 issue tracker、通知或多人权限；handoff 仍须通过
  正式任务或受控 application service 处理；
- 不复用审批、GenerationTask、Provider 或 reservation 状态；
- 不实现 Command Gateway 或核心业务修复逻辑。

## 聚焦设计（WSM2-B 反馈与 Action 合同）

本节是 TASK-029 对 ADR-0035 的聚焦设计产出，只定领域边界与生命周期语义，不选具体
schema/字段/目录/类型/DB、不定 Gateway 协议、不含代码。裁决结论见
[ADR-0035](../adr/ADR-0035-feedback-and-action-contract.md)。

- **反馈与 Action 分离**：按 ADR-0035，feedback 只描述问题（谁、在哪个对象版本、
  发现了什么），可在无处理时独立存在；action 描述受控处理承诺（对哪个绑定做什么、
  当前状态、结果）。二者不合并为既描述问题又直接执行的单条记录。
- **版本绑定与 fail-closed**：feedback、action 与其派生的高风险命令至少绑定目标
  `ref + version + content_digest` 及自动带入的上下文快照（项目、阶段、步骤、任务、
  Provider/模型、对象版本）；目标 digest 漂移自动 `stale`，重执行须新绑定或显式
  rebind 记录，绝不静默作用于错误版本。
- **独立状态域**：Action 状态固定为 `pending` / `in_progress` / `waiting_for_user` /
  `completed` / `blocked` / `cancelled` / `stale`，是独立管理语义，不复用工作流审批、
  GenerationTask、StepManifest、Provider 或 reservation 状态。
- **唯一命令路径**：Action 触发的任何变更一律经 Command Gateway（ADR-0033）应用，
  复用版本绑定、预算、并发、恢复与防覆盖守门；Workspace 不直连 Provider、不做第二
  写入者。Gateway 前 Action Center 只读，写入仅由当时已批准的 CLI/app service 承担。
- **处理与验证闭环**：Action 保留问题、处理者（actor=user/Agent/执行系统）、执行
  记录、新旧产物引用、成本变化、验证证据和用户确认，支撑「发现 → 处理 → 返回新
  版本 → 用户验证 → 确认解决/继续修改」；旧 Action 不因 rebind 或新版本被覆盖或
  冒充已解决。
- **Agent 边界与凭据隔离**：Agent/执行系统只经仓库正式任务或受控 application service
  处理 handoff，不获任意项目文件写权限、不绕过核心合同、不含自动调度；credential 与
  私有 URL 不进入 feedback/action、上下文快照、日志或异常。
- **只读 Action Center 信息架构**：统一展示上述状态与问题→处理→验证闭环，标注目标
  绑定与 stale/rebind；query 错误 fail-closed，按 ADR-0031 结构化 problem 呈现，不
  伪装成空数据。
- **延期项（本节不定）**：精确 schema/字段/枚举/目录/DB、持久化路径与唯一写入者、
  原子状态转移与保留策略、合法状态转换图、Gateway 协议与 command envelope、Agent
  调度/外部 tracker/通知/多人分派/SLA，均待 ADR-0035 Accepted 前后按各自 owner 补齐。

## 实施步骤

1. 接受 ADR-0035，锁定反馈/Action 分离、状态和绑定语义。
2. 实现原子、版本绑定的 application service 与 CLI。
3. 实现 stale 检测、显式 rebind、处理/验证记录。
4. 扩展 query 与只读 Action Center。
5. 用产物、成本事件、错误和评价对象覆盖上下文创建。

## 测试要求

- 所有目标类型上下文完整；digest 漂移自动 stale；
- 合法/非法状态转换、cancel、blocked、waiting_for_user；
- 旧 Action 不因 rebind 被覆盖；
- 处理结果、新旧产物、成本变化和验证证据可追溯；
- credential/私有 URL 不进入 Action。

## 验收标准

- [ ] Action 始终绑定精确对象版本且状态域独立；
- [ ] 用户可查看完整问题处理和验证闭环；
- [ ] stale Action 不能继续执行或冒充已解决；
- [ ] Workspace 在 Gateway 前仍为只读；
- [ ] 未授予 Agent 绕过核心合同的写权限。
