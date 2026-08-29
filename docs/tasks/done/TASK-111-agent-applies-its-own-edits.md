# TASK-111：让对话里的 Agent 真的把改动落到作品上

- 状态：完成（2026-08-29）—— 创意简报（核心创意 + 字段）已能由对话直接落地并留下持久回执；
  故事大纲的落地刻意不做，理由写在下面
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

## 实施（2026-08-29）

起点是他在应用里问的那句「你可以帮我改类型吗」，助理答「我这边能看到的项目事实里没有
「类型/题材」这个字段，所以我改不了它」—— 字段就住在 `story.brief`，是**装配事实时漏了它**，
不是应用没有这个概念。所以本卡是两件事：让它看得见，再让它改得动。

| 位置 | 内容 |
| --- | --- |
| `server.py:_conv_facts` | 事实里加上创意简报：报的是 **active 那一版**的字段（类型/基调/形态/时长/备注/目标集数），没有版本时才报草稿，全空时明说「字段都还是空的」 |
| `server.py` | 新增编辑种类 `brief.fields`；`_conv_brief_fields()` 是**边界上的白名单**（模型的答案要落进他的 `canvas.json`，未知键一律不进），`targetEpisodes` 保持 1–50 且拒绝 bool |
| `server.py:_conv_prompt` | 告诉模型可以改哪些字段，以及这些改动**会被自动落到作品上**（它据此决定要不要给 edits） |
| `src/workflow/convedits.js`（新） | 落地本体：走创作者自己那条写路径（`setIdea` / `editBrief` → `commitBrief("developed", 他那句话)`）。**一轮一版**，不是一条改动一版 |
| `src/ui/production.js` | 轮次终态后落地 → 回执 → 刷新线程 |
| `server.py` + `services/conversation.js` | `POST /api/projects/<name>/conversation/applied`：落地回执写进对话线 |
| `src/ui/convthread.js` | 「已落到作品上」与「它建议的改动（还没落到作品上）」是两块；同一条不会同时出现在两处 |

### 为什么落地写在前端

ADR-0089 决策 2b：创作文档由前端整份保存，服务端不偷改。走他自己那条编辑路径，结果就与
他手点一模一样：**新的一版，旧版本一字不动**（决策 3）—— 这也是「不问就能落」的前提
（AGENTS.md §1：可逆的事直接做）。

### 刻意不做：`story.outline` 的落地

大纲版本是 8 个文本字段 + 人物 + 集数的结构，一段自由文本没有安全的映射方式；硬映射等于
让模型改写他**已批准**的大纲，那正是「不可逆」。它继续停在「它建议的改动」。

### 中途发现并一并修掉的缺陷

**「已落到作品上」熬不过一次刷新。** 第一版把落地结果只存在页面内存里，刷新后那一轮退回
「还没落到作品上」—— 在他眼里等于改动丢了。所以补了回执：落地结果写进对话线（应用自己的
文件，不是创作文档，所以不违反决策 2b），真机重载后仍然写着「已落到作品上（创意简报 v2）」。

## 验证

- `tests/studio/test_motv_conversation_task109.py` → 50 passed（新增：简报进事实、草稿回退、
  空简报、字段白名单 8 组、`brief.fields` 过适配器、回执落在提出它的那一轮、回执熬过重载、
  CSRF、未知 run、畸形回执 4 组、恶意回执的长度上限）
- `mockups/motv-workspace/tests/convapply.test.mjs` → 12 passed（**行为**测试：真的调
  `applyConversationEdits`，断言它调了 `editBrief` + 一次 `commitBrief`；大纲不许被这条路径
  改写；提交失败必须说出来；服务端回执优先于内存）
- 前端全量 1887 passed / 0 failed
- **真机**（隔离账户根 + 隔离注册表，不碰他的项目）：输入「把类型改成悬疑，别的先不动」→
  文档里出现 `v2 origin=developed instruction=「把类型改成悬疑，别的先不动」genre=悬疑`，
  `v1` 一字未动，`active=2`；刷新页面后那一轮仍然是「已落到作品上」

## Follow-up（不在本卡范围）

- 画布文档被判为无效时，应用会加载空白画布并**封锁保存**（`persist._blocked`）。验证过程中
  用一个不合法的临时 fixture 触发了它：界面照常可编辑、可发送，但没有任何保存请求发出去。
  fail-closed 本身是对的，缺的是**说出来**。记进
  [TASK-087 欠账总账](../active/TASK-087-followup-ledger.md)。
