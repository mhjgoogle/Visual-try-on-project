# ADR-0089：对话式 Agent 写路径 —— 一句话进来，Agent 自己收集信息、自己落改动

- 状态：Accepted
- 日期：2026-08-27
- 决策者：产品负责人下发需求（2026-08-27），实施 Agent 依 AGENTS.md §1
  「ADR 的 Accept 权」自行 Accept 技术形状（不涉付费、不涉不可逆动用户数据）
- 关联：[REQ-004 v2](../requirements/REQ-004-three-pane-shell-and-agent-conversation.md) ·
  [TASK-109](../tasks/done/TASK-109-three-pane-shell-and-agent-conversation.md) ·
  [ADR-0033](ADR-0033-command-gateway-contract.md)（唯一写路径 = Command Gateway）·
  [ADR-0065](ADR-0065-every-ai-action-through-the-runtime-layer.md)（每个 AI 动作经 Runtime 层）·
  [ADR-0066](ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) 决策 9
  （API 路由不得直接执行 Provider 或 CLI）· [ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)
  （Runtime / Executor / Skill 分层）· [ADR-0042](ADR-0042-creative-agent-cli-integration.md)（草稿域 agent 用法）

## 1. 背景

产品负责人 2026-08-27：

> 「AI导演台不需要了。根本用不上。直接给我做一个像现在一样的对话框。能和你对话。
> 你直接在后台收集信息修改行不行」

系统今天做不到，缺口是具体的：

| 现状 | 证据 |
| --- | --- |
| 会话框**明文拒绝**自由文本进入 Prompt | `agentsession.js`：「你写的文字**不会**进入这次运行的 Prompt——Skill 的输入是声明式的（ADR-0056 决策 6）」 |
| 五个 `/api/agent/*` 端点是**结构化 + 零写入**的草稿域端点 | `story-develop` / `shots-draft` / `bible-breakdown`，`server.py` 注释：「local `claude -p`, free, draft-domain, fail-closed, **zero writes**」 |
| 前端**从不读**运行状态 | `GET /api/runs` 零调用点（只调 `POST /api/runs/<id>/cancel`），TASK-106 记着这个缺口 |

所以「能对话」缺的是**自由文本的 turn**，「你直接改」缺的是**从 turn 到写入的合法通道**，
「看得见你在做什么」缺的是**读运行状态的循环**。

## 2. 决策

### 决策 0：信息收集在**服务端**，不指望模型有工具

Runtime 的 `claude-code` executor 跑的是 `claude -p --tools ""` —— **所有工具都关掉**，
模型只能输出文本（ADR-0042 / ADR-0056 的既有安全姿态：Prompt 里内联创作者写的剧本
文字，本身就是注入面）。所以「Agent 自己去后台收集信息」的正确实现是：

**服务端**按这次消息装配上下文（创意 / 大纲 / 人物 / 分集 / 镜头 / 资产摘要 /
最近运行），模型只负责**理解 + 回话 + 提出要执行的命令**。这比给模型开文件工具更安全，
且对创作者的体验完全相同 —— 他说一句话，不必自己去翻任何页面。

### 决策 1：一条会话 turn 端点，经 Runtime 层，不新开 CLI 直连

`POST /api/projects/<name>/conversation` 接受 `{ message, context }`，**返回 run id**，
turn 的执行走既有 Runtime / Executor 分层（ADR-0056），**不得**在路由里直接 `claude -p`
—— 那正是 ADR-0066 决策 9 禁止的形状，也是 ADR-0065 要收口的旧路径。

`GET /api/projects/<name>/conversation` 返回该项目的对话记录。

### 决策 2：读随便读，写只走 Command Gateway

turn 内的**信息收集是只读的**，可以读项目的任何权威文件（这正是「你自己去后台收集」）。
**任何改动都表达成 Gateway 命令**（ADR-0033 P1「唯一写路径」不破例）：Agent 不碰业务
文件，命令由既有应用边界写入。Agent 想做 Gateway 里没有的事 → 它**说出来**，不绕路。

### 决策 2b：创意文档的改动走**创作者自己那条编辑路径**，服务端不偷改

实现时查明：创意 / 大纲 / 人物 / 分镜这些创意文档由**前端整份保存**
（`PUT /api/projects/<name>/canvas`，服务端只做存储 + `_reconcile_skill_runs`
保护运行进度）。所以「服务端直接改文档」会与前端内存里的同一份文档打架，
并绕开 UI 自己的版本语义。

