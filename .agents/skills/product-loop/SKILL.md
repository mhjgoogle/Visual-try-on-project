---
name: product-loop
description: >-
  产品反馈闭环 —— 前端 Agent（应用里的对话）与后端 Agent（仓库里的开发）之间那条 来回。INVOKE 在四种时刻：(1)
  会话开始或他说「看看有没有新意见」——读台账； (2) 他在应用里要一份方案（dev.request）——那一轮已经自动跑了，来这里把方案收口； (3)
  我做完一批想告诉他——写成提案发进他的「开发」窗口；(4) 他拍了板——按 verdict 实施并把结果告诉他 ——
  **实现与上线是这条回路的一环**：他点头就去做、做完重启服务， 他刷新看到新 UI 之后多半还有新意见，那是回路在转，不是返工。台账是账户级
  feedback.json，工具是 .claude/tools/read_feedback.py。作品内容的改动不走这里
  （走应用自己的写路径），改源码的是仓库里的开发 Agent 而不是运行中的应用。
---

# product-loop

**这是入口，不是实现。** 这个技能的规范源是仓库里的：

    .claude/skills/product-loop/SKILL.md

**先完整读那份文件，再按它说的做。** 这里不复制它的正文、`references/` 或
`scripts/` —— 复制多少字，就是往后要对齐多少字（[ADR-0097](../../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md) 决策 1）。

<!-- 由 .claude/tools/agent_harness.py apply 生成，台账在 .claude/agent-entries.json。
     不要手改：手改会被 check 当场发现并拒绝覆盖，你的改动不会丢，但也不会生效。
     要改内容，改上面那份规范源。 -->
