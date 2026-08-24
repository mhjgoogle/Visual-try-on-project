# Creation Workspace 只读查询合同（WSM0 / TASK-024）

> **状态：Frozen query baseline (WSM1-implementable)，待 ADR-0031 独立审查后
> Accepted。** 本文把
> [数据可观察性要求](../creation_workspace_data_observability_requirements.md)
> 与 [L0–S7 工作层级 I/O 合同](workflow-stage-step-io-contract.md) 收口为一组
> 稳定、与 UI 技术和数据库无关的只读查询。**不定义** JSON 字段名、目录、数据库、
> HTTP/IPC 协议、前端 view model，也不实现任何 projection、API、页面或 Gateway。
> 决策依据 [ADR-0030](../adr/ADR-0030-creation-workspace-delivery-governance.md)、
> [ADR-0031](../adr/ADR-0031-workspace-query-and-projection-contract.md)、
> [ADR-0010](../adr/ADR-0010-creation-workspace-boundary.md)。

## 1. 合同边界与总原则

1. **只读、可重建**：查询只从权威业务文件和 append-only 事件派生；结果可删除并
   确定性重建，绝不写回、修复或扩展权威状态，绝不持有凭据。
2. **UI/DB 中立**：本合同定义查询的语义、输入、返回语义、排序和失败规则，不定义
   实现所用的字段名、序列化、存储或界面。
3. **权威 / 派生 / 不可用三分**：每个返回字段必须标注为
   `authoritative`（唯一写入者按合同持久化的事实）、`derived`（可重算派生值，如
   JPY 折算、累计、当前状态、下游谱系）或 `unavailable/legacy`（WFM1 未实现或历史
   数据不具备该语义，明确标注，不猜测补值）。
4. **计划定义与运行实例分离**：未运行项目也能返回完整阶段/步骤计划（§5），运行事实
   为空时标注 unavailable，不伪装 completed。
5. **fail-closed**：source 损坏、ref 缺失、version 不存在、digest 漂移、孤儿谱系或
   成本对账不明时，查询不静默降级，而是在结果的 `problems` 中返回结构化问题
   （§4），必要时整条 readiness 判定为失败。
6. **合同版本化**：本查询合同带独立 `contract_version`；每个查询有稳定 `query_id`。
   兼容与弃用策略见 §6。

## 2. 查询结果信封（语义，非字段名）

每个查询返回一个信封，语义包含：

- `query_id`：稳定查询标识；
- `contract_version`：本合同版本；
- `generated_at`：生成时刻（UTC 存储，Asia/Tokyo 为派生显示）；
- `scope`：项目 ref 或账户范围 + 过滤/分页/排序参数回显；
- `items`：结果集合，每项字段按 §1.3 标注三分；
- `problems`：结构化问题列表（§4），空表示无异常；
- `markers`：整查询级标记（如 `contains_unavailable`、`projection_conflict`、
  `readiness_failed`）。

信封不承诺任何物理编码；实现（TASK-025）在其 Accepted 设计内决定序列化。

## 3. 查询目录（冻结基线）

下列查询覆盖可观察性要求 §6 的九条 readiness 查询、跨项目发现与复用/预算/审计
深钻。每条列出：用途、输入、返回语义要点、排序、失败语义。字段三分标注在“返回”
中以〔A〕authoritative /〔D〕derived /〔U〕unavailable 标示。

### WQ-01 project-plan（未运行完整计划）
- 用途：对任意项目（含未运行）返回完整 L0–S7 阶段/步骤计划、依赖、预期输入输出、
  required/conditional/optional-data 标记和 stage gate。
- 输入：project ref；stage registry；I/O 合同；project profile。
- 返回：阶段/步骤 stable id〔A〕、依赖〔A〕、逻辑输入输出类型〔A〕、执行类别〔A〕、
  gate 判定项〔A〕；WFM1 未实现步骤的执行事实〔U，定义可见、运行为空〕（见 §5）。
- 排序：阶段序 → 步骤序（stable id 决定，确定）。
- 失败：stage registry 与 I/O 合同不一致、profile 缺失 → problem，计划仍尽力返回
  已知部分并标 markers。

### WQ-02 project-status（当前进度）
- 用途：返回项目当前阶段、整体/阶段进度、运行中与阻塞步骤及 reason。
- 输入：approval markers + audit；orchestration/运行事实；packets。
- 返回：各 stage status〔A〕、stale 原因〔A〕、blocked_by〔D〕、当前阶段〔D〕、
  进度比〔D〕；非成功状态的 category/reason〔A〕与可定位对象〔A〕。