正确形状：turn 返回**语义化的编辑意图**（例如「把创意改成 X」「追加一版大纲」），
由**前端调用创作者点按钮时走的同一批文档函数**应用，然后按既有路径保存。
好处不是省事，是三条实质的：版本与撤销语义天然继承、改动立刻出现在工作区、
**没有第二条写路径**（ADR-0033 P1 的精神在这里的落法）。

Gateway 命令仍然是**生产/生成类**动作（付费、运行、审批）的路径，这一点不变。

### 决策 3：改动一律是「加一版」，所以不必问就能落

产品负责人要的是「直接改」。能直接改的前提是**改了能回来**：文档域的写入一律表达为
**新版本**（创意 v2、大纲 v3……），旧版本一字不动（AGENTS.md 第 13 条、ADR-0087 的
REQ 版本纪律同一条道理）。因此：

- **加法/版本化写入** → Agent 直接落，不问；对话里说明落了什么、落成第几版。
- **付费动作** → 仍然必须显式确认（AGENTS.md §1：花钱是唯一必须问的事）。
- **破坏性动作**（删除、覆盖既有文件字节） → 不在本路径内，Agent 只能提议。

### 决策 3b：落地回执 —— 「已落到作品上」是持久事实（2026-08-29 补，TASK-111）

落地只能发生在浏览器（决策 2b），所以只有浏览器知道结果。第一版把结果留在页面内存里，
于是刷新一次，那一轮就从「已落到作品上」退回「它建议的改动（还没落到作品上）」——
在创作者眼里等于**改动丢了**，而作品里其实好好地躺着新的一版。

因此 `POST /api/projects/<name>/conversation/applied` 把落地结果写到**提出它的那一轮**上。
这不违反决策 2b：写的是应用自己的对话文件，不是他的创作文档。回执失败不掩盖落地本身
（改动已经在作品里），只是这一行字下次读不回来。

**能落的与不能落的**（TASK-111 交付时的确切边界）：

| 编辑种类 | 落地方式 |
| --- | --- |
| `brief.idea` | `setIdea` → `commitBrief("developed", 他那句话)` |
| `brief.fields` | `editBrief(白名单字段)` → 同一次 `commitBrief` —— **一轮一版**，不是一条改动一版 |
| `story.outline` | **不落**：大纲版本是 8 个文本字段 + 人物 + 集数的结构，自由文本没有安全映射；硬映射等于让模型改写他已批准的大纲，那正是「不可逆」 |
| `note` | 从来就不落 —— 它表示「本应用还做不到」 |

字段白名单在**边界上**执行（`server.py:_conv_brief_fields`）：模型的答案会落进他的
`canvas.json`，未知键一律不进，`targetEpisodes` 保持 1–50 且拒绝 bool。

### 决策 7：Agent 的可操作面 = 创作者的可操作面（2026-08-29 补，TASK-114）

产品负责人 2026-08-29：「用户能够操作的前端的agent都应该可以操作。」

所以**不再逐条手写编辑种类**。界面动作登记在一处（`src/workflow/convactions.js`），
模型的词汇表、参数白名单、落地、界面文案**都从那一处长出来**：

- 词汇表：`actionCatalog()` → 每一轮的 `context.actions` → 服务端转写进提示词。
  **服务端不再自持一份 kind 名单** —— 界面按钮在前端，服务端抄一份必然漂移成
  「提示里说能做、落地却没有」。服务端退回守**形状**（值有界、最多一层结构）。
- 落地：那条动作自己的 `apply(ctx, args)`，调的就是界面按钮调的 `ctx.*`。
- 「做得到 / 做不到」的判定跟着表走，所以永远与能做的事一致。

**进表的门槛就是决策 3 那一条：可逆。** 版本化写入天然可逆，所以不必问就能落；
删除、绑定实体身份（`confirmPlan`）、花钱这三类不在表里 —— 那不是「Agent 不够聪明」，
是那条路径本身该先被做成可逆的（AGENTS.md §1「回不了头是缺陷」）。这条门槛由测试守：
`convactions.test.mjs` 扫 id 名单，禁止 delete / publish / generate / pay / confirmPlan
混进来。

### 决策 8：意见不是作品的改动，它有自己的去处（2026-08-29 补，TASK-114）

产品负责人 2026-08-29：「可以给后端反馈意见。比如页面不合适了把意见收集起来。
你在后端接收到反馈以后提出修改方案。」

