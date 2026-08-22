# ADR-0012: WFM1 阶段审计、生产规划与交付归档的项目内路径增补

- Status: Accepted
- Date: 2026-08-02
- Scope tasks: TASK-019（审批审计）、TASK-020（生产规划）、TASK-022（QC/
  发布/归档）
- Amends: ADR-0001（WFM1 增补——仅新增路径，不改既有条目）
- Related: ADR-0011（profile/reuse 路径）、TASK-014 合同 1（审批 v2）
- Amended (WFM2): 2026-08-03 — 新增 `creative/{l0,s1,s2,s3}/<kind>_v<N>.json`
  创意/视听锁定产物结构化索引树（TASK-034 / ADR-0037）；仅新增路径，不改既有条目，
  不改既有 stage/step id。详见「## WFM2 增补」。

## Context

TASK-019/020/022 各自需要新的**项目内**持久化位置：阶段转换审计与变更
记录、L0–S3 规划产物与任务包、S4–S7 的 QC/发布/归档产物。按 ADR-0007
§7，任何新增物理路径先经 ADR 授权。三张卡的路径一次性在此锁定，避免
逐卡增补 ADR-0001。

## Decision — 路径（全部相对项目根，经 ADR-0004 containment 准入）

**TASK-019（唯一写入者：approval workflow 服务）**

- `approval/audit.jsonl` — append-only 阶段转换审计与变更记录（stage、
  action、from/to、时间、操作者、原因）。只追加、不改写；损坏行为类型化
  错误。审批标记本身沿用既有 `approval/<stage>.json` v2 合同（TASK-014
  合同 1），状态转换以原子替换更新标记文件，不改其 schema。

**TASK-020（唯一写入者：planning 模块）**

- `planning/brief_v<N>.json`、`planning/story_v<N>.json`、
  `planning/shot_plan_v<N>.json` — L0–S3 最小结构化产物，**不可变版本**
  （修订=新版本文件，防覆盖）。
- `planning/prompts/<prompt_id>/v<N>.json` — 提示词不可变版本（含上一版
  引用与修改原因；`prompt_id` 为安全路径组件）。
- `planning/packets/<shot_id>_v<N>.json` — 逐镜头 task packet 不可变版本；
  同输入 digest 重复编译幂等复用，不同 digest 产生新版本，绝不覆盖。

**TASK-022（唯一写入者：release 模块）**

- `qc/technical_qc_v<N>.json`、`qc/final_review_v<N>.json` — QC 检查清单
  与人工终审结论，不可变版本；可作为 `qc_release` 阶段的审批 targets。
- `release/release_v<N>.json` — 发布包 manifest（引用成片相对路径 +
  digest，不复制媒体）。
- `archive/archive_manifest_v<N>.json`、`archive/postmortem_v<N>.json` —
  归档清单与结构化复盘（复盘为 QCD 事件与阶段记录的**派生**，可重算，
  不复制权威事实）。

## Decision — 通用规则

- 全部 JSON、UTF-8、canonical 排序键；金额沿用整数最小单位/整数日元；
- 不可变版本文件一律创建型原子写（temp + fsync + link，已存在即拒绝）；
  `audit.jsonl` 一律 O_APPEND；
- 引用一律 `ref + version + content_digest` 或项目内相对 POSIX 路径，
  不写跨项目绝对路径；
- 这些目录都不含 `config/wfm1.json`，不影响账户级项目发现与月度预算
  语义；
- Provider/Orchestrator/budget 等既有组件不读写这些路径；新模块也不写
  任何既有业务状态文件。

## Consequences

- Batch C–E 的持久化位置一次锁定，后续任务不再需要路径类 ADR；
- 审计、规划、QC、发布、复盘全部可由权威文件派生/重算，无第二事实来源。

## Schema 演进记录

- 2026-08-02（milestone review 修正批）：`qc/technical_qc_v<N>.json` 的
  `schema_version` 由 1 升为 **2**：`final_output` 从裸 ref 字符串改为
  `{ref, content_digest}`，并新增 `final_media_playable` 检查项，使 QC
  判定绑定其检查过的确切媒体。旧 v1 文档在 `package-release` 处 fail-closed
  （提示重新 `qc-run`），不做迁移。`qc/final_review_v<N>.json` 保持
  schema_version 1 不变。

## WFM2 增补（TASK-034 / ADR-0037，2026-08-03）

WFM2 把 WFM1 最小 brief/story/shot plan 扩展为完整 L0/S1/S2/S3 创意与视听设计。
按 ADR-0037「结构化索引覆盖正文媒体」裁决，新增一棵项目内不可变索引树（全部相对
项目根、经 ADR-0004 containment 准入）：

- `creative/l0/<ref>_v<N>.json` — L0 创意锁定产物索引（kind：idea_card、
  logline_set、load_declaration、short_form_test、feasibility_report、
  concept_probe、concept_lock 等）；
- `creative/s1/<ref>_v<N>.json` — S1 叙事设计索引（kind：story_bible、beat_sheet、
  character_arc、screenplay、load_review、narrative_qc、screenplay_lock 等）；
- `creative/s2/<ref>_v<N>.json` — S2 视听设计索引（kind：format_lock、visual_bible、
  design_registry、cinematography_guide、audio_bible、visual_probe、
  av_design_lock 等）；
- `creative/s3/<ref>_v<N>.json` — S3 生产设计索引（kind：shot_list、shot_card、
  production_route、provider_plan、shot_budget、preflight_report、
  production_design_lock 等）。

`<ref>` 是 stage 内稳定唯一 slug（如 `concept_lock`、`shot_card_shot-1`），承载产物
身份；`kind` 是索引内的分类字段（同一 kind 可有多个 ref，如逐镜头 shot_card）。

规则（在「## Decision — 通用规则」之上补充，冲突以更严者为准）：

- 每个索引是**创建型原子写、不可变版本**（temp + fsync + link，已存在即拒绝），
  承载稳定 `ref`、不可变 `version`、`content_digest`（`config_digest` 规范化）、
  `producing_step`、精确 `input_refs`（`stage+ref+version+content_digest`，跨 stage
  可无歧义解析）、`parent_version`
  + `change_reason`（有 parent 必填）、`checklist_evidence` 与可选项目内相对
  `body_ref`（Markdown/媒体正文路径，正文本身不是正式事实，身份只在索引上）；
- 文件名不代替 `ref/version/digest`；正文/媒体不得脱离索引独立成为正式事实；
- 既有 WFM1 `planning/`（brief/story/shot_plan/prompts/packets）与 `approval/`
  路径不变，仍是 S3 formal 编译与 stage lock 审批面；`creative/s3/` 只承载 S3 逻辑
  设计索引（拆分/任务卡/路线/provider 计划/预算/预检），不重复 packet 编译；
- stage lock（concept/screenplay/av_design/production）仍由既有 `approval/` 门人工
  完成，索引通过 `approval target`（`ref+version+content_digest`）绑定，不引入
  UI/Agent 专用状态机或自动创意批准；
- 逐字段最终 JSON schema、DB/物化 projection、多媒体 Provider/probe 落盘（ADR-0038）
  与 S5–S7 后期/QC/发布 schema（ADR-0039）不在本增补授权范围内。

## Not decided here

- 提示词自动优化、实验比较、发布平台集成（范围外）；
- 归档的对象存储迁移（未来）；
- WFM2 逐字段最终 schema、多媒体 Provider 与后期/QC/发布/复盘路径（ADR-0038/0039）。
