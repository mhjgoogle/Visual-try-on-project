# Current Implemented Product — 当前系统真实能力盘点

**日期** 2026-08-16 · **Commit** `18fa281` · **验证方式** 真实运行 + 代码 + 真实
Connected Project（`照见未明rev2`），不依赖 README（README 的 IA 描述已落后于
TASK-064/066/072–075）。

判据优先级：**实际运行行为 > 代码 > 测试 > schema > README > 注释**。
文档与代码冲突处一律以代码和运行结果为准，并在下文标注。

---

## 0. 系统地图（真实存在的东西）

这个仓库里有**两个前端**和**一个核心库**，而且它们的领域模型是**分裂的**：

```
┌─────────────────────────────────────────────────────────────────┐
│ mockups/motv-workspace/     创作者 Studio（产品主界面）           │
│   index.html + src/*.js     38k 行浏览器 JS —— 创作领域全在这里    │
│   server.py (306 KB)        loopback 后端：静态 + canvas 持久化    │
│                             + claude CLI agent 路由 + ffmpeg      │
│   持久化：<ProjectRoot>/studio/canvas.json（单个 JSON 文档）       │
│           <ProjectRoot>/media/*（媒体字节）                       │
│   → 只从核心库借用：6 个只读查询 + 2 个 Gateway 命令               │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ src/workspace_shell/        Creation Workspace Shell（WSM1-B）    │
│   app.py + static/app.js    850 行，只读观察面 + 4 个创意事实写命令 │
│   → 对真实 Studio 项目 **全空**（见 §5 GAP-05）                   │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ src/ai_video_workflow/      核心库，172 个 .py，20 个子包          │
│   CLI 60 个子命令 —— 完整的 L0–S7 流水线                          │
│   → 其中 **只有 4 个子包**被任一前端 import                       │
└─────────────────────────────────────────────────────────────────┘
```

**核心库被前端触达的范围（`grep ai_video_workflow\.` 实测）**

| 前端 | import 的核心包 |
| --- | --- |
| Studio `server.py` | `workspace`（查询）、`gateway`、`app.lock_gateway`、`app.paid_gateway`、`app.media_fetch`、`app.bootstrap`、`planning`、`providers.registry`、`errors` |
| `workspace_shell` | `workspace`、`gateway`、`app.gateway_commands`、`errors` |

**没有任何前端触达的核心包**：`orchestration`、`composition`、`qcd`、`release`、
`learning`、`evaluation`、`action`、`automation`、`creative`、`postproduction`、
`assets`、`audio`、`media`、`inspection`、`profile`、`budget`、`approval`、`security`。

> 这不是「有些函数没被调用」。这是**整个流水线核心只被 CLI 驱动**，
> 而 Studio 用 JavaScript + 直接 ffmpeg 子进程实现了它自己的一份平行实现。

---

## 1. Backend Capability Matrix

### 1.1 只读查询（`ai_video_workflow.workspace.WorkspaceQueryService`，ADR-0031 公开合同 v1.5）

核心提供 **19 个查询**。它们各自的暴露状态：

