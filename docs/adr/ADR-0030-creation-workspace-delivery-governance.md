# ADR-0030: Creation Workspace 分阶段交付、任务编号与核心门槛

- Status: Accepted
- Date: 2026-08-02
- Scope tasks: TASK-024～TASK-033（WFM1 数据基线）、TASK-039～040（完整流程扩展与最终验收）
- Extends: ADR-0010
- Supersedes: ADR-0010 中“暂不分配实施任务编号”的延期决定；ADR-0010 的安全
  边界、唯一写入者和可重建 projection 决定继续有效
- Requirements: [AI 视频创作工作视窗统一需求](../ai_video_creation_workspace_requirements.md)

## Context

用户已明确决定实现 Creation Workspace，并授权现在规划 ADR 与任务。核心 WFM1
尚在 TASK-020～023 阶段，但需求、信息架构、query 合同和只读原型不必等待
TASK-023 才开始；写能力仍必须等待核心命令和数据 readiness 稳定。

## Decision

1. 工作视窗任务从 `TASK-024` 起，使用独立里程碑 `WSM0`～`WSM3`，不重开
   原 M1/WFM1。
2. **WSM0 Planning（TASK-024）** 可立即开始，只做需求、信息架构、query 合同、
   source mapping 和 ADR 裁决，不实现生产 UI。
3. **WSM1 Observe（TASK-025～027）** 建立可重建只读 projection、只读工作视窗和
   版本/谱系/成本观察。可针对已 Accepted 的 WFM1 source contract 增量开发；
   WSM1 最终验收必须等待 TASK-023 readiness 通过。
4. **WSM2 Evaluate/Manage/Run（TASK-028～031）** 建立评价/实验、反馈/Action、
   Command Gateway 和工作视窗写操作。Command Gateway 与任何界面写操作的实现
   必须等待 TASK-023 通过；此前相关 UI 只能只读。
5. **WSM3 Learn/Baseline Gate（TASK-032～033）** 建立复盘、跨项目指标、经验沉淀、
   证据化推荐，并完成 Workspace-on-WFM1 数据基线的安全/恢复验收；这不是两份
   顶层需求的最终产品验收。
6. 每个里程碑沿用 batch milestone review；实施 Agent 与独立审查者分离。
7. 任务卡可以现在创建为 Planned，但未满足依赖和 Proposed ADR 未 Accepted 时
   不得进入实现。
8. 工作视窗 ADR 使用预留编号 `ADR-0030`～`ADR-0036`，避免与仍在推进的 WFM1
   ADR 顺序冲突；编号间隔不表示存在未记录决策。
9. WFM2/WFM3 完成后，TASK-039 扩展完整多媒体与命令能力，TASK-040 才对
   `ai_shortfilm_pipeline_workflow.md` 与 Workspace 统一需求做最终联合验收。

## Consequences

- 规划和只读技术验证可以与 WFM1 后续任务并行，减少无必要等待；
- 核心 schema 变化只需更新 source adapter，不允许 UI 直接读取或写入业务文件；
- TASK-023 仍是生产级 read model 验收和所有写能力的硬门槛，而不是规划门槛；
- UI 技术、query API、Action schema、Gateway 协议和推荐模型分别由后续 Proposed
  ADR 裁决，不在本 ADR 提前锁定。
