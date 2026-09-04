# 当前架构合同（Current Architecture Contract）

**这份文件只回答「现在什么是成立的」（WHAT IS TRUE NOW）。**
「当时为什么这么定」（WHY / HISTORY）在 `docs/adr/` —— 两者刻意分开
（[ADR-0087](adr/ADR-0087-document-lifecycle-and-default-agent-context.md) 决策 4）。

- 它是**索引，不是副本**：每条只写结论，细节在「权威」列指向的文档里。
- 它是 **A 类当前事实**：过期即缺陷。改动使某条不再成立时，**在同一个提交里**
  改这里（dev-workflow 第 9 步收敛清单会问）。
- 目标长度 ≤ 200 行（`tests/tooling/test_lifecycle_check.py` 钉住）。超了说明在抄细节。
- 规则不在这里：Agent 必须遵守的条款只有 [AGENTS.md](../AGENTS.md) 一份。
  项目背景与路线在 [project-context.md](project-context.md)，逐项状态在
  [STATUS.md](STATUS.md)（生成的）。

---

## 1. 模块边界（现在有哪些盒子）

| 模块 | 位置 | 职责 | 权威 |
| --- | --- | --- | --- |
| **核心库** | `src/ai_video_workflow/` | 工作流领域逻辑：创意、资产、生成编排、合成、QCD、评价、Action、学习、预算、发布 | [architecture.md](architecture.md) |
| **Workspace 只读外壳** | `src/workspace_shell/` | WFM1 核心项目的只读观察面；**不服务 Studio 项目**（Portfolio 对 Studio 项目为空是正确行为） | [ADR-0086](adr/ADR-0086-workspace-shell-serves-core-projects-only.md) · [ADR-0032](adr/ADR-0032-workspace-runtime-and-ui-topology.md) |
| **Creation Studio（原型形态）** | `mockups/motv-workspace/` | 创作工作视窗：Python 后端 `server.py` + 浏览器前端 `src/*.js` | [creator-system-contract.md](design/creator-system-contract.md)（Studio 范围唯一权威） |
| **产品资产包** | `product-skills/`、`product-flows/` | 内置能力包与流程模板 —— **产品资产**，不是原型私有物。`user-capabilities.json` 是对话 Agent 看得见的那三个能力 | [ADR-0084](adr/ADR-0084-project-flow-template-as-a-package.md) 决策 7 · [ADR-0067](adr/ADR-0067-product-skill-package.md) · [ADR-0091](adr/ADR-0091-three-user-capabilities-and-a-server-side-resolver.md) |
| **人用启动器** | `scripts/launch/` | `studio.ps1`（Windows 权威）/ `studio.bat` / `studio.sh` | [ADR-0077](adr/ADR-0077-repository-path-ownership.md) |
| **Agent 工装** | `.claude/` | hooks（commit gate）、skills、tools —— 不是产品代码 | [ADR-0050](adr/ADR-0050-powershell-native-agent-dev-tooling.md) · [ADR-0062](adr/ADR-0062-windows-authoritative-environment.md) |

仓库路径所有权（哪个位置放什么）是 **ADR-0077**，它同时钉在
`tests/tooling/test_repository_layout.py` 上。

## 2. 依赖方向（哪边可以看见哪边）

```
浏览器前端 (mockups/motv-workspace/src/*.js)
      │  只经 HTTP /api/*
      ▼
Studio 后端 (mockups/motv-workspace/server.py)
      │  只 import 公共包 ai_video_workflow.*
      ▼
核心库 (src/ai_video_workflow/)          ← 永远不 import 上面任何一层
```

- **核心库不认识 Studio**：`src/` 里不得 import `mockups/`（现存两处提及都只是
  注释里的对照说明，不是 import）。
- **Studio 后端只吃公共包**：`ai_video_workflow.workspace` / `.app.*` / `.gateway`
  这类公开入口，不伸进私有实现。
- **前端不碰文件系统**：页面读不到磁盘，一切经后端端点（这是 `/api/skills`、
  `/api/flows` 存在的理由）。
- **Provider 中立**：核心工作流不依赖任何具体视频厂商，一律经 `VideoProvider`
  接入（AGENTS.md 第 8/9 条）。

## 3. 前后端合同（跨层的那条线）

