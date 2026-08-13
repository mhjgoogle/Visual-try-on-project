# TASK-072：第二阶段 —— 后端合同、持久化任务、版本管理与兼容层

- 状态：**已规划，未开始**（第一阶段只做文档定稿）
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[ADR-0066](../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)、
  [创作者系统合同](../design/creator-system-contract.md)
- 前置：ADR-0066 **转 Accepted**（其中包含撤销 ADR-0063 决策 4 / 5，需产品负责人拍板）
- 后续：[TASK-073](TASK-073-fixed-ia-and-contextual-agent.md)（前端 IA）依赖本卡的合同落地

## 0. 本轮边界

**只做后端与领域层合同。前端只改到「能调用新合同」为止，IA 不动。**

不做：页面重构、导航变更、Agent 面板改造（TASK-073）；旧接口下线、旧页面删除、
真实项目全流程验收（TASK-074）。

## 1. 交付

### 1.1 Skill Run 状态拆分（系统合同 §5.2）

| 项 | 内容 |
| --- | --- |
| 变更 | `run.status` = `queued / awaiting_confirmation / running / cancelling / cancelled / succeeded / failed`；新增 `run.proposal.disposition` = `pending / accepted / rejected / superseded` |
| 影响 | `workflow/skillrun.js` `RUN_STATUSES`、`services/canvasschema.js` `SKILL_RUN_STATUS_SET` 与校验、所有读 `status` 的调用点 |
| 迁移 | canvas schema v14 → **v15**，确定性映射表见系统合同 §5.2 |
| 守卫 | v14 文档迁移后每条 run 的 `(status, disposition)` 对；旧 `proposed` 不得丢失提案 |

### 1.2 Skill Run 持久化字段补齐（系统合同 §5.3）

补齐：`taskType` · `provider` · `model` · `executor` · `inputVersions` ·
`outputs` / `outputVersions` · `progress` · `cost` · `startedAt` / `endedAt` ·
`failureReason` · `confirmation`。

- `contextTrace`（ADR-0064 决策 2）作为 `inputVersions` 的实现，**不新建第二份**。
- `cost` 订阅内记 0 并注明 `basis`，**不留空**——空值会被读成「不知道」。
- `provider` / `model` 未知即 `null`，**不猜**（ADR-0056）。

### 1.3 长任务身份：`run_id` + 轮询 + 真实取消

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

### 1.4 Query / Command 分离与统一 API Client（系统合同 §7）

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

### 1.5 Review 三层的领域落地（系统合同 §6）

- 新增 `workflow/review.js`：`ReviewIssue` / `ReviewDecision` 的纯领域转换。
- 三层 `category` 集合**互不相交**，由常量表与守卫测试保证。
- `ReviewDecision.by` 只能是 `"user"`——领域层拒绝任何其他值。
- 层 2 的 Issue **`locatedShotId` 必填**，领域层拒绝无定位的整集问题。
- `approveShot` 迁移为层 1 Decision（系统合同 §6.4），旧标记保留一版做对照。

### 1.6 门槛 G1–G5 的领域实现（系统合同 §6.3）

- 全部实现在**领域层**，不在任一页面里。
- G3（结构变更 → `needs_rereview`）由 Action 层统一触发：
  `patchShots` / `removeShot` / `confirmShotVersion(video)` / `moveTimelineClip` /
  `trimTimelineClip` 等任一走 Action 的写入都触发判定。
- G5：`buildRoughCut` / `exportDelivery` 只有 append 路径，**代码里不存在覆盖分支**。

### 1.7 ArtifactVersion 五态的派生视图（系统合同 §3）

- 新增纯读模块，把各文档的 `versions/active/locked` 映射为
  `draft/suggested/candidate/confirmed/locked/deprecated`。
- **不改存储结构**——这是一次映射，不是一次迁移。
- 守卫：`confirmed` / `locked` 只能由 `origin=user` 的动作产生。

### 1.8 `/api/agent/*` 收口（承接 ADR-0065 / TASK-068）

五个创作端点改由 Runtime 层承载。若 TASK-068 已单独完成，本卡只做回归验证。

## 2. 依赖

```
ADR-0066 Accepted
   ↓
1.1 Skill Run 状态  ──→ 1.2 字段补齐 ──→ 1.3 run_id / 取消
   ↓                                        ↓
1.4 Query/Command 分离  ←────────────────────┘
   ↓
1.5 Review 三层 ──→ 1.6 门槛 G1–G5
1.7 版本派生（独立，可并行）
1.8 /api/agent 收口（独立，可并行）
```

## 3. 迁移方案

| 项 | 策略 |
| --- | --- |
| canvas v14 → v15 | 确定性迁移函数 + 双向守卫测试；**不用时钟、不用随机** |
| 旧 `/api/skill/run` 同步语义 | 新语义并存一个阶段：无 `X-Motv-Async: 1` 头时保持旧行为，前端切换后下线（TASK-074） |
| 旧 `query.js` 写函数 | re-export 兼容层，标 deprecated |
| `approveShot` | 双写一版（旧标记 + 新 Decision），TASK-074 删旧 |

## 4. 验收标准

| # | 标准 | 验证 |
| --- | --- | --- |
| 1 | v14 文档迁移到 v15 后，每条 run 的状态与提案处置都正确 | 迁移守卫测试（含真实项目文档） |
| 2 | 页面刷新后运行中的任务状态可从后端恢复 | 真实项目：发起 Run → 刷新 → 状态仍为 `running` 且进度继续 |
| 3 | 取消传递到实际后台任务 | 发起长 Run → 取消 → 子进程真实退出（进程表验证），Run 落 `cancelled` |
| 4 | 后端重启后无 Run 停在 `running` | 重启后端 → 断言全部落 `failed(backend_restarted)` |
| 5 | 后端 500 时 UI 模型是 error 而不是 empty | 注入失败的守卫测试 |
| 6 | 三层 Issue 的 category 互不相交 | 常量守卫测试 |
| 7 | `ReviewDecision.by` 只能是 `user` | 领域守卫测试 |
| 8 | 层 2 Issue 无 `locatedShotId` 被拒绝 | 领域守卫测试 |
| 9 | G1–G5 在领域层生效（绕过 UI 也生效） | 直接调 Action 的守卫测试 |
| 10 | `confirmed` / `locked` 不能由 AI origin 产生 | `allowedAt` 守卫测试 |
| 11 | 无页面 / 导航变更 | `NAV` / `EPISODE_NAV` / `ASSET_NAV` 快照测试不变 |

**风险等级：高**（持久化 + schema 迁移 + 存储生命周期）→ AGENTS.md 第 20 条：
**全量 pytest + 全量前端 + ruff + Codex 独立审查**。
