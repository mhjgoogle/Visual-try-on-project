# ADR-0012: WFM1 阶段审计、生产规划与交付归档的项目内路径增补

- Status: Accepted
- Date: 2026-08-02
- Scope tasks: TASK-019（审批审计）、TASK-020（生产规划）、TASK-022（QC/
  发布/归档）
- Amends: ADR-0001（WFM1 增补——仅新增路径，不改既有条目）
- Related: ADR-0011（profile/reuse 路径）、TASK-014 合同 1（审批 v2）

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

## Not decided here

- 提示词自动优化、实验比较、发布平台集成（范围外）；
- 归档的对象存储迁移（未来）。
