# TASK-072：第二阶段 —— 后端合同、持久化任务、版本管理与兼容层

- 状态：**批次一已完成并提交**（`70dab40`）；批次二 / 三未开始
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[ADR-0066](../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)、
  [创作者系统合同](../design/creator-system-contract.md)
- 前置：**已满足**
  - ADR-0066 Accepted（含撤销 ADR-0063 决策 4 / 5）；ADR-0064 / ADR-0065 已收口转 Accepted；
  - **TASK-064 / 065 / 066 / 067 / 069 / 070 / 071 已验收**（产品负责人 2026-08-13
    随 ADR-0066 批准一并收口）；
  - **[TASK-068](TASK-068-legacy-agent-endpoints-to-runtime.md) 并入本卡 §1.8，
    不再单独实施** —— 它保留为该项的详细规格，不是一张待排期的卡。
- **代码基线：`ae0a54a`**（唯一代码基线；它是混合提交，理由与代价见 ADR-0066 §0.2）
- **合同基线：`6b0d893`**（三轮 docs-only 合同收口之后的当前权威；
  实施以此为准，不以 `ae0a54a` 里的文档为准）

  > 合同基线只能由**下一个**提交写下：一个提交无法包含自己的哈希。
  > 因此这个指针**永远指向上一个 docs 提交**，由紧随其后的提交更新。
  > 前两次的值分别是 `62ef70a`（第一轮）与 `870f043`（第二轮）。
- 提交纪律：**文档提交与业务代码提交分开**，**每个批次单独提交**（ADR-0066 §0.2，
  2026-08-13 校正，原为「每个交付项单独提交」）
- 后续：[TASK-073](TASK-073-fixed-ia-and-contextual-agent.md)（前端 IA）依赖本卡的合同落地

> **两个基线是两件事**，不要合并成一个：`ae0a54a` 说「代码从哪儿开始改」，
> `870f043` 说「按哪一版合同改」。`ae0a54a` 里携带的那一版文档已经被两轮校正
> 取代（ADR-0066 §6 / §6.1），照着它实施会实现掉已经被撤回的合同。

## 0. 本轮边界

**只做后端与领域层合同。前端只改到「能调用新合同」为止，IA 不动。**

不做：页面重构、导航变更、Agent 面板改造（TASK-073）；旧接口下线、旧页面删除、
真实项目全流程验收（TASK-074）。

### 0.0 三个批次（每批一个提交）

| 批次 | 交付项 | 为什么是一批 |
| --- | --- | --- |
| **批次一** | §1.1 状态拆分 · §1.2 字段补齐 · §1.3 `run_id`/排队/取消 · §1.8 `/api/agent/*` 收口 | 四项改的是**同一条运行调用链**。§1.8 与 §1.3 分开做，等于先给五个端点建一套临时直连方案，再在下一个提交里拆掉它 |
| **批次二** | §1.4 Query / Command 分离 + 统一 API Client | 依赖批次一已经定死的运行端点形状 |
| **批次三** | §1.5 Review 三层 · §1.6 门槛 G1–G5 · §1.7 版本派生 · §1.9 遗留领域缺陷 | 同属领域层，互相引用门槛与版本状态 |

**一个批次全绿才提交，一个批次没验收完不进入下一个批次。**

### 0.1 后端模块化边界（约束，批次一起生效）

`server.py` 在基线上已经 5497 行。本卡新增的运行注册表、队列、取消与重启清扫
**不得再堆进它**——那会让一个已经难以审查的文件继续增长，而这次新增的恰好是
最需要被单独测试的那部分（并发、子进程生命周期、崩溃恢复）。

| 规则 | 内容 |
| --- | --- |
| 新模块 | 运行注册表与队列落在**独立模块**（与 `rootadmit.py` 同级的 sibling module），不放进 `server.py` |
| 职责 | 新模块只管**运行状态、持久化、队列与取消协议**；**不认识** HTTP、不认识路由、不 import `server` |
| 执行器 | 子进程的解析与启动留在 `server.py`（`_executor_argv` / `_run_executor`），以**回调**注入新模块——这样新模块可以在不启动任何 CLI 的情况下被完整测试 |
| 单测 | 新模块必须能脱离 HTTP 与子进程被单测：队列顺序、状态迁移、重启清扫、取消失败路径 |
| 反向依赖 | `server.py` 依赖新模块；新模块**永远不**依赖 `server.py` |

## 1. 交付

### 1.1 Run 状态拆分（系统合同 §5.2）—— 批次一

| 项 | 内容 |
| --- | --- |
| 变更 | `run.status` = `awaiting_confirmation / queued / running / **awaiting_input** / cancelling / cancelled / succeeded / failed`（**八态**）；新增 `run.proposal.disposition` = `pending / accepted / rejected / superseded` |
| 顺序 | **需确认：`awaiting_confirmation → queued → running`；无需确认：`queued → running`**。`awaiting_confirmation` / `queued` / `awaiting_input` 可**直接**取消（无本机进程，不经 `cancelling`） |
| `awaiting_input` | **人工执行专用**：外部模型跑 Prompt、外部工具出视频，等创作者交回结果。今天这类运行停在 `running`（假话），于是重启清扫会把健康的手工运行打成 `failed`。**清扫必须跳过 `awaiting_input` 与 `awaiting_confirmation`** |
| 影响 | `workflow/skillrun.js` `RUN_STATUSES`、`services/canvasschema.js` `SKILL_RUN_STATUS_SET` 与校验、所有读 `status` 的调用点 |
| 迁移 | canvas schema v14 → **v15**，确定性映射表见系统合同 §5.2。v14 的 `running` 按**已记录的 `executor`** 分两路：`manual` → `awaiting_input`；本机执行器 → `failed(interrupted)`（宿主进程已不存在，它永远不会再有结果） |
| 守卫 | v14 文档迁移后每条 run 的 `(status, disposition)` 对；旧 `proposed` 不得丢失提案；`running` 的两路分支各有用例 |

