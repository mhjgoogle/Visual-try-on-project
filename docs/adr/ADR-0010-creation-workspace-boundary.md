# ADR-0010: AI 视频创作工作视窗安全边界与延期策略

- Status: Accepted
- Date: 2026-08-01
- Scope: Creation Workspace 的核心边界；不授权实现
- Related: ADR-0001、ADR-0003、ADR-0004、ADR-0007、ADR-0008
- Requirements: [AI 视频创作工作视窗统一需求](../ai_video_creation_workspace_requirements.md)
- Data readiness: [Creation Workspace 数据可观察性要求](../creation_workspace_data_observability_requirements.md)

## Context

项目长期需要一个跨项目的创作控制台，用于观察、运行、管理、评价和学习。当前
核心 WFM1 尚未完成，如果直接围绕 UI 设计新的状态、数据库或 Provider 调用路径，
会造成第二事实来源、绕过资金安全守门或与现有唯一写入者冲突。

## Decision

1. **独立表现层**：Creation Workspace 是核心工作流之上的客户端/表现层，不是
   新 Orchestrator，不拥有 Provider 生命周期，也不替代现有 CLI。
2. **唯一命令路径**：所有变更命令必须经未来的 Command Gateway，复用审批、预算、
   版本、并发、恢复和防覆盖检查，再进入 Workflow Orchestrator 应用边界；工作
   视窗永不直接调用 Provider。
3. **唯一写入者不变**：工作视窗不得直接修改项目核心业务文件。状态变化继续由
   Orchestrator 应用边界内的现有指定组件写入；Provider 继续不写业务状态。
4. **可重建观察层**：进度、谱系、成本、评价和跨项目视图是权威文件/事件的派生
   projection。未来可采用索引或数据库，但其损坏或删除后必须可重建，不得成为
   第二事实来源。
5. **独立运行**：核心执行和恢复不依赖工作视窗进程存活。关闭界面不得取消、暂停
   或破坏已提交工作。
6. **版本绑定**：反馈、Action 和高风险命令至少绑定 `ref + version +
   content_digest`；绑定过期时 fail-closed。高风险命令必须在执行前展示输入、
   预计成本与下游影响并二次确认。
7. **状态域分离**：Action/评价/实验状态不得复用工作流审批、GenerationTask、
   StepManifest、Provider 或 reservation 状态。
8. **先核心后界面**：当前 WFM1 任务只保留未来观察所需的稳定身份、版本、谱系、
   成本和审计证据，具体语义责任按数据 readiness 文档分配，不提前实现 UI 专用抽象。

## Deferred

- UI 形态与技术栈；
- Command Gateway 的协议、部署和精确 API；
- projection/index/database 技术；
- Action、评价、实验、提示词版本和知识库 schema；
- pause/cancel/skip 的精确语义；
- 实施任务编号和工作视窗里程碑。

以上内容必须在核心工作流稳定后通过聚焦任务卡和必要 ADR 决定。

## Consequences

- 现有文件式核心、CLI、Provider、QCD、恢复和防覆盖能力可直接复用；
- 历史任务中的“本任务不做 Web UI/数据库”继续是有效的局部范围声明，不构成
  对未来 Creation Workspace 的永久禁止；
- 当前不修改任何冻结合同，不创建工作视窗代码，不声明需求已实现；
- 后续只读观察层可以先落地，写操作必须等待统一命令/状态合同和 Gateway 设计。
