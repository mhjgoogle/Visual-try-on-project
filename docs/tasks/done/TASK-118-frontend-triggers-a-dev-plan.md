# TASK-118：前端能触发后端出方案 + product-loop Skill

- 状态：完成（2026-08-29）
- Workflow：Feature · 深度：SHALLOW
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  **v4 判据 8（本卡追加）**
- 关联 ADR：[ADR-0089](../../adr/ADR-0089-conversational-agent-write-path.md) 决策 8/9/10
- 起因：产品负责人 2026-08-29 —— 前端 Agent 回他「我这边不能直接让开发动手改」，
  他问「不能做到前端触发后端agent的修改方案吗」；随后又说「是不是需要建立一个前端agent
  和后端agent交互的skill呢…你来修改就行。你就是后端agent」

## 1. 前端触发的是**方案**，不是改动

他在「开发」窗口说「你能让后端现在改吗」→ 前端 Agent 给一条 `dev.request` →
**服务端真的起一轮** `dev.proposal`（本地订阅的 claude CLI，**没有工具**）→
产出 `{title, body}` → 落成一条**待他拍板的提案**。

他立刻看到的是一条「（开发正在写方案）…」的占位提案 —— 而不是等一分钟看着什么都没有；
跑完在下一次读线程时对账落地。跑失败则标题变成「（方案没写成）…」并说明原因，
**不会永远停在「正在写方案」**。

**为什么止步于方案**：真正改代码要过测试、commit gate、独立审查、可回滚的提交；
而且他写的文字会进提示词，一条能写仓库的自动路径就是注入面（ADR-0042/0056 的既有姿态）。
所以应用那一轮只产出文字，真正的实现仍由仓库里的开发 Agent 做。

## 2. product-loop Skill

这条回路本来就一直在跑，只是散在我的记忆里。写成 `.claude/skills/product-loop/SKILL.md`
是为了**它每次都一样**：四个时刻（开场读台账 / 收口自动方案 / 做完写提案 /
按 verdict 实施），三条不许（不许应用自动改仓库源码、不许用这条路径改创作文档、
不许删台账条目），以及 `changes` 里那句话**是新的需求**这一条最容易被读错的规则。

## 验证

- `tests/studio/test_motv_conversation_task109.py` → 70 passed（新增 7 条：起真轮 +
  占位提案、同一轮不重复起、空要求不起轮、方案落回占位、失败也收口且说原因、
  方案解析 fail-closed、开发窗口知道「出来的是方案不是改动」）
- `tests/tooling/test_product_loop_skill.py` → Skill 里教的每个开关都真的存在、
  引用的每份文档都在、三条不许都在、三种 verdict 的含义都写了
- 前端全量 / 后端归属域：见提交信息

## Follow-up

- 方案那一轮**没有仓库上下文**（无工具），所以它给的是产品层面的方案，不是代码层面的。
  够他拍板用；要更准就由我在收口时重写一条