- 排序：阶段序。
- 失败：审批目标 digest 漂移、状态无法由权威记录验证 → problem + stale 标注。

### WQ-03 lineage-upstream（向上溯源）
- 用途：从任意正式产物追溯全部输入 refs/versions/digests。
- 输入：artifact ref；lifecycle/asset records；packets；planning refs。
- 返回：输入 ref/version/digest 链〔A〕、producing step/task/operation〔A〕、
  派生的完整祖先集合〔D〕。
- 排序：按谱系深度再按 stable id。
- 失败：无 producer 的孤儿产物、指向不存在对象 → readiness 失败。

### WQ-04 lineage-downstream（向下消费者）
- 用途：对任意输入返回其直接下游消费者。
- 输入：object ref；谱系索引（可只存一向，另一向派生）。
- 返回：直接消费 task/step/artifact〔A 或 D〕。
- 排序：stable id。
- 失败：同 WQ-03。

### WQ-05 prompt-history（创意/提示词版本链）
- 用途：对一个 prompt 返回版本链、差异依据（parent + 修改原因）、生成批次、全部
  结果、选中结果和后续产物。**仅覆盖 WFM1 已支持的产物类型**；范围外类型标 unavailable。
- 输入：prompt id；planning 版本 + lineage；packets；lifecycle。
- 返回：version 链〔A〕、parent/change_reason〔A〕、reference assets〔A〕、生成批次与
  候选/选中〔A〕、下游产物〔D〕；图片/音频/字幕结果〔U〕。
- 排序：version 升序。
- 失败：版本从自由文本推断、缺 digest → readiness 失败。

### WQ-06 shot-attempts（镜头执行历史）
- 用途：对一个镜头返回全部 attempt/redo/fallback、Provider/model/参数、状态和时间。
- 输入：shot id；reservation records；qcd events；packets。
- 返回：operation/attempt〔A〕、状态/category/reason〔A〕、external ref〔A〕、
  provider/model/参数版本〔A〕、时间〔A〕、redo/fallback 关系〔A〕；
  **合同 1.6 起**：该 attempt 产出的媒体 `media_ref` / `media_kind` /
  `media_version` / `media_path` / `media_sha256`〔A〕、`media_asset_count`〔D〕。
- **媒体绑定的连接键是 `operation_id`**（TASK-027 part-2b）：它在两侧都是权威
  事实 —— `media/assets.py` 的 `_validate_producer` 对每个 generation 来源的资产
  强制要求它，reservation 本来就带 —— 所以绑定不靠名字或时间推断。
  手工/导入来源的资产没有 `operation_id`，**不参与绑定**，也不编一个。
- **没有已发布资产的 attempt，五个媒体字段全部 `unavailable`**，一个都不回填：
  空路径在界面上会读成「有这个文件但打不开」，而事实是「这次尝试没有产出资产」。
  一次操作发布了多个资产时，取版本最高的那个并把总数放进 `media_asset_count`，
  **不静默只显示一个**。
- 排序：时间升序（带时区）。
- 失败：skip/retry/redo/fallback/cancel/人工终止无法区分 → problem。

### WQ-07 cost-breakdown（成本深钻）
- 用途：按阶段/步骤/镜头/Provider/model/时间派生预计、预留、实际、失败/重试成本。
- 输入：catalog/packets（quote/estimate）；reservation（hold）；qcd events（actual）。
- 返回：quote/estimate/hold/actual 分列，语义不合并〔quote/estimate〔A packet 内〕、
  hold〔A〕、actual 原币整数〔A〕〕；JPY 折算、累计、按维度聚合〔D〕；failed/retry/
  redo/fallback/ambiguous 占额与实际可单独识别〔D〕。
- 排序：所选维度键 → 时间。
- 失败：paid operation 无法关联 quote/reservation/actual 或对账状态 → readiness 失败；
  跨币种不得错误相加（不同币种分列，不合成单一 cost）。

### WQ-08 evaluation-decision（评价与创作决定）
- 用途：对一个评价或决定返回精确目标版本、创作目标、结论和理由。
- 输入：QC/final review 证据；release/archive manifests；（WFM2）评价/决定证据。
- 返回：target ref+version+content_digest〔A〕、actor（用户/AI 辅助区分）〔A〕、
  verdict/score/tag〔A〕、reason〔A〕、profile 目标基线绑定〔A〕；WFM1 范围外的
  L0/S1/S2 创作决定〔U〕。
