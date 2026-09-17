# 文档状态总览

> **本文件是生成的，不要手改。** 来源是各文档自己的状态行；
> 重新生成：`python .claude/tools/gen_docs_status.py`。
> `tests/tooling/test_docs_status.py` 会在它与文档不一致时转红 —— 手写索引一定
> 会漂移，这正是本文件要消除的缺陷（2026-08-23 一天查出五处过期状态，其中一处
> 错标签把两条真缺陷藏了十天）。
>
> **想一眼看到「每条需求做到哪了」，看 [工作进度](WORKSTATUS.md)** —— 同一条命令
> 生成，本文件是**文档清单**，那份是**需求进度**。

## 怎么读这份文档

| 位置 | 含义 |
| --- | --- |
| `docs/tasks/` | **所有任务卡，平铺一层**；状态看卡头那一行（ADR-0105） |
| `docs/design/active/` | 仍有未闭合项的设计、验收 runbook 与活账清单 |
| `docs/design/done/` | 已通过的评审、已落地的实施记录 —— 历史查阅 |
| `docs/adr/` | **决策记录**，没有「完成」这一维；被取代的写明取代者 |
| `docs/design/` 根 | **稳定合同与参考**，合同不会「做完」 |
| `docs/requirements/` | 需求记录：DRAFT / CONFIRMED / SUPERSEDED |
| `docs/reports/` | 阶段性工作报告与审查记录 —— **历史证据**，默认不读 |
| `docs/auto-push/` · `docs/skill-evolution/` | 工具维护的数据，不手改 |

卡头状态行只有三个词：`待办` 没人在做 · `进行中` 在办 · `完成` 已完成。

**当前**：9 在办 · 8 待办 · 132 已完成 · 89 条 ADR。

**找在办的任务**：本文件的「进行中 · 任务卡」一节，或
`python .claude/tools/agent_harness.py resume`，加上
[TASK-087 欠账总账](tasks/TASK-087-followup-ledger.md)。

## 默认加载什么（AGENTS.md 第 25 条 · ADR-0087 决策 5）

**默认读**：[AGENTS.md](../AGENTS.md) · 本次 Change 关联的 REQ ·
[当前架构合同](current-architecture.md) 里相关的那几行 ·
`docs/tasks/` 里**本次**这一张卡 · 本文件 · 影响范围内的代码与测试。

**默认不读**：状态为 `完成` 或 `待办` 的卡 · `design/done/` · `reports/` ·
未被当前架构合同指向的历史 ADR · 被取代的 REQ 版本 · 历史 Change 清单。
只有**回归调查 / 架构理由 / 历史冲突 / 需求演化 / 复现旧决策边界**这五种情形
才按需去读 —— 历史存在，但历史不占日常开发上下文。

---
## 当前真相（六面）

> **生成的。** 前三面来自 [project-context.md](project-context.md) 的
> `<!-- current-truth: … -->` 锚点（仓库里仅有的三行手写排期事实），
> 后三面从卡的状态行与 ADR 目录派生（AGENTS.md 第 27 条 ·
> [ADR-0101](adr/ADR-0101-idea-intake-level-and-milestone-gate.md) 决策 5 ·
> [ADR-0105](adr/ADR-0105-task-state-lives-on-the-card.md)）。

**新想法先过 Milestone Gate**：读下面第三面，四问（在当前里程碑交付面上 /
阻塞在办主线 / 不做会造成不可逆损害 / 是几分钟的当前事实修正）**全 No 就立
一张 `状态：待办` 的卡，不实施**。
闸判错可逆，因此不问用户（AGENTS.md §1–2）。

| 面 | 现在是什么 |
| --- | --- |
| **Mission** —— 这个产品为什么存在 | 构建覆盖「故事构思 → 剧本 → 场景镜头 → 资产 → 图片/视频生成 → 配音字幕 → 合成 → QCD」的 AI 视频 / 短剧生产工作流，核心对视频厂商保持中立。 |
| **Strategy** —— 用哪条路线达成 | 原 M1 最小闭环已完成并冻结为基础；WFM1 增量加入可复用短剧流程与云端默认生产路线；创作者 Studio 按 ADR-0066 四阶段落成产品界面；会花钱的能力按 Accepted ADR 逐个命令开门。 |
| **Current Milestone** —— 这一轮交付什么 | **先把小说写出来，再把它拍成片**（[REQ-009](requirements/REQ-009-write-the-novel-first-then-film-it.md)，产品负责人 2026-09-14 换的里程碑）：一个想法进去、一本小说出来，然后这本小说接进已经存在的视频线，四个垂直切片依次推进（一 AI 写得出一章**小说**正文 → 二 连着往下写、可停可改不覆盖 → 三 核心/大纲/结构在小说语境下成立 → 四 小说→剧集的真实转换），**不新增一级或二级页面**（ADR-0066 十一页闭集不动）；现在在**切片一**（TASK-146）。上一个里程碑「创作者 Studio 单一路径收敛」的切片 ①② 已闭合到机制层面，剩余（②的真实项目人工走查、③④⑤）降为背景工作，卡的状态仍是 `进行中`，不再是主线。 |

### Active Requirements

现在必须成立的产品需求。「在办卡」列是状态为 `进行中` 的卡里
卡头引用它的那些 —— **空不代表失效**，只代表这一轮没人在动它。

| REQ | 标题 | 状态 | 在办卡 |
| --- | --- | --- | --- |
| [REQ-001](requirements/REQ-001-auto-push.md) | REQ-001：Task 完成后自动 commit/push，Change 完成后受控合并 | CONFIRMED | — |
| [REQ-002](requirements/REQ-002-document-lifecycle.md) | REQ-002：文档与记录的统一生命周期 —— 当前事实保持精简，历史保持可追溯 | CONFIRMED | — |
| [REQ-003](requirements/REQ-003-traceability-and-requirement-fulfillment-review.md) | REQ-003：每一次实现都能从产品意图追到验证，审查先答「需求做完了吗」 | CONFIRMED | — |
| [REQ-004](requirements/REQ-004-three-pane-shell-and-agent-conversation.md) | REQ-004：全站统一三栏 —— 左控制/选择 · 中工作区 · 右 Agent 对话 | CONFIRMED | TASK-106 |
| [REQ-005](requirements/REQ-005-remove-a-project-from-the-home-list.md) | REQ-005：主页可以把项目从列表里删除（文件他自己删） | CONFIRMED | — |
| [REQ-006](requirements/REQ-006-agent-can-do-what-the-creator-can-do.md) | REQ-006：对话里的 Agent 能做创作者能做的事，并且能把意见带回给开发 | CONFIRMED | TASK-132 |
| [REQ-007](requirements/REQ-007-say-it-and-the-right-capability-runs.md) | REQ-007：他说一句话，对的那个专业能力就跑起来 | CONFIRMED | — |
| [REQ-008](requirements/REQ-008-images-from-my-own-account.md) | REQ-008：用我自己的账号自动出图，不要按次计费的 API | CONFIRMED | — |
| [REQ-009](requirements/REQ-009-write-the-novel-first-then-film-it.md) | REQ-009：先把小说写出来，再把它拍成片 | CONFIRMED | TASK-146 |

