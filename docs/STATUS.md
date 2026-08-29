# 文档状态总览

> **本文件是生成的，不要手改。** 来源是 `docs/` 的目录结构与各文档自己的状态行；
> 重新生成：`python .claude/tools/gen_docs_status.py`。
> `tests/tooling/test_docs_status.py` 会在它与目录不一致时转红 —— 手写索引一定
> 会漂移，这正是本文件要消除的缺陷（2026-08-23 一天查出五处过期状态，其中一处
> 错标签把两条真缺陷藏了十天）。

## 怎么读这份文档

| 位置 | 含义 |
| --- | --- |
| `docs/tasks/active/` · `docs/design/active/` | **还没做完**，需要有人接手 |
| `docs/tasks/backlog/` | **没人在做**：已立卡但未排期（默认不读） |
| `docs/tasks/done/` · `docs/design/done/` | **已经做完**，只作历史查阅 |
| `docs/adr/` | **决策记录**，没有「完成」这一维；被取代的写明取代者 |
| `docs/design/` 根 | **稳定合同与参考**，合同不会「做完」 |
| `docs/requirements/` | 需求记录：DRAFT / CONFIRMED / SUPERSEDED |
| `docs/reports/` | 阶段性工作报告 —— **历史证据**，默认不读 |
| `docs/auto-push/` · `docs/skill-evolution/` | 工具维护的数据，不手改 |

**当前**：5 在办 · 2 待排期 · 110 已完成 · 74 条 ADR。

**找待办只看 `active/` 两个目录**，加上
[TASK-087 欠账总账](tasks/active/TASK-087-followup-ledger.md)。

## 默认加载什么（AGENTS.md 第 25 条 · ADR-0087 决策 5）

**默认读**：[AGENTS.md](../AGENTS.md) · 本次 Change 关联的 REQ ·
[当前架构合同](current-architecture.md) 里相关的那几行 ·
`docs/tasks/active/` 里**本次**这一张卡 · 本文件 · 影响范围内的代码与测试。

**默认不读**：`tasks/done/` · `design/done/` · `tasks/backlog/` · `reports/` ·
未被当前架构合同指向的历史 ADR · 被取代的 REQ 版本 · 历史 Change 清单。
只有**回归调查 / 架构理由 / 历史冲突 / 需求演化 / 复现旧决策边界**这五种情形
才按需去读 —— 历史存在，但历史不占日常开发上下文。

---
## 在办 · 任务卡

还没做完的任务卡。「部分完成」也在这里 —— 只要还有人要接着做，它就是在办。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [TASK-040-final-unified-product-acceptance.md](tasks/active/TASK-040-final-unified-product-acceptance.md) | TASK-040：AI 短剧工作流与 Creation Workspace 最终统一验收 | Evidence Ready — 等用户一句话确认（2026-08-04） |
| [TASK-041-workspace-generation-command-and-evidence.md](tasks/active/TASK-041-workspace-generation-command-and-evidence.md) | TASK-041: 工作视窗付费视频生成命令 + UI 接入 + 1 次真实证据 | Accepted（2026-08-07，用户「同意」） |
| [TASK-074-delivery-migration-and-legacy-retirement.md](tasks/active/TASK-074-delivery-migration-and-legacy-retirement.md) | TASK-074：第四阶段 —— 后期交付、旧数据迁移、旧页面与旧接口清理、真实项目验收 | 部分实施（2026-08-25 更新） |
| [TASK-087-followup-ledger.md](tasks/active/TASK-087-followup-ledger.md) | TASK-087：Follow-up 总账 —— 把散在九张卡里的欠账收成一处 | 活账（不是一次性交付 |
| [TASK-106-frontend-run-path-and-legacy-endpoint-retirement.md](tasks/active/TASK-106-frontend-run-path-and-legacy-endpoint-retirement.md) | TASK-106：前端接上 run_id 路径 —— 并由此退役同步分支与 /api/agent/ | 待开始（分析已完成，见 §1 |

## 在办 · 设计与验收文档

仍有未闭合项的设计、验收 runbook 与活账清单。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [final-unified-acceptance-runbook.md](design/active/final-unified-acceptance-runbook.md) | 最终统一验收 Runbook（TASK-040） | — |
| [final-unified-acceptance-traceability.md](design/active/final-unified-acceptance-traceability.md) | 最终统一验收追踪矩阵（TASK-040） | — |
| [pending-codex-rereview.md](design/active/pending-codex-rereview.md) | 待补 codex 复审清单（活账） | 活账（不是一次性交付） |

## 待排期 · 任务卡