### 1.2 Run 持久化字段补齐（系统合同 §5.0 / §5.3）—— 批次一

补齐：`runId` · `kind` · `taskType` · `queueSeq` · `commandId` · `idempotencyKey` ·
`retryOfRunId` · `sideEffect` · `provider` · `model` · `executor` · `inputVersions` ·
`outputs` / `outputVersions` · `progress` · `cost` · `startedAt` / `endedAt` ·
`failureReason` · `confirmation`。

- **运行记录只有一份**（系统合同 §5.0）：Skill / 图片 / 视频 / TTS / FFmpeg /
  渲染 / 导出共用同一个 Run 对象，由 `kind` 区分。**不建第二份运行记录。**
- `runId` 是唯一运行标识；v15 迁移后 `runId === skillRunId`，
  `skillRunId` 保留一版兼容别名（TASK-074 删除）。**不新建身份。**
- **`taskType` 是稳定机器标识**（`skill.<skillId>` / `generation.image` / …），
  **不是** `Skill.taskName`。`taskName` 只用于给普通用户显示，改文案不得动 `taskType`。
- `contextTrace`（ADR-0064 决策 2）作为 `inputVersions` 的实现，**不新建第二份**。
- `cost` 订阅内记 0 并注明 `basis`，**不留空**——空值会被读成「不知道」。
- `provider` / `model` 未知即 `null`，**不猜**（ADR-0056）。
- **历史 run 的新字段一律 `null`**：文档从未捕获它们，回填即伪造（TASK-074 §1.3 同规）。
- **`queuePosition` 不持久化**（系统合同 §5.6）：持久化的是入队序号 `queueSeq`，
  位置读时派生。一个持久化的排队位置从写下的下一秒起就是错的，而它看起来像事实。
- **`commandId` / `idempotencyKey` / `retryOfRunId`**（系统合同 §5.7）：
  同一 `idempotencyKey` 的非终态运行**不新建**，返回已有 `run_id`；
  付费 kind 的已成功运行同键再来**拒绝**并指向已有结果；再花一次钱必须是
  带 `retryOfRunId` 的**显式重试**（一次新的用户决定，成本单独记账）。
- **`sideEffect` = `none` / `applied` / `unknown`**（系统合同 §5.8）：
  只有 400/401/403/404/422 算「确定未执行」；超时 / 5xx / 连接中断一律 `unknown`。
  **`unknown` 禁止任何自动重试**，必须由用户在看到「可能已计费但未产出」后显式决定。

### 1.3 长任务身份：`run_id` + 轮询 + 真实取消 —— 批次一

| 端点 | 变更 |
| --- | --- |
| `POST /api/skill/run` + `X-Motv-Async: 1` | **立即返回 `202 { run_id, status, queuePosition }`**，不再阻塞到子进程结束 |
| `GET /api/runs/<run_id>` | 状态 / 进度 / 排队位置 / 成本 / `sideEffect` / 失败原因 / `outputs` |
| `POST /api/runs/<run_id>/cancel` | 置 `cancelling` → **终止进程树** → `cancelled`（§5.9 竞态表） |
| `GET /api/runs?filter=` | 看板与镜头制作用的运行列表 |

六条硬要求：

1. 取消必须终止**完整进程树**（Windows `taskkill /T /F`，POSIX 进程组信号），
   不是直接子进程——WSL 桥是 `wsl.exe → node → CLI`，杀掉桥会留下 CLI 继续烧额度。
   终止失败时停在 `cancelling` 并如实说明（含残留 PID），**不得伪装成 `cancelled`**。
   取消与完成的**竞态判定表**见系统合同 §5.9，结果**不得取决于谁先被调度**。
2. `_SKILL_RUN_MAX_CONCURRENT` 并发上限保留；**异步路径**超限进入 `queued`，
   排队位置**读时派生**（`queueSeq`，系统合同 §5.6）。
   **`/api/skill/run` 的同步路径仍然 429，不排队**：挂住一个同步调用方的连接，
   与「立即返回 run_id」是相反的两种承诺。
   **五个 `/api/agent/*` 的同步路径相反：槽满时等待**——它们旧实现没有并发上限、
   从不 429，给它们一个没见过的失败码是行为破坏（系统合同 §5.9c 约束 3）。
3. 后端重启后未完成的 Run 落到 `failed`（原因：`backend_restarted`），
   **不得永久停在 `running`**——那正是 TASK-067 补记 2 修过的那类僵死。
   **清扫跳过 `awaiting_input` / `awaiting_confirmation`**：它们的宿主是创作者，
   后端重启没有夺走它们的任何东西，打成 `failed` 才是丢失在途工作。

   **但只改记录是不够的**（系统合同 §5.9a）：把 Run 标成 `failed` 而 CLI 还在跑，
   得到的是一个说谎的记录加一个吃订阅额度的孤儿。本批次必须同时落地：
   - **退出时先杀干净再改记录**（顺序不可交换）；
   - **首选让子进程自己跟着死**：Windows Job Object + `KILL_ON_JOB_CLOSE`，
     POSIX 新会话 + 退出钩子 `killpg`。这样 `kill -9` / 崩溃 / 断电之后也没有孤儿；
   - **绝不凭旧 PID 盲杀**：PID 会被复用，那个号码现在可能是用户的浏览器。
     Run 记 `{ pid, createdAt, sessionId/jobId, argv0 }`，
     **三项同时匹配**才允许终止；对不上就**不杀**并如实记录；
     拿不到进程创建时间的平台路径**一律不杀**；
   - **无法确认残留是否退出 → `sideEffect = "unknown"`**，因此**禁止自动重试**。
