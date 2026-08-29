# TASK-111：让对话里的 Agent 真的把改动落到作品上

- 状态：未开工
- Workflow：Feature · 深度：DEEP
- 关联 Requirement：[REQ-004](../../requirements/REQ-004-three-pane-shell-and-agent-conversation.md)
  **v2 判据「对话的另一端是能干活的 Agent」的后半段**（前半段「自己收集信息 + 回话」已由
  [TASK-109](../done/TASK-109-three-pane-shell-and-agent-conversation.md) 交付）
- 关联 ADR：[ADR-0089](../../adr/ADR-0089-conversational-agent-write-path.md) 决策 2b / 决策 3
- 起因：TASK-109 收口时，v2 判据只满足了一半 —— 对话能读懂项目、能回话、能**提出**改动，
  但落地那一步没做。按 ADR-0088 决策 6，不让 `PARTIAL` 被 merge 掉，所以缺口在这里立卡。

## 现状（TASK-109 交付之后的确切位置）

- Agent 的改动意图以 `edits` 返回，词汇表是 `_CONV_EDIT_KINDS`（`brief.idea` /
  `story.outline` / `note`），解析在 `server.py:_adapt_conversation`
- 屏幕上明确写着「它建议的改动（**还没落到作品上**）」——「说要改」和「已经改了」
  在界面上是分开的，这一点不能因为本卡而模糊
- 应用不支持的动作保留为 `unsupported`，不静默丢弃

## IN SCOPE

- 把 `edits` 应用到创作文档，**走创作者自己那条编辑路径**（ADR-0089 决策 2b）：
  前端调用它点按钮时调用的同一批文档函数，然后按既有路径保存
- 每次应用产生**新版本**（创意 v2、大纲 v3……），旧版本一字不动 —— 这是「不问就能落」的前提
- 对话里说明落了什么、落成第几版；应用失败要说出原因

## OUT OF SCOPE

- 服务端直接改 `canvas.json`（会与前端内存里的同一份文档打架，并绕开 UI 的版本语义）
- 破坏性动作（删除、覆盖既有文件字节）
- 付费动作自动执行 —— 花钱仍然是唯一必须问用户的事（AGENTS.md §1）

## 已知的前置

- 「逐步可见」依赖 [TASK-106](../active/TASK-106-frontend-run-path-and-legacy-endpoint-retirement.md)
  的运行状态读取循环。TASK-109 已经消费了它的最小面（`GET /api/runs/<id>?project=`），
  完整机制仍归 TASK-106