- 排序：目标 version → 时间。
- 失败：评价未绑定 ref+version+digest、结论只在 Markdown 无结构化索引 → readiness 失败。

### WQ-09 recent-problems（最近问题）
- 用途：返回最近错误/QC 问题及其 project/step/task/operation/object 上下文。
- 输入：qcd events；qc records；reconciliation gaps。
- 返回：问题 category/reason〔A〕、定位上下文〔A〕、时间〔A〕；聚合计数〔D〕。
- 排序：时间降序。
- 失败：关键关系只能从日志文本/异常/文件名得到 → readiness 失败。

### WQ-10 projection-rebuild-check（重建一致性，元查询）
- 用途：删除 projection/cache 后，从同一权威输入重建出语义等价、排序确定的结果。
- 输入：任意上列查询的两次独立求值。
- 返回：逐字节/语义等价判定〔D〕、差异定位〔D〕。
- 排序：不适用。
- 失败：两次结果不一致，或求值过程写入任何文件 → readiness 失败。

### WQ-11 cross-project-index（跨项目发现）
- 用途：发现账户下全部项目并返回高层状态、成本累计概览。
- 输入：账户根；各项目 project/profile/approval/qcd 概览。
- 返回：project ref/title/version〔A〕、当前阶段〔D〕、账户级成本累计（按币种）〔D〕、
  月度在途概览〔D〕。
- 排序：project stable id（确定）；分页参数回显。
- 失败：项目 config 缺失或损坏 → 该项目降级为 problem 条目，不阻断其他项目。

### WQ-12 reuse-asset-usage（复用资产使用面）
- 用途：对一个复用资产（ref+version+digest）返回引用它的项目集合与替代关系。
- 输入：账户级 reuse packs；各项目 reuse_refs。
- 返回：asset ref/version/content_digest〔A〕、引用项目集合〔A〕、来源/替代关系〔A〕。
- 排序：project stable id。
- 失败：ref 引用不存在版本、digest 不匹配 → readiness 失败。

### WQ-13 approval-audit（审批审计）
- 用途：返回阶段审批的 status、锁定 target refs/versions/digests、审批人/时间、失效原因。
- 输入：approval markers；append-only audit。
- 返回：stage status〔A〕、approved_targets〔A〕、actor/time（带时区）〔A〕、
  stale/invalidation reason〔A〕、转换来源〔A〕。
- 排序：阶段序 → 审计时间。
- 失败：当前状态无法由权威审计验证 → problem。

### WQ-14 budget-standing（预算态势）
- 用途：返回项目 episode 与账户 monthly 的 committed + outstanding hold 态势。
- 输入：reservation records；qcd 成本事件；project config 预算与 FX。
- 返回：episode soft/hard、monthly hard〔A config〕、committed 原币/JPY〔A/D〕、
  outstanding holds（含跨项目在途）〔A/D〕、余量〔D〕。
- 排序：项目 → 时间。
- 失败：hold 与已提交成本无法关联、FX 未在项目锁定 → problem。

### WQ-15 evaluation-domain（评价 / 实验 / 创作决定，WSM2-A，contract v1.2）
- 用途：返回 ADR-0034 append-only 评价事实域（evaluation / experiment /
  creative_decision）历史；每条附其绑定 target + goals + actor + payload
  （authoritative）与读取期派生的 stale。实验 payload 含被比较 variants、
  changed_factor、预期/实际与复用结论（比较视图）。
- 输入：评价域事实日志（ADR-0034）；project profile（goals 基线）与 QCD
  asset_imported（target 权威事实，仅用于 stale 派生，只读引用不复制）。
- 返回：record_type/record_id/occurred_at/actor/target/goals_version/payload〔A〕、
  stale + stale_reasons〔D，goals/digest/版本漂移或目标缺失〕、incremental_cost_time
  〔D（仅 experiment）：每个 variant 经 asset_imported→source_task_id 关联到该任务的
  权威 cost_by_currency（minor units）+ attempts_elapsed_ms，并给出对首个 variant 的
  delta。`cost_known` 区分**已知零**（有聚合任务但无付费成本，如手动 variant →
  `cost_by_currency={}`、可算 delta）与**未知**（无产出任务 → `cost_by_currency=null`、
  delta=null，绝不伪造成 0/负 delta）；delta 仅在两侧皆已知时给出。项目快照或事件
  日志缺失时该项 unavailable。按 ADR-0034 为 query 层派生、本域不存第二成本源〕。
