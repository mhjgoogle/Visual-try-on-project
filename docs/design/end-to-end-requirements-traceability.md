# AI 短剧工作流与 Creation Workspace 端到端需求追踪

> **状态：Approved planning baseline；实现状态以 implementation plan 和任务卡为准。**
> 本文只分配需求责任和验收层级，不定义最终 schema、目录、UI 技术或 Provider
> 接口。需求源为 `ai_shortfilm_pipeline_workflow.md` 与
> `ai_video_creation_workspace_requirements.md`。

核心阶段/步骤 I/O 的语义权威基线见
[L0–S7 工作层级输入输出合同](workflow-stage-step-io-contract.md)。

## 1. 覆盖状态

- `wfm1_supported`：WFM1 已有 owner 和实现/验收路径；最终状态等待 TASK-023 gate。
- `workspace_wfm1_baseline`：TASK-024～033 在 WFM1 数据与命令范围内交付。
- `wfm2_planned`：正式作品所需的完整 L0–S7、多媒体和正式音画，由
  TASK-008、034～037 承接。
- `wfm3_planned`：自动化率、自动路由和批量固定职责，由 TASK-011/012/038 承接。
- `workspace_final_planned`：完整多媒体 Workspace 扩展与两份需求最终验收，由
  TASK-039/040 承接。
- `upgrade_only`：不是最终验收硬依赖的可选升级，例如 Local Provider。

`unavailable` 只允许用于阶段性视图，不等于最终需求完成。

## 2. 核心工作流追踪

| 需求域 | 执行主体 | 权威产物/合同 | 当前或后续 owner | 状态 |
| --- | --- | --- | --- | --- |
| 项目参数、创作目标、主/次载荷、预算 | 用户定义；CLI 校验 | project profile、brief、budget config | TASK-018/020 | `wfm1_supported` |
| L0 创意候选、载荷 Checklist、概念试制与锁定 | Agent 产候选；用户审核；CLI 管版本/审批 | versioned creative artifacts + approval | TASK-034；WFM1 仅 brief/concept-lock 最小子集 | `wfm2_planned` |
| S1 完整叙事设计与专项审核 | Agent 辅助；用户定稿 | bible、beat、arc、screenplay、reviews | TASK-034 | `wfm2_planned` |
| S2 格式、视觉/声音 Bible、设计登记和三镜头试制 | Agent/创作工具生成；用户锁定 | format/AV locks、design registry、probe manifests | TASK-034/035 | `wfm2_planned` |
| S3 镜头计划、prompt 版本、Provider 方案和 P50/P90 | CLI 编译；用户批准 | planning artifacts、task packets、production lock | TASK-019/020 | `wfm1_supported` |
| S4 参考资料、母资产、关键帧和图片候选 | Image Provider/外部工具；Orchestrator 登记；用户选择 | image/reference assets、generation batches、lineage | TASK-035 | `wfm2_planned` |
| S4 云视频生成、恢复、成本和正式资产 | VideoProvider；协调器/Orchestrator 写事实 | reservation、operation、QCD cost、VideoAsset | TASK-015～017/021 | `wfm1_supported` |
| S4/S5 用户音频、字幕、混音与挂载 | 用户提供；CLI 校验/登记；FFmpeg 合成 | Audio/Subtitle assets、mix/subtitle manifests | TASK-008 | `wfm2_planned` |
| S4 生成式对白、音乐和音效 | Audio Provider/外部工具；用户批准 | versioned audio generations + cost/lineage | TASK-035/036 | `wfm2_planned` |
| S5 粗剪、精剪、代理、调色和正式音画 | CLI/FFmpeg + 人工精剪 | assembly/fine-cut/master manifests | TASK-036 | `wfm2_planned` |
| S6 叙事、连续性、技术、版权和平台发布 | CLI 生成检查包；用户终审/发布 | QC evidence、release/package/result manifests | TASK-022 最小子集；TASK-036 完整化 | `wfm2_planned` |
| S7 QCD、模型表现、观众数据、复用候选 | CLI 派生；用户确认经验 | postmortem、scorecard、performance、reuse candidates | TASK-022 最小子集；TASK-036/037 完整化 | `wfm2_planned` |
| 项目实例与全局复用资产分离 | CLI 发布/引用；项目只读消费 | immutable reuse package + locked project refs | TASK-018 | `wfm1_supported` |
| Provider 中立、审批、预算、凭据、断点和防覆盖 | application services/Orchestrator | ADR-0006～0009、reservation/QCD/approval contracts | TASK-014～017/019/021 | `wfm1_supported` |
| WFM1 60 秒最小闭环 | CLI/Driver + 用户审批 | E2E fixture、MP4、release、postmortem | TASK-023 | `wfm1_supported` |
| WFM2 正式作品完整验收 | 全链 | 完整 L0–S7、正式音画、QC、复盘 | TASK-037 | `wfm2_planned` |
| WFM3 固定职责自动化与路由 | CLI/Gateway/Orchestrator；用户保留创作批准 | capability registry、receipts、自动化 E2E | TASK-012/038；TASK-011 可选 | `wfm3_planned` |

