---
name: skill-evolution
description: >-
  Controlled Skill Evolution — collect ultra-short evidence after real skill
  usage, accumulate it per skill, and evolve skills only on repeated evidence
  or a severe defect, with human approval. INVOKE in exactly three cases: (1)
  Post-Use Feedback — a development task that used any skill has just
  completed and its work is committed (or pushed): capture one 50–150 char
  feedback via two cheap script calls; (2) the user says "Sync Skills" / 「同步
  skills」: run the manual full registry sync; (3) a record call returned
  review_due=true and the current task is closed: run the Evolution Review and
  write a proposal. DO NOT invoke: mid-task, per message, to audit or rewrite
  all skills, to scan every skill, or to change another skill's core behavior
  without an approved proposal.
---

# skill-evolution

**这是入口，不是实现。** 这个技能的规范源是仓库里的：

    .claude/skills/skill-evolution/SKILL.md

**先完整读那份文件，再按它说的做。** 这里不复制它的正文、`references/` 或
`scripts/` —— 复制多少字，就是往后要对齐多少字（[ADR-0097](../../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md) 决策 1）。

<!-- 由 .claude/tools/agent_harness.py apply 生成，台账在 .claude/agent-entries.json。
     不要手改：手改会被 check 当场发现并拒绝覆盖，你的改动不会丢，但也不会生效。
     要改内容，改上面那份规范源。 -->