4. `render-episode` / `mix-shot` / `compose` / `tts` / `image-gen` 等长任务
   **共用同一套 run 语义**，不各造一套。全表（endpoint → kind → taskType → executor）
   见系统合同 §5.9b；本批次只落地表中标「一」的六个端点，其余**只登记不改造**。
5. **幂等**：同 `idempotencyKey` 的非终态运行不新建（返回已有 `run_id`）；
   付费 kind 的已成功运行同键再来拒绝并指向已有结果（系统合同 §5.7）。
6. **`sideEffect = unknown` 禁止自动重试**（系统合同 §5.8）。本批次的六个端点都是
   订阅内执行器（不产生外部计费），因此 `sideEffect` 恒为 `none` / `applied`；
   **字段与规则先立好**，付费 kind 在第四阶段接入时直接用，不再补一次合同。

#### 1.3a 运行状态的存储与唯一写入边界

后端 `runs.json` 是运行生命周期的**唯一权威**；canvas 的 `skillRuns[]` 拥有创作者的
决定与输入指纹。完整的所有权表、Canvas PUT 规则与并发规则见系统合同 §5.5。

**存储位置（冻结）**：`mockups/motv-workspace/data/runs.json`，与 `projects.json`
**同址同类**（账户级、跨项目、非源码），并随 [TASK-056](TASK-056-app-storage-location.md)
一起迁到应用数据目录。**不新增第三个存储位置**，也**不**放进 `<ProjectRoot>/studio/`
（重启清扫要在任何项目被打开之前跑完；且存在没有项目的 Run）。理由全文见合同 §5.5。

**项目归属与跨项目隔离（冻结）**：Run 增加 `projectId`。

| 调用 | `projectId` |
| --- | --- |
| 旧 `/api/skill/run`（不带 project） | `null` + `origin: "legacy_no_project"`，**不属于任何项目** |
| 新调用（异步路径、五个 `/api/agent/*`、一切生成 / 渲染 / 导出） | **必填**，缺失即 `400`，**不猜「当前项目」** |

- `GET /api/runs` **必须带 `project=`**；**不带就返回全部是被禁止的**——
  那正是让别的项目的运行混进当前项目页面的那条路径。
- `projectId = null` 的 Run **不出现在任何项目页面**，只在 ⚙ 存储与诊断的
  「无项目归属的运行」里可见。
- `GET /api/runs/<run_id>` 与 `cancel` **都要校验归属**，不一致返回 **`404`**
  （不是 403 —— 403 会泄露「这个 id 存在」）。

本批次必须落地的三条（存储边界）：

1. **`canvas_put` 忽略 `skillRuns[].<生命周期字段>`**（`status` / `progress` /
   `startedAt` / `endedAt` / `failureReason` / `cost` / `sideEffect` / `outputs` /
   `queueSeq`）：不写入 `runs.json`，**也不因此让 PUT 失败**。
   前端本来就不是它们的所有者，拒绝一次合法的画布保存是把所有权问题变成用户的问题。
2. **`canvas_get` 不注入运行状态**：读运行状态只有一条路径 —— `GET /api/runs`。
3. **后端不认识的 runId（本地 / demo 模式、纯前端手工运行），canvas 就是唯一真相。**

守卫测试（三条，缺一不可）：

- 后台 Run 推进到 60% 时，用一份**持有旧快照**的 canvas 做 PUT
  → `GET /api/runs/<id>` 仍是 60%，且 PUT 返回成功；
- 一个已 `succeeded` 的 Run，被 PUT 回 `running` 的快照 → 后端仍报 `succeeded`；
- 本地模式（无 `runs.json` 条目）下 canvas 里的 run 状态正常读出，不被清空。

#### 1.3b 接口迁移（新旧并存的确切形状）

见系统合同 §5.9c。本批次的落点：

| 调用方式 | 响应 |
| --- | --- |
| `/api/skill/run` + `X-Motv-Async: 1` | `202 { run_id, status, queuePosition }` |
| `/api/skill/run` 无该头 | **旧行为不变**：`200 { ok, text, model }`，槽满 429 |
| 五个 `/api/agent/*` 默认 | **旧响应结构不变** + 加法字段 `run_id` / `executor` / `model` |
| 五个 `/api/agent/*` + `X-Motv-Async: 1` | `202 { run_id, status, queuePosition }`，**不含产物键** |

**异步响应里没有产物**；产物在 `GET /api/runs/<run_id>` 的 `outputs` 里，
且用**与同步响应完全相同的键**（`shots` / `script` / `breakdown` / `outline` /
`episodes`）——同一件东西两个名字，就是下一次解析错误的来源。

### 1.4 Query / Command 分离与统一 API Client（系统合同 §7）—— 批次二

```
services/apiclient.js   唯一 fetch 出口（错误分类 · 重试 · 超时）
services/query.js       只读；名录见系统合同 §8.2
services/command.js     只写；Envelope 构造 + preflight + submit
```

- 现有 5 个直接 `fetch` 的模块（`services/{gateway,persist,query,runtime}.js`、
  `workflow/mediaref.js`）全部改为经 `apiclient`。
- **API 错误不得静默转换为空列表或本地数据**：`apiclient` 抛分类错误，
  调用方必须显式处理；守卫测试断言「后端 500 时 UI 模型是 error 而不是 empty」。
- 旧 `query.js` 的写函数保留一版 re-export（兼容层），标注 deprecated，
  第四阶段删除。

### 1.5 Review 三层的领域落地（系统合同 §6）—— 批次三