## 3. Workspace 需求追踪

| 需求章节 | 基线 owner | 最终 owner | 阶段边界 |
| --- | --- | --- | --- |
| 项目、阶段、步骤、进度、问题和预算观察 | TASK-024～026 | TASK-039 | 基线使用 WFM1 source；最终纳入 WFM2 全媒体步骤 |
| 创意到成片的双向谱系 | TASK-025/027 | TASK-035/039 | 基线允许 WFM1 外类型 unavailable；最终不得 unavailable |
| prompt 版本、候选图片、选中结果和后续视频比较 | TASK-027 | TASK-035/039 | 图片候选事实由 WFM2 核心产生，UI 不补造 |
| 预计/预留/实际/失败重试成本及筛选 | TASK-025/027 | TASK-035/039 | 最终覆盖所有付费媒体 Provider |
| 运行前检查、确认、幂等、恢复和命令回执 | TASK-030 | TASK-038/039 | Gateway 只调用已批准核心能力 |
| 常规运行、重试、续做、选择、审批和阶段推进 | TASK-031 | TASK-038/039 | 只暴露 capability matrix 中 supported 的命令 |
| Feedback、Action 与 Action Center | TASK-029/031 | TASK-039 | 目标始终绑定 ref/version/digest |
| 目标、评价、实验与创作决定 | TASK-028/031 | TASK-039 | 用户最终判断；WFM2 提供完整媒体 target |
| 复盘、跨项目 KPI、经验提升和证据化推荐 | TASK-032 | TASK-039 | 推荐只读，知识提升需用户确认 |
| 关闭 UI、projection 重建、secret 和资金安全 | TASK-025/030/033 | TASK-040 | 基线和最终验收均为硬门槛 |
| WFM1 数据上的 Workspace 闭环 | TASK-033 | — | `workspace_wfm1_baseline`，不是最终产品验收 |
| 两份顶层需求最终闭环 | — | TASK-040 | 依赖 TASK-037～039 和 WFM3 必需自动化 |

## 3b. TASK-074 第四阶段交付了什么 —— 以及**没闭合什么**（2026-08-25）

> **不提升上表任何一行的覆盖级别**（维护规则第 2 条）。TASK-074 不是 §3 里任何
> 一行的最终 owner —— 那些是 TASK-039 / TASK-040。这一节只是让「清理阶段做到哪」
> 在追踪表里有一个地方能读到，否则下一个人会默认它做完了。

**已交付**（各带代码级证据，细节在 [TASK-074](../tasks/active/TASK-074-delivery-migration-and-legacy-retirement.md)）：

| | 内容 |
| --- | --- |
| §1.1 / §1.1b | 后期交付七分区补齐；`mix-shot` 端点四条加固（含两条可被构造请求触发的） |
| §1.2 | 交付质检七项 + ffmpeg 真实探测接线。**检测能力缺失 → `unavailable`，绝不产出一条「通过」** |
| §1.3 | 四条迁移里三条完成/本来成立；第四条（`approveShot` 双写）**未做**，见下 |
| §1.4 | 八条边界情况**七条**有自动守卫（合成真媒体 + 真 Chromium + 真后端） |
| §1.5 | 删除 `run.skillRunId` 别名（v18→v19）、`query.js` 十六个写函数 re-export、`services/gateway.js` 兼容层 |