已立卡但**没人在做**：需求成立、优先级未排。`active/` 只放正在进行的工作，否则「待办 = ls active/」会把没人做的也读成待办（ADR-0087 决策 2）。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [TASK-011-local-video-provider.md](tasks/backlog/TASK-011-local-video-provider.md) | TASK-011：LocalVideoProvider（阶段 8） | Outline（可选 WFM3 升级） |
| [TASK-012-qcd-auto-routing.md](tasks/backlog/TASK-012-qcd-auto-routing.md) | TASK-012：基于 QCD 的自动模型路由（阶段 9） | Outline（WFM3） |

## 已完成 · 任务卡

已完成、已验收或已退役。**退役**指目标被后续决策取代，不是被放弃。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [TASK-001-project-foundation.md](tasks/done/TASK-001-project-foundation.md) | TASK-001：项目基础（Project Foundation） | — |
| [TASK-002-project-foundation-and-data-models.md](tasks/done/TASK-002-project-foundation-and-data-models.md) | TASK-002：项目骨架与核心数据模型（Project Foundation and Data Models） | — |
| [TASK-003-video-provider-contract-and-manual-provider.md](tasks/done/TASK-003-video-provider-contract-and-manual-provider.md) | TASK-003：VideoProvider 契约与 ManualVideoProvider（Video Provider Contract and Manual Provider） | — |
| [TASK-004-provider-orchestrator-foundation.md](tasks/done/TASK-004-provider-orchestrator-foundation.md) | TASK-004：Provider Orchestrator 契约与基础编排（Provider Orchestrator Contract and Foundational Orchestration） | — |
| [TASK-005-video-file-validation.md](tasks/done/TASK-005-video-file-validation.md) | TASK-005：视频文件校验、VideoAsset 登记与 QCD 事件日志基础（阶段 3） | 已实现（IMPLEMENTED），并已随 TASK-013 |
| [TASK-006-ffmpeg-composition.md](tasks/done/TASK-006-ffmpeg-composition.md) | TASK-006：FFmpeg 按镜头顺序合成（阶段 4） | 已实现（IMPLEMENTED），并已随 TASK-013 |
| [TASK-007-workflow-bootstrap-and-cli.md](tasks/done/TASK-007-workflow-bootstrap-and-cli.md) | TASK-007：任务生成 Bootstrap、工作流驱动与最小 CLI（阶段 2 收尾 + 最小闭环接线） | 已实现（IMPLEMENTED），并已随 TASK-013 |
| [TASK-008-subtitles-voice-audio.md](tasks/done/TASK-008-subtitles-voice-audio.md) | TASK-008：字幕、配音与音频合成（阶段 5） | 已交付（WFM2，2026-08-04） |
| [TASK-009-qcd-aggregation-reporting.md](tasks/done/TASK-009-qcd-aggregation-reporting.md) | TASK-009：QCD 汇总、指标计算与报告（阶段 6） | Implemented |
| [TASK-010-cloud-video-provider.md](tasks/done/TASK-010-cloud-video-provider.md) | TASK-010：首个 CloudVideoProvider（阶段 7） | Historical / Superseded |
| [TASK-013-m1-findings-closure.md](tasks/done/TASK-013-m1-findings-closure.md) | TASK-013：M1 Findings Closure（整体审查 blocker/important 收口） | 已实现并验收（IMPLEMENTED AND ACCEPTED） |
| [TASK-014-wfm1-contract-consolidation.md](tasks/done/TASK-014-wfm1-contract-consolidation.md) | TASK-014：WFM1 提交前合同收口（docs-only） | Accepted（合同锁定） |
| [TASK-015-wfm1-config-approval-budget-alignment.md](tasks/done/TASK-015-wfm1-config-approval-budget-alignment.md) | TASK-015：WFM1 配置/审批/预算合同对齐（Batch A） | Implemented |
| [TASK-016-wfm1-cloud-provider-and-cost.md](tasks/done/TASK-016-wfm1-cloud-provider-and-cost.md) | TASK-016：WFM1 云端 Provider 接线与权威成本事实（Batch B） | Implemented |
| [TASK-017-minimax-real-api-and-smoke.md](tasks/done/TASK-017-minimax-real-api-and-smoke.md) | TASK-017：MiniMax/Hailuo 真实 API 接线与安全冒烟测试 | Implemented |
| [TASK-018-wfm1-project-and-reusable-assets.md](tasks/done/TASK-018-wfm1-project-and-reusable-assets.md) | TASK-018：WFM1 项目实例与复用资产边界 | Implemented |
| [TASK-019-wfm1-stage-approval-and-change-control.md](tasks/done/TASK-019-wfm1-stage-approval-and-change-control.md) | TASK-019：WFM1 阶段审批与变更控制 | Implemented |
| [TASK-020-wfm1-production-planning-and-task-packets.md](tasks/done/TASK-020-wfm1-production-planning-and-task-packets.md) | TASK-020：WFM1 生产规划与镜头任务包 | Implemented |
| [TASK-021-wfm1-paid-lifecycle-and-qcd-integration.md](tasks/done/TASK-021-wfm1-paid-lifecycle-and-qcd-integration.md) | TASK-021：WFM1 付费生成生命周期与 QCD 接回 | Implemented |
| [TASK-022-wfm1-qc-release-and-archive.md](tasks/done/TASK-022-wfm1-qc-release-and-archive.md) | TASK-022：WFM1 质检、发布包与归档收口 | Implemented |
| [TASK-023-wfm1-end-to-end-acceptance.md](tasks/done/TASK-023-wfm1-end-to-end-acceptance.md) | TASK-023：WFM1 端到端验收与文档收口 | Implemented |
| [TASK-024-workspace-query-contract-and-information-architecture.md](tasks/done/TASK-024-workspace-query-contract-and-information-architecture.md) | TASK-024：Creation Workspace 查询合同与信息架构收口（WSM0） | Docs-complete |
| [TASK-025-workspace-projection-and-query-service.md](tasks/done/TASK-025-workspace-projection-and-query-service.md) | TASK-025：可重建 Projection 与 Query Service（WSM1-A） | Accepted（2026-08-02，独立审查两轮通过） |
| [TASK-026-workspace-read-only-shell.md](tasks/done/TASK-026-workspace-read-only-shell.md) | TASK-026：跨项目只读工作视窗骨架（WSM1-B） | Done（2026-08-03） |
| [TASK-027-workspace-lineage-comparison-and-cost.md](tasks/done/TASK-027-workspace-lineage-comparison-and-cost.md) | TASK-027：谱系、提示词/产物比较与成本深钻（WSM1-C） | 已完成（2026-08-24） |
| [TASK-028-workspace-evaluation-experiment-decision.md](tasks/done/TASK-028-workspace-evaluation-experiment-decision.md) | TASK-028：评价、实验比较与创作决定（WSM2-A） | Delivered（步骤 1–5，2026-08-03） |
| [TASK-029-workspace-feedback-and-action.md](tasks/done/TASK-029-workspace-feedback-and-action.md) | TASK-029：Feedback、Action 合同与只读 Action Center（WSM2-B） | Delivered（2026-08-03 |
| [TASK-030-command-gateway-foundation.md](tasks/done/TASK-030-command-gateway-foundation.md) | TASK-030：Command Gateway、安全预检与命令回执（WSM2-C） | Delivered（2026-08-03） |
| [TASK-031-workspace-controlled-operations.md](tasks/done/TASK-031-workspace-controlled-operations.md) | TASK-031：工作视窗受控运行与 Action Center 写闭环（WSM2-D） | Delivered（2026-08-03） |
| [TASK-032-workspace-learning-and-recommendations.md](tasks/done/TASK-032-workspace-learning-and-recommendations.md) | TASK-032：项目复盘、跨项目学习与证据化推荐（WSM3-A） | Delivered（2026-08-03） |
| [TASK-033-workspace-end-to-end-acceptance.md](tasks/done/TASK-033-workspace-end-to-end-acceptance.md) | TASK-033：Creation Workspace WFM1 数据基线验收（WSM3-B） | Accepted（2026-08-03，用户签字通过） |
| [TASK-034-wfm2-full-creative-and-audiovisual-design.md](tasks/done/TASK-034-wfm2-full-creative-and-audiovisual-design.md) | TASK-034：WFM2 完整创意与视听设计（L0–S3） | Implemented（2026-08-03） |
| [TASK-035-wfm2-multimedia-generation-and-lineage.md](tasks/done/TASK-035-wfm2-multimedia-generation-and-lineage.md) | TASK-035：WFM2 多媒体生成、资产谱系与统一成本 | Implemented（2026-08-04） |
| [TASK-036-wfm2-formal-postproduction-qc-release.md](tasks/done/TASK-036-wfm2-formal-postproduction-qc-release.md) | TASK-036：WFM2 正式后期、QC、发布与复盘 | Delivered（合同层，2026-08-04） |
| [TASK-037-wfm2-end-to-end-acceptance.md](tasks/done/TASK-037-wfm2-end-to-end-acceptance.md) | TASK-037：WFM2 正式作品端到端验收 | 里程碑 PASS（产品负责人 2026-08-24 原话「WFM2 可以了」） |
| [TASK-038-wfm3-automation-and-command-capabilities.md](tasks/done/TASK-038-wfm3-automation-and-command-capabilities.md) | TASK-038：WFM3 固定职责自动化与命令能力收口 | Delivered（合同层，2026-08-04） |
| [TASK-039-workspace-multimedia-and-full-workflow-expansion.md](tasks/done/TASK-039-workspace-multimedia-and-full-workflow-expansion.md) | TASK-039：Creation Workspace 多媒体与完整工作流扩展 | Delivered（只读观测层，2026-08-04） |
| [TASK-042-creative-agent-shots-draft.md](tasks/done/TASK-042-creative-agent-shots-draft.md) | TASK-042: 创意 Agent 分镜草稿（Claude CLI 通道）+ 画布自动衔接 | Accepted（2026-08-07，随 ADR-0042） |
| [TASK-047-draft-lock-command.md](tasks/done/TASK-047-draft-lock-command.md) | TASK-047: lock-draft-plan 命令与图↔视频一致性打通 | Done（2026-08-07 实施完成） |
| [TASK-048-motv-p0-asset-flow-and-status.md](tasks/done/TASK-048-motv-p0-asset-flow-and-status.md) | TASK-048: motv 原型 P0 断层修复——图→视频流转、付费状态自动轮询、上传版本化 | Done（2026-08-07 实施完成 |
| [TASK-049-native-windows-run-target.md](tasks/done/TASK-049-native-windows-run-target.md) | TASK-049: 冻结 V1 并使其在原生 Windows 上可复现运行 | Done（2026-08-23 复查） |
| [TASK-050-powershell-agent-dev-tooling.md](tasks/done/TASK-050-powershell-agent-dev-tooling.md) | TASK-050: agent 开发工装 PowerShell 原生化（Windows 宿主） | Delivered（2026-08-10） |
| [TASK-051-production-studio-ui-convergence.md](tasks/done/TASK-051-production-studio-ui-convergence.md) | TASK-051 — Production Studio UI 收敛（V1 视觉重建） | 已退役（2026-08-23 复查） |
| [TASK-051A-ai-director-production-control-tower.md](tasks/done/TASK-051A-ai-director-production-control-tower.md) | TASK-051A — AI 导演升级为生产控制塔（Production Control Tower） | 已退役（2026-08-23 复查） |
| [TASK-051B-landing-and-new-project.md](tasks/done/TASK-051B-landing-and-new-project.md) | TASK-051B — 落地页收敛与「新建项目」（项目名 + 资产位置） | 已退役（2026-08-23 复查） |
| [TASK-052-agent-tooling-and-shell-hardening.md](tasks/done/TASK-052-agent-tooling-and-shell-hardening.md) | TASK-052 — Agent 工装与 workspace_shell 加固（审查遗留收口） | 已完成（2026-08-23） |
| [TASK-053-choose-project-location.md](tasks/done/TASK-053-choose-project-location.md) | TASK-053 — 在界面里选任意路径，后端就往那儿写 | 已验收并收口（2026-08-13，随 ADR-0051 一并收口） |
| [TASK-054-workflow-provenance-graph.md](tasks/done/TASK-054-workflow-provenance-graph.md) | TASK-054 — 工作流页面重做：生成溯源图 | 已验收并收口（产品负责人 2026-08-13，随 ADR-0052 / ADR-0066 一并收口） |
| [TASK-055-project-rooted-storage.md](tasks/done/TASK-055-project-rooted-storage.md) | TASK-055 — Studio 数据与媒体落在项目目录内（high-risk checkpoint） | 已验收并收口（2026-08-13，随 ADR-0053 一并收口） |
| [TASK-056-app-storage-location.md](tasks/done/TASK-056-app-storage-location.md) | TASK-056 — 应用级数据移出仓库（小 checkpoint） | 实现完成（2026-08-23） |
| [TASK-057-production-upstream-workspace.md](tasks/done/TASK-057-production-upstream-workspace.md) | TASK-057：Production Upstream Workspace v1 | 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-058-asset-registration-foundation.md](tasks/done/TASK-058-asset-registration-foundation.md) | TASK-058：Asset Registration Foundation（统一资产登记） | 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-059-local-ai-runtime-and-film-skills.md](tasks/done/TASK-059-local-ai-runtime-and-film-skills.md) | TASK-059：Local AI Runtime + Film Skill Runtime | 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-060-shot-production-and-dailies.md](tasks/done/TASK-060-shot-production-and-dailies.md) | TASK-060：Shot 生产状态 + 连续审片（Dailies） | 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-061-asset-library-and-episode-production-ui.md](tasks/done/TASK-061-asset-library-and-episode-production-ui.md) | TASK-061：Asset Library + Episode Production UI | 已完成（CP5–CP7 实施 + 真实 Connected 验收） |
| [TASK-061-independent-review.md](tasks/done/TASK-061-independent-review.md) | TASK-061 独立审查记录（第 1 轮） | — |
| [TASK-062-integration-production-graph.md](tasks/done/TASK-062-integration-production-graph.md) | TASK-062：Integration / Production Graph | 已完成（2026-08-23 复查收口，ADR-0082） |
| [TASK-063-risk-based-commit-gate.md](tasks/done/TASK-063-risk-based-commit-gate.md) | TASK-063：风险分级本地 Commit Gate | 完成（2026-08-12） |
| [TASK-064-creator-ui-consolidation.md](tasks/done/TASK-064-creator-ui-consolidation.md) | TASK-064：创作者 IA 收口与自动初版剧集制作 | 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-065-creator-object-first-ia.md](tasks/done/TASK-065-creator-object-first-ia.md) | TASK-065：创作对象优先的 IA 收口（基础资产 / 关系图 / 当前 Shot 生产图） | 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-066-episode-production-shot-workbench.md](tasks/done/TASK-066-episode-production-shot-workbench.md) | TASK-066：剧集制作 = 把每个 Shot 做成「选定的最终 Shot Video」 | 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-067-ai-director-operationalization.md](tasks/done/TASK-067-ai-director-operationalization.md) | TASK-067：AI 导演 / Skill / Agent 的可操作化 | 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-068-legacy-agent-endpoints-to-runtime.md](tasks/done/TASK-068-legacy-agent-endpoints-to-runtime.md) | TASK-068：把旧 /api/agent/ 创作端点收进 Runtime 层 | 已完成（由 TASK-072 §1.8 落地） |
| [TASK-069-manual-episode-plan-editing.md](tasks/done/TASK-069-manual-episode-plan-editing.md) | TASK-069：分集规划可以手工修改 | 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-070-cast-seeded-from-outline.md](tasks/done/TASK-070-cast-seeded-from-outline.md) | TASK-070：初始人物从故事大纲的「主要角色概念」获取 | 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-071-storyboard-first-episode-entry.md](tasks/done/TASK-071-storyboard-first-episode-entry.md) | TASK-071：进入剧集制作先定分镜，再逐镜详细制作 | 已验收（产品负责人 2026-08-13 随 ADR-0066 批准一并收口） |
| [TASK-072-system-contract-and-persistent-runs.md](tasks/done/TASK-072-system-contract-and-persistent-runs.md) | TASK-072：第二阶段 —— 后端合同、持久化任务、版本管理与兼容层 | 已完成（2026-08-24 收口） |
| [TASK-073-fixed-ia-and-contextual-agent.md](tasks/done/TASK-073-fixed-ia-and-contextual-agent.md) | TASK-073：第三阶段 —— 前端信息架构、页面重构与上下文 Agent 交互 | 已完成（2026-08-24 收口） |
| [TASK-075-product-skill-package.md](tasks/done/TASK-075-product-skill-package.md) | TASK-075：Product Skill Package —— Skill 从源码常量变成可加载的产品资产 | 已完成 |
| [TASK-076-continuous-chain-gate.md](tasks/done/TASK-076-continuous-chain-gate.md) | TASK-076：让连续修改链在 commit gate 上真实生效 | 已完成 |
| [TASK-077-honest-state-and-dead-surfaces.md](tasks/done/TASK-077-honest-state-and-dead-surfaces.md) | TASK-077：诚实状态与死掉的面 —— UI Gap Audit Phase 0 | 已完成（六条交付全部完成 |
| [TASK-078-storyboard-table-to-first-frame.md](tasks/done/TASK-078-storyboard-table-to-first-frame.md) | TASK-078：从分镜到第一张画面 —— UI Gap Audit Phase 1 | 已完成（2026-08-16，批次 A db2781a + 批次 B f9d637f，见 §8 实施记录） |
| [TASK-079-review-surface-and-chaining.md](tasks/done/TASK-079-review-surface-and-chaining.md) | TASK-079：审阅面与链式流转 —— UI Gap Audit Phase 1（后半） | 已完成（2026-08-16，批次 A + B 均已提交） |
| [TASK-080-skill-catalog-and-one-agent-session.md](tasks/done/TASK-080-skill-catalog-and-one-agent-session.md) | TASK-080：能力可见 —— Skill 目录页 + 一个 Agent 会话（Phase 2 上半） | 已完成（2026-08-16，三个批次三次提交） |
| [TASK-081-url-routing-and-deep-links.md](tasks/done/TASK-081-url-routing-and-deep-links.md) | TASK-081：URL 即状态 —— 路由与深链接（Phase 2 下半 · 之一） | 已完成（2026-08-16，提交 3ca71e8） |
| [TASK-082-project-health-and-asset-tree.md](tasks/done/TASK-082-project-health-and-asset-tree.md) | TASK-082：项目健康与资产内容树（Phase 2 下半 · 之二） | 已完成（2026-08-16 · 本链链尾） |
| [TASK-083-phase3-adrs-first.md](tasks/done/TASK-083-phase3-adrs-first.md) | TASK-083：Phase 3 —— 先落 ADR，再谈实现 | 四个 ADR 全部已定，本卡收口（2026-08-23） |
| [TASK-084-clear-the-push-gate.md](tasks/done/TASK-084-clear-the-push-gate.md) | TASK-084：清掉 push 闸门上剩下的四项 | 已完成（2026-08-16） |
| [TASK-085-gate-intent-detection.md](tasks/done/TASK-085-gate-intent-detection.md) | TASK-085：commit gate 改用 shell 自己的解析器判断意图 | 已完成（2026-08-16） |
| [TASK-086-address-truth-and-count-scope.md](tasks/done/TASK-086-address-truth-and-count-scope.md) | TASK-086：地址说真话，数字带口径 | 已完成（2026-08-16） |
| [TASK-088-episode-plan-as-an-ai-written-table.md](tasks/done/TASK-088-episode-plan-as-an-ai-written-table.md) | TASK-088：分集规划是一张 AI 写好、我能改的表 | 已完成（2026-08-18） |
| [TASK-089-story-outline-eight-items.md](tasks/done/TASK-089-story-outline-eight-items.md) | TASK-089：故事大纲写这八项就够了 | 已完成（2026-08-18） |
| [TASK-090-bible-is-derived-and-comes-last.md](tasks/done/TASK-090-bible-is-derived-and-comes-last.md) | TASK-090：作品设定是派生的，而且排在故事开发的最后 | 已完成（2026-08-18） |
| [TASK-091-episode-production-is-a-nine-step-line.md](tasks/done/TASK-091-episode-production-is-a-nine-step-line.md) | TASK-091：剧本搬进剧集制作，九步变成一条看得见的线 | 已退役（2026-08-17） |
| [TASK-092-shot-workflow-multi-stage.md](tasks/done/TASK-092-shot-workflow-multi-stage.md) | TASK-092：Shot 工作流从线性状态机升级成带依赖的多 Stage | 已完成（2026-08-18，TASK-097 批次 1 · 提交 c94fd19 · ADR-0073） |
| [TASK-093-one-canvas-per-shot.md](tasks/done/TASK-093-one-canvas-per-shot.md) | TASK-093：一镜一画布 —— 把只读的制作流程图变成能干活的面 | 已完成（2026-08-19，TASK-097 批次 3 · 提交 550504f） |
| [TASK-094-story-development-chain.md](tasks/done/TASK-094-story-development-chain.md) | TASK-094：故事开发这条链 —— 一个对话框从头做完 | 已完成（2026-08-18） |
| [TASK-095-episode-production-wizard.md](tasks/done/TASK-095-episode-production-wizard.md) | TASK-095：剧集制作是一条向导，不是五个平级页面 | 已完成（2026-08-20，TASK-097 批次 4A–4G + 4E） |
| [TASK-096-post-video-three-steps.md](tasks/done/TASK-096-post-video-three-steps.md) | TASK-096：视频之后那三步 —— 配音·音效 → 剪辑 → QC | 已完成（2026-08-20，TASK-097 批次 5A / 5B） |
| [TASK-097-episode-production-chain.md](tasks/done/TASK-097-episode-production-chain.md) | TASK-097：剧集制作这条链 —— 一个对话框从头做完 | 已完成（2026-08-20，13 个批次全部落地，链尾全量绿） |
| [TASK-098-camera-motion-preview.md](tasks/done/TASK-098-camera-motion-preview.md) | TASK-098：白膜视频 —— 让「运镜」第一次有反馈 | 已完成（2026-08-22） |
| [TASK-099-repository-path-ownership.md](tasks/done/TASK-099-repository-path-ownership.md) | TASK-099：仓库根目录治理与启动器归档 | 已完成（2026-08-23） |
| [TASK-100-skill-evolution-skill.md](tasks/done/TASK-100-skill-evolution-skill.md) | TASK-100：skill-evolution Skill v0.1 —— 受控的 Skill 演化闭环 | 完成 |
| [TASK-101-auto-push-skill.md](tasks/done/TASK-101-auto-push-skill.md) | TASK-101：auto-push Skill v0.1 —— Task 级自动 commit/push 与受控合并 | 完成 · 已合入 main（2026-08-23，产品负责人「合并并收口」），merge commit 17372a1 |
| [TASK-102-injected-adr-0080-2026-08-22.md](tasks/done/TASK-102-injected-adr-0080-2026-08-22.md) | ADR-0080：测试所有权、Agent Skill 与集成闸门 | Accepted |
| [TASK-102-injected-agents-md-2026-08-22.patch](tasks/done/TASK-102-injected-agents-md-2026-08-22.patch) | （patch 留痕） | — |
| [TASK-102-repo-test-decoupling.md](tasks/done/TASK-102-repo-test-decoupling.md) | TASK-102：仓库集成与解耦重构 —— 测试所有权、前后端边界、文档收敛 | 本卡已完成并已合入 main（2026-08-22） |
| [TASK-102-scope-injection-evidence-2026-08-22.md](tasks/done/TASK-102-scope-injection-evidence-2026-08-22.md) | TASK-102 任务卡范围注入事件留痕（2026-08-22） | — |
| [TASK-103-frontback-and-ui-residuals.md](tasks/done/TASK-103-frontback-and-ui-residuals.md) | TASK-103：前后端交互与 UI 的剩余欠账 | A–E 批已落地（2026-08-23） · 已合入 main（2026-08-23，产品负责人「合并并收口」），merge commit e5c52f7 |
| [TASK-104-governance-docs-merge.md](tasks/done/TASK-104-governance-docs-merge.md) | TASK-104：治理文档合并 —— AGENTS.md 成为唯一规范 | 已完成（2026-08-23） · 已合入 main（2026-08-23，产品负责人「合并并收口」），merge commit 8b9eb81 |
| [TASK-105-flow-template-first-slice.md](tasks/done/TASK-105-flow-template-first-slice.md) | TASK-105：流程模板第一刀 —— 内置一份 flow，新建项目时可选 | 第一刀实现完成（2026-08-24） |
| [TASK-107-document-lifecycle.md](tasks/done/TASK-107-document-lifecycle.md) | TASK-107：文档与记录的统一生命周期 —— 落到规则、工装与现有文档上 | 完成（2026-08-26） |
| [TASK-108-traceability-and-requirement-review.md](tasks/done/TASK-108-traceability-and-requirement-review.md) | TASK-108：把「产品意图 → 验证」的追溯链与需求完成度审查接进开发流程 | 完成（2026-08-26） |
| [TASK-109-three-pane-shell-and-agent-conversation.md](tasks/done/TASK-109-three-pane-shell-and-agent-conversation.md) | TASK-109：全站三栏骨架 + 右栏改成真正的 Agent 对话框 | 完成（2026-08-27） |
| [TASK-110-remove-project-from-home.md](tasks/done/TASK-110-remove-project-from-home.md) | TASK-110：主页可以把项目从列表里移除（文件他自己删） | 完成（2026-08-27） |
| [TASK-111-agent-applies-its-own-edits.md](tasks/done/TASK-111-agent-applies-its-own-edits.md) | TASK-111：让对话里的 Agent 真的把改动落到作品上 | 完成（2026-08-29） |
| [TASK-112-connected-home-list-shows-only-backend-projects.md](tasks/done/TASK-112-connected-home-list-shows-only-backend-projects.md) | TASK-112：已连接后端时，主页只显示后端真的有的项目 | 完成（2026-08-29） |
| [TASK-113-latest-version-only-and-apply-outlet.md](tasks/done/TASK-113-latest-version-only-and-apply-outlet.md) | TASK-113：版本行默认只露最新版；还没落下的改动有个出口 | 完成（2026-08-29） |
| [TASK-114-agent-action-registry-and-feedback-loop.md](tasks/done/TASK-114-agent-action-registry-and-feedback-loop.md) | TASK-114：动作注册表（Agent 能做创作者能做的事）+ 意见回路 | 完成（2026-08-29） |
| [TASK-115-delete-with-an-undo-everywhere.md](tasks/done/TASK-115-delete-with-an-undo-everywhere.md) | TASK-115：故事与镜头都能删 —— 而且都能撤销 | 完成（2026-08-29） |

