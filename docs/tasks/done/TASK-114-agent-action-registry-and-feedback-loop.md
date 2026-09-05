# TASK-114：动作注册表（Agent 能做创作者能做的事）+ 意见回路

- 状态：完成（2026-08-29）
- Workflow：Feature · 深度：DEEP
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  判据 1–5
- 关联 ADR：[ADR-0089](../../adr/ADR-0089-conversational-agent-write-path.md)
  决策 2b / 3 / 3b，本卡加了**决策 7**（可操作面对等）与**决策 8**（意见回路）
- 起因：产品负责人 2026-08-29 —— 「我希望前端的对话框可以修改前端页面的设定好的和
  用户共同完成的内容」「用户能够操作的前端的agent都应该可以操作」「可以给后端反馈意见…
  你在后端接收到反馈以后提出修改方案」

## 1. 动作注册表：加一个动作 = 加一条记录

TASK-111 是一条条手写编辑种类（`brief.idea` / `brief.fields`），那条路走不到「他能点的
Agent 都能做」—— 每加一个界面按钮要在提示词、白名单、落地、界面文案四处各补一遍，
必然漂移成「提示里说能做、落地却没有」。

所以改成**一处登记**：`src/workflow/convactions.js`。每条动作有 id、中文名、参数白名单、
以及 `apply(ctx, args)` —— **调的就是界面按钮调的那个 `ctx.*`**。

| 从哪儿长出来 | 怎么长 |
| --- | --- |
| 模型的词汇表 | `actionCatalog()` → 随每一轮的 `context.actions` 送到服务端 → 服务端转写进提示词。**服务端不再自持一份 kind 名单** |
| 落地 | `runAction()` → 那条动作自己的 `apply` |
| 界面文案 | 同一份 `label`（`convthread.js` 的 `EDIT_ZH` 由注册表生成） |
| 「做得到 / 做不到」的判定 | `knownAction()` —— 判定跟着表走，所以永远与能做的事一致 |

**这一批登记了**：`brief.idea` · `brief.fields` · `brief.setActive` · `outline.fields` ·
`outline.approve` · `outline.setActive` · `plan.entry` · `plan.save` · `settings.delivery`。

**有意留白（不是遗漏）**：`confirmPlan`（确认规划会绑定剧集身份，反悔不干净）、删除类、
运行/生成类（花钱）。三条硬规矩写在文件头：只登记可逆动作、付费不进表、必须走创作者
自己那条函数。`convactions.test.mjs` 里有一条测试**扫 id 名单**，禁止 delete / publish /
generate / pay / confirmPlan 混进来 —— 这条规矩由测试守着，不靠人记得。

## 2. 服务端：从「持有词汇表」退回「守住形状」

- `_CONV_SERVER_KINDS = ("feedback.ui", "note")` —— 服务端只自己处理这两种
- 其余动作原样带着数据交给前端，服务端做的是**形状约束**：值有界、最多一层结构
  （`_conv_shallow_values`），任意嵌套的模型输出不许原样流进他的 `canvas.json`
- `_conv_prompt(message, facts, actions)`：词汇表来自这一轮前端送来的那份；
  恶意/超大的动作表被截断（40 条 / id 64 字 / 名称 60 字）

## 3. 意见回路（REQ-006 判据 4）

| 环节 | 实现 |
| --- | --- |
| 他说「这个页面不合适」 | 模型给一条 `feedback.ui`（text = 他的意见，expect = 他要的样子） |
| 记下来 | **服务端**在读时对账落地（`_file_feedback`）：写账户级 `feedback.json`，按 run 去重。它写的是应用数据不是创作文档，所以不受决策 2b 约束；落在这里意味着「他说完就记下了」，不依赖那个标签页还开着 |
| 他看到 | 那一轮显示「已记下这条意见（#N），下次开发时会看到」 |
| 后端读到 | `python .claude/tools/read_feedback.py`（`--all` / `--json` / `--done N`）。标记已处理**不删除**任何一条 |

为什么台账是**账户级**而不是项目级：他反馈的是这个应用，不是某一部作品；换个项目
也该看得见自己提过什么（与 `projects.json` / `runs.json` 同类，ADR-0053 / TASK-056）。

## 4. 顺带修掉的两个自己引入的缺陷

1. `applyConversationEdits` 改成收整个 `ctx`（注册表要用 `ctx.setDeliverySpecField`），
   而调用点还传着 `ctx.story` → 真机第一次试就报
   `Cannot read properties of undefined (reading 'applyManualOutline')`。
2. 落地失败的那一条同时挂在「已落到作品上」和「有改动没能落下」两处 —— 现在
   「已落到作品上」只列真的落下的。

另外把 `applyManualOutline` 补成接受 `origin` / `instruction`：对话产生的大纲版本记成
`developed` 并带上他那句话，否则它和他自己敲的那一版在版本列表里长得一模一样
（与 `commitBrief` 同一条理由）。

## 验证

- `mockups/motv-workspace/tests/convactions.test.mjs` → 11 passed（词汇表就是注册表、
  未知动作不认、**破坏性/花钱动作不许进表**、白名单挡未知键与二层结构、值有界、
  模型把 fields 摊平也能收、runAction 落到创作者那条函数上、表外动作抛错）
- `mockups/motv-workspace/tests/convapply.test.mjs` → 22 passed（每类动作真的调到了
  对应的 `ctx.*`；一轮一版；大纲不借简报的提交；一条失败不连累别的；失败不算落下）
- `tests/studio/test_motv_conversation_task109.py` → 45 passed（服务端守形状不守词汇表、
  词汇表来自前端目录、恶意动作表被截断、意见落台账/去重/有界/HTTP 可读）
- `tests/tooling/test_feedback_reader_req006.py` → 8 passed（读得到、`--all`、
  标记已处理不删除、未知 id 会说、`--json`、缺文件不算错、坏文件明说、
  **默认路径与服务端算的是同一个文件**）
- 前端全量 **1916 passed / 0 failed**
- **真机**（隔离账户根 + 隔离注册表，不碰他的项目）：
  - 「把故事大纲的一句话故事改成…」→ 大纲 `v2`（`origin: developed`，instruction 是
    他那句话），`v1` 一字未动，`approved` 仍指 v1
  - 「这个页面版本太多了…这条是对应用的意见」→ 屏幕回「已记下这条意见（#1）」，
    后端 `read_feedback.py` 读出「说的是 / 他要的是 / 在哪个项目哪一页」

## Follow-up

- 注册表目前覆盖故事开发与设置；人物、世界观、镜头这些页面的动作还没登记 ——
  加法是「加一条记录」，但需要逐个确认它们的可逆性
- 意见台账没有「读过就提醒开发」的推送，靠开发时主动跑 `read_feedback.py`