- 新增 `workflow/review.js`：`ReviewIssue` / `ReviewDecision` 的纯领域转换。
- 三层 `category` 集合**互不相交**，由常量表与守卫测试保证。
- `ReviewDecision.by` 只能是 `"user"`——领域层拒绝任何其他值。
- 层 2 的 Issue **`locatedShotId` 必填**，领域层拒绝无定位的整集问题。
- `approveShot` 迁移为层 1 Decision（系统合同 §6.4），旧标记保留一版做对照。

### 1.6 门槛 G1–G5 的领域实现（系统合同 §6.3）—— 批次三

- 全部实现在**领域层**，不在任一页面里。
- G3（结构变更 → `needs_rereview`）由 Action 层统一触发：
  `patchShots` / `removeShot` / `confirmShotVersion(video)` / `moveTimelineClip` /
  `trimTimelineClip` 等任一走 Action 的写入都触发判定。
- G5：`buildRoughCut` / `exportDelivery` 只有 append 路径，**代码里不存在覆盖分支**。

### 1.7 ArtifactVersion 六态的派生视图（系统合同 §3）—— 批次三

- 新增纯读模块，把各文档的 `versions/active/locked` 映射为**六态**
  `draft/suggested/candidate/confirmed/locked/deprecated`
  （2026-08-13 校正：`deprecated` 是六态之一，不是「五态之外的标记」）。
- **不改存储结构**——这是一次映射，不是一次迁移。
- 守卫：`confirmed` / `locked` 只能由 `origin=user` 的动作产生。

### 1.8 `/api/agent/*` 收口（吸收 TASK-068）—— 批次一，**必须与 §1.3 同批**

[TASK-068](TASK-068-legacy-agent-endpoints-to-runtime.md) **不单独排期**，其内容并入本项：
`story-develop` / `script-draft` / `shots-draft` / `bible-breakdown` / `episode-plan`
五个创作端点改由 Runtime 层承载（ADR-0065 决策 1），并各自获得手工兜底（决策 2）。

合并的理由：这五个端点的调用点与 §1.3 的 `run_id` / 取消语义改造**是同一批代码**
（`services/query.js` 的 `developStory` / `generateScriptDraft` / `generateShotsDraft` /
`generateBibleBreakdown` / `planEpisodes`）。分两次做会让同一段代码被改两遍，
第二遍还要拆掉第一遍刚建的兼容层。

TASK-068 保留为该项的**详细规格**（旧端点行为、响应形状差异、迁移清单）。

### 1.9 遗留领域缺陷 —— 批次三

[TASK-064](TASK-064-creator-ui-consolidation.md) §4d–§4m 按 AGENTS.md 第 17 条转记了
一批 codex 发现，它们**至今没有归属**。本节给每一条一个归属，**不留无主项**。

原则：**领域 / 前端的归本卡批次三；`mix-shot` / `render` 端点的归 TASK-074 §1.1b**
（那是后期交付端点自己的面）。每条**必须先复现再修**——审查提出的现象不等于已确认的
缺陷，照着描述改代码等于把一个未经验证的判断写成事实。复现不了就记「未复现」
并说明查了什么。

#### 批次三（领域 / 前端）

