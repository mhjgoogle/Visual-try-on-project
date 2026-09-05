# 项目背景与路线

**这份文件回答「这个项目是什么、走到哪了」，不含任何约束条款。**
逐项的完成状态见 [STATUS.md](STATUS.md)（生成的）——本文件只讲路线，不逐条报状态。
**现在的架构事实**见 [当前架构合同](current-architecture.md)（模块边界 / 依赖方向 /
前后端合同 / 测试归属）；**为什么这么定**见 `adr/`。
你必须遵守的规则在 [AGENTS.md](../AGENTS.md)；那里只放规则，不放背景。

---

## 当前真相锚点（三行，唯一手写的那部分）

**这三行是 [STATUS.md](STATUS.md)「当前真相」节前三面的来源**
（AGENTS.md 第 27 条 · [ADR-0101](adr/ADR-0101-idea-intake-level-and-milestone-gate.md)
决策 5）。其余三面（Active Requirements / Deferred / Recent Decisions）从目录派生，
不手写。**注释锚点不能删也不能留空** —— `gen_docs_status.py` 会 fail-closed。

**里程碑那一行是 Milestone Gate 每次要读的东西**：里程碑推进或换掉时，
在同一个提交里改它（收敛检查第 7 问）。

<!-- current-truth: mission -->
构建覆盖「故事构思 → 剧本 → 场景镜头 → 资产 → 图片/视频生成 → 配音字幕 → 合成 → QCD」的 AI 视频 / 短剧生产工作流，核心对视频厂商保持中立。
<!-- current-truth: strategy -->
原 M1 最小闭环已完成并冻结为基础；WFM1 增量加入可复用短剧流程与云端默认生产路线；创作者 Studio 按 ADR-0066 四阶段落成产品界面；会花钱的能力按 Accepted ADR 逐个命令开门。
<!-- current-truth: milestone -->
创作者 Studio 单一路径收敛，五个垂直切片依次推进（① 当前事实收口 → ② run_id 前端闭环 → ③ Candidate/QC/Final 闭环 → ④ 一份 Surface/Command Manifest → ⑤ 单一路径 + Connected Project 验收），**不增加新的顶层页面**；现在在切片 ①（TASK-125）。

---

## 长期目标

构建一个 AI 视频 / AI 短剧生产工作流，覆盖：

故事构思 → 结构化剧本 → 场景与镜头拆分 → 人物/场景/道具资产管理 → 图片生成
→ 视频生成 → 配音、音效和字幕 → FFmpeg 合成 → 质量检查
→ 质量、成本、交付周期（QCD）记录 → 最终成片
→ 统一创作工作视窗中的观察、运行、评价、复盘与跨项目学习。

运行环境的权威归属见 AGENTS.md 第 2 条（原生 Windows + NTFS 为权威，
Ubuntu / WSL2 与 Linux CI runner 为受支持目标）。

## 第一阶段（原 M1，已完成）

最小闭环，不接入付费 API：

读取故事与镜头数据 → 生成人工视频制作任务 → 用户在网页视频工具中手工生成视频
→ 用户将视频放入指定目录 → 程序检查视频文件 → FFmpeg 按镜头顺序合成
→ 输出最终 MP4。

它已完成，并作为后续工作的稳定基础保留。

## WFM1 增量路线

WFM1 在原 M1 之后增量加入可复用短剧生产流程、人工创意审批、生产规划、
预算约束与云端视频默认生产路线。它**不重定义原 M1，不修改既有冻结合同**；
新开发任务从 `TASK-014` 起，采用现有 batch milestone review。

云端视频是 WFM1 的默认生产路线，但核心架构继续保持 Provider 中立
（约束见 AGENTS.md 第 8–10 条）。

- 详细规格：[product_spec.md](product_spec.md)
- 架构：[architecture.md](architecture.md)
- WFM1 工作流：[ai_shortfilm_pipeline_workflow.md](ai_shortfilm_pipeline_workflow.md)
- 实施规划：[implementation_plan.md](implementation_plan.md)
- 文档权威关系：[ADR-0007](adr/ADR-0007-wfm1-document-baseline-and-governance.md)

## 统一创作工作视窗（Creation Workspace，规划中）

跨项目 Creation Workspace 已进入分阶段建设规划。

- 需求基线：[ai_video_creation_workspace_requirements.md](ai_video_creation_workspace_requirements.md)
- 安全边界：[ADR-0010](adr/ADR-0010-creation-workspace-boundary.md)
- WFM1 数据准备：[creation_workspace_data_observability_requirements.md](creation_workspace_data_observability_requirements.md)
- 交付治理：[ADR-0030](adr/ADR-0030-creation-workspace-delivery-governance.md)
- 端到端归属：[端到端需求追踪矩阵](design/end-to-end-requirements-traceability.md)
- L0–S7 阶段/步骤逻辑 I/O 基线：[工作层级输入输出合同](design/workflow-stage-step-io-contract.md)