| # | Capability | Query | Studio | Shell | User Accessible |
| --- | --- | --- | --- | --- | --- |
| 1 | 看 L0–S7 完整计划（54 步） | `project_plan` | HTTP 有，**前端不调** | ✅ | 🟡 只在 Shell |
| 2 | 看阶段状态与推进度 | `project_status` | ✅ 调 | ✅ | ✅ |
| 3 | 看预算余额 | `budget_standing` | ✅ 调 | ✅ | 🟡 **但渲染错误，见 GAP-03** |
| 4 | 看实际成本 | `cost_breakdown` | ✅ 调 | ✅ | ✅ |
| 5 | 看数据问题清单 | `recent_problems` | HTTP 有，**前端不调** | ✅ | 🔵 Backend only |
| 6 | 看审批审计 | `approval_audit` | HTTP 有，**前端不调** | ✅ | 🔵 Backend only |
| 7 | 看一个产物的上游血缘 | `lineage_upstream` | ❌ | ✅ | 🟡 只在 Shell |
| 8 | 看一个对象的下游消费者 | `lineage_downstream` | ❌ | ✅ | 🟡 只在 Shell |
| 9 | 看一条 Prompt 的版本史 | `prompt_history` | ❌ | ✅ | 🟡 只在 Shell |
| 10 | 看一个镜头的所有尝试 | `shot_attempts` | ❌ | ✅ | 🟡 只在 Shell |
| 11 | 看评价决策（终审/技术 QC） | `evaluation_decision` | ❌ | ❌ | 🔵 **CLI only** |
| 12 | 看评价域全量 | `evaluation_domain` | ❌ | ❌ | 🔵 **CLI only** |
| 13 | 看 Action Center（反馈→行动） | `action_center` | ❌ | ❌ | 🔵 **CLI only** |
| 14 | 看项目多媒体资产（核心侧） | `project_multimedia` | ❌ | ❌ | 🔵 **CLI only** |
| 15 | 重建校验（可重建性证明） | `rebuild_check` | ❌ | ❌ | 🔵 **CLI only** |
| 16 | 看一个复用资产被谁用了 | `reuse_usage` | ❌ | ❌ | 🔵 **CLI only** |
| 17 | 跨项目索引 | `cross_project_index` | ❌ | ❌ | 🔵 **CLI only** |
| 18 | 跨项目分析（QCD 对比） | `cross_project_analytics` | ❌ | ❌ | 🔵 **CLI only** |
| 19 | 跨项目学习建议 | `recommendations` | ❌ | ❌ | 🔵 **CLI only** |

**结论：19 个查询里，Studio 实际消费 3 个（status / cost / budget）。**

### 1.2 写命令（Command Gateway，ADR-0033）

Gateway 是唯一合规写路径。注册表是**按前端分别构造的**，两边不一样：

| Command | Risk | 注册在哪 | Studio UI 入口 | 状态 |
| --- | --- | --- | --- | --- |
| `lock-draft-plan` | HIGH | Studio | 分镜「锁定为正式版本」 | ✅ |
| `submit-video-generation` | HIGH | Studio，**仅 `--enable-paid`** | 视频「生成」/「批量生成」 | 🟡 需付费开关 |
| `record-evaluation` | LOW | `workspace_shell` | ❌ Studio 没有 | 🔵 Backend only |
| `create-feedback` | LOW | `workspace_shell` | ❌ Studio 没有 | 🔵 Backend only |
| `create-action` | LOW | `workspace_shell` | ❌ Studio 没有 | 🔵 Backend only |
| `action-transition` | LOW | `workspace_shell` | ❌ Studio 没有 | 🔵 Backend only |

> **没有任何一个前端同时拥有这 6 个命令。** 创作者在 Studio 里做完片子，
> 无法记录一次评价、提一条反馈、开一个行动项 —— 那套闭环只存在于另一个
> 界面里，而那个界面看不到他的项目（GAP-05）。

### 1.3 Studio 自有后端能力（`server.py`，不经核心库）