- 排序：occurred_at → record_id。
- 失败：评价日志损坏 → source_corrupt problem（fail-closed，空记录集）；某条记录
  target/goals 漂移或缺失 → 该条标 stale + 结构化 problem（readiness 不失败，事实仍
  authoritative 返回，不静默补值）。
- 只读：本查询不写入、不调用 Provider、不复制 QC/成本/谱系事实；写入仅经批准
  CLI/app service（ADR-0032）。

### WQ-16 action-center（反馈 / Action，WSM2-B，contract v1.3）
- 用途：只读 Action Center——返回 ADR-0035 append-only feedback/action 事实域的
  全部 feedback 与 Action；Action 附其**折叠出的**生命周期状态（pending/in_progress/
  waiting_for_user/completed/blocked/cancelled）、派生 target stale 叠加与问题→处理→
  验证事件轨迹。
- 输入：feedback/action 事实日志（ADR-0035）；QCD asset_imported（target 权威事实，
  仅用于 stale 派生，只读引用不复制）。
- 返回：feedback〔kind/feedback_id/occurred_at/actor/target/context/summary〔A〕、
  target_stale/stale_reason〔D〕〕；action〔kind/action_id/feedback_id/occurred_at/
  actor/intent/target〔A〕、lifecycle_state/effective_state/target_stale/stale_reason/
  rebind_count/event_trail〔D，由 append-only 事件折叠〕〕。
- 排序：occurred_at → 记录 id。
- 失败：日志损坏 → source_corrupt problem（fail-closed，空记录集）；target digest 漂移
  或缺失的 Action → effective_state=stale + 结构化 problem（readiness 不失败，事实仍
  authoritative 返回）。
- 只读：本查询不写入、不调用 Provider、不应用 Action 隐含的变更（那是 Gateway 的职责，
  ADR-0033）；写入仅经批准 CLI/app service，状态转换经独立状态机与合法转换图校验。

### WQ-17 cross-project-analytics（跨项目派生指标，WSM3-A，contract v1.4）
- 用途：账户级、按项目派生的 KPI——evaluation pass rate、Action resolution rate 等，
  从版本化权威事实**按需派生、无持久缓存**（ADR-0036/0031），带稳定定义。
- 输入：各项目 evaluation / action append-only 事实（只读引用）；账户发现。
- 返回：per-project evaluation_count/action_count〔A〕、evaluation_pass_rate/
  action_resolution_rate〔D，无该类事实即 `unavailable`（insufficient_evidence），
  绝不编造置信度〕、insufficient_evidence〔D〕。
- 排序：项目名。
- 失败：源事实损坏按各域 fail-closed；证据不足 → unavailable，不伪造。

### WQ-18 recommendations（证据化推荐，WSM3-A，contract v1.4）
- 用途：返回**用户确认的已提升知识**作为证据化推荐，每条附适用条件、历史 evidence
  refs（ref+digest+project）、样本 scope 与已知 limits（ADR-0036）。只作建议，不替代
  用户创作决定、不自动触发任何写命令（变更须经 Gateway）。
- 输入：账户级 append-only 知识事实日志（ADR-0036 / ADR-0001 第五次增补）。
- 返回：knowledge_id/category/applicability/recommendation/evidence_refs/scope/
  limits〔A〕。
- 排序：knowledge id。
- 失败：无已提升知识 → 空 + `insufficient_evidence` problem（不伪造推荐）；知识日志
  损坏 → source_corrupt problem（fail-closed，空）。

## 4. 失败与问题模型

- 每个 problem 至少语义包含：`category`（如 `missing_ref`、`version_absent`、
  `digest_mismatch`、`orphan_lineage`、`cost_unreconciled`、`projection_conflict`、
  `schema_unsupported`）、可定位上下文（project/stage/step/task/operation/object）、
  以及是否触发 `readiness_failed`。
- projection 与权威事实冲突时，以权威事实为准，标记 projection 损坏，**不回写**。
- 面向用户的问题信息必须脱敏：credential 值、Authorization、私有下载 URL 和敏感
  响应不得进入结果或 problem 文本。
- 历史数据不具备新语义时标记 `unavailable/legacy`，不猜测补值；WFM1 未实现的图片/
  音频/字幕/Action 标记为范围外，不得为通过 readiness 伪造记录。

## 5. Stage/Step 计划查询对 I/O 合同的无损映射（WQ-01）

WQ-01 必须无损呈现 [I/O 合同](workflow-stage-step-io-contract.md) 的层级：

