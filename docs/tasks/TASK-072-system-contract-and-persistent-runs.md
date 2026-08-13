# TASK-072：第二阶段 —— 后端合同、持久化任务、版本管理与兼容层

- 状态：**已解锁，可开工** —— ADR-0066 已于 2026-08-13 转 Accepted
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[ADR-0066](../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)、
  [创作者系统合同](../design/creator-system-contract.md)
- 前置：**已满足** —— ADR-0066 Accepted（含撤销 ADR-0063 决策 4 / 5）；
  ADR-0064 / ADR-0065 已收口转 Accepted；TASK-064～071 全部标记已验收
- 实施基线：**`ae0a54a`**（唯一基线；它是混合提交，理由与代价见 ADR-0066 §0.2）
- 提交纪律：**文档提交与业务代码提交分开**，**每个批次单独提交**（ADR-0066 §0.2，
  2026-08-13 校正，原为「每个交付项单独提交」）
- 后续：[TASK-073](TASK-073-fixed-ia-and-contextual-agent.md)（前端 IA）依赖本卡的合同落地

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
| 变更 | `run.status` = `awaiting_confirmation / queued / running / cancelling / cancelled / succeeded / failed`；新增 `run.proposal.disposition` = `pending / accepted / rejected / superseded` |
| 顺序 | **需确认：`awaiting_confirmation → queued → running`；无需确认：`queued → running`**。`awaiting_confirmation` 与 `queued` 可**直接**取消（无子进程可杀，不经 `cancelling`） |
| 影响 | `workflow/skillrun.js` `RUN_STATUSES`、`services/canvasschema.js` `SKILL_RUN_STATUS_SET` 与校验、所有读 `status` 的调用点 |
| 迁移 | canvas schema v14 → **v15**，确定性映射表见系统合同 §5.2 |
| 守卫 | v14 文档迁移后每条 run 的 `(status, disposition)` 对；旧 `proposed` 不得丢失提案 |

### 1.2 Run 持久化字段补齐（系统合同 §5.0 / §5.3）—— 批次一

补齐：`runId` · `kind` · `taskType` · `provider` · `model` · `executor` ·
`inputVersions` · `outputs` / `outputVersions` · `progress` · `queuePosition` ·
`cost` · `startedAt` / `endedAt` · `failureReason` · `confirmation`。

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

### 1.3 长任务身份：`run_id` + 轮询 + 真实取消 —— 批次一

| 端点 | 变更 |
| --- | --- |
| `POST /api/skill/run` | **立即返回 `{ run_id }`**，不再阻塞到子进程结束 |
| `GET /api/runs/<run_id>` | 状态 / 进度 / 成本 / 失败原因 |
| `POST /api/runs/<run_id>/cancel` | 置 `cancelling` → **终止子进程** → `cancelled` |
| `GET /api/runs?filter=` | 看板与镜头制作用的运行列表 |

四条硬要求：

1. 取消必须终止**实际子进程**；终止失败时停在 `cancelling` 并如实说明，
   **不得伪装成 `cancelled`**。
2. `_SKILL_RUN_MAX_CONCURRENT` 并发上限保留；超限从「立即 429」改为进入 `queued`，
   并在 Run 上可见排队位置。
3. 后端重启后未完成的 Run 落到 `failed`（原因：`backend_restarted`），
   **不得永久停在 `running`**——那正是 TASK-067 补记 2 修过的那类僵死。
4. `render-episode` / `mix-shot` / `compose` / `tts` / `image-gen` 等长任务
   **共用同一套 run 语义**，不各造一套。

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

一次实施前审查（2026-08-13）提出四个既有缺陷。它们**全部在领域层**，与 §1.5–§1.7 的
门槛与版本工作同族，因此归批次三，**批次一不碰**。

每条**必须先复现再修**：审查提出的现象不等于已确认的缺陷，直接照着描述改代码，
等于把一个未经验证的判断写成事实。复现不了就在本卡记录「未复现」并说明查了什么。

| # | 现象（待复现） | 涉及 | 修复后守卫 |
| --- | --- | --- | --- |
| 1 | 首帧绑定不校验**绑定目标**与**槽位**：可以把一个帧绑到不属于该镜头的槽，或绑到不存在的槽 | `workflow/framebind.js` `bind` / `sanitizeBinding` | 领域层拒绝越界目标与未知槽位，并给出原因 |
| 2 | 生成输入清单的 `frames` 来源不对：应读 `assets.firstFrames[slot]`（真正喂给生成的那份），实际读到别处 | `workflow/geninput.js` `buildInputSet({ frames })` 的调用点 | 断言清单显示的首帧 === 生成实际收到的首帧 |
| 3 | 参考解读（interpretation）在**媒体版本变化后**不标记 `stale`，于是旧解读被当成对新版本的解读 | `workflow/refinterp.js` / `ctxcache.js` | 媒体版本变更 → 解读标 `stale` 并在准备输入里可见 |
| 4 | 删除视频片段时**不级联处理已锁定音频**：视频没了，锁定的音频仍指向它 | `workflow/timeline.js` / `shotaudio.js` | 删除被拒绝并列出锁定引用，**或**显式确认后一并处理；**不静默留孤儿** |

四条共同的底线：**不静默**。拒绝要说为什么，级联要先问，标记要看得见。

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