| Capability | 路由 | 实现 | 花费 | Persistence | User Accessible |
| --- | --- | --- | --- | --- | --- |
| 创建项目 / 选目录 | `POST /api/projects`、`GET /api/fs/*` | 自有 + rootadmit | 免费 | `<应用数据目录>/projects.json` + 项目目录 | ✅ |
| 迁移 legacy 项目 | `POST /api/projects/migrate-legacy` | 自有 | 免费 | 项目目录 | ✅ |
| 画布读写（**全部创作数据**） | `GET/PUT /api/canvas/<项目>` | 自有 | 免费 | `studio/canvas.json` | ✅ |
| 上传/读取媒体 | `PUT/GET /api/uploads/<项目>/<slug>` | 自有，magic 字节校验，版本追加 | 免费 | `media/` | ✅ |
| 删除媒体文件 | `POST /api/assets/delete-file` | 自有 | 免费 | `media/` | ✅ |
| Skill 目录 | `GET /api/skills` | `skillpkg`（ADR-0067） | 免费 | `product-skills/` 三级来源 | ✅ 21 个 Skill |
| Skill 运行（同步/异步） | `POST /api/skill/run`、`/api/runs/*` | `runstore` + `claude -p` | 订阅制，**不计费** | `<应用数据目录>/runs.json` | ✅ |
| 运行时探测 | `GET /api/runtimes` | `shutil.which` + `--version` | 免费 | 缓存 30s | ✅（claude-code installed / codex 主动停用） |
| 剧本草稿 / 故事发展 / 分集规划 / 分镜草稿 / 剧本拆解 | `POST /api/agent/*` | `claude -p`，fail-closed，**服务端零写入** | 订阅制 | 无（提案回前端） | ✅ |
| 本地 TTS | `POST /api/agent/tts` | Piper | 免费离线 | `media/` | 🟡 需装 piper + 模型 |
| 单镜头混音 | `POST /api/agent/mix-shot` | **直接 ffmpeg** | 免费 | `media/` | ✅ |
| 整集渲染 | `POST /api/agent/render-episode` | **直接 ffmpeg** | 免费 | `media/render-ep-v<N>` 原子版本化 | ✅ |
| 成片合成 | `POST /api/agent/compose` | **直接 ffmpeg** | 免费 | `media/` | ✅ |
| 交付质检探测 | `POST /api/delivery/probe` | **直接 ffprobe + ebur128/blackdetect** | 免费 | 无 | ✅ |
| 付费图像生成 | `POST /api/agent/image-gen` | Provider | **花钱** | `media/` | 🟡 需 `--enable-paid` |
| 领取付费成片 | `POST /api/agent/adopt-paid` | 只读桥接 | 免费 | canvas 槽位 | 🟡 同上 |
| 付费任务投影 | `GET /api/paid-ops/<项目>` | 只读 | 免费 | — | 🟡 同上 |

> **`ai_video_workflow/composition/ffmpeg.py` 的模块 docstring 写着
> 「the only module permitted to call ffmpeg」。`server.py` 在至少 4 处直接
> `shutil.which("ffmpeg")` 并自己拼 argv。**这条不变量已经被破坏，不是理论风险。

### 1.4 核心库里存在、但**任何界面都到不了**的能力（CLI-only）

按 CLI 子命令归类（共 60 个，Studio 一个也不调用）：

- **编排与断点续跑**：`init-tasks` `prepare` `submit` `report-artifact` `collect`
  `validate` `status` `run` `create-redo-task` `show-instruction`
- **正式合成**：`compose`（Studio 用自己的 ffmpeg 版本）
- **计划与包**：`stage-plan` `stage-status` `plan-compile` `lineage`
- **人工 Gate**：`stage-review` `stage-approve` `stage-reject` `stage-revise`
- **QCD / 交付 / 归档**：`qcd-report` `qc-run` `qc-review` `package-release`
  `archive-project`
- **评价 / 反馈 / 行动 / 学习**：`eval-record` `experiment-record` `decision-record`
  `feedback-create` `action-create` `action-transition` `action-handle`
  `action-verify` `action-rebind` `knowledge-promote`
- **复用包与项目档案**：`profile-init` `reuse-publish` `reuse-add-ref` `reuse-verify`
- **WFM2/WFM3**：`creative-plan` `creative-publish` `creative-validate`
  `media-generate` `media-select` `media-promote`
- **付费**：`paid-submit` `poll-media` `paid-integrate`
- **观察查询**：`ws-*`（19 个）

---

## 2. Frontend ↔ Backend Interaction Map

Studio 前端实际发出的**全部**请求（`grep '/api/'` 实测，无遗漏）：