1. **计划定义层（始终可返回，即使未运行）**：Project → L0 → S1…S7 的每个 step，
   携带其 `执行`（required / conditional / optional-data）、必需输入类型、逻辑输出
   类型、责任描述、完成条件，以及 §11 的 stage gate 判定项。这些全部来自 stage
   registry 与 I/O 合同，标注〔A〕，**不从已有运行记录反推**。
2. **运行实例层（有则叠加）**：对已实现步骤叠加真实审批/运行/成本事实；未实现步骤
   的运行事实标注〔U，定义可见、运行为空〕。
3. **WFM1 粒度对齐（诚实声明）**：WFM1 当前实现的是 8 阶段审批登记
   （concept_lock、screenplay_lock、av_design_lock、production_lock、assets_ready、
   assembly_done、qc_release、retrospective）与 planning/packets 的最小规划。
   I/O 合同的 L0–S7 细分步骤中，**L0–S3 的部分创意/设计步骤、S4 的图片/音频/字幕、
   S5–S7 的正式后期/QC/发布/复盘细分**当前为**定义可见、执行 unavailable**，其
   source owner 由 ADR-0037～0039 / TASK-034～036 锁定，TASK-039 接入 Workspace。
   WQ-01 必须如实区分“已实现并有运行事实”与“计划定义存在但 WFM1 未执行”，
   不得在查询层补造缺失步骤、输入或输出。
4. `conditional` 步骤未触发时返回 `not_applicable` 及依据；`optional-data` 未获得时
   返回 `unavailable`，二者都不得记为 completed 或零。

## 6. 兼容性与弃用策略

- 本合同带 `contract_version`。**新增查询或在返回中新增可选字段** = 向后兼容，
  提升 minor。
- **删除/重命名查询或返回语义、收紧失败语义** = 破坏性变更，须新 ADR 增补后才可，
  并在本文记录迁移。
- 每个查询的 `query_id` 稳定，不复用、不改义。
- source adapter 遇到其不支持的 schema_version：返回 `schema_unsupported` problem，
  **不崩溃、不猜测**；查询尽力返回其余可解析部分。

## 7. Source-to-Query 可追溯矩阵

“权威来源/写入边界”只指定语义所有者与已存在的读边界，**不授权新增路径或修改冻结
schema**。每个 source 由一个独立只读 adapter 读取，跨域组合只在查询层完成。

| Source 域 | 权威写入者 / 已存在文件（示意语义，非授权路径） | owner task | 服务的查询 |
| --- | --- | --- | --- |
| Project / goals | project 记录、profile 版本 | TASK-018 | WQ-01/02/11 |
| Reusable asset | 账户级 reuse pack + 项目 reuse refs | TASK-018 | WQ-12 |
| Stage plan 定义 | stage registry + I/O 合同 + profile | TASK-019 + 本文 | WQ-01 |
| Stage approval | approval v2 markers + append-only audit | TASK-019 | WQ-02/13 |
| Creative/prompt | planning 版本化产物 + lineage | TASK-020 | WQ-01/05 |
| Task packet | task packet + locked catalog | TASK-020 | WQ-05/06/07 |
| Run/attempt | orchestration + reservation | TASK-021 | WQ-02/06 |
| Generated artifact | asset 记录 + lifecycle 谱系投影 | TASK-021 | WQ-03/04/05/06 |
| Cost | catalog/reservation/QCD 事件 | TASK-015/016/021 | WQ-07/14 |
| QC / evaluation / decision | QC + final review 证据 | TASK-022 | WQ-08/09 |
| Release / postmortem | release + archive manifests | TASK-022 | WQ-08 |
| Reconciliation / problems | QCD 事件 + reconciliation gaps | TASK-016/021 | WQ-09/14 |
| Projection readiness | 只读验收 fixture | TASK-023 | WQ-10 |

## 8. WFM1 Gap List（当前可回答 / 缺什么 / 由谁补齐）

