---
name: auto-push
description: >-
  Auto Push — deterministic Git execution after dev-workflow decides. INVOKE
  in exactly two cases: (1) Task-level — dev-workflow has declared the current
  task DONE with targeted verification PASS: attribute the diff, stage only
  this task's changes, hand the commit command to the shell (so the commit
  gate runs), record metadata, push the change branch — no per-push user
  confirmation; (2) Change-level — the Change is finished: its Done criteria
  hold, the FINAL FULL verification passed, no P1 is outstanding, and the
  pending-re-review ledger carries nothing covering this branch: set the merge
  gate (recording that evidence, not a user utterance — ADR-0085), sync latest
  main, re-verify, merge --no-ff into main, push main, clean up the branch. DO
  NOT invoke: to decide whether a task or requirement is done (dev-workflow's
  job), while verification is failing, before the final full verification has
  passed, for repos without a Change manifest (run init-change first), or to
  force-push / rewrite remote history (always forbidden).
---

# auto-push

**这是入口，不是实现。** 这个技能的规范源是仓库里的：

    .claude/skills/auto-push/SKILL.md

**先完整读那份文件，再按它说的做。** 这里不复制它的正文、`references/` 或
`scripts/` —— 复制多少字，就是往后要对齐多少字（[ADR-0097](../../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md) 决策 1）。

<!-- 由 .claude/tools/agent_harness.py apply 生成，台账在 .claude/agent-entries.json。
     不要手改：手改会被 check 当场发现并拒绝覆盖，你的改动不会丢，但也不会生效。
     要改内容，改上面那份规范源。 -->