### 2.1 三条真实链路（完整追踪）

**A. 「AI 生成分镜」—— 唯一真正跑通的 AI 创作链**

```
UI       剧集制作 › 分镜 › 「重新生成（新版本）」/ AI 导演「分镜生成」
Handler  app.js → workflow/skillapply.js
Service  command.generateShotsDraft(script)
Request  POST /api/agent/shots-draft  { script, ...skill inputs }
Backend  server._agent_shots_draft → skillpkg 取 prompt → claude -p --tools ""
Effect   **服务端零写入**；子进程 20–60s；输出严格解析，失败 fail-closed
Response { shots: [...] }（草稿提案）
FE state canvasschema 追加一个**新的不可变草稿版本**（旧版本全留）
Persist  PUT /api/canvas/<项目> → studio/canvas.json
UI       分镜列表刷新，标「草稿 v1/1 · 未锁定」
```

**B. 「锁定分镜」—— 唯一走 Gateway 的免费写**

```
UI       分镜 › 锁定为正式版本
Service  query.getLockTarget → command.buildEnvelope("lock-draft-plan", …)
Request  POST /api/projects/<项目>/preflight   （只读预检，返回 blockers + digest）
UI       预检弹窗展示 blockers / 报价 / digest，**必须人工确认**
Request  POST /api/projects/<项目>/command  { envelope, confirmation: digest }
Backend  CommandGateway → lock_gateway._apply → 写 planning/shot_plan_v<N>.json
Persist  **核心文件**（这是 Studio 唯一一次写核心业务文件）
UI       分镜标「已锁定 v<N>」
```

**C. 「整集渲染」—— 绕开核心的媒体写**

```
UI       后期交付 › 时间线 › 渲染
Service  command.renderEpisode(project, clips, settings)
Request  POST /api/agent/render-episode
Backend  server._agent_render_episode → shutil.which("ffmpeg") → 自拼 argv 单遍合成
Effect   写 media/render-ep-v<N>.mp4（O_CREAT|O_EXCL 原子版本化，不覆盖）
         **不经 Command Gateway，不经 ai_video_workflow.composition**
Persist  canvas.json 里追加一条 type="render" 的 Generation 记录
UI       成片区显示新版本
```

### 2.2 前端调用面全表

| 前端模块 | 端点 | 类型 |
| --- | --- | --- |
| `services/query.js` | `/api/meta`、`/api/projects`、`/api/fs/default`、`/api/fs/list`、`/api/skills`、`/api/projects/<p>/{status,cost,budget}`、`/shots`、`/lock-target`、`/generation-target`、`/api/paid-ops/<p>`、`/api/delivery/probe` | 读 |
| `services/persist.js` | `/api/canvas/<p>` GET+PUT | 读写（**全部创作数据**） |
| `services/command.js` | `/api/agent/{shots-draft,script-draft,story-develop,episode-plan,bible-breakdown,tts,compose,image-gen,adopt-paid,render-episode,mix-shot}`、`/api/assets/delete-file`、`/api/uploads/<p>/<slug>`、`/api/projects`、`/migrate-legacy`、`/preflight`、`/command` | 写 |
| `services/runtime.js` | `/api/runtimes`、`/api/skill/run`、`/api/runs/<id>/cancel` | Skill 执行 |
| `services/apiclient.js` | `/api/meta`、`/api/skills` | 引导 |

**服务端有、前端一次都没调**：`/api/projects/<p>/plan`、`/problems`、`/approvals`。

---

## 3. User-facing Capability Map

一个普通用户打开当前 App，**真正能完成的事**（真实项目实测）：

