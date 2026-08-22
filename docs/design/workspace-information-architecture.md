# Creation Workspace 信息架构（WSM0 / TASK-024）

> **状态：Frozen information-architecture baseline，待 ADR-0031 独立审查后
> Accepted。** 本文定义跨项目 Creation Workspace 的**导航结构与页面职责**：每个
> 视图回答什么问题、由哪些查询（见
> [查询合同](workspace-query-contract.md)）支撑、只读还是写、属于哪个里程碑。
> **不做视觉稿、不选 UI 框架、不定义组件、不定义 URL/路由或状态管理**。写能力
> 一律标注为 WSM2 且受 TASK-023 门槛与 Command Gateway 约束——本文只描述职责归属，
> 不在此实现。依据 [ADR-0030](../adr/ADR-0030-creation-workspace-delivery-governance.md)、
> [ADR-0010](../adr/ADR-0010-creation-workspace-boundary.md)。

## 1. 架构原则

1. **跨项目优先**：Workspace 首屏是账户级项目组合，不是单项目工具。
2. **观察与操作分离**：只读观察（WSM1）与受控写操作（WSM2）在信息架构上分层；
   界面关闭不影响核心执行；写操作只经 Command Gateway，不直接调用 Provider 或
   改业务文件。
3. **查询驱动**：每个页面职责映射到一个或多个稳定查询；页面不自行扫描文件、不复制
   事实、不猜测关系。
4. **权威/派生/不可用可见**：页面必须能把 unavailable/legacy 语义显式呈现，不把缺失
   渲染为零或伪造完成。
5. **计划与运行分离**：未运行项目也能展示完整 L0–S7 计划、依赖、预期输入输出和 gate。

## 2. 导航骨架（页面职责，非视觉稿）

| 区域 | 职责（回答什么） | 支撑查询 | 读/写 | 里程碑 |
| --- | --- | --- | --- | --- |
| Portfolio 概览 | 账户下所有项目、当前阶段、成本累计、月度在途、问题计数 | WQ-11、WQ-14、WQ-09 | 只读 | WSM1-B |
| Project 计划视图 | 单项目完整 L0–S7 阶段/步骤计划、依赖、预期 I/O、gate（含未运行） | WQ-01 | 只读 | WSM1-B |
| Project 进度视图 | 当前阶段、整体/阶段进度、运行中/阻塞步骤及 reason | WQ-02、WQ-13 | 只读 | WSM1-B |
| 审批与变更 | 阶段审批状态、锁定 target digest、审批人/时间、失效原因、审计流 | WQ-13 | 只读 | WSM1-B |
| Lineage 谱系视图 | 任意产物向上溯源 + 向下消费者；选择/替代/redo/fallback 关系 | WQ-03、WQ-04 | 只读 | WSM1-C |
| Prompt/创意深钻 | 提示词版本链、差异依据、生成批次、候选/选中、下游产物 | WQ-05 | 只读 | WSM1-C |
| 镜头执行视图 | 镜头全部 attempt/redo/fallback、Provider/model/参数、状态、时间 | WQ-06 | 只读 | WSM1-C |
| 成本深钻 | 按阶段/步骤/镜头/Provider/model/时间的预计/预留/实际/失败重试成本 | WQ-07、WQ-14 | 只读 | WSM1-C |
| 复用资产视图 | 复用资产 ref/version/digest、引用项目、替代关系 | WQ-12 | 只读 | WSM1-B/C |
| 评价与决定 | 评价/终审目标版本绑定、创作目标、结论、理由；创作决定证据 | WQ-08 | 只读 | WSM2-A |
| 问题中心 | 最近错误/QC 问题及其项目/步骤/task/operation/对象上下文 | WQ-09 | 只读 | WSM1-C |
| 重建一致性检查 | projection 删除后确定性重建的验收视图 | WQ-10 | 只读（元） | WSM1 验收 |
| 实验/比较 | 版本/方案横向比较与创作决定（超出 QC 的评价） | 依赖 ADR-0034 新 source | 只读 | WSM2-A（deferred） |
| Action Center | 反馈/受控运行/命令回执（写闭环） | 依赖 ADR-0033/0035 | **写** | WSM2-B/C/D（deferred，受 TASK-023 门槛） |
| 学习/推荐 | 跨项目复盘指标、经验沉淀、证据化推荐 | 依赖 ADR-0036 新 source | 只读 | WSM3-A（deferred） |

## 3. 页面责任细则（只读线，WSM1）

- **Portfolio 概览**：项目发现以账户根下项目 config 存在为准；成本累计按币种分列
  （不跨币种相加），月度在途含跨项目 hold（WQ-14）。损坏项目降级为问题条目，不阻断
  他项。
- **Project 计划视图**：必须无损呈现 I/O 合同层级（查询合同 §5）；诚实区分“已实现
  并有运行事实”“计划定义存在但 WFM1 未执行（unavailable）”，不补造缺失步骤。
- **Project 进度视图 / 审批与变更**：当前状态必须可由权威审批/审计验证；stale 审批
  显式标注失效原因，不隐藏。
- **Lineage / Prompt / 镜头 / 成本 / 问题 / 复用**：全部只读深钻，孤儿产物、digest
  漂移、成本对账不明按 fail-closed 呈现为问题，不静默。
- **重建一致性检查**：呈现 WQ-10 结果，证明删除 projection 后语义等价且过程零写入。

## 4. 写操作与 Action（WSM2 及以后，仅归属声明）

- 评价与决定、实验/比较、Action Center、学习/推荐的**写能力**均属 WSM2/WSM3，
  依赖对应 Proposed ADR（0033/0034/0035/0036）Accepted，且 Command Gateway 与任何
  界面写操作的实现**必须等待 TASK-023 通过**（已于 2026-08-02 通过，门槛解除，但
  实现仍需各自 ADR Accepted 与其前置任务）。
- 本文只声明这些区域在信息架构中的位置与职责边界；**不在 TASK-024 实现**，也不在
  只读查询合同中混入写语义。Action 必须绑定正确对象版本、不复用工作流运行状态、
  经 Gateway 边界应用——这些约束由 ADR-0033/0035 与 TASK-030/031 决定。

## 5. 明确不做（TASK-024 范围）

- 不选 UI 框架、不定义组件/路由/状态管理、不出视觉稿；
- 不实现 projection、query API、页面或 Command Gateway；
- 不定义数据库或搜索索引；
- 不把写操作 / Action 纳入只读合同；
- 不把任何 Proposed ADR 自行标为 Accepted。