| 合同 | 现在成立的形状 | 权威 |
| --- | --- | --- |
| **写路径** | 一切变更命令经 **Command Gateway**，前端不直接改核心业务文件 | [ADR-0033](adr/ADR-0033-command-gateway-contract.md) · AGENTS.md §4 |
| **生成写路径** | 工作视窗的生成命令 = `POST /api/projects/<name>/{preflight,command}` | [ADR-0041](adr/ADR-0041-workspace-generation-write-path.md) |
| **运行身份** | `runId` 是运行的**唯一身份**（`skillRunId` 别名已删除） | [TASK-074](tasks/active/TASK-074-delivery-migration-and-legacy-retirement.md) §1.5 |
| **对话里的能力路由** | 前端 Agent 只认 3 个用户能力（`story-development` / `episode-production` / `story-review`）；选哪个内部专业能力由**服务端 resolver** 确定性决定，模型无权指定 `skillId` | [ADR-0091](adr/ADR-0091-three-user-capabilities-and-a-server-side-resolver.md) |
| **只读投影** | 观察数据可从权威文件/事件重建；界面关闭不影响核心执行 | [ADR-0031](adr/ADR-0031-workspace-query-and-projection-contract.md) · [workspace-query-contract.md](design/workspace-query-contract.md) |
| **阶段 I/O** | L0–S7 每一步的输入输出 | [workflow-stage-step-io-contract.md](design/workflow-stage-step-io-contract.md) |
| **页面集合** | 固定信息架构，页面集合封闭（十一页，`PAGES.length === 11` 有守卫）；现行形状是三空间 / 故事开发四入口 / 剧集制作单画布 | [creator-product-information-architecture.md](design/creator-product-information-architecture.md)（当前事实）· [ADR-0066](adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) · [ADR-0092](adr/ADR-0092-story-development-is-four-entries.md) · [ADR-0094](adr/ADR-0094-greybox-previz-is-a-section-not-a-page.md) |
| **全站骨架** | 每一页恰好三栏：左控制/选择 · 中工作区 · **右栏只有对话**（消息流 + 底部输入），对话按页面分开 | [REQ-004](requirements/REQ-004-three-pane-shell-and-agent-conversation.md) v2/v3 |
| **交付生命周期** | 候选 → 质检 → 用户确认导出 → Final。渲染产出 `kind: "cut"`（**候选**）；`kind: "final"` 的**唯一**写入者是过了 G4 的显式导出，且 append（G5）。G4「没跑过质检 = 未知，不是通过」，且质检必须是**针对这一版**测的 | [creator-system-contract.md](design/creator-system-contract.md) §6.5 · [TASK-074](tasks/active/TASK-074-delivery-migration-and-legacy-retirement.md) §1.7 |
| **运行的恢复** | 还在跑的那一轮**从线程认出来**（有问没答），再问一次 `GET /api/runs/<id>`；**问不到 ≠ 没在跑**；恢复只落地、不起跑 | [ADR-0095](adr/ADR-0095-a-run-is-picked-up-from-the-thread-not-from-a-poller.md) |
| **退役中的旧接口** | `/api/agent/*` 同步分支正在退役；16 处同步长调用尚未改走 `run_id` | [TASK-106](tasks/active/TASK-106-frontend-run-path-and-legacy-endpoint-retirement.md) |

跨 py↔js 的合同验证只住 `tests/contract/`（Python 测试不得对前端 JS 做源码文本
断言，唯一例外见该目录 `test_frontend_write_path_invariants.py` 的 docstring）。

## 4. 测试归属（改了什么 → 跑哪个域）

| 域 | 目录 | 命令 |
| --- | --- | --- |
| 后端（核心库 + workspace_shell） | `tests/backend/` | `pytest tests/backend` |
| Studio Python 后端 | `tests/studio/` | `pytest tests/studio` |
| 跨 py↔js 合同 | `tests/contract/` | `pytest tests/contract` |
| 端到端关键路径 | `tests/e2e/` | `pytest tests/e2e -m "not serial"` + `pytest -m serial` |
| Agent 工装 | `tests/tooling/` | `pytest tests/tooling` |
| 前端 | `mockups/motv-workspace/tests/` | `node --test mockups/motv-workspace/tests/*.test.mjs` |

权威是 **AGENTS.md §20 + [ADR-0080](adr/ADR-0080-test-ownership-and-gate-mapping.md)**；
全量（两阶段 pytest + 全量前端 + ruff）是**集成检查点**，不是日常提交默认。
本地 commit gate 按同一张映射自动选域（`.claude/hooks/commit_gate_policy.py`）。

## 5. 当前架构约束（现在必须成立的不变量）

