# Requirement Records

轻量需求记录：一个需求一个文件（`REQ-NNN-slug.md`），记录**为什么要做、
用户真正要什么**，不记实现方案。格式、状态机（DRAFT / CONFIRMED /
SUPERSEDED）与版本修订规则见
[dev-workflow Skill 的 records 参考](../../.claude/skills/dev-workflow/references/records.md)；
机制决策见 [ADR-0076](../adr/ADR-0076-dev-workflow-operating-skill.md)。

- **存量需求不回填**：既有需求继续由 `docs/product_spec.md`、两份顶层需求
  文档与任务卡「依据」行承载。某条存量需求发生**变化**时才为它建 REQ，
  v1 指回原始出处，此后以 REQ 文件为准。
- 追溯：`REQ → TASK / commit → 代码 → 测试`，双向引用。
- Agent 建 REQ 时在下方索引加一行；状态变化时同步更新该行。

## 索引

- [REQ-001](REQ-001-auto-push.md) — CONFIRMED — Task 完成后自动 commit/push，
  Change 完成后受控合并（TASK-101 / ADR-0079）