```
新建项目（选磁盘目录）
  ↓
写一句创意 → AI 发展成故事大纲（版本链 + 批准）
  ↓
AI 生成分集规划（版本链 + 确认）→ 建立剧集实体
  ↓
选一集 → AI 生成本集剧本（版本链，修订=新版本）
  ↓
AI 剧本拆解 → 人物/场景地提案 → 逐条确认进「作品设定」
  ↓
AI 生成分镜草稿（60 镜）→ 手工编辑 → 「锁定为正式版本」【唯一写核心文件】
  ↓
为镜头绑定参考资产（从资产库或上传）
  ↓
编译 Image Prompt / Video Prompt → 📋 复制 → 到外部网页工具生成 → ⬆ 导入
  （或 --enable-paid 时走 Gateway 真实付费生成视频）
  ↓
本地 Piper TTS 配音 / 上传音频
  ↓
时间线粗剪 → 字幕（台词→字幕）→ 本地 ffmpeg 渲染成片
  ↓
交付质检探测（ffprobe + ebur128 + blackdetect）→ 导出
```

这条链是**真实可跑的**，而且免费部分（AI 文本创作全部）确实在跑
—— `照见未明rev2` 里有 48 集规划、6 个角色档案、60 个分镜、9 个资产，全是真的。

### 3.1 逐项评估

| User Goal | Current UI Path | Screens | Backend | UX | Hidden Capability | 最大摩擦 |
| --- | --- | --- | --- | --- | --- | --- |
| 开一个新项目 | 落地页 › 新建项目 › 选目录 | C-001 | Full | Usable | — | 卡片没封面/没进度，回来找不到「上次做到哪」 |
| 把创意变成大纲 | 故事开发 › 项目与创意 › 生成提案 | C-002 C-003 | Full | **Good** | — | — |
| 规划分集 | 故事开发 › 分集规划 | C-005 | Full | Confusing | — | 48 vs 12 两个数字并列，不知道信哪个 |
| 写本集剧本 | 故事开发 › 本集剧本 | C-006 | Full | Good | — | 右栏能力面板在这页消失，不一致 |
| 建人物/场景设定 | 故事开发 › 作品设定 | C-004 | Full | **Good** | — | — |
| 拆分镜 | 剧集制作 › 工作区▾ › 分镜 | C-011 | Full | Usable | `project_plan` 54 步计划没露出 | 入口藏在下拉菜单第 5 项 |
| 做一个镜头 | 剧集制作 › 制作台 | C-007 | Full | Usable | — | 中栏标题不随工作区变（C-014/C-017 仍写「制作流程图」） |
| 生成画面 | 制作台 › ② 制作主画面 | C-013 | 🟡 Partial | Usable | — | 免费路线=复制到外部网页再导入；付费图像默认被拒 |
| 生成视频 | 制作台 › ③ 制作视频 | C-014 | 🟡 Partial | Usable | — | 同上；付费需 `--enable-paid` + env + API key |
| 配音 | 工作区▾ › 音频 | C-015 | 🟡 Partial | Usable | — | 需另装 Piper 与模型 |
| 粗剪与成片 | 工作区▾ › 剪辑 | C-017 | Full | Usable | 核心 `composition` 包 | 与核心实现平行两套 |
| 审片 | 工作区▾ › 审片 | C-016 | Full | Confusing | `evaluation_*` / `action_center` | 60 个分页码平铺；通过/跳过没有去处 |
| 管资产 | 资产库 | C-018 | Full | Usable | `reuse_usage` | 左 rail 7 行与页内 chips 重复 |
| 管存储 | 项目设置 › 存储与诊断 | C-019 | Full | **Broken** | — | 「媒体不可用 0」是假的（GAP-02） |
| 看花了多少钱 | 顶栏余额 | C-002… | Full | **Broken** | — | `unavailable` 被渲染成 `¥0`（GAP-03） |
| 看整个项目健康度 | — | — | Full | **不存在** | `plan` `problems` `approvals` `rebuild_check` | 后端全有，界面没有 |
| 记录一次评价/反馈/行动 | — | — | Full | **不存在** | 4 个 Gateway 命令 | 只在另一个前端里 |
| 跨项目复盘/学习 | — | — | Full | **不存在** | `cross_project_*` `recommendations` | CLI only |