| # | 来源 | 缺陷（**已按原始记录校正**） | 涉及 | 修复后守卫 |
| --- | --- | --- | --- | --- |
| 1 | 064 §4d 第 1 条 · §4d 第 4 条（TASK-066 轮 1）· §4k 第 2 条 | **绑定前不校验，且先落库再校验。** 三个同族缺口：① `targetShotId` 不校验是否解析到真实镜头 → 悬空绑定并报告成功；② 接受**任意**图片资产写进 `assets.firstFrames`，即使属于**另一个槽位**且不是 `derived-frame` → **canvas 校验器会拒绝该文档，绑定之后项目打不开**；③ `frames.bind` 在确认 `_slotOf` 可解析**之前**就持久化并返回成功 → Prompt 显示新帧、生成仍用旧帧 | `src/app.js` `ctx.frames.bind` / `workflow/framebind.js` | **先校验镜头存在 + 资产属于该槽位且类型正确 + slot 可解析，任一不满足即拒绝并说明；失败不得写入任何文档** |
| 2 | 064 §4d 第 5 条（TASK-066 轮 3） | **首帧回落顺序缺了中间一层。** `frameInputs` 只在 `frameBindings` 有记录时才认「显式选择」，否则直接回落到「本镜头当前画面」——于是**已经写进 `assets.firstFrames[slot]`** 的显式首帧（付费出图路线写的、创作者按过「用作视频首帧」的）被当前画面顶替，生成输入与溯源互相矛盾 | `src/ui/storyboard.js` `frameInputs` | 顺序固定为 **显式 binding → `assets.firstFrames[slot]`（`from` 如实标「已记录的首帧（没有来源记录）」）→ 本镜头当前画面**；断言清单显示的首帧 === 生成实际收到的首帧 |
| 3 | 064 §4d 第 2 条（TASK-065 轮 6） | **参考解读只按 `r.key` 取，不带媒体版本。** 换新媒体版本后 Prompt 把参考标成 `v2`，编译进去的六轴文字仍是读 `v1` 时写的 → 过期的导演指令 + 「用了 v2 的解读」这个不成立的溯源 | `workflow/refinterp.js` · `src/app.js` `ctx.skills.context` / `ctx.refInterp` 全部读路径 | 解读**记录它是针对哪个素材 ID、哪一版 / 哪个摘要**做的；素材版本前进 → 标 `stale`，在准备输入与 Prompt 的 `missing` 里如实报「这条解读是针对 v1 写的，当前是 v2」，给三个出口（保持 / 重新解读 / 解除）。**绝不自动改写创作者写过的文字** |
| 4 | 064 §4d 第 3 条（TASK-066 轮 1） | **删除未锁定的视频片段会连带静默删除已锁定的音频。**（方向与早先的粗略描述相反：不是「不级联」，而是**级联了但不看锁**）`setClipRemoved` 移除一个片段时连带移除同镜头的音频片段，不检查它们各自的 `locked` | `workflow/timeline.js` `setClipRemoved` | 级联时**逐条检查锁**：锁定的**保留**并如实报告「N 条已锁定的音频没有跟着移除」；不静默移除，也不静默留孤儿 |
| 5 | 064 §4f · §4m | 字幕生成遍历 `timeline.clipsOf` 而非 `liveClips` → **给已移出成片的片段生成 cue**，交付的 SRT 描述观众看不到的画面 | `src/app.js` `ctx.subtitles.generate` | 改用 `liveClips`；守卫「移除一个片段后重新生成字幕，不再为它产生 cue」 |
| 6 | 064 §4g 第 1 条 | 一条字幕修正同时带 `mergeWithNext` 与 text / 时间字段时，dispatcher 把「合并」当**互斥**分支 → 同一条里的其它修正被**静默丢弃**，界面显示已应用 | `workflow/skillapply.js` `collectSubtitleFixes` · `ctx.subtitles.applyFix` | 要么都执行，要么明确拒绝并说明；**不能默默只做一半** |
| 7 | 064 §4g 第 2 条 | `ctx.skills.context` 的 `timeline.alternatives` 不看 `trackType`，一律去查该镜头的**视频链** → 音频片段被投影出一串视频版本作为「可替换项」，Editing Director 依此提的提案必在域校验处失败 | `src/app.js` | 按 `trackType` 取对应的链，音频取音频 |
| 8 | 064 §4i 第 2 条（blocking） | dispatcher `replaceTimelineAsset` 只要同 domain 的已登记资产就接受，**不校验它是否出现在那次运行看到的 `alternatives` 里** → 被注入或幻觉的提案可以把片段换成项目里**任意**无关媒体 | `src/app.js` dispatcher | 照搬 TASK-067 在 `shot-asset-recommender` 上的修法：候选集记进 `contextTrace`，应用时按它过滤，**没有记录就拒绝**（fail-closed） |
| 9 | 064 §4l | `setFade` **只在 `layer === "shot"` 时**发出 → 只调 episode 层淡入淡出的合法 Sound Designer 提案被**静默忽略**，界面却显示已应用 | `workflow/skillapply.js` | 支持 episode 层 fade，**或**无法应用时如实拒绝并说明；不能两者都不做 |
| 10 | 064 §4j（**codex 自标 uncertain，未复现**） | `"at"` 帧提取：`currentTime` 设到 0 ms 时若视频本来就停在 0，浏览器**不保证**派发 `seeked` → 抓第一帧走到超时 | `src/app.js` | **先在真实项目里实测**；复现不了就记「未复现」并关闭，**不要凭报告改** |

#### 已驳回，不分配（留档以免再花审查配额）

`ctx.frames.reextract` 传 `force: true`「会覆盖创作者锁定的帧」——**假阳性，已被驳回两次**
（TASK-064 §4e / §4d 末段）：`framebind.bind` 的 `force` 只由创作者自己的动作传入
（Auto Rough Cut 与 Skill 提案都不传），且 `next.locked = true` 让锁在重新绑定后继续存在。
**锁保护的是自动化，不是创作者本人**（ADR-0061 决策 5）。若产品要改这条语义，
那是一次 ADR-0061 决策 5 的变更，需单独立项。

#### 转 TASK-074 §1.1b（`mix-shot` / `render` 端点）

| # | 来源 | 缺陷 |
| --- | --- | --- |
| a | 064 §4h 第 1 条（blocking） | `_agent_mix_shot` 输出 basename 只过 `_NAME_RE`，**未强制 `mix-` 保留前缀** → 构造请求可占用属于对白 / 音效音频链的带版本文件名（命名空间抢占）。其它写入路径都已用 `_slug_reserved` 挡住反向情况 |
| b | 064 §4h 第 2 条 | 开放式片段两端上界不一致：`in == 36000` 允许而 `out` 被夹到 `36000` → 超十小时音频产生**零长度片段**，混音失败或静默消失 |
| c | 064 §4i 第 1 条（blocking） | mix 端点 `math.isfinite(v)` 对**大到无法转 float 的 JSON 整数**抛 `OverflowError` → 合法体积的构造请求让 handler **崩掉**而不是返回 400 |
| d | 064 §4k 第 1 条（blocking） | mix：ffprobe 在拿 `_RENDER_LOCK` **之前**跑，每请求最多在锁外起 60 个 `ffprobe` → 资源耗尽，且「作业串行化」名存实亡 |

四条都在 `server.py` 的后期交付端点上，与本卡批次一改造的运行链路**不重叠**
（`mix-shot` / `render-episode` 属 ADR-0065 明确「不动」的三个端点）。
**批次一不顺手改**（AGENTS.md 第 17 条）。若 d 在批次一的并发测试中被实际触发，
按第 17 条记录现象、不改代码。

十条 + 四条共同的底线：**不静默**。拒绝要说为什么，级联要先问，标记要看得见。

## 2. 依赖

```
ADR-0066 Accepted
   ↓
批次一 ─┬─ 1.1 状态拆分 ──→ 1.2 字段补齐 ──→ 1.3 run_id / 排队 / 取消 ─┐
        └────────────────────────────────────  1.8 /api/agent 收口 ──┘
                       （1.3 与 1.8 改同一条调用链，同批完成）
   ↓
批次二 ── 1.4 Query / Command 分离 + 统一 API Client
   ↓
批次三 ─┬─ 1.5 Review 三层 ──→ 1.6 门槛 G1–G5
        ├─ 1.7 版本六态派生（批次三内可并行）
        └─ 1.9 遗留领域缺陷（批次三内可并行）
```