**本文件的节号就是引用句柄**：任务卡与 Review Package 引用架构约束时写 `CA §2`
（依赖方向）、`CA §5.3`（fail-closed）这种形式，不写「architecture: frontend」
（[ADR-0088](adr/ADR-0088-traceability-and-requirement-fulfillment-review.md) 决策 1）。
改这些节号等于改句柄 —— 增删条目可以，重排序号要连引用一起改。

1. **可重跑 / 可续跑**：每个步骤能单独执行；中断后从已完成步骤之后继续
   （AGENTS.md 第 11/12 条）。
2. **不静默覆盖**：禁止覆盖用户文件与已有生成结果；优先写**带版本的新路径**，
   迁移留可回滚旧数据，删除做成软删除（AGENTS.md 第 13 条）。
3. **fail-closed 的外部工具解析**：ffmpeg/ffprobe/piper/claude/codex/node 一律经
   `shutil.which`，失败即停，不得裸名调用（AGENTS.md 第 6 条 · ADR-0049）。
4. **平台中立**：路径走 pathlib/stdlib，不硬编码分隔符或用户目录；权威环境是
   原生 Windows + NTFS，Ubuntu 是受支持目标且其 CI job 必须绿
   （AGENTS.md 第 2/3 条 · [ADR-0062](adr/ADR-0062-windows-authoritative-environment.md)）。
5. **项目根围栏**：项目数据只在项目根内；包/资产解析后仍须落在自己根内，
   越界 fail-closed（[ADR-0004](adr/ADR-0004-project-root-containment-and-symlink-policy.md) ·
   [ADR-0053](adr/ADR-0053-project-rooted-studio-storage.md)）。
6. **付费边界**：只有 Accepted ADR 明确批准的窄范围才可接付费 API
   （[ADR-0006](adr/ADR-0006-paid-api-boundary-lift.md) · [ADR-0009](adr/ADR-0009-minimax-vendor-contract.md)）；
   **花钱是唯一必须问用户的事**。
7. **不提前泛化**：未经任务卡与 ADR，不提前实现 UI 专用状态机、不由 UI 发明
   pause/cancel/skip、不提前泛化 `VideoProvider`（AGENTS.md §4 尾）。

## 6. Agent 读什么（改页面之前先看这一节）

产品负责人 2026-08-30：「所以前端服务是看哪里的内容来进行创作的呢…**你每次改内容的
时候必须要结合这个设计做修改才不会断线**。」当天三个缺陷是同一个根因：页面改了，
喂给 Agent 的那份「世界观」没跟着改，于是它拿着旧地图给他指路。

**前端 Agent 一共读四样东西**，各自的来源与负责人：

| # | 它读什么 | 从哪来 | 住在哪 |
| --- | --- | --- | --- |
| 1 | 他在对话框里打的那句话 | 直接传给模型 | — |
| 2 | **项目当前事实** | 服务端读 `canvas.json` 组装 | `server.py` 的 `_conv_facts` |
| 3 | **页面地图**（界面现在长什么样） | 服务端常量，进每一段提示词 | `server.py` 的 `_CONV_PAGE_MAP` |
| 4 | **它能做的动作**（他能点的 = 它能做的） | 前端动作表，随请求上送 | `src/workflow/convactions.js` |
| 5 | **既定资产**（canon 输入：故事核心/大纲/人物/关系/世界观） | 能力运行时装配 | `src/controllers/skillctl.js` |

**skill 不是这份清单**：`product-skills/*/manifest.json` 只声明它要 `brief` /
`outline` 这些**名字**，名字落到哪份数据由第 5 条决定。2026-08-30 那条
「还缺 创意 Brief」正是名字还在、数据换了地方。

**因此这条是硬约束**：动了故事开发的任何一页（新增/改名/搬走/换数据位置），
上面第 2、3、5 条必须在**同一次改动里**跟着改。

由 [tests/contract/test_agent_reading_map_task122.py](../tests/contract/test_agent_reading_map_task122.py)
强制：左栏画出来的每一页都要出现在页面地图里；已经退休的名字（创意简报 / 项目与创意 /
分集规划 / 本集剧本）必须被显式禁掉；屏幕上有内容的每一处都要出现在事实里；
读得到的每一处都要有对应的写动作（否则就是他说的「这个前端的 agent 还是改不了」）。

## 7. 这份文件不回答什么

- **为什么**这么定 → `docs/adr/`（条数见 [STATUS.md](STATUS.md)；被取代的会写明取代者）。
- **谁还没做完** → [STATUS.md](STATUS.md) 与 `docs/tasks/active/`。
- **怎么运行** → [README.md](../README.md)。
- **规则** → [AGENTS.md](../AGENTS.md)。