### Deferred

里程碑闸判「现在不做」的 8 张卡（状态 `待办`）——
**队列，不是垃圾桶**：每张卡都要写清什么条件下它会变成该做。
跨任务欠账另见 [TASK-087 总账](tasks/TASK-087-followup-ledger.md)。

- [TASK-011](tasks/TASK-011-local-video-provider.md) TASK-011：LocalVideoProvider（阶段 8）
- [TASK-012](tasks/TASK-012-qcd-auto-routing.md) TASK-012：基于 QCD 的自动模型路由（阶段 9）
- [TASK-128](tasks/TASK-128-episode-side-actions-into-the-table.md) TASK-128：剧集制作侧的写也走动作表 —— REQ-006 判据 1 的另一半
- [TASK-135](tasks/TASK-135-server-authoritative-workflow-plan.md) TASK-135：下一步该干什么由后端说了算 —— 服务端权威工作流计划
- [TASK-136](tasks/TASK-136-generation-resume-and-idempotency.md) TASK-136：重启之后不许重复扣费 —— 生成任务的续跑与幂等
- [TASK-137](tasks/TASK-137-review-issue-to-rework-loop.md) TASK-137：审片问题进入返工队列 —— 从问题定位到重新审片的闭环
- [TASK-138](tasks/TASK-138-story-development-visual-workflow.md) TASK-138：剧情制作不再是四张表单 —— 一条看得见的故事创作链
- [TASK-143](tasks/TASK-143-one-worktree-per-session.md) TASK-143：一棵工作树同时装八个会话，没有配套工具

### Recent Decisions

最近 5 条 ADR（新→旧）。**WHY / HISTORY 在这里**，**WHAT IS TRUE NOW 在**
[当前架构合同](current-architecture.md)，两者不合并（ADR-0098）。

| ADR | 标题 | 状态 |
| --- | --- | --- |
| [ADR-0105](adr/ADR-0105-task-state-lives-on-the-card.md) | ADR-0105：任务的状态住在卡上，不住在目录里 | Accepted（2026-09-17，产品负责人明确指示 |
| [ADR-0104](adr/ADR-0104-git-native-hook-is-the-authoritative-gate.md) | ADR-0104：权威的提交闸门是 git 原生 hook，PreToolUse 降级为快反馈 | Accepted（2026-09-16，实施 Agent 依 AGENTS.md §1 自行 Accept |
| [ADR-0103](adr/ADR-0103-two-planes-and-cost-based-depth.md) | ADR-0103：开发流程分两个面，深度按代价判 —— 不是继续加规则，是把规则分层 | Accepted（2026-09-08，实施 Agent 依 AGENTS.md §1 自行 Accept） |
| [ADR-0102](adr/ADR-0102-origin-and-confirmation-are-two-fields.md) | ADR-0102：发起方与确认方是两个字段 —— 「他在对话里说的」不等于「他自己点的」 | Accepted（2026-09-05，实施 Agent 依 AGENTS.md §1 自行 Accept） |
| [ADR-0101](adr/ADR-0101-idea-intake-level-and-milestone-gate.md) | ADR-0101：想法先分层、再过当前里程碑闸，然后才谈需求 | Accepted |

## 进行中 · 任务卡

还没做完的任务卡。「部分完成」也在这里 —— 只要还有人要接着做，它就是在办。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [TASK-040-final-unified-product-acceptance.md](tasks/TASK-040-final-unified-product-acceptance.md) | TASK-040：AI 短剧工作流与 Creation Workspace 最终统一验收 | 进行中 · 逐条判词见 §验收判词（2026-09-04 订正） |
| [TASK-074-delivery-migration-and-legacy-retirement.md](tasks/TASK-074-delivery-migration-and-legacy-retirement.md) | TASK-074：第四阶段 —— 后期交付、旧数据迁移、旧页面与旧接口清理、真实项目验收 | 进行中 · 部分实施 |
| [TASK-087-followup-ledger.md](tasks/TASK-087-followup-ledger.md) | TASK-087：Follow-up 总账 —— 把散在九张卡里的欠账收成一处 | 进行中 · 活账（不是一次性交付 |
| [TASK-106-frontend-run-path-and-legacy-endpoint-retirement.md](tasks/TASK-106-frontend-run-path-and-legacy-endpoint-retirement.md) | TASK-106：前端接上 run_id 路径 —— 并由此退役同步分支与 /api/agent/ | 进行中 · 部分实施（2026-09-04 |
| [TASK-132-click-ui-element-and-leave-feedback.md](tasks/TASK-132-click-ui-element-and-leave-feedback.md) | TASK-132：点击界面元素写意见，并让开发 Agent 收到准确位置 | 进行中 · 切片 A 完成、切片 B 完成核心、切片 C 未做（2026-09-05 实施 |
| [TASK-146-ai-writes-a-novel-chapter.md](tasks/TASK-146-ai-writes-a-novel-chapter.md) | TASK-146：小说模式下，AI 真的能写出一章小说 | 进行中 · 实现完成（2026-09-14） |
| [TASK-147-session-isolation-and-evidence-identity.md](tasks/TASK-147-session-isolation-and-evidence-identity.md) | TASK-147：一个会话一棵树，以及「上一轮那句验证」不再冒充新结论 | 进行中 · 切片 A / B 实现完成（2026-09-15） |
| [TASK-148-l5-continuous-autonomous-delivery.md](tasks/TASK-148-l5-continuous-autonomous-delivery.md) | TASK-148：L5 —— 给一个方向就连续交付，而且没人看着的时候不会静默放行 | 进行中 |
| [TASK-151-architecture-dependency-graph.md](tasks/TASK-151-architecture-dependency-graph.md) | TASK-151：架构依存关系由代码派生 —— 改了 X，谁会跟着受影响 | 进行中 |

## 待办 · 任务卡

