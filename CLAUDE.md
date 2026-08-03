# CLAUDE.md

@AGENTS.md

## Claude Code 专用规则

- 架构变更前必须先提出计划，经用户确认后再实施。
- 不把 Claude 自动记忆（memory）作为正式项目规格；正式规格以仓库文档为准。
- 持久性决策必须记录到仓库文档（docs/），不得只保留在会话或记忆中。
- 未得到用户确认前，不得扩大当前任务的范围。
- Creation Workspace 当前仅以
  `docs/ai_video_creation_workspace_requirements.md`、
  `docs/creation_workspace_data_observability_requirements.md`、ADR-0010 和 ADR-0030
  约束实施。只可执行依赖已满足的 TASK-024～033、TASK-008/034～038（完整短剧
  流程）与 TASK-039～040；对应 Proposed
  ADR 未 Accepted 前，不得选择或实现 UI、数据库、Gateway、Action 或最终 schema。
- 完整短剧流程按 TASK-008/034～038 与 ADR-0037～0040 推进；TASK-033 只验收
  WFM1 数据基线，只有 TASK-040 可以宣告两份顶层需求最终完成。

## 实施纪律

- 任何 feat / fix / refactor 实施任务完成后，必须立即调用 `codex-review-loop`
  skill 完成审查与修复，不得跳过。
- 不得在审查前先行 `git commit`；审查结果（`.claude/tmp/last-review.md`）
  未产出前，不得向用户报告「已完成」。
- codex 不可用时该 skill 会自动回退到独立的 claude 会话审查；此时独立性降级，
  必须在报告中如实注明。