| 语义领域 | WFM1 状态 | 缺口与 owner |
| --- | --- | --- |
| 项目/目标、复用资产身份 | ✅ 可回答 | 无（TASK-018） |
| 8 阶段审批 + 审计 | ✅ 可回答 | 无（TASK-019） |
| 规划产物 + 任务包 + P50/P90 | ✅ 可回答 | 无（TASK-020） |
| 付费 run/operation + 谱系 + 成本 | ✅ 可回答 | 无（TASK-021） |
| 技术 QC + 人工终审 + 发布/归档/复盘 | ✅ 可回答 | 无（TASK-022） |
| 只读 projection 确定性重建 | ✅ 可回答 | 无（TASK-023） |
| L0/S1/S2 完整创意/设计步骤运行事实 | ⛔ unavailable | ADR-0037 / TASK-034，验收 TASK-037 |
| 图片/母资产/关键帧生成 | ⛔ unavailable | ADR-0038 / TASK-035，验收 TASK-037 |
| 音频/对白/音乐/音效/字幕 | ⛔ unavailable | ADR-0038/0039 / TASK-008/035/036 |
| 正式 S5–S7 后期/多维 QC/权利 QC/多平台发布 | ⛔ unavailable | ADR-0039 / TASK-036 |
| 实验比较 / 评价 scorecard（超出 QC，含增量成本/时间） | ✅ 可回答（WQ-15，contract v1.2） | ADR-0034 / TASK-028（WSM2-A 消费） |
| 观众表现数据 | ⛔ optional-data/unavailable | S7-T03；TASK-037/039 |
| 跨项目学习 / 证据化推荐 | ✅ 可回答（WQ-17/18，contract v1.4） | ADR-0036 / TASK-032（WSM3-A 消费） |
| 反馈 / Action Center（只读观察） | ✅ 可回答（WQ-16，contract v1.3） | ADR-0035 / TASK-029（WSM2-B 消费） |
| Action 写操作 / 状态机驱动 | ⛔ 范围外（只读合同不含，写入经 Gateway） | ADR-0033/0035 / TASK-030/031（WSM2） |

范围外语义在查询结果中一律标 `unavailable`，不得为通过 readiness 伪造记录，也不得
反向扩大 TASK-018～023。

## 9. WSM1 冻结基线与里程碑 checkpoint

- **冻结查询基线**：WQ-01～WQ-14 及其返回语义、排序、失败规则构成 WSM1-A/B/C 可
  实现的稳定合同；TASK-025 实现 projection/query service 时只依据本文与 ADR-0031，
  不新增查询语义、不引入第二事实来源。
- **WQ-15 扩展（contract v1.2，TASK-028 / WSM2-A）**：在冻结的 WQ-01～14 之上叠加
  WQ-15 评价域只读消费（§8 覆盖表指定的 owner，ADR-0034 事实域）。为叠加式只读：
  不改任何写入者、不改既有查询语义/排序/失败规则、不新增第二事实源；
  `QUERY_CONTRACT_VERSION` 由 1.1 minor bump 至 1.2。WQ-01～14 基线保持冻结。
- **WQ-16 扩展（contract v1.3，TASK-029 / WSM2-B）**：叠加 WQ-16 反馈/Action Center
  只读消费（ADR-0035 事实域）。同为叠加式只读：Action 当前状态由 append-only 事件
  折叠派生，不引入第二写入者、不改既有查询语义；`QUERY_CONTRACT_VERSION` minor bump
  至 1.3。WQ-01～14 基线保持冻结。
- **WQ-17/18 扩展（contract v1.4，TASK-032 / WSM3-A）**：叠加 WQ-17 跨项目派生指标
  与 WQ-18 证据化推荐（ADR-0036）。指标为账户级 on-demand 派生、无持久缓存；推荐读
  账户级 append-only 已提升知识事实（ADR-0001 第五次增补授权 `<account>/knowledge/
  events/log.jsonl`）。均叠加式只读，不改既有查询语义；`QUERY_CONTRACT_VERSION` minor
  bump 至 1.4。WQ-01～14 基线保持冻结。
- **Projection 策略（初版）**：见 ADR-0031 决策——WSM1 采用 **on-demand 求值、
  不落持久缓存**；因此本基线**不授权任何项目/账户持久 projection 路径**。若 WSM1-A
  证明必须物化，须回到后续 ADR 增补（锁定路径、生命周期、唯一写入者，且持久路径
  须经 ADR-0001 授权）后方可实施。
- **Milestone checkpoint**：WSM1 最终只读验收仍以 TASK-023 readiness 通过为门槛
  （已于 2026-08-02 通过），并在 TASK-033 做 Workspace-on-WFM1 数据基线批末验收。

## 10. 当前不决定

字段名 / JSON 拆分 / 目录 / schema version / Python 类型；graph/relational DB、搜索
索引或文件扫描实现；query API、GraphQL/REST、前端 view model 或刷新策略；Action
schema、跨项目知识 schema、推荐算法；历史 M1 数据迁移方案。这些分别由 ADR-0032～
0036 / TASK-025 及后续任务在各自 Accepted 设计内决定。
