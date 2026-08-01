# CLAUDE.md

@AGENTS.md

## Claude Code 专用规则

- 架构变更前必须先提出计划，经用户确认后再实施。
- 不把 Claude 自动记忆（memory）作为正式项目规格；正式规格以仓库文档为准。
- 持久性决策必须记录到仓库文档（docs/），不得只保留在会话或记忆中。
- 未得到用户确认前，不得扩大当前任务的范围。
- Creation Workspace 当前仅以
  `docs/ai_video_creation_workspace_requirements.md`、
  `docs/creation_workspace_data_observability_requirements.md` 和 ADR-0010 约束未来
  边界；不得提前分配实施 TASK、选择 UI/数据库技术或设计最终 schema。