任务路线为 `TASK-024`～`TASK-033`（WFM1 数据基线）。TASK-024 可立即做 docs-only
收口，已稳定 source 的只读能力可增量实施；Workspace 仍不属于 WFM1 验收，生产级
只读验收及全部界面写能力受 TASK-023 门槛约束。完整流程由 WFM2
TASK-008/034～037 与 WFM3 TASK-012/038 补齐；Workspace 完整多媒体扩展和两份
顶层需求最终验收分别由 TASK-039/040 承接。

**当前可执行范围**：只可执行依赖已满足的 TASK-024～033、TASK-008/034～038
与 TASK-039～040。对应 Proposed ADR 未 Accepted 前，不得选择或实现 UI、
数据库、Gateway、Action 或最终 schema。只有 TASK-040 可以宣告两份顶层需求
最终完成（TASK-033 只验收 WFM1 数据基线）。实现任务只能细化获批 schema/路径，
不能删除输入绑定、输出身份或人工 Gate。

## 创作者 Studio（`mockups/motv-workspace`）

界面归属与系统边界由两份文档冻结，它们是该范围的**唯一权威**
（自 [ADR-0066](adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)）：

- [创作者产品信息架构](design/creator-product-information-architecture.md)
  —— 三空间 / 十一页的**封闭集合**、完整用户流程、三层检查、页面职责、
  现状→目标映射、Agent 协作与权限边界。
- [创作者系统合同](design/creator-system-contract.md)
  —— 核心对象、Artifact 版本状态机、Skill Run 状态与持久化字段、
  Command / Query 名录、「界面—命令—任务—输出—确认」矩阵、前后端交互原则。

实施分四阶段（ADR-0066 决策 10 / TASK-072～074）：**新增 Skill 不得新增一级或
二级页面**；每项功能只有一个归属页面；Agent 不得静默覆盖、静默定稿、静默付费
或替用户完成审美决策。

**Skill 是产品资产而不是源码常量**（自 [ADR-0067](adr/ADR-0067-product-skill-package.md)）：
一个 Skill 是 `manifest.json` + `prompt.md` + `output.schema.json` 三件套，
从项目 → 用户 → 内置三个来源按优先级加载，Run 记录 `skillDigest` 使版本指向
确定的内容；已被历史 Run 引用的版本**不得原地覆盖**；Skill 只产生提案，
**不得定稿、锁定、付费或导出**；加载或校验失败一律 fail-closed。
实施见 [TASK-075](tasks/done/TASK-075-product-skill-package.md)。

### Studio 原型的运行时边界

- 它是**非生产的 UX 原型**，不是受治理的 Workspace 实现。
- **只读接真实数据是允许的**（ADR-0031/0032 已 Accepted）：可选后端 `server.py`
  消费**公开**查询包 `ai_video_workflow.workspace`（与 `src/workspace_shell/app.py`
  同一公开面），只读、不写业务状态、不持凭据，刻意不放进 `src/workspace_shell/`。
  禁的是 import 核心**内部**类型。
- **写侧经 Command Gateway，按命令逐个开门**（2026-08-23 复核订正 —— 「保持
  stub」在 TASK-041 增量二与 TASK-103 批次 B 之后已经不成立）：
  `services/gateway.js` 做的是**真实的两步提交**（preflight → 确认 → submit），
  `_command_gateway` 注册的是真命令。**门是按命令开的，不是整体开的**：

  | 命令 | 花费 | 注册条件 |
  | --- | --- | --- |
  | `lock-draft-plan`（ADR-0047） | 无 | 永远注册 |
  | `record-evaluation` / `create-feedback` / `create-action` / `action-transition`（TASK-103 批次 B） | 无 | 永远注册 |
  | `submit-video-generation`（ADR-0041） | **有** | 仅付费模式：`--enable-paid` **且** `AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1`，真实调用再要 key + 人工预检确认 |

  没开付费门时，注册表里**一个会花钱的命令都没有** —— 这条不变，变的只是
  「无花费的写命令也一律 stub」那半句。
- **画布持久化在项目目录里**（ADR-0053 / TASK-055）：`<ProjectRoot>/studio/canvas.json`
  + `<ProjectRoot>/media/`。仓库内的 `mockups/motv-workspace/data/<project>.json`
  降为**只读 legacy**，要显式迁移后才能编辑。账户级的两份注册表
  （`projects.json` / `runs.json`）也已移出仓库，见 TASK-056。
- **已知非目标**：不做真实发布、不进 `workspace_shell`、不建 DB 或物化 projection；
  付费生成之外不新增会花钱的命令。要把它落成生产 Workspace UI，另走 ADR 与任务卡。
- 演示模式的种子项目与 SVG 占位素材不是验收依据（见 AGENTS.md 第 20 条
  「真实 Connected Project 是主要验收环境」）；连接模式永不触发种子。

### UI 差距审计工装

`src/ui-gap-audit/` 放审计报告与抓图工装。**像素不进 Git**——`current/` 拍的是
用户自己的创作项目，`target/` 拍的是他人产品界面，与 AGENTS.md 第 23 条同一
理由；清单、报告与脚本进 Git，使审计可复现。竞品截图需要**用户自己的登录态，
凭据从不经过 Agent**。审计**不得按下任何真实付费提交**，付费才能触发的状态
如实标注为未实拍。审计判据优先级：实际运行行为 > 代码 > 测试 > schema > 注释。
