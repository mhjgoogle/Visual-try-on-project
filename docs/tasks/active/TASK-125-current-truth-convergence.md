# TASK-125：切片 1 —— 当前事实收口

- 状态：**进行中**（2026-09-04 开卡）
- Workflow：Refactor（文档层）· 深度：STANDARD
- 关联 Requirement：[REQ-004](../../requirements/REQ-004-three-pane-shell-and-agent-conversation.md) v2 判据 1–2 ·
  [REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md) 判据 7
  —— 本卡不改这两条需求的实现，改的是**描述它们的当前事实文档在说谎**这件事
- 技术目标：`docs/current-architecture.md` 指着的 IA 权威、若干 active 任务卡与真实代码
  互相矛盾。下一个 Agent 按它们干活会被带回旧方向 —— 这不是整理癖，是**当前事实类文档
  过期即缺陷**（AGENTS.md 第 24 条 · [ADR-0087](../../adr/ADR-0087-document-lifecycle-and-default-agent-context.md)）
- 架构约束：`CA §3`（前后端合同 · 页面集合那一行）· `CA §6`（Agent 读什么）
- 依据：[产品需求与界面简洁性收敛审查](../../design/active/product-requirement-and-ux-convergence-review.md) §8

## IN SCOPE

1. 把 [创作者产品信息架构](../../design/creator-product-information-architecture.md)
   改成**当前事实**：三空间 / 故事开发四入口 / 剧集制作单画布 / 右栏纯对话，
   并写明它取代了自己哪几段旧描述（取代关系双向）。
2. `docs/current-architecture.md` 的「页面集合」一行跟着改，补上 REQ-004 与
   ADR-0092 / ADR-0094 两条现行权威。
3. TASK-040 的总标题 `Evidence Ready` 拆成**逐条判词**（`PASS` / `PARTIAL` /
   `FAIL` / `NOT_EVIDENCED`），不让一个总词盖住未完成判据。
4. TASK-121 / 122 / 123 / 124 主体已交付 → 剩余事项进 TASK-087 总账，卡进 `done/`。
5. TASK-041 只剩一次需要产品负责人批准花钱的证据、没有 Agent 在做 → 进 `backlog/`。
6. TASK-074 开头给出**唯一一份当前剩余清单**（旧的分段结论保留为历史）。
7. 重新生成 `docs/STATUS.md`，`lifecycle_check` 零发现。

## OUT OF SCOPE

- 不改任何产品代码（切片 2～5 的事）。
- 不删历史 ADR、不改被取代的 REQ 旧版。
- 不把 `workbench` / `provenance` 的内容搬走 —— 那是切片 5（TASK-087 §5.1），
  本卡只如实写出「它们今天还在，且解析到自己」。

## 受影响

| 面 | 文件 |
| --- | --- |
| 当前事实 | `docs/design/creator-product-information-architecture.md`、`docs/current-architecture.md` |
| Change 状态 | `docs/tasks/active/TASK-040/041/074/087/121/122/123/124` |
| 生成物 | `docs/STATUS.md` |

## 验证

- `pytest tests/tooling`（`lifecycle_check` + `test_docs_status` + 仓库结构）
- `python .claude/tools/lifecycle_check.py` → 0 finding
- 纯文档改动，按 AGENTS.md §20 触发表**不调用** `codex-review-loop`

## 实施记录

（做完后逐条填。）