已立卡但**没人在做**：需求成立、优先级未排。`进行中` 只给正在进行的工作，否则「待办 = 进行中的那些」会把没人做的也读成待办（ADR-0087 决策 2）。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [TASK-011-local-video-provider.md](tasks/TASK-011-local-video-provider.md) | TASK-011：LocalVideoProvider（阶段 8） | 待办 |
| [TASK-012-qcd-auto-routing.md](tasks/TASK-012-qcd-auto-routing.md) | TASK-012：基于 QCD 的自动模型路由（阶段 9） | 待办 |
| [TASK-128-episode-side-actions-into-the-table.md](tasks/TASK-128-episode-side-actions-into-the-table.md) | TASK-128：剧集制作侧的写也走动作表 —— REQ-006 判据 1 的另一半 | 待办 · 盘点完成，接线未开工 |
| [TASK-135-server-authoritative-workflow-plan.md](tasks/TASK-135-server-authoritative-workflow-plan.md) | TASK-135：下一步该干什么由后端说了算 —— 服务端权威工作流计划 | 待办 · 待开始（2026-09-05 开卡 |
| [TASK-136-generation-resume-and-idempotency.md](tasks/TASK-136-generation-resume-and-idempotency.md) | TASK-136：重启之后不许重复扣费 —— 生成任务的续跑与幂等 | 待办 · 待开始 · 前置 ADR 已 Accept（2026-09-05 开卡 |
| [TASK-137-review-issue-to-rework-loop.md](tasks/TASK-137-review-issue-to-rework-loop.md) | TASK-137：审片问题进入返工队列 —— 从问题定位到重新审片的闭环 | 待办 · 待开始（2026-09-05 开卡 |
| [TASK-138-story-development-visual-workflow.md](tasks/TASK-138-story-development-visual-workflow.md) | TASK-138：剧情制作不再是四张表单 —— 一条看得见的故事创作链 | 待办 · 待开始（2026-09-05 开卡 |
| [TASK-143-one-worktree-per-session.md](tasks/TASK-143-one-worktree-per-session.md) | TASK-143：一棵工作树同时装八个会话，没有配套工具 | 待办 · 未开始，且当前里程碑闸判定不做（2026-09-06 立卡） |

## 完成 · 任务卡