**未闭合，且每条都指名了原因**：

| 缺口 | 为什么 | 去向 |
| --- | --- | --- |
| §1.4 边界 4「刷新页面 → 状态从后端恢复」 | 归属测试测的是**后端 API**，而前端一处都不读运行状态（`GET /api/runs` 零调用点） | TASK-106 |
| §1.5 `/api/skill/run` 同步分支 | 条件「前端已全部走 `run_id` 路径」不成立 —— 缺的是一个**新机制**（读运行状态并对账的循环），不是接线 | TASK-106 |
| §1.5 `/api/agent/*` 五个创作端点 | 同一个条件、同一个缺口 | TASK-106 |
| §1.3 `approveShot` 双写 | 「只留层 1 Decision」会丢 `assetId`（判据从身份退化成版本序数）与 `note`（用户写的字）；且「没有版本号的旧通过」在 Decision 词汇里表示不出来 → **需要一次 ReviewDecision 合同变更 + ADR** | TASK-087 §4.12 |
| 「生成记录」页无入口 | `ui/genrecord.js` 零 importer，却是唯一渲染 Skill ID / 执行器 / 模型的地方，而界面上写着让创作者去那里看 | TASK-087 §5.13 |

**§1.5 的三行「未删」不是推迟。** 那一节的规则 1 是「先确认无引用，再删」，
规则 3 是「有疑问就保留」；确认的结果是仍被引用且条件不成立，照规则走完，
结论就是保留。

## 4. 命令能力矩阵

| 操作 | 当前权威入口 | Workspace 基线 | 最终责任 |
| --- | --- | --- | --- |
| 创建项目/profile、创建目标新版本 | TASK-018 CLI/application service | TASK-031 经 Gateway | TASK-039 保持 |
| 规划/编译 task packet 与预算预览 | TASK-020 CLI/application service | TASK-031 经 Gateway | TASK-039 扩展多媒体 |
| stage review/approve/reject/revise/next | TASK-019 CLI/application service | TASK-031 经 Gateway | 保持 |
| paid start/poll/fetch/integrate/resume | TASK-016/017/021 application services | TASK-031 经 Gateway | TASK-039 扩展 Provider |
| retry/redo/new parameters | 新 immutable version + 新 task/operation | TASK-030/031 明确准入 | TASK-038 统一 capability |
| 选择候选、评价、创建 Action | TASK-022 最小证据；TASK-028/029 通用 service | TASK-031 经 Gateway | TASK-039 扩展所有媒体 |
| pause | 当前无统一核心命令 | 不展示 | TASK-038 决定支持或明确永久不支持 |
| vendor cancel | 当前无通用计费安全合同 | 不展示 | TASK-038 决定 Provider capability 与费用语义 |
| skip | 只有步骤内部幂等 skip/no-op，不等于用户跳过 | 不展示 | TASK-038 定义 allowlist 与下游影响 |
| 自动 Provider 路由 | 当前显式选择 | 不展示 | TASK-012/038 |

## 5. 文档维护规则

1. TASK-024 负责把本表细化为 query/page/source/test 级追踪，但不得删除 WFM2/WFM3
   deferred owner。
2. 每个新任务完成时更新本表状态；只有对应验收任务通过后才能提升覆盖级别。
3. TASK-033 只关闭 `workspace_wfm1_baseline`；TASK-040 才能关闭
   `workspace_final_planned` 和两份顶层需求的最终缺口。
4. 若某项只能从日志、文件名、Agent 对话或 UI 缓存推断，视为未覆盖。
5. Proposed ADR 未 Accepted、物理路径未获授权或唯一写入者未明确时，对应任务不得
   进入代码实施。
6. TASK-034～036 必须维护 I/O baseline 到 schema/owner/validator/test 的映射；
   TASK-037 逐行验收，不允许用阶段总状态替代步骤证据。
