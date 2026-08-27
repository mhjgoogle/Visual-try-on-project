# ADR-0089：对话式 Agent 写路径 —— 一句话进来，Agent 自己收集信息、自己落改动

- 状态：Accepted
- 日期：2026-08-27
- 决策者：产品负责人下发需求（2026-08-27），实施 Agent 依 AGENTS.md §1
  「ADR 的 Accept 权」自行 Accept 技术形状（不涉付费、不涉不可逆动用户数据）
- 关联：[REQ-004 v2](../requirements/REQ-004-three-pane-shell-and-agent-conversation.md) ·
  [TASK-109](../tasks/active/TASK-109-three-pane-shell-and-agent-conversation.md) ·
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

### 决策 3：改动一律是「加一版」，所以不必问就能落

产品负责人要的是「直接改」。能直接改的前提是**改了能回来**：文档域的写入一律表达为
**新版本**（创意 v2、大纲 v3……），旧版本一字不动（AGENTS.md 第 13 条、ADR-0087 的
REQ 版本纪律同一条道理）。因此：

- **加法/版本化写入** → Agent 直接落，不问；对话里说明落了什么、落成第几版。
- **付费动作** → 仍然必须显式确认（AGENTS.md §1：花钱是唯一必须问的事）。
- **破坏性动作**（删除、覆盖既有文件字节） → 不在本路径内，Agent 只能提议。

### 决策 4：对话记录是项目事实，住在项目根里

`<project>/studio/conversation.json`，append-only 的 turn 列表（`turnId` /
`role` / `text` / `runId` / `commands` / `createdAt`）。理由：它记录的是**这个作品
是怎么被做出来的**，和 `canvas.json` 同级，属于项目而不是账户级（对比
`projects.json` / `runs.json` 是账户级，ADR-0053 / TASK-056）。项目根围栏照旧
（ADR-0004 / ADR-0053）。

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