**2026-08-13 校正**：原依赖图把 §1.8 标为「独立，可并行」，与 §1.8 自己写下的
合并理由（「与 §1.3 的改造是同一批代码，分两次做会让同一段代码被改两遍」）
直接矛盾。以本图为准：**§1.8 与 §1.3 同批，不可分开提交。**

## 3. 迁移方案

| 项 | 策略 |
| --- | --- |
| canvas v14 → v15 | 确定性迁移函数 + 双向守卫测试；**不用时钟、不用随机** |
| `skillRunId` → `runId` | 同一个值换字段名；`skillRunId` 保留为兼容别名并标 deprecated，TASK-074 删除。**不新建身份、不重排、不回填** |
| 旧 `/api/skill/run` 同步语义 | 新语义并存一个阶段：无 `X-Motv-Async: 1` 头时保持旧行为，前端切换后下线（TASK-074） |
| 旧 `/api/agent/*` 五个端点 | **URL 与响应键不变**（`shots` / `script` / `breakdown` / `outline` / `episodes`），内部改走 Runtime 层，新增字段为**加法**（`run_id` / `executor` / `model`）。旧调用方不改也能继续工作 |
| 旧 `query.js` 写函数 | re-export 兼容层，标 deprecated |
| `approveShot` | 双写一版（旧标记 + 新 Decision），TASK-074 删旧 |

## 4. 验收标准

标了批次的项目只在该批次验收；**每批全绿才提交，才进入下一批**。

| # | 批次 | 标准 | 验证 |
| --- | --- | --- | --- |
| 1 | 一 | v14 文档迁移到 v15 后，每条 run 的状态与提案处置都正确 | 迁移守卫测试（含真实项目文档副本） |
| 2 | 一 | 页面刷新后运行中的任务状态可从后端恢复 | 真实项目副本：发起 Run → 刷新 → 状态仍为 `running` 且进度继续 |
| 3 | 一 | 取消传递到实际后台任务 | 发起长 Run → 取消 → 子进程真实退出（进程表验证），Run 落 `cancelled` |
| 3b | 一 | **取消失败不伪装成功** | 注入「杀不掉」的子进程 → Run 停在 `cancelling` 并显示真实原因 |
| 4 | 一 | 后端重启后无 Run 停在 `running` | 重启后端 → 断言全部落 `failed(backend_restarted)` |
| 4b | 一 | 超过并发上限进入 `queued` 且**排队位置可见**，任务不丢 | 并发守卫测试 + 真实项目副本观察 |
| 4c | 一 | 五个 `/api/agent/*` 端点**不再直接 spawn `claude`** | 代码守卫：五个 handler 内无 `_run_claude`；执行经 Runtime 层解析 |
| 4d | 一 | `taskType` 是机器标识，与 `taskName` 无推导关系 | 守卫测试：改 `taskName` 不改变任何持久化 `taskType` |
| 4e | 一 | **Canvas PUT 不覆盖后台 Run 进度** | §1.3a 的三条守卫（60% 快照回写 / `succeeded` 被写回 `running` / 本地模式仍可读） |
| 4f | 一 | 手工运行落 `awaiting_input`，**重启清扫不打它** | 迁移守卫（v14 `running`+manual → `awaiting_input`）+ 清扫守卫 |
| 4g | 一 | 同 `idempotencyKey` 的非终态运行不新建 | 并发重复提交守卫：两次请求得到**同一个** `run_id` |
| 4h | 一 | `sideEffect = unknown` 时**没有任何自动重试路径** | 代码守卫 + 注入 `unknown` 的行为测试 |
| 4i | 一 | 取消终止**完整进程树**；竞态结果符合 §5.9 判定表 | 进程表验证 + 逐行竞态测试（含「取消期间正常完成」） |
| 4j | 一 | 长任务端点全表（§5.9b）与代码一致 | 守卫测试：路由表 ↔ `kind`/`taskType` 映射表逐行比对，缺一行即红 |
| 4k | 一 | 异步响应**不含产物键**；`outputs` 用与同步响应相同的键 | 端点契约测试（五个端点 × 两种 header） |
| 4l | 一 | `queuePosition` **不出现在持久化文件里** | `runs.json` 快照断言 + 派生值随其它运行结束而变化 |
| 4m | 一 | **跨项目隔离**：`GET /api/runs` 不带 `project=` 被拒；A 项目的 Run 不出现在 B 项目；跨项目取 / 取消返回 **404** | 两项目并存的隔离守卫测试 |
| 4n | 一 | `executor` 封闭枚举，**合同 §5.3 与 §5.9b 两张表逐行一致** | 表 ↔ 表比对测试，多一个少一个即红 |
| 4o | 一 | **后端退出 / 重启后没有孤儿后代进程** | **真进程测试**：起父→子进程树 → 正常退出 **与** `kill -9` 两条路 → 按 `pid + 创建时间` 断言全部后代不存在 |
| 4p | 一 | 无法确认残留退出时 `sideEffect === "unknown"`，且**没有任何自动重试路径** | 注入「确认不了」的清扫测试 |
| 5 | 二 | 后端 500 时 UI 模型是 error 而不是 empty | 注入失败的守卫测试 |
| 6 | 三 | 三层 Issue 的 category 互不相交 | 常量守卫测试 |
| 7 | 三 | `ReviewDecision.by` 只能是 `user` | 领域守卫测试 |
| 8 | 三 | 层 2 Issue 无 `locatedShotId` 被拒绝 | 领域守卫测试 |
| 9 | 三 | G1–G5 在领域层生效（绕过 UI 也生效） | 直接调 Action 的守卫测试 |
| 10 | 三 | `confirmed` / `locked` 不能由 AI origin 产生 | `allowedAt` 守卫测试 |
| 11 | 每批 | 无页面 / 导航变更 | `NAV` / `EPISODE_NAV` / `ASSET_NAV` 快照测试不变 |
| 12 | 一 | 运行注册表**不在 `server.py` 里**，且可脱离 HTTP 与子进程单测 | §0.1 边界；模块单测存在且通过 |