「这个页面不合适」不是对作品的编辑，把它塞进创作文档是错的。所以 `feedback.ui`
是一条**服务端自己处理**的动作：写账户级 `feedback.json`（应用数据，不是创作文档，
因此不受决策 2b 约束），按 run 去重，落在读时对账那一步 —— 意味着「他说完就记下了」，
不依赖那个标签页还开着。

账户级而非项目级：他反馈的是这个应用，不是某一部作品；换个项目也该看得见提过什么
（与 `projects.json` / `runs.json` 同类，ADR-0053 / TASK-056）。

回路的后端一半是 `.claude/tools/read_feedback.py`：意见写在**运行期**目录里，开发
Agent 看不见，除非有工具把它取出来。标记已处理**不删除**任何一条（第 13 条）。

### 决策 4：对话记录是项目事实，住在项目根里

`<project>/studio/conversation.json`，append-only 的 turn 列表（`turnId` /
`role` / `text` / `runId` / `commands` / `createdAt`）。理由：它记录的是**这个作品
是怎么被做出来的**，和 `canvas.json` 同级，属于项目而不是账户级（对比
`projects.json` / `runs.json` 是账户级，ADR-0053 / TASK-056）。项目根围栏照旧
（ADR-0004 / ADR-0053）。

### 决策 4b：对话按页面分线，键是页面本身

产品负责人 2026-08-27：「我可以打开不同的页面都有新的对话框吗。历史内容保存在不同
对话框」。所以 `conversation.json` 从「一条 turns」变成「按 key 分组的多条 turns」，
key 就是**页面**（`context.module`），因为那正是他说的「不同的页面」。

三条实现纪律：

1. **key 由服务端从 run 的 context 推**，不新增字段 —— run 记录里本来就存着这一轮的
   context（决策 5 的投影逻辑照旧成立）：一轮答案属于哪条线，是从它自己的事实推出来的，
   不是前端事后声称的。
2. **旧数据不丢**：v1 的单条 `turns` 迁进 `__legacy__` 线，仍然读得到（AGENTS.md 第 13 条
   的加法优先：不改旧结构，加一层）。
3. **不按对象分得更细**（每个镜头一条线）—— 他说的是页面。分得比他要的更细，
   等于替他发明一套他没要求的组织方式。

### 决策 5：过程可见靠读运行状态，不靠 Agent 自己汇报

对话流里「Agent 正在做什么」来自**读 run 状态**（`GET /api/runs`，TASK-106 的机制），
不是让 Agent 在文本里自称进度 —— 自称的进度会在进程死掉时永远停在「进行中」。
本 ADR 只消费该机制；机制本身归 TASK-106。

### 决策 6：手工兜底不取消

ADR-0065 决策 2 的「每个 AI 动作都必须有手工兜底」对本路径同样成立：对话失败、
`claude` 不可用、turn 超时，创作者仍能用既有工作区手工完成同一件事，且对话里如实
说明失败原因（fail-closed，不假装做了）。

## 3. 后果

- **好的**：创作者说一句话就能推进作品，不必先学会「选哪个能力、填哪些声明式输入」；
  写入仍然只有一条路（Gateway），版本历史仍然完整。
- **要接受的**：turn 的耗时不可预测（本地 `claude` 一次 6–60 秒不等），所以对话必须
  异步 + 可取消；Agent 读得多，Prompt 成本比结构化 Skill 高。
- **不做的**：不给 Agent 直接写文件的能力、不做破坏性动作、不自动花钱、
  不在路由里直连 CLI、不新增第二个运行记录（复用 `runs.json`）。

## 4. 落地

| 位置 | 动作 |
| --- | --- |
| `server.py` | 新增 `POST/GET /api/projects/<name>/conversation`；turn 经 Runtime 层；写入经 Gateway 命令 |
| `<project>/studio/conversation.json` | 新增，append-only turn 记录 |
| `src/ui/agentsession.js` | composer 允许纯自由文本提交（不再要求先选能力） |
| 新增 `src/ui/convthread.js` | 对话流渲染：用户 turn / Agent turn / 执行步骤 / 落了哪些命令 |
| `src/services/*` | 读 `GET /api/runs` 的轮询（TASK-106 机制的最小消费面） |
| `tests/studio/` · `tests/contract/` · 前端 `.test.mjs` | 端点行为、Gateway 写入边界、对话流渲染 |
