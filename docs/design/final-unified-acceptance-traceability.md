# 最终统一验收追踪矩阵（TASK-040）

以两份顶层需求为唯一验收源，逐条映射到 ADR、owner 任务、实现、测试与证据。只做
最终验收收口，不新增功能。上游追踪见
[端到端需求追踪矩阵](end-to-end-requirements-traceability.md)。

## 1. 闭环覆盖（目标→运行→观察→评价/Action→复盘→学习/复用）

| 闭环阶段 | 层/合同 | 证据 |
|---|---|---|
| 目标 | 项目 profile、创意锁定（L0–S3，ADR-0037/TASK-034） | `test_creative_*`；`test_wfm2_*` 引用 |
| 运行 | 多媒体资产（S4，ADR-0038/035）、音画（S5，TASK-008）、后期/QC/发布（S5–S7，ADR-0039/036） | `test_media*`、`test_av_*`、`test_postproduction_index.py`、`test_wfm2_e2e_acceptance.py` |
| 观察 | Workspace 只读 projection（WQ-01..19，含 WQ-19 多媒体） | `test_workspace_*`、`test_final_unified_acceptance.py`（authoritative + 可重建） |
| 评价 | 评价域（ADR-0034/TASK-028，WQ-15） | `test_workspace_evaluation_query.py` |
| Action | Feedback/Action + Gateway 写（ADR-0035/033，TASK-029/030/031，WQ-16） | `test_workspace_action_query.py`、`test_gateway_*`、`test_workspace_wfm1_acceptance.py` |
| 复盘 | S7 postmortem/scorecard/performance（ADR-0039/036） | `test_postproduction_index.py`、`test_wfm2_e2e_acceptance.py` |
| 学习/复用 | 跨项目学习/知识提升/推荐（ADR-0036/032，WQ-17/18） | `test_learning.py`；`test_final_unified_acceptance.py`（跨项目 digest 复用） |
| 自动化编排 | WFM3 capability registry（ADR-0040/038） | `test_automation_capabilities.py` |

## 2. 跨切面产品不变量 → 证据

| 不变量 | 证据 |
|---|---|
| 唯一写入者、无第二事实源 | `test_final_unified_acceptance.py::test_unique_writer_fact_domains_are_separated`；projection 只读派生 |
| projection 可确定性重建 | WQ-10 rebuild-check；`test_final_..::test_closed_loop_..rebuildable` |
| 损坏/篡改 fail-closed | `test_final_..::test_corruption..fails_closed`；各 index digest 自校验 |
| 图片/音频/字幕不再 unavailable | WQ-19；`test_final_..::test_closed_loop_..authoritative` |
| 缺失≠零（P7） | not_applicable/unavailable+依据贯穿 postproduction→WQ-19 |
| 跨项目复用（digest 身份） | `test_final_..::test_formal_facts_are_reusable_across_projects` |
| 自动化不替代用户创作决定 | `test_final_..::test_automation_never_replaces_user_creative_judgement`；无 human_gate 自动职责 |
| 资金安全/人工批准/版本/恢复/凭据 | TASK-033 验收（真实 Gateway/HTTP 链）+ 各 owner 任务测试 |

## 3. 两份顶层需求逐条状态

- **`ai_shortfilm_pipeline_workflow.md`（完整短剧流程 L0–S7）**：创意锁定、多媒体
  生成、正式音画、后期/QC/发布/复盘均已实现并有 E2E 证据（TASK-034/035/008/036 +
  TASK-037 WFM2 gate）。合同层交付项（QC validator/release service 等具体 schema）
  按 ADR-0039「Not decided here」留作后续细化，不构成需求缺口——身份/谱系/事实域/
  状态/Gate 契约成立并可组合。
- **`ai_video_creation_workspace_requirements.md`（统一创作工作视窗）**：WFM1 数据
  基线已用户签字（TASK-033）；WFM2 多媒体只读观测已交付（TASK-039，WQ-19，图片/
  音频/字幕 authoritative）。完整 UI 页面、评价/Action/推荐扩展到全部新媒体 target、
  新增 Gateway 真实写命令接线为后续增量（TASK-039 卡已列明）；核心闭环（观察→评价→
  Action→学习→复用）经真实链验收（TASK-033 + 本矩阵）。

## 4. 已知限制（诚实声明，非需求缺口）

1. **合同层交付未落最终 schema/DB/CLI**：ADR-0039/0040「Not decided here」的具体
   validator/service/字段 schema/DB/CLI/apply handler 与 TASK-012 路由执行留作后续
   增量；本验收证明契约成立、可组合、fail-closed，不以 unavailable 关闭已要求能力。
2. **content_digest 自算无外部锚定**（creative/media/postproduction/qcd 同约定）：对
   拥有项目写权限并重算 digest 的攻击者不设防（该威胁使本地工具整体失效）；被引用
   上游改写在下游 load fail-closed 检出。keyed/signed 锚定属跨切面 ADR（TASK-036 卡
   follow-up）。
3. **Workspace 完整 UI 页面 + 新媒体写命令接线**为后续增量（TASK-039 卡已列明）；
   本轮交付只读多媒体观测 + 缺失语义 + fail-closed。
4. **无真实付费 API / 无自动商业发布 / 无本地 Provider 默认**（各 ADR 明确不做）；
   全离线打桩，真实工具仅 skipif 冒烟。

## 5. 结论

两份顶层需求的核心闭环（目标→运行→观察→评价→Action→复盘→学习→复用）已由 Accepted
ADR、实现与测试贯通并有证据；跨切面不变量（唯一写入者/可重建/fail-closed/缺失语义/
跨项目复用/人工优先）均有针对性验收。最终里程碑「验收标准勾选」属用户，见
[最终验收 runbook](final-unified-acceptance-runbook.md) §5 签字栏。