---

## 4. Backend-only Features（后端已实现，UI 没有入口）

| 能力 | 后端位置 | 证据 |
| --- | --- | --- |
| L0–S7 完整计划（54 步，含 owner/执行类/Gate） | `workspace.project_plan` | 真实项目实测返回 54 项，`Project-Init` 起 |
| 数据问题清单 | `workspace.recent_problems` | 真实项目实测报出 `config/wfm1.json` 缺失，UI 从不显示 |
| 审批审计 | `workspace.approval_audit` | HTTP 通，前端不调 |
| 血缘上/下游、Prompt 版本史、镜头尝试史 | `workspace.lineage_*` / `prompt_history` / `shot_attempts` | 只在 `workspace_shell` |
| 评价决策 / 评价域 / Action Center | `workspace.evaluation_*` / `action_center` | CLI only |
| 可重建性校验 | `workspace.rebuild_check` | CLI only |
| 复用资产使用情况 | `workspace.reuse_usage` | CLI only |
| 跨项目索引/分析/建议 | `workspace.cross_project_*` / `recommendations` | CLI only |
| 评价/反馈/行动闭环写入 | Gateway 4 命令 | 只注册在 `workspace_shell` |
| 正式编排（prepare/submit/collect/续跑） | `orchestration` | 无任何前端 import |
| 正式合成 / AV profile | `composition` | 无任何前端 import |
| QCD 聚合与报表 | `qcd` | 无任何前端 import |
| 技术 QC / 终审 / 发布打包 / 归档 | `release` | 无任何前端 import |
| 离线多媒体生成 + 候选批次 + 选定晋升 | `media` | 无任何前端 import |
| 复用包发布/校验 | `profile` | 无任何前端 import |
| WFM3 自动化能力注册表 | `automation` | 无任何前端 import |
| 预算 guard / reservation / ledger / FX | `budget` | 仅经 `budget_standing` 只读露出一角 |

---

## 5. Partial Features（有入口但不完整）

| 能力 | 现状 |
| --- | --- |
| 付费视频生成 | 命令齐全、预检齐全，但需 `--enable-paid` + `AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1` + `WFM1_MINIMAX_API_KEY`，默认关闭 |
| 付费图像生成 | 路由在，但 ADR-0038 未授权，Provider 层拒绝 |
| 本地 TTS | 需另装 `piper-tts` + 模型文件，缺失时 503 |
| 场景层 | 领域模型完整，真实项目里 **48 集全部 0 场景 0 归属**，60 个镜头挂在「未分配到场景」（C-010） |
| 生成溯源 | 组件完整，真实项目 0 次生成，永远空态（C-008） |
| Skill 系统 | 21 个 Skill 已加载、可运行，但**没有自己的页面** —— 只作为右栏「能力 21 个」的折叠区 |
| Codex 运行时 | 已实现但主动 `unavailable`（注入面风险，需显式 env 开启） |

---

## 6. Dead / Unused Paths

| 路径 | 证据 |
| --- | --- |
| **`EPISODE_NAV`（ADR-0066 冻结 IA 的剧集制作五页）** | `shell.js` 导出，**除 shell.js 自身和测试外零消费者**。没有任何渲染器画它 |
| **`cutreview`（⑨ 粗剪审片）页面** | `production.js:807` 有渲染器、`:1562` 有绑定，但全仓库无 `data-mod="cutreview"` / `data-goto` / `setModule("cutreview")` / 别名指向 → **完全不可达** |
| `board` / `storyboard` / `shotwork` / `delivery` / `projectsettings` | 有渲染器，但只能靠历史键别名间接落到（`episode`→board、`shots`→storyboard、`video`→shotwork、`edit`→delivery、`storage`→projectsettings）。**没有一个按钮直呼其名** |
| `ASSET_NAV` 七行 rail | ADR-0066/TASK-073 说要变成页内筛选值，但 rail 仍在渲染（C-018），与页内 chips 重复 |
| `LEGACY_EPISODE_STAGES` 十一项 | TASK-073 说这是「旧入口，TASK-074 退休」，实测**它才是唯一入口** |
| 节点画布（`?canvas=1`） | ADR-0061 降级为诊断视图，创作路径不再经过 |
| `workspace_shell` 整个前端 | 对真实 Studio 项目 Portfolio 全空（C-020）—— **2026-08-24 结案：这是正确行为**，见 [ADR-0086](../../../docs/adr/ADR-0086-workspace-shell-serves-core-projects-only.md)。它的主语是 WFM1 核心项目；让 Studio 项目出现在这里只会把范围问题伪装成一堆缺陷 |
| Studio 服务端 `plan`/`problems`/`approvals` 路由 | 前端一次不调 |

