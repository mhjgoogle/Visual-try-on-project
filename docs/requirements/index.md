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
- [REQ-002](REQ-002-document-lifecycle.md) — CONFIRMED — 文档与记录的统一
  生命周期：当前事实精简、历史可追溯、完成记录不进默认上下文
  （TASK-107 / ADR-0087）
- [REQ-003](REQ-003-traceability-and-requirement-fulfillment-review.md) — CONFIRMED — 从产品意图到验证的追溯链，审查先答「声称完成的需求真的完成了吗」
  （TASK-108 / ADR-0088）
- [REQ-004](REQ-004-three-pane-shell-and-agent-conversation.md) — CONFIRMED — 全站统一三栏（左控制/选择 · 中工作区 · 右 Agent 对话），右栏是真正的对话框
  （TASK-109）
- [REQ-005](REQ-005-remove-a-project-from-the-home-list.md) — CONFIRMED — 主页可以把项目从列表里删除（只删列表，文件他自己删）
  （TASK-110 / ADR-0090）
- [REQ-006](REQ-006-agent-can-do-what-the-creator-can-do.md) — CONFIRMED — 对话里的 Agent 能做创作者能做的事，并把意见带回给开发
  （TASK-114 / ADR-0089 决策 7、8）
- [REQ-007](REQ-007-say-it-and-the-right-capability-runs.md) — CONFIRMED — 他说一句话，对的那个专业能力就跑起来：前端 Agent 只认三类工作，
  选哪个专业能力由服务端确定性地决定（TASK-119 / ADR-0091）
