---
name: codex-review-loop
description: >-
  Run an automated read-only review of the current diff and fix only the
  blocking findings: ONE round by default, plus one more round to re-review a
  P1 fix (ADR-0081). The review answers requirement fulfilment FIRST and code
  quality last (four gates, ADR-0088), fed by a Review Package instead of a
  repo-wide scan. INVOKE after finishing an implementation task whose change
  touches behavior, a contract, persistence, identity, registration, render or
  file operations, paid paths, concurrency, security, Windows portability, or
  more than one domain — i.e. once code has actually changed and the change is
  complete. The reviewer is codex when available, otherwise an independent
  claude session (fallback). DO NOT invoke for: purely presentational changes
  (CSS, layout, spacing, copy), documentation-only changes, answering
  questions, explaining code, or while an implementation is still in progress
  / incomplete. Judge by WHAT the change touches, never by how small or how
  obvious it is; when unsure whether a change needs review, review it.
---

# codex-review-loop

**这是入口，不是实现。** 这个技能的规范源是仓库里的：

    .claude/skills/codex-review-loop/SKILL.md

**先完整读那份文件，再按它说的做。** 这里不复制它的正文、`references/` 或
`scripts/` —— 复制多少字，就是往后要对齐多少字（[ADR-0097](../../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md) 决策 1）。

<!-- 由 .claude/tools/agent_harness.py apply 生成，台账在 .claude/agent-entries.json。
     不要手改：手改会被 check 当场发现并拒绝覆盖，你的改动不会丢，但也不会生效。
     要改内容，改上面那份规范源。 -->