## 已完成 · 设计与验收记录

已通过的里程碑评审、已落地的实施记录，及其任务卡已收口的设计文档。

| 文档 | 标题 | 状态行（首句） |
| --- | --- | --- |
| [codex-rereview-history-2026-08.md](design/done/codex-rereview-history-2026-08.md) | codex 补审历史（2026-08-13 – 2026-08-23）—— 已闭合，仅作历史查阅 | 已完成（全部条目已闭合 |
| [commit-gate-intent-detection.md](design/done/commit-gate-intent-detection.md) | commit gate 的意图判定：从正则读命令文本，改成用每个 shell 自己的解析器 | 已实施（2026-08-16，TASK-085） |
| [creation-workspace-implementation-roadmap.md](design/done/creation-workspace-implementation-roadmap.md) | Creation Workspace ADR 与实施任务路线 | 已完成（规划基线已被消化，2026-08-26 归档） |
| [final-unified-milestone-review.md](design/done/final-unified-milestone-review.md) | 最终统一产品里程碑评审记录（TASK-040） | 已完成（评审记录本身在 2026-08-04 就已写完并定稿 |
| [handover-2026-08-23-remaining-active-tasks.md](design/done/handover-2026-08-23-remaining-active-tasks.md) | 交接：docs/tasks/active/ 的剩余任务（2026-08-23） | — |
| [M1-milestone-review.md](design/done/M1-milestone-review.md) | M1 Milestone Review Record | — |
| [pending-speedup-and-gate-fix.md](design/done/pending-speedup-and-gate-fix.md) | 测试提速 + commit gate 分类修复 | 已落地（2026-08-15） |
| [remaining-roadmap-design-report.md](design/done/remaining-roadmap-design-report.md) | 剩余 Roadmap 整体设计报告（供 Codex 一次性架构审查） | — |
| [TASK-003-provider-contract-design.md](design/done/TASK-003-provider-contract-design.md) | TASK-003 设计文档：VideoProvider 契约与 ManualVideoProvider | approved — ready for implementation |
| [TASK-004-provider-orchestrator-design.md](design/done/TASK-004-provider-orchestrator-design.md) | TASK-004 设计文档：Provider Orchestrator 契约与基础编排 | completed — implementation complete through Step G; Codex |
| [TASK-008-audio-subtitle-design.md](design/done/TASK-008-audio-subtitle-design.md) | TASK-008 Focused Design — Subtitles, Voice-over, Audio (M2) | 聚焦设计定案（用户已批准 3 项产品假设「全按推荐」+ 批准 |
| [TASK-009-qcd-aggregation-design.md](design/done/TASK-009-qcd-aggregation-design.md) | TASK-009 Focused Design — QCD Aggregation, Metrics, Reporting | 聚焦设计定案（M2 |
| [task097-handover-2026-08-19.md](design/done/task097-handover-2026-08-19.md) | TASK-097 交接说明（2026-08-19，换机器） | — |
| [WFM1-milestone-review.md](design/done/WFM1-milestone-review.md) | WFM1 Milestone Review（TASK-023 gate） | — |
| [wfm2-acceptance-runbook.md](design/done/wfm2-acceptance-runbook.md) | WFM2 正式作品验收 Runbook（TASK-037） | — |
| [wfm2-acceptance-traceability.md](design/done/wfm2-acceptance-traceability.md) | WFM2 端到端验收追踪矩阵（TASK-037） | — |
| [WFM2-milestone-review.md](design/done/WFM2-milestone-review.md) | WFM2 里程碑评审记录（TASK-037） | — |
| [workspace-wfm1-acceptance-runbook.md](design/done/workspace-wfm1-acceptance-runbook.md) | Workspace WFM1 数据基线验收 Runbook（TASK-033 / WSM3-B） | Approved acceptance evidence（2026-08-03） |
| [workspace-wfm1-acceptance-traceability.md](design/done/workspace-wfm1-acceptance-traceability.md) | Workspace WFM1 数据基线验收追踪矩阵（TASK-033 / WSM3-B） | Approved acceptance evidence（2026-08-03） |
| [WSM3-workspace-wfm1-milestone-review.md](design/done/WSM3-workspace-wfm1-milestone-review.md) | WSM3 Workspace WFM1 数据基线里程碑评审（TASK-033 gate） | — |

## 稳定参考（没有「完成」这一维）

合同不会「做完」，决策只要 Accepted 就一直有效 —— 所以它们不进 active/done。

| 位置 | 放什么 |
| --- | --- |
| [当前架构合同](current-architecture.md) | **现在**成立的边界与约束（NOW） |
| [`docs/adr/`](adr/) | 74 条决策记录（ADR-0001 … ADR-0090）—— WHY / HISTORY |
| [`docs/design/`](design/) 根 | 系统合同、产品信息架构、L0–S7 I/O 合同 |
| [项目背景与路线](project-context.md) | 这个项目是什么、走到哪了 |
| [实施规划](implementation_plan.md) | 阶段与里程碑路线图 |
| [产品规格](product_spec.md) · [架构](architecture.md) | 规格与架构基线 |