---

## 7. 真实项目暴露的数据/状态缺陷（不是 UI 皮肤问题）

| # | 现象 | 证据 | 判断 |
| --- | --- | --- | --- |
| D-1 | 资产库 9 个资产里 **2 张渲染为浏览器碎图** | C-018 / C-007；`naturalWidth=0`；`media/` 里只有 7 个文件，缺 `ref-c6e26bfb-…`、`ref-5d4cf6e2-…` | 注册表引用的媒体字节丢失，UI 没有诚实空态（`shell.mediaBox` 的 placeholder 分支没生效） |
| D-2 | 存储页显示 **「媒体不可用 0」** | C-019 | `storageState` 只记录「App 自己删过」，**从不与文件系统核对**。声明状态 ≠ 实际状态 |
| D-3 | 顶栏 **「已花 ¥0 JPY · 余额 ¥0 JPY」** | C-002 等全部页面 | 后端 `budget_standing` 明确返回 `provenance: "unavailable"` + `"no config"` + 一条 `source_corrupt` problem；`realmap.js:7` `num()` 把非数字**强制成 0** |
| D-4 | 分集规划同屏出现 **48 集 / 12 集 / 47 集** | C-005 | 48=剧集实体数，12=规划 v4 条目数，47=AI 导演统计。三个数没有一个说明自己是什么 |
| D-5 | 真实项目缺 `config/wfm1.json` | 实测 `project.json` 只有 4 个字段 | 核心把它当「非项目」；`discover_projects` 看不见它 → `workspace_shell` 全空 |
| D-6 | 核心 `/shots` 返回 `[]`，canvas 里有 60 个镜头 | 实测 | 创作领域与核心领域**没有同步**，直到「锁定分镜」那一刻才写核心 |
| D-7 | CJK 项目名让 `server.py` 启动崩溃 | 实测（cp932 控制台）`UnicodeEncodeError` on `print(projects)` | 启动器打印项目名未指定编码；需 `PYTHONIOENCODING=utf-8` 才能起 |
| D-8 | 中栏标题与内容不符 | C-014「视频」页、C-017「后期交付」页仍写 `S1-01 … 制作流程图` | 中栏 header 是常驻 chrome，不随工作区切换 |
| D-9 | 面包屑写 `Shot 01`，页面是本集看板 | C-009 | 面包屑不反映当前页面的作用域 |

---

## 8. 一句话结论

> **后端不是短板。** 核心库有 19 个查询、60 个 CLI 能力、完整的编排/QCD/发布/学习闭环，
> 而界面只接了其中 3 个查询和 2 个写命令；Studio 用 38k 行 JS 和直调 ffmpeg
> 重新实现了核心早就有的一半东西，并且在它自己实现的那部分上，
> **把后端明确标记为「不可用」的数字渲染成了「0」。**
>
> 当前 UI 的首要问题**不是视觉，也不是信息架构，而是诚实性与暴露度**：
> 用户看到的状态有一部分是假的（D-1/D-2/D-3），
> 而真的、后端已经算好的状态，界面上没有位置放（§4）。