**风险等级：高**（持久化 + schema 迁移 + 存储生命周期）→ AGENTS.md 第 20 条：
**全量 pytest + 全量前端 + ruff + Codex 独立审查**。

## 5. 批次一测试计划

### 5.1 新增测试

| 层 | 文件（新建） | 覆盖 |
| --- | --- | --- |
| 后端模块单测（**无 HTTP、无子进程**） | `tests/test_motv_runstore_task072.py` | 八态迁移合法性 · 队列顺序与 `queueSeq` · `queuePosition` 派生 · 重启清扫（含跳过 `awaiting_input`/`awaiting_confirmation`）· 幂等去重 · `sideEffect=unknown` 无自动重试 · 取消竞态判定表逐行 · 原子落盘与单一写入者 |
| 后端端点契约 | `tests/test_motv_runs_api_task072.py` | `/api/skill/run` 同步 / 异步两条路 · 五个 `/api/agent/*` 两种 header × 响应形状 · `/api/runs/<id>` · `/api/runs?filter=` · `/api/runs/<id>/cancel` · §5.9b 路由↔映射表逐行比对 |
| 后端存储边界 | 同上 | §1.3a 三条：60% 快照回写 · `succeeded` 被写回 `running` · 本地模式仍可读 |
| 取消真实子进程 | 同上（标记 slow） | 起一个真实可控的长进程 → 取消 → **进程表验证**整棵树消失；再起一个「杀不掉」的 → 停 `cancelling` + 真实原因 |
| **退出 / 重启不留孤儿**（真进程） | `tests/test_motv_run_lifecycle_task072.py` | 起 **父→子** 两层进程树 → 记录全部后代 pid + **创建时间** → 分别测「正常退出」与「`kill -9`」→ 断言**全部后代不存在** → Run 落 `failed(backend_restarted)`，确认不了时 `sideEffect="unknown"`。**pid 存在性单独判断不够**：复用的 pid 会造成假阴性，恰好退出的无关进程会造成假阳性，必须核对创建时间 |
| 跨项目隔离 | `tests/test_motv_runs_api_task072.py` | 两个项目各起一个 Run → 互相看不见；`GET /api/runs` 不带 `project=` 被拒；跨项目 GET / cancel 返回 **404** |
| 封闭枚举一致性 | 同上 | 合同 §5.3 executor 枚举 ↔ §5.9b 端点表**逐行比对**，多一个少一个即红 |
| 前端领域单测 | `mockups/motv-workspace/tests/runs.test.mjs` | `skillrun.js` 八态转换 · `disposition` 四态 · v14→v15 迁移（含 `running` 按 executor 两路分支）· canvasschema 校验器新旧 both-ways |
| 前端既有单测更新 | `tests/skills.test.mjs` 等 | 状态枚举变更的连带更新 |

### 5.2 必须更新的既有测试（状态与架构变更的连带）

| 文件 | 为什么要动 |
| --- | --- |
| `tests/test_motv_skills_task059.py` | `_skill_run` 的并发/槽位断言随队列迁入新模块而移位；429 只剩同步路径 |
| `tests/test_motv_script_slice_e2e.py` | 五个端点不再 stub `_run_claude`，改 stub Runtime 层执行器 |
| `tests/test_motv_story_m9.py` · `tests/test_motv_studio_m8.py` | 同上（`story-develop` / `episode-plan` / `bible-breakdown`） |
| `mockups/motv-workspace/tests/skills.test.mjs` | `RUN_STATUSES` / 状态读取点 |

**更新既有测试不等于放宽它们**：每处改动都要说明「合同变了什么」，
不得因为断言变红就删断言。

### 5.3 真实 Connected Project 验收（AGENTS.md 第 20 条）

在**真实项目的副本**上（不动原件）逐条验：

1. v14 → v15 迁移：迁移前后 run 条数一致，`(status, disposition)` 逐条正确；
2. 发起长 Run → **刷新页面** → 状态仍从后端恢复且进度继续；
3. **真实取消** → 进程表确认整棵树退出，Run 落 `cancelled`；
4. **重启后端** → 遗留 `running` 全部落 `failed(backend_restarted)`，
   而 `awaiting_input` **原样保留**；
5. 五个 `/api/agent/*` 动作各跑一次 → 各自产生 Run 记录与 provenance；
6. 并发压到上限 → 新任务进 `queued` 且排队位置可见，**任务不丢**。

**发现真实数据问题优先如实报告，不得用 mock 绕过。**

### 5.4 提交门槛

全量 pytest + 全量前端（`node --test`）+ ruff + **Codex 独立审查**，
且 §4 中标「一」的验收项全绿。**一项不过就不提交，也不进入批次二。**

**批次二起改用连续修改链节奏**（[ADR-0068](../adr/ADR-0068-continuous-modification-chain.md)，
产品负责人 2026-08-13 授权）：批次二 / 批次三的提交为**中间提交** ——
实现 → 定向测试 → Codex review loop → 修复时定向回归 → Codex 通过 → 立即独立
commit，**不跑**全量 pytest 与全量前端（把 `MOTV_CONTINUOUS_CHAIN=1` 逐次写在
提交命令最前面；**不是环境变量**，见 ADR-0068 决策 7 补记）。
**最终检查点在批次三之后**：统一跑一次全量 pytest + 全量前端 + ruff + §4 全部
验收项。批次一已按原规则跑完全量，不受影响。