已完成、已验收或已退役。**退役**指目标被后续决策取代，不是被放弃。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [TASK-001-project-foundation.md](tasks/TASK-001-project-foundation.md) | TASK-001：项目基础（Project Foundation） | 完成 |
| [TASK-002-project-foundation-and-data-models.md](tasks/TASK-002-project-foundation-and-data-models.md) | TASK-002：项目骨架与核心数据模型（Project Foundation and Data Models） | 完成 |
| [TASK-003-video-provider-contract-and-manual-provider.md](tasks/TASK-003-video-provider-contract-and-manual-provider.md) | TASK-003：VideoProvider 契约与 ManualVideoProvider（Video Provider Contract and Manual Provider） | 完成 |
| [TASK-004-provider-orchestrator-foundation.md](tasks/TASK-004-provider-orchestrator-foundation.md) | TASK-004：Provider Orchestrator 契约与基础编排（Provider Orchestrator Contract and Foundational Orchestration） | 完成 |
| [TASK-005-video-file-validation.md](tasks/TASK-005-video-file-validation.md) | TASK-005：视频文件校验、VideoAsset 登记与 QCD 事件日志基础（阶段 3） | 完成 |
| [TASK-006-ffmpeg-composition.md](tasks/TASK-006-ffmpeg-composition.md) | TASK-006：FFmpeg 按镜头顺序合成（阶段 4） | 完成 |
| [TASK-007-workflow-bootstrap-and-cli.md](tasks/TASK-007-workflow-bootstrap-and-cli.md) | TASK-007：任务生成 Bootstrap、工作流驱动与最小 CLI（阶段 2 收尾 + 最小闭环接线） | 完成 |
| [TASK-008-subtitles-voice-audio.md](tasks/TASK-008-subtitles-voice-audio.md) | TASK-008：字幕、配音与音频合成（阶段 5） | 完成 |
| [TASK-009-qcd-aggregation-reporting.md](tasks/TASK-009-qcd-aggregation-reporting.md) | TASK-009：QCD 汇总、指标计算与报告（阶段 6） | 完成 |
| [TASK-010-cloud-video-provider.md](tasks/TASK-010-cloud-video-provider.md) | TASK-010：首个 CloudVideoProvider（阶段 7） | 完成 |
| [TASK-013-m1-findings-closure.md](tasks/TASK-013-m1-findings-closure.md) | TASK-013：M1 Findings Closure（整体审查 blocker/important 收口） | 完成 |
| [TASK-014-wfm1-contract-consolidation.md](tasks/TASK-014-wfm1-contract-consolidation.md) | TASK-014：WFM1 提交前合同收口（docs-only） | 完成 |
| [TASK-015-wfm1-config-approval-budget-alignment.md](tasks/TASK-015-wfm1-config-approval-budget-alignment.md) | TASK-015：WFM1 配置/审批/预算合同对齐（Batch A） | 完成 |
| [TASK-016-wfm1-cloud-provider-and-cost.md](tasks/TASK-016-wfm1-cloud-provider-and-cost.md) | TASK-016：WFM1 云端 Provider 接线与权威成本事实（Batch B） | 完成 |
| [TASK-017-minimax-real-api-and-smoke.md](tasks/TASK-017-minimax-real-api-and-smoke.md) | TASK-017：MiniMax/Hailuo 真实 API 接线与安全冒烟测试 | 完成 |
| [TASK-018-wfm1-project-and-reusable-assets.md](tasks/TASK-018-wfm1-project-and-reusable-assets.md) | TASK-018：WFM1 项目实例与复用资产边界 | 完成 |
| [TASK-019-wfm1-stage-approval-and-change-control.md](tasks/TASK-019-wfm1-stage-approval-and-change-control.md) | TASK-019：WFM1 阶段审批与变更控制 | 完成 |
| [TASK-020-wfm1-production-planning-and-task-packets.md](tasks/TASK-020-wfm1-production-planning-and-task-packets.md) | TASK-020：WFM1 生产规划与镜头任务包 | 完成 |
| [TASK-021-wfm1-paid-lifecycle-and-qcd-integration.md](tasks/TASK-021-wfm1-paid-lifecycle-and-qcd-integration.md) | TASK-021：WFM1 付费生成生命周期与 QCD 接回 | 完成 |
| [TASK-022-wfm1-qc-release-and-archive.md](tasks/TASK-022-wfm1-qc-release-and-archive.md) | TASK-022：WFM1 质检、发布包与归档收口 | 完成 |
| [TASK-023-wfm1-end-to-end-acceptance.md](tasks/TASK-023-wfm1-end-to-end-acceptance.md) | TASK-023：WFM1 端到端验收与文档收口 | 完成 |
| [TASK-024-workspace-query-contract-and-information-architecture.md](tasks/TASK-024-workspace-query-contract-and-information-architecture.md) | TASK-024：Creation Workspace 查询合同与信息架构收口（WSM0） | 完成 |
| [TASK-025-workspace-projection-and-query-service.md](tasks/TASK-025-workspace-projection-and-query-service.md) | TASK-025：可重建 Projection 与 Query Service（WSM1-A） | 完成 |
| [TASK-026-workspace-read-only-shell.md](tasks/TASK-026-workspace-read-only-shell.md) | TASK-026：跨项目只读工作视窗骨架（WSM1-B） | 完成 |
| [TASK-027-workspace-lineage-comparison-and-cost.md](tasks/TASK-027-workspace-lineage-comparison-and-cost.md) | TASK-027：谱系、提示词/产物比较与成本深钻（WSM1-C） | 完成 |
| [TASK-028-workspace-evaluation-experiment-decision.md](tasks/TASK-028-workspace-evaluation-experiment-decision.md) | TASK-028：评价、实验比较与创作决定（WSM2-A） | 完成 |
| [TASK-029-workspace-feedback-and-action.md](tasks/TASK-029-workspace-feedback-and-action.md) | TASK-029：Feedback、Action 合同与只读 Action Center（WSM2-B） | 完成 |
| [TASK-030-command-gateway-foundation.md](tasks/TASK-030-command-gateway-foundation.md) | TASK-030：Command Gateway、安全预检与命令回执（WSM2-C） | 完成 |
| [TASK-031-workspace-controlled-operations.md](tasks/TASK-031-workspace-controlled-operations.md) | TASK-031：工作视窗受控运行与 Action Center 写闭环（WSM2-D） | 完成 |
| [TASK-032-workspace-learning-and-recommendations.md](tasks/TASK-032-workspace-learning-and-recommendations.md) | TASK-032：项目复盘、跨项目学习与证据化推荐（WSM3-A） | 完成 |
| [TASK-033-workspace-end-to-end-acceptance.md](tasks/TASK-033-workspace-end-to-end-acceptance.md) | TASK-033：Creation Workspace WFM1 数据基线验收（WSM3-B） | 完成 |
| [TASK-034-wfm2-full-creative-and-audiovisual-design.md](tasks/TASK-034-wfm2-full-creative-and-audiovisual-design.md) | TASK-034：WFM2 完整创意与视听设计（L0–S3） | 完成 |
| [TASK-035-wfm2-multimedia-generation-and-lineage.md](tasks/TASK-035-wfm2-multimedia-generation-and-lineage.md) | TASK-035：WFM2 多媒体生成、资产谱系与统一成本 | 完成 |
| [TASK-036-wfm2-formal-postproduction-qc-release.md](tasks/TASK-036-wfm2-formal-postproduction-qc-release.md) | TASK-036：WFM2 正式后期、QC、发布与复盘 | 完成 |
| [TASK-037-wfm2-end-to-end-acceptance.md](tasks/TASK-037-wfm2-end-to-end-acceptance.md) | TASK-037：WFM2 正式作品端到端验收 | 完成 |
| [TASK-038-wfm3-automation-and-command-capabilities.md](tasks/TASK-038-wfm3-automation-and-command-capabilities.md) | TASK-038：WFM3 固定职责自动化与命令能力收口 | 完成 |
| [TASK-039-workspace-multimedia-and-full-workflow-expansion.md](tasks/TASK-039-workspace-multimedia-and-full-workflow-expansion.md) | TASK-039：Creation Workspace 多媒体与完整工作流扩展 | 完成 |
| [TASK-041-workspace-generation-command-and-evidence.md](tasks/TASK-041-workspace-generation-command-and-evidence.md) | TASK-041: 工作视窗付费视频生成命令 + UI 接入 + 1 次真实证据 | 完成 |
| [TASK-042-creative-agent-shots-draft.md](tasks/TASK-042-creative-agent-shots-draft.md) | TASK-042: 创意 Agent 分镜草稿（Claude CLI 通道）+ 画布自动衔接 | 完成 |
| [TASK-047-draft-lock-command.md](tasks/TASK-047-draft-lock-command.md) | TASK-047: lock-draft-plan 命令与图↔视频一致性打通 | Done（2026-08-07 实施完成） |
| [TASK-048-motv-p0-asset-flow-and-status.md](tasks/TASK-048-motv-p0-asset-flow-and-status.md) | TASK-048: motv 原型 P0 断层修复——图→视频流转、付费状态自动轮询、上传版本化 | 完成 · Done（2026-08-07 实施完成 |
| [TASK-049-native-windows-run-target.md](tasks/TASK-049-native-windows-run-target.md) | TASK-049: 冻结 V1 并使其在原生 Windows 上可复现运行 | 完成 · Done（2026-08-23 复查） |
| [TASK-050-powershell-agent-dev-tooling.md](tasks/TASK-050-powershell-agent-dev-tooling.md) | TASK-050: agent 开发工装 PowerShell 原生化（Windows 宿主） | 完成 · Delivered（2026-08-10） |
| [TASK-051-production-studio-ui-convergence.md](tasks/TASK-051-production-studio-ui-convergence.md) | TASK-051 — Production Studio UI 收敛（V1 视觉重建） | 完成 · 已退役（2026-08-23 复查） |
| [TASK-051A-ai-director-production-control-tower.md](tasks/TASK-051A-ai-director-production-control-tower.md) | TASK-051A — AI 导演升级为生产控制塔（Production Control Tower） | 完成 · 已退役（2026-08-23 复查） |
| [TASK-051B-landing-and-new-project.md](tasks/TASK-051B-landing-and-new-project.md) | TASK-051B — 落地页收敛与「新建项目」（项目名 + 资产位置） | 完成 · 已退役（2026-08-23 复查） |
| [TASK-052-agent-tooling-and-shell-hardening.md](tasks/TASK-052-agent-tooling-and-shell-hardening.md) | TASK-052 — Agent 工装与 workspace_shell 加固（审查遗留收口） | 完成 · 已完成（2026-08-23） |
| [TASK-053-choose-project-location.md](tasks/TASK-053-choose-project-location.md) | TASK-053 — 在界面里选任意路径，后端就往那儿写 | 完成 · 已验收并收口（2026-08-13，随 ADR-0051 一并收口） |
| [TASK-054-workflow-provenance-graph.md](tasks/TASK-054-workflow-provenance-graph.md) | TASK-054 — 工作流页面重做：生成溯源图 | 完成 · 已验收并收口（产品负责人 2026-08-13，随 ADR-0052 / ADR-0066 一并收口） |
| [TASK-055-project-rooted-storage.md](tasks/TASK-055-project-rooted-storage.md) | TASK-055 — Studio 数据与媒体落在项目目录内（high-risk checkpoint） | 完成 · 已验收并收口（2026-08-13，随 ADR-0053 一并收口） |
| [TASK-056-app-storage-location.md](tasks/TASK-056-app-storage-location.md) | TASK-056 — 应用级数据移出仓库（小 checkpoint） | 完成 · 实现完成（2026-08-23） |
| [TASK-057-production-upstream-workspace.md](tasks/TASK-057-production-upstream-workspace.md) | TASK-057：Production Upstream Workspace v1 | 完成 · 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-058-asset-registration-foundation.md](tasks/TASK-058-asset-registration-foundation.md) | TASK-058：Asset Registration Foundation（统一资产登记） | 完成 · 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-059-local-ai-runtime-and-film-skills.md](tasks/TASK-059-local-ai-runtime-and-film-skills.md) | TASK-059：Local AI Runtime + Film Skill Runtime | 完成 · 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-060-shot-production-and-dailies.md](tasks/TASK-060-shot-production-and-dailies.md) | TASK-060：Shot 生产状态 + 连续审片（Dailies） | 完成 · 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-061-asset-library-and-episode-production-ui.md](tasks/TASK-061-asset-library-and-episode-production-ui.md) | TASK-061：Asset Library + Episode Production UI | 完成 · 已完成（CP5–CP7 实施 + 真实 Connected 验收） |
| [TASK-062-integration-production-graph.md](tasks/TASK-062-integration-production-graph.md) | TASK-062：Integration / Production Graph | 完成 · 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-063-risk-based-commit-gate.md](tasks/TASK-063-risk-based-commit-gate.md) | TASK-063：风险分级本地 Commit Gate | 完成（2026-08-12） |
| [TASK-064-creator-ui-consolidation.md](tasks/TASK-064-creator-ui-consolidation.md) | TASK-064：创作者 IA 收口与自动初版剧集制作 | 完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-065-creator-object-first-ia.md](tasks/TASK-065-creator-object-first-ia.md) | TASK-065：创作对象优先的 IA 收口（基础资产 / 关系图 / 当前 Shot 生产图） | 完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-066-episode-production-shot-workbench.md](tasks/TASK-066-episode-production-shot-workbench.md) | TASK-066：剧集制作 = 把每个 Shot 做成「选定的最终 Shot Video」 | 完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-067-ai-director-operationalization.md](tasks/TASK-067-ai-director-operationalization.md) | TASK-067：AI 导演 / Skill / Agent 的可操作化 | 完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-068-legacy-agent-endpoints-to-runtime.md](tasks/TASK-068-legacy-agent-endpoints-to-runtime.md) | TASK-068：把旧 /api/agent/ 创作端点收进 Runtime 层 | 完成 · 已完成（由 TASK-072 §1.8 落地） |
| [TASK-069-manual-episode-plan-editing.md](tasks/TASK-069-manual-episode-plan-editing.md) | TASK-069：分集规划可以手工修改 | 完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-070-cast-seeded-from-outline.md](tasks/TASK-070-cast-seeded-from-outline.md) | TASK-070：初始人物从故事大纲的「主要角色概念」获取 | 完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-071-storyboard-first-episode-entry.md](tasks/TASK-071-storyboard-first-episode-entry.md) | TASK-071：进入剧集制作先定分镜，再逐镜详细制作 | 完成 · 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-072-system-contract-and-persistent-runs.md](tasks/TASK-072-system-contract-and-persistent-runs.md) | TASK-072：第二阶段 —— 后端合同、持久化任务、版本管理与兼容层 | 完成 · 已完成（2026-08-24 收口） |
| [TASK-073-fixed-ia-and-contextual-agent.md](tasks/TASK-073-fixed-ia-and-contextual-agent.md) | TASK-073：第三阶段 —— 前端信息架构、页面重构与上下文 Agent 交互 | 完成 · 已完成（2026-08-24 收口） |
| [TASK-075-product-skill-package.md](tasks/TASK-075-product-skill-package.md) | TASK-075：Product Skill Package —— Skill 从源码常量变成可加载的产品资产 | 完成 · 已完成 |
| [TASK-076-continuous-chain-gate.md](tasks/TASK-076-continuous-chain-gate.md) | TASK-076：让连续修改链在 commit gate 上真实生效 | 完成 · 已完成 |
| [TASK-077-honest-state-and-dead-surfaces.md](tasks/TASK-077-honest-state-and-dead-surfaces.md) | TASK-077：诚实状态与死掉的面 —— UI Gap Audit Phase 0 | 完成 · 已完成（六条交付全部完成 |
| [TASK-078-storyboard-table-to-first-frame.md](tasks/TASK-078-storyboard-table-to-first-frame.md) | TASK-078：从分镜到第一张画面 —— UI Gap Audit Phase 1 | 完成 · 已完成（2026-08-16，批次 A db2781a + 批次 B f9d637f，见 §8 实施记录） |
| [TASK-079-review-surface-and-chaining.md](tasks/TASK-079-review-surface-and-chaining.md) | TASK-079：审阅面与链式流转 —— UI Gap Audit Phase 1（后半） | 完成 · 已完成（2026-08-16，批次 A + B 均已提交） |
| [TASK-080-skill-catalog-and-one-agent-session.md](tasks/TASK-080-skill-catalog-and-one-agent-session.md) | TASK-080：能力可见 —— Skill 目录页 + 一个 Agent 会话（Phase 2 上半） | 完成 · 已完成（2026-08-16，三个批次三次提交） |
| [TASK-081-url-routing-and-deep-links.md](tasks/TASK-081-url-routing-and-deep-links.md) | TASK-081：URL 即状态 —— 路由与深链接（Phase 2 下半 · 之一） | 完成 · 已完成（2026-08-16，提交 3ca71e8） |
| [TASK-082-project-health-and-asset-tree.md](tasks/TASK-082-project-health-and-asset-tree.md) | TASK-082：项目健康与资产内容树（Phase 2 下半 · 之二） | 完成 · 已完成（2026-08-16 · 本链链尾） |
| [TASK-083-phase3-adrs-first.md](tasks/TASK-083-phase3-adrs-first.md) | TASK-083：Phase 3 —— 先落 ADR，再谈实现 | 完成 · 四个 ADR 全部已定，本卡收口（2026-08-23） |
| [TASK-084-clear-the-push-gate.md](tasks/TASK-084-clear-the-push-gate.md) | TASK-084：清掉 push 闸门上剩下的四项 | 完成 · 已完成（2026-08-16） |
| [TASK-085-gate-intent-detection.md](tasks/TASK-085-gate-intent-detection.md) | TASK-085：commit gate 改用 shell 自己的解析器判断意图 | 完成 · 已完成（2026-08-16） |
| [TASK-086-address-truth-and-count-scope.md](tasks/TASK-086-address-truth-and-count-scope.md) | TASK-086：地址说真话，数字带口径 | 完成 · 已完成（2026-08-16） |
| [TASK-088-episode-plan-as-an-ai-written-table.md](tasks/TASK-088-episode-plan-as-an-ai-written-table.md) | TASK-088：分集规划是一张 AI 写好、我能改的表 | 完成 · 已完成（2026-08-18） |
| [TASK-089-story-outline-eight-items.md](tasks/TASK-089-story-outline-eight-items.md) | TASK-089：故事大纲写这八项就够了 | 完成 · 已完成（2026-08-18） |
| [TASK-090-bible-is-derived-and-comes-last.md](tasks/TASK-090-bible-is-derived-and-comes-last.md) | TASK-090：作品设定是派生的，而且排在故事开发的最后 | 完成 · 已完成（2026-08-18） |
| [TASK-091-episode-production-is-a-nine-step-line.md](tasks/TASK-091-episode-production-is-a-nine-step-line.md) | TASK-091：剧本搬进剧集制作，九步变成一条看得见的线 | 完成 · 已退役（2026-08-17） |
| [TASK-092-shot-workflow-multi-stage.md](tasks/TASK-092-shot-workflow-multi-stage.md) | TASK-092：Shot 工作流从线性状态机升级成带依赖的多 Stage | 完成 · 已完成（2026-08-18，TASK-097 批次 1 · 提交 c94fd19 · ADR-0073） |
| [TASK-093-one-canvas-per-shot.md](tasks/TASK-093-one-canvas-per-shot.md) | TASK-093：一镜一画布 —— 把只读的制作流程图变成能干活的面 | 完成 · 已完成（2026-08-19，TASK-097 批次 3 · 提交 550504f） |
| [TASK-094-story-development-chain.md](tasks/TASK-094-story-development-chain.md) | TASK-094：故事开发这条链 —— 一个对话框从头做完 | 完成 · 已完成（2026-08-18） |
| [TASK-095-episode-production-wizard.md](tasks/TASK-095-episode-production-wizard.md) | TASK-095：剧集制作是一条向导，不是五个平级页面 | 完成 · 已完成（2026-08-20，TASK-097 批次 4A–4G + 4E） |
| [TASK-096-post-video-three-steps.md](tasks/TASK-096-post-video-three-steps.md) | TASK-096：视频之后那三步 —— 配音·音效 → 剪辑 → QC | 完成 · 已完成（2026-08-20，TASK-097 批次 5A / 5B） |
| [TASK-097-episode-production-chain.md](tasks/TASK-097-episode-production-chain.md) | TASK-097：剧集制作这条链 —— 一个对话框从头做完 | 完成 · 已完成（2026-08-20，13 个批次全部落地，链尾全量绿） |
| [TASK-098-camera-motion-preview.md](tasks/TASK-098-camera-motion-preview.md) | TASK-098：白膜视频 —— 让「运镜」第一次有反馈 | 完成 · 已完成（2026-08-22） |
| [TASK-099-repository-path-ownership.md](tasks/TASK-099-repository-path-ownership.md) | TASK-099：仓库根目录治理与启动器归档 | 完成 · 已完成（2026-08-23） |
| [TASK-100-skill-evolution-skill.md](tasks/TASK-100-skill-evolution-skill.md) | TASK-100：skill-evolution Skill v0.1 —— 受控的 Skill 演化闭环 | 完成 |
| [TASK-101-auto-push-skill.md](tasks/TASK-101-auto-push-skill.md) | TASK-101：auto-push Skill v0.1 —— Task 级自动 commit/push 与受控合并 | 完成 · 已合入 main（2026-08-23，产品负责人「合并并收口」），merge commit 17372a1 |
| [TASK-102-repo-test-decoupling.md](tasks/TASK-102-repo-test-decoupling.md) | TASK-102：仓库集成与解耦重构 —— 测试所有权、前后端边界、文档收敛 | 完成 · 本卡已完成并已合入 main（2026-08-22） |
| [TASK-103-frontback-and-ui-residuals.md](tasks/TASK-103-frontback-and-ui-residuals.md) | TASK-103：前后端交互与 UI 的剩余欠账 | 完成 · A–E 批已落地（2026-08-23） · 已合入 main（2026-08-23，产品负责人「合并并收口」），merge commit e5c52f7 |
| [TASK-104-governance-docs-merge.md](tasks/TASK-104-governance-docs-merge.md) | TASK-104：治理文档合并 —— AGENTS.md 成为唯一规范 | 完成 · 已完成（2026-08-23） · 已合入 main（2026-08-23，产品负责人「合并并收口」），merge commit 8b9eb81 |
| [TASK-105-flow-template-first-slice.md](tasks/TASK-105-flow-template-first-slice.md) | TASK-105：流程模板第一刀 —— 内置一份 flow，新建项目时可选 | 完成 · 第一刀实现完成（2026-08-24） |
| [TASK-107-document-lifecycle.md](tasks/TASK-107-document-lifecycle.md) | TASK-107：文档与记录的统一生命周期 —— 落到规则、工装与现有文档上 | 完成（2026-08-26） |
| [TASK-108-traceability-and-requirement-review.md](tasks/TASK-108-traceability-and-requirement-review.md) | TASK-108：把「产品意图 → 验证」的追溯链与需求完成度审查接进开发流程 | 完成（2026-08-26） |
| [TASK-109-three-pane-shell-and-agent-conversation.md](tasks/TASK-109-three-pane-shell-and-agent-conversation.md) | TASK-109：全站三栏骨架 + 右栏改成真正的 Agent 对话框 | 完成（2026-08-27） |
| [TASK-110-remove-project-from-home.md](tasks/TASK-110-remove-project-from-home.md) | TASK-110：主页可以把项目从列表里移除（文件他自己删） | 完成（2026-08-27） |
| [TASK-111-agent-applies-its-own-edits.md](tasks/TASK-111-agent-applies-its-own-edits.md) | TASK-111：让对话里的 Agent 真的把改动落到作品上 | 完成（2026-08-29） |
| [TASK-112-connected-home-list-shows-only-backend-projects.md](tasks/TASK-112-connected-home-list-shows-only-backend-projects.md) | TASK-112：已连接后端时，主页只显示后端真的有的项目 | 完成（2026-08-29） |
| [TASK-113-latest-version-only-and-apply-outlet.md](tasks/TASK-113-latest-version-only-and-apply-outlet.md) | TASK-113：版本行默认只露最新版；还没落下的改动有个出口 | 完成（2026-08-29） |
| [TASK-114-agent-action-registry-and-feedback-loop.md](tasks/TASK-114-agent-action-registry-and-feedback-loop.md) | TASK-114：动作注册表（Agent 能做创作者能做的事）+ 意见回路 | 完成（2026-08-29） |
| [TASK-115-delete-with-an-undo-everywhere.md](tasks/TASK-115-delete-with-an-undo-everywhere.md) | TASK-115：故事与镜头都能删 —— 而且都能撤销 | 完成（2026-08-29） |
| [TASK-116-proposal-loop-both-ways.md](tasks/TASK-116-proposal-loop-both-ways.md) | TASK-116：提案回路 —— 我提案，他在对话里拍板，我读回他的决定 | 完成（2026-08-29） |
| [TASK-117-two-chat-windows.md](tasks/TASK-117-two-chat-windows.md) | TASK-117：两个聊天窗口 —— 「作品」改东西，「开发」提意见 | 完成（2026-08-29） |
| [TASK-118-frontend-triggers-a-dev-plan.md](tasks/TASK-118-frontend-triggers-a-dev-plan.md) | TASK-118：前端能触发后端出方案 + product-loop Skill | 完成（2026-08-29） |
| [TASK-119-three-user-capabilities-and-a-resolver.md](tasks/TASK-119-three-user-capabilities-and-a-resolver.md) | TASK-119：三个用户能力 + 后端 resolver | 完成 · 实现完成（2026-08-29） |
| [TASK-120-feedback-carries-a-locator.md](tasks/TASK-120-feedback-carries-a-locator.md) | TASK-120：意见自带定位情报 —— 让后端更快找到那一页 | 完成（2026-08-29） |
| [TASK-121-proposals-you-can-actually-see.md](tasks/TASK-121-proposals-you-can-actually-see.md) | TASK-121：方案要看得见、答过的不再问、发送后不跳回顶部 | 完成 · 已完成（2026-08-30 交付，2026-09-04 收口） |
| [TASK-122-story-development-four-entries.md](tasks/TASK-122-story-development-four-entries.md) | TASK-122：Story Development 按他的规格重构 —— 四个入口 | 完成 · 已完成（2026-08-30 六步全部落地，逐条真浏览器验收见下 |
| [TASK-123-greybox-previz.md](tasks/TASK-123-greybox-previz.md) | TASK-123：3D 白膜导演台 | 完成 · 已完成（v1）（2026-08-30 落地，可在真实项目上摆位、预览、录白膜 |
| [TASK-124-episode-canvas.md](tasks/TASK-124-episode-canvas.md) | TASK-124：剧集制作收成一块画布 | 完成 · 已完成（v1）（2026-08-30 落地 |
| [TASK-125-current-truth-convergence.md](tasks/TASK-125-current-truth-convergence.md) | TASK-125：切片 1 —— 当前事实收口 | 完成 · 已完成（2026-09-04 开卡，2026-09-05 收口） |
| [TASK-126-agent-sees-and-changes-everything.md](tasks/TASK-126-agent-sees-and-changes-everything.md) | TASK-126：Agent 看得见全部、也改得动全部（2026-08-30～09-03 连续实施的补登卡） | 完成 · 已完成（2026-09-03 最后一提交） |
| [TASK-127-one-action-table.md](tasks/TASK-127-one-action-table.md) | TASK-127：切片 4 —— 他能点的 = 它能做的，靠一张表 | 完成 · 实现完成（2026-09-05 |
| [TASK-129-settings-structure-writes-into-the-table.md](tasks/TASK-129-settings-structure-writes-into-the-table.md) | TASK-129：作品设定的结构写也走动作表 —— REQ-006 判据 1 的第三块 | 完成 · 实现完成（2026-09-05 收口，切片 2e 划掉棘轮里最后两个名字） |
| [TASK-130-connected-sample-and-journey.md](tasks/TASK-130-connected-sample-and-journey.md) | TASK-130：切片 5 —— 可重复的 Connected Project 样本 + 一条从头到尾的旅程 | 完成 · 实现完成（2026-09-05 |
| [TASK-131-agent-harness-discovery-and-runtime-evidence.md](tasks/TASK-131-agent-harness-discovery-and-runtime-evidence.md) | TASK-131：让 Claude / Codex 找到同一套技能，并验证工装真正生效 | 完成 · 实现完成（2026-09-05） |
| [TASK-133-glossary-and-out-of-scope-index.md](tasks/TASK-133-glossary-and-out-of-scope-index.md) | TASK-133：给「名字」和「不做」各一个落点 —— 术语表与范围外索引 | 完成（2026-09-05） |
| [TASK-134-import-linter-layering-contract.md](tasks/TASK-134-import-linter-layering-contract.md) | TASK-134：把 Provider 中立从散文变成 CI 闸门 —— import-linter 分层契约 | 完成 · 实现完成（2026-09-05 实施）· 最终全量见下方「验证」 |
| [TASK-139-images-from-my-own-account.md](tasks/TASK-139-images-from-my-own-account.md) | TASK-139：用他自己的账号额度出图 —— 第三条路，不过付费闸 | 完成 · 实现完成（2026-09-05）· 真实证据已闭合（他自己在界面上点出了图 |
| [TASK-140-main-ci-has-been-red-for-nine-days.md](tasks/TASK-140-main-ci-has-been-red-for-nine-days.md) | TASK-140：main 的 CI 连续八次全红，而没有人看见 | 完成 · 实现完成（2026-09-05 接手 · 2026-09-06 收口） |
| [TASK-141-idea-intake-and-current-truth.md](tasks/TASK-141-idea-intake-and-current-truth.md) | TASK-141：想法入口 —— 分层、里程碑闸与可重建的当前真相 | 完成 · 已完成（2026-09-05 开卡 · 同日收口 · codex 独立审查 2 轮 pass） |
| [TASK-142-a-save-refused-by-a-reader.md](tasks/TASK-142-a-save-refused-by-a-reader.md) | TASK-142：他打的字，因为「有人正在读那个文件」而丢掉 | 完成 · 实现完成（2026-09-06 · 提交 6d9473b） |
| [TASK-144-dev-workflow-v03-two-planes.md](tasks/TASK-144-dev-workflow-v03-two-planes.md) | TASK-144：dev-workflow v0.3 —— 压成「人类控制面 / Agent 执行面」两层 | 完成 |
| [TASK-145-workstatus.md](tasks/TASK-145-workstatus.md) | TASK-145：一屏看完「每条需求做到哪了」 | 完成 · 实现完成（2026-09-08） |
| [TASK-149-task-prerequisites-are-machine-readable.md](tasks/TASK-149-task-prerequisites-are-machine-readable.md) | TASK-149：卡上的「前置」变成机器读得到的边，队列按它排 | 完成 · 实现完成并经三轮独立审查收口（2026-09-17，与 TASK-150 合审，记录在 |
| [TASK-150-task-state-on-the-card.md](tasks/TASK-150-task-state-on-the-card.md) | TASK-150：任务的状态住在卡上 —— 目录平铺，「在办的有哪些」由工具回答 | 完成 · 实现完成并经三轮独立审查收口（2026-09-17） |

