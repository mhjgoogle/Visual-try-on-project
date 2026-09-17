---
name: dev-workflow
description: >-
  Route development work from intake through implementation, verification and
  delivery. Use at the start of features, bug fixes, refactors, performance
  work, migrations and development-document maintenance. Claim ownership of a
  shared tree first, apply the current milestone gate, pick depth from
  uncertainty, impact, reversibility and contract change, and keep the
  human-reviewable plane thin by leaving code-level plans in the working
  memory of the agent. Do not use for questions, code explanations, pure
  conversation or a standalone review (use codex-review-loop for that).
---

# dev-workflow

**这是入口，不是实现。** 这个技能的规范源是仓库里的：

    .claude/skills/dev-workflow/SKILL.md

**先完整读那份文件，再按它说的做。** 这里不复制它的正文、`references/` 或
`scripts/` —— 复制多少字，就是往后要对齐多少字（[ADR-0097](../../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md) 决策 1）。

<!-- 由 .claude/tools/agent_harness.py apply 生成，台账在 .claude/agent-entries.json。
     不要手改：手改会被 check 当场发现并拒绝覆盖，你的改动不会丢，但也不会生效。
     要改内容，改上面那份规范源。 -->