---

## 6. 批次一实施记录（2026-08-13，提交 `70dab40`）

`.claude/tmp/` 是 gitignored 的临时区，所以审查结论留档在这里 —— 与 TASK-064
同一做法。完整逐条报告见实施当时的 `.claude/tmp/last-review.md`（不入库）。

### 6.1 交付

| 项 | 落点 |
| --- | --- |
| 运行注册表（独立模块，§0.1） | `mockups/motv-workspace/runstore.py` |
| Run 八态 + `proposal.disposition` 两个轴 | `runstore.py`、`src/workflow/skillrun.js` |
| canvas v14 → v15 确定性迁移 | `src/services/canvasschema.js` `migrateV14ToV15` |
| `run_id` / 排队 / 真实取消 / 重启清扫 | `runstore.py`、`server.py` `/api/runs*` |
| 五个 `/api/agent/*` 收口，`_run_claude` 删除 | `server.py` `_creative_agent` |
| Canvas PUT 所有权 | `server.py` `_reconcile_skill_runs` |
| 跨项目隔离（`projectId`、404-not-403） | `runstore.py`、`server.py` `_runs_get` |

### 6.2 测试

新增 4 个文件（约 130 用例）：`test_motv_runstore_task072.py`（模块单测，
无 HTTP / 无子进程）、`test_motv_runs_api_task072.py`（端点契约 + 隔离 + 所有权）、
`test_motv_run_lifecycle_task072.py`（**真父子进程树**的退出 / 硬杀 / 重启）、
`mockups/.../tests/runs.test.mjs`（v15 域与迁移）。连带更新 8 个既有测试文件。

提交时：全量 pytest **3039 passed / 56 skipped / 0 failed**、
全量前端 **929 passed / 0 failed**、ruff check + format 全绿。

### 6.3 Codex 独立审查：23 轮，71 个 blocking 已修，2 个已驳回

代表性类别（每一类都不止一处）：

1. **跨项目泄漏** —— 幂等键未按 project / kind / taskType / executor / target 限定；
   `_reconcile_skill_runs` 全局查 runId 导致 canvas 保存可导入他项目的 `outputs`；
   `__unowned__` 用可被用户输入的项目名当哨兵。
2. **重复扣费** —— `sideEffect=unknown` 不阻止重放；`retryOfRunId` 只判真值且可无限
   重放；付费运行无幂等键时毫无保护；付费 `cost` 默认成 0；承载花费的历史被裁剪。
3. **持久化一致性** —— 状态先改内存后落盘且失败不回滚（create / pump / confirm /
   land 全部）；终态写盘失败回滚成 `running` 永久占槽；裁剪先于写盘成功；
   读 journal 的 OSError 被当成损坏而清空历史。
4. **并发与子进程生命周期** —— 同步与异步各持一个并发池（可跑两倍执行器）；
   `preexec_fn` 在多线程服务里 fork 后可死锁；Windows Job Object 的 ctypes HANDLE
   截断 / 赋值失败被吞 / 创建晚于首个子进程；`_kill_tree` 只验直接子进程、
   把 `taskkill` rc 128 当成功、对已回收 pid 动手。
5. **契约与兼容层** —— `source` 变值、`raw_excerpt` 丢失、手工提交空对象或错形状
   变成永久成功、显式 `manual` 让 HTTP 请求永久挂起、`_await_run` 超时含排队时间。
6. **信息泄漏** —— CLI 的 stdout/stderr（本地绝对路径）进入 HTTP 响应与持久记录。

**驳回两条**（留档以免下一轮重复报）：

- `_JOB_LOCK` 嵌套死锁 —— `_guard_child` 的 `with` 块在调用 `_windows_job()`
  **之前**就已退出，两处是顺序不是嵌套。经代码核对为误报。
- `proposeRun` 拒绝数组提案 —— 活路径的提案全部来自 `readSkillAnswer`，其解析器
  只返回顶层**对象**（分镜表以 `{shots: [...]}` 到达）。v15 迁移之所以包装裸值，
  是因为**受损的历史文档**里可能有；运行中的系统产生不了。

### 6.4 范围裁定：进程树的可证明性（第 23 轮）

第 19–23 轮的发现**全部是同一个主题**：如何**证明**一棵进程树已经死了。这个问题
在通用情况下没有廉价的完整答案（pid 回收、僵尸、跨平台），因此每修一处就暴露一个
更窄的变体 —— 典型的 whack-a-mole。按 codex-review-loop 的「尽早做范围裁定」，
第 23 轮起停止追变体，改为把能力边界写进**系统合同 §5.9a**（「能证明什么，
不能证明什么」），同时仍修掉其中有真实危害的三条。

**这一裁定的代价如实记在这里**：本该在第 20 轮左右做出，晚了约四轮。

### 6.5 两个未闭合项（交接给后续）

| # | 内容 | 归属 |
| --- | --- | --- |
| 1 | 第 23 轮的 3 个修复**未经 codex 复审**（第 24 轮 `ENV_ERROR: codex unavailable`，`claude` 回退未安装）。三处均有定向测试且全绿：确认 kill 后终结卡住的 `cancelling`、404 不再当作所有权证明、测试清理需身份才发信号 | codex 恢复后补跑一轮复审 |
| 2 | POSIX 下后端被 `SIGKILL` 仍可能留下孤儿。关闭它需要 cgroup 或 PID namespace | 另立 ADR；当前一律记 `childExitVerified: false`，绝不声称已清理 |
