# TASK-034：WFM2 完整创意与视听设计（L0–S3）

> **状态：Implemented（2026-08-03）。** ADR-0037 Accepted、TASK-023 gate 通过后实施。
> 交付 `src/ai_video_workflow/creative/`（结构化索引 index + L0–S3 catalog + 载荷贯穿
> payload + 三代表镜头 pilot 门 + 四锁 stage_targets + CLI），路径经 ADR-0001 第六次增补
> 与 ADR-0012 WFM2 增补授权（`creative/<stage>/<ref>_v<N>.json`）。codex 11 轮独立审查
> 通过（20+ blocking 修复，谱系/身份契约加固）；完整套件 2474 passed, 3 env-skips，ruff
> clean。合同层裁决，不接 Provider、不做审批、不生成图片/音频（ADR-0038/0039 承接）；
> WFM2 端到端最终验收由 TASK-037。原文见下「聚焦设计」。

## 目的

把 WFM1 的最小 brief/story/shot plan 扩展为完整 L0、S1、S2 和正式 S3 设计流程，
使 Agent 生成候选、人工 Checklist、定向修改和人工锁定都有版本化证据。

## 输入

- 短剧工作流 L0、S1～S3 与四载荷规则；
- [L0–S7 工作层级输入输出合同](../../design/workflow-stage-step-io-contract.md) 中
  Project/L0/S1～S3 baseline；
- TASK-018～020 profile/stage/planning 合同；
- ADR-0011/0012、Proposed ADR-0037 和统一追踪矩阵。

## 输出

- Accepted ADR-0037 及必要的 ADR-0001/0012 路径增补；
- 完整 creative/audiovisual artifact catalog、索引、stage targets 和 CLI 校验；
- 每个 Project/L0/S1～S3 step 的 input/output schema、owner、validator、
  required/conditional 和 change-impact mapping；
- 三个代表镜头试制清单、主载荷专项审核和 change-impact 证据；
- Agent/manual/CLI 执行责任说明、示例和测试。

## 修改范围

ADR-0037 授权的新创意/视听设计模块、结构化索引、CLI、示例和测试；WFM1 已有
profile/planning/approval 只通过公开合同复用。

## 明确不做

- 不接入 LLM API、不让 Agent 自动批准；
- 不实现图片/音频 Provider、正式素材生产或 Workspace UI；
- 不覆盖 WFM1 产物，不修改既有 stage id；
- 不把 Markdown 文件名当作稳定身份。

## 聚焦设计（WFM2 创意与视听产物合同）

本节是 TASK-034 对 ADR-0037 的聚焦设计产出，只定产物身份/版本/谱系的合同层与边界
规格，不选最终 schema/字段/目录/Python 类型/DB、不接入 Provider、不含代码。裁决结论
见 [ADR-0037](../../adr/ADR-0037-wfm2-creative-and-audiovisual-artifact-contract.md)。

- **合同层裁决**：按 ADR-0037 采用「结构化索引覆盖正文媒体」——完整创意/视听正文可用
  Markdown/媒体，但每个锁定产物由稳定 `ref/version/content_digest` 的结构化 index
  承载身份、parent、精确输入 refs、修改原因、Checklist 证据与人工批准。
- **产物身份**：L0/S1/S2/S3 每个正式产物（结构化剧本、场景/镜头、人物/场景/道具资产、
  图像/视频/配音/字幕产物等）具备稳定 ref、不可变 version、content digest、producing
  step 与精确输入 refs；生成型产物追加引用 task/operation/provider/model/parameters。
  文件名不代替 `ref/version/digest`。
- **版本与不可变性**：锁定产物不可变发布；修改已批准产物须创建带 parent、修改原因与
  受影响引用的新版本，绝不原地覆盖；覆盖只经显式确认或带版本的新路径。
- **谱系与载荷贯穿**：每个锁定产物引用精确输入、前一版、Checklist 证据与人工批准；一主
  至多一次载荷贯穿剧本、视听设计、QC 与评价引用。
- **Provider 中立边界**：核心创意/视听合同不绑定具体厂商；Provider 只产结构化结果或
  staging，正式身份由授权 Orchestrator/application 写入者发布；本任务不泛化
  `VideoProvider`、不定义 Provider（多媒体抽象属 ADR-0038）。
- **人工 Gate**：Agent 生成候选与定向修改建议，不能独自形成最终批准；stage lock 须
  人工完成，不引入 UI/Agent 专用状态机或自动创意批准。
- **独立执行与续跑**：完整 L0/S1/S2/S3 计划在步骤未运行时即可查询；上游版本变化时
  旧执行记录保留、下游 readiness 失效，重执行产生新版本或 operation，不原地覆盖。
- **WFM1 兼容与 baseline 完整**：既有 stage/step id 不变，只扩展产物与完成条件；逐项
  细化语义 I/O baseline，不删除输入绑定、输出身份或人工 Gate；WFM1 legacy/minimal
  产物以兼容方式暴露给 WFM2 查询层。
- **授权边界（须有测试固化）**：新增物理路径、schema 或状态先走 ADR-0001/0012 增补；
  三个代表镜头未通过时不得进入正式素材制造；Agent 输出不能形成最终批准。

## 实施步骤

1. 将语义 I/O baseline 逐项细化为 schema/owner/validator，不删除或合并步骤，
   并接受 ADR-0037。
2. 实现不可变版本索引、Checklist 和 stage target 校验。
3. 实现 Agent handoff 输入包与人工确认记录，不引入 Agent 状态机。
4. 实现三镜头试制与 format/AV design lock 的准入检查。
5. 增加 WFM1 minimal 到 WFM2 complete 的兼容和失败测试。

## 测试要求

- 主/次载荷值域、不得相同、Checklist 与目标 digest；
- parent/version/digest、不可变发布、stale approval 和 change impact；
- 完整 L0/S1/S2/S3 计划在未运行时可查询；
- Agent 输出不能形成最终批准；M1/WFM1 回归保持通过。

## 验收标准

- [ ] 工作流 L0、S1、S2、S3 每项均有执行主体、权威产物和完成条件；
- [ ] 每一步的输入 refs、输出身份、required/conditional、唯一写入者和失效传播明确；
- [ ] 主载荷及创作目标贯穿剧本、视听设计、QC 和评价引用；
- [ ] 三个代表镜头未通过时不能进入正式素材制造；
- [ ] 新路径与 owner 均有 Accepted ADR 授权；
- [ ] 未实现图片/音频生成或自动创作批准。
