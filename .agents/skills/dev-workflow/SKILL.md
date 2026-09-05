---
name: dev-workflow
description: >-
  Software Development Operating Skill — the single entry point for any
  development request. INVOKE at the START of any task that will change code
  or behavior: new feature / enhancement, bug fix or debugging, refactor or
  cleanup, performance optimization, dependency or schema or framework
  migration, and requirement changes to already-shipped features. It first
  places the idea on one of six levels (Mission / Strategy / Milestone /
  Requirement / Solution / Implementation) and runs the Current Milestone Gate
  — an idea that serves no current milestone goes to the backlog INSTEAD of
  being built. Then it routes the task to the right internal workflow,
  establishes requirement understanding and confirmation, picks the process
  depth, creates and maintains the Requirement / Change records, decides
  verification scope, and runs the convergence check before finishing. DO NOT
  invoke for: answering questions, explaining code, pure conversation, or
  running the review loop by itself (that is codex-review-loop, which this
  skill calls at the right moment).
---

# dev-workflow

**这是入口，不是实现。** 这个技能的规范源是仓库里的：

    .claude/skills/dev-workflow/SKILL.md

**先完整读那份文件，再按它说的做。** 这里不复制它的正文、`references/` 或
`scripts/` —— 复制多少字，就是往后要对齐多少字（[ADR-0097](../../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md) 决策 1）。

<!-- 由 .claude/tools/agent_harness.py apply 生成，台账在 .claude/agent-entries.json。
     不要手改：手改会被 check 当场发现并拒绝覆盖，你的改动不会丢，但也不会生效。
     要改内容，改上面那份规范源。 -->