## 在办 · 设计与验收文档

仍有未闭合项的设计、验收 runbook 与活账清单。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [final-unified-acceptance-runbook.md](design/active/final-unified-acceptance-runbook.md) | 最终统一验收 Runbook（TASK-040） | — |
| [final-unified-acceptance-traceability.md](design/active/final-unified-acceptance-traceability.md) | 最终统一验收追踪矩阵（TASK-040） | — |
| [pending-codex-rereview.md](design/active/pending-codex-rereview.md) | 待补 codex 复审清单（活账） | 活账（不是一次性交付） |
| [product-requirement-and-ux-convergence-review.md](design/active/product-requirement-and-ux-convergence-review.md) | 产品需求与界面简洁性收敛审查 | 当前整改依据（2026-09-04） |
| [proposal-one-surface-list.md](design/active/proposal-one-surface-list.md) | 提案：一份「面清单」，让「我明明写了你怎么看不到」不再发生 | 提案，等他拍板 |

## 已完成 · 设计与验收记录

已通过的里程碑评审、已落地的实施记录，及其任务卡已收口的设计文档。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [M1-milestone-review.md](design/done/M1-milestone-review.md) | M1 Milestone Review Record | — |
| [TASK-003-provider-contract-design.md](design/done/TASK-003-provider-contract-design.md) | TASK-003 设计文档：VideoProvider 契约与 ManualVideoProvider | approved — ready for implementation |
| [TASK-004-provider-orchestrator-design.md](design/done/TASK-004-provider-orchestrator-design.md) | TASK-004 设计文档：Provider Orchestrator 契约与基础编排 | completed — implementation complete through Step G; Codex |
| [TASK-008-audio-subtitle-design.md](design/done/TASK-008-audio-subtitle-design.md) | TASK-008 Focused Design — Subtitles, Voice-over, Audio (M2) | 聚焦设计定案（用户已批准 3 项产品假设「全按推荐」+ 批准 |
| [TASK-009-qcd-aggregation-design.md](design/done/TASK-009-qcd-aggregation-design.md) | TASK-009 Focused Design — QCD Aggregation, Metrics, Reporting | 聚焦设计定案（M2 |
| [WFM1-milestone-review.md](design/done/WFM1-milestone-review.md) | WFM1 Milestone Review（TASK-023 gate） | — |
| [WFM2-milestone-review.md](design/done/WFM2-milestone-review.md) | WFM2 里程碑评审记录（TASK-037） | — |
| [WSM3-workspace-wfm1-milestone-review.md](design/done/WSM3-workspace-wfm1-milestone-review.md) | WSM3 Workspace WFM1 数据基线里程碑评审（TASK-033 gate） | — |
| [codex-rereview-history-2026-08.md](design/done/codex-rereview-history-2026-08.md) | codex 补审历史（2026-08-13 – 2026-08-23）—— 已闭合，仅作历史查阅 | 已完成（全部条目已闭合 |
| [commit-gate-intent-detection.md](design/done/commit-gate-intent-detection.md) | commit gate 的意图判定：从正则读命令文本，改成用每个 shell 自己的解析器 | 已实施（2026-08-16，TASK-085） |
| [creation-workspace-implementation-roadmap.md](design/done/creation-workspace-implementation-roadmap.md) | Creation Workspace ADR 与实施任务路线 | 已完成（规划基线已被消化，2026-08-26 归档） |
| [final-unified-milestone-review.md](design/done/final-unified-milestone-review.md) | 最终统一产品里程碑评审记录（TASK-040） | 已完成（评审记录本身在 2026-08-04 就已写完并定稿 |
| [handover-2026-08-23-remaining-active-tasks.md](design/done/handover-2026-08-23-remaining-active-tasks.md) | 交接：docs/tasks/ 的剩余任务（2026-08-23） | — |
| [pending-speedup-and-gate-fix.md](design/done/pending-speedup-and-gate-fix.md) | 测试提速 + commit gate 分类修复 | 已落地（2026-08-15） |
| [remaining-roadmap-design-report.md](design/done/remaining-roadmap-design-report.md) | 剩余 Roadmap 整体设计报告（供 Codex 一次性架构审查） | — |
| [task097-handover-2026-08-19.md](design/done/task097-handover-2026-08-19.md) | TASK-097 交接说明（2026-08-19，换机器） | — |
| [wfm2-acceptance-runbook.md](design/done/wfm2-acceptance-runbook.md) | WFM2 正式作品验收 Runbook（TASK-037） | — |
| [wfm2-acceptance-traceability.md](design/done/wfm2-acceptance-traceability.md) | WFM2 端到端验收追踪矩阵（TASK-037） | — |
| [workspace-wfm1-acceptance-runbook.md](design/done/workspace-wfm1-acceptance-runbook.md) | Workspace WFM1 数据基线验收 Runbook（TASK-033 / WSM3-B） | Approved acceptance evidence（2026-08-03） |
| [workspace-wfm1-acceptance-traceability.md](design/done/workspace-wfm1-acceptance-traceability.md) | Workspace WFM1 数据基线验收追踪矩阵（TASK-033 / WSM3-B） | Approved acceptance evidence（2026-08-03） |

## 稳定参考（没有「完成」这一维）

合同不会「做完」，决策只要 Accepted 就一直有效 —— 所以它们没有状态行里的三态。

| 位置 | 放什么 |
| --- | --- |
| [当前架构合同](current-architecture.md) | **现在**成立的边界与约束（NOW） |
| [`docs/adr/`](adr/) | 89 条决策记录（ADR-0001 … ADR-0105）—— WHY / HISTORY |
| [`docs/design/`](design/) 根 | 系统合同、产品信息架构、L0–S7 I/O 合同 |
| [项目背景与路线](project-context.md) | 这个项目是什么、走到哪了 |
| [实施规划](implementation_plan.md) | 阶段与里程碑路线图 |
| [产品规格](product_spec.md) · [架构](architecture.md) | 规格与架构基线 |
