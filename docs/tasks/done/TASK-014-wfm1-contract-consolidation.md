# TASK-014：WFM1 提交前合同收口（docs-only）

> **状态：Accepted（合同锁定）。** 本任务只锁定合同，不改任何代码/测试。
> 治理基线见 [ADR-0007](../../adr/ADR-0007-wfm1-document-baseline-and-governance.md)
> （本任务即其所推迟的"具体审批/预算/选择合同"的落实）。
> 后续实施分两批：**TASK-015**（原型对齐补齐，非冻结）与 **TASK-016**
> （云端 Provider 接线与权威成本事实，含唯一一处冻结变更，见
> [ADR-0008](../../adr/ADR-0008-wfm1-authoritative-cost-fact-and-qcd-cost-event.md)）。

## 正式名称

WFM1 Pre-Submit Contract Consolidation

## 目的

Codex 审计指出 WFM1 原型（临时命名 B1/B2/B3 已落盘、P-C 未实施）在
五个合同点语义不足。本任务一次性锁定这些合同，使后续开发者无需再
猜语义，并明确每个后续任务的**允许修改范围**与**冻结合同边界**。
本任务落在 ADR-0007 治理基线之下，填入其 §"Not Decided Here" 推迟的
审批/预算/选择/成本具体合同。

## 背景与现状（事实基线）

已落盘的原型（未提交、未审查）：

- `src/ai_video_workflow/config/`（catalog + project_config + selection）；
- `src/ai_video_workflow/approval/`（approved.json 布尔守门）；
- `src/ai_video_workflow/budget/`（fx / quote / estimate / ledger / guard）；
- 示例 `config/providers/catalog.example.json`、
  `examples/projects/minimal/config/wfm1.example.json`、
  `.../approval/approved.example.json`；对应 tests。

这些原型**不删除、不覆盖**。TASK-015 在其之上对齐本文件锁定的合同。

关键既有约束（不可违反）：

- `providers/models.py::ProviderCostObservation.amount` 是**冻结的
  float 字段**——不得作为权威账目，不得修改该类（见 §5、ADR-0008）；
- QCD 事件（`qcd/events.py`）当前为 ADR-0003 固定 7 类，仅
  `manual_attempt_recorded` 携带 `cost_minor_units`/`currency`，其
  `action` 固定 `"manual_generation"`、类型名为 manual，**不得**用于
  云端成本（用户已裁定）；
- 目录/路径受 ADR-0004 containment 约束；覆盖保护见 ADR-0001/§9。

---

## 锁定合同

### 合同 1：审批记录绑定（stage + 版本 + digest + 自动失效）

审批不再是布尔标记，而是**对具体内容的绑定**。

- **审批标记按 stage 分文件**：`<project-root>/approval/<stage>.json`。
  WFM1 首个 stage = `concept_lock`。
- **标记 schema（v2，字段固定封闭）**：
  - `schema_version: 2`
  - `stage: str`（本标记治理的阶段，如 `"concept_lock"`）
  - `status: draft | review_needed | revision | approved | rejected`
  - `approved_at: str|null`、`approved_by: str|null`
  - `approved_targets: [ {ref_kind, ref, version, content_digest} ]`
    - `ref_kind: "file" | "asset"`
    - `ref: str`（file=项目内相对 POSIX 路径；asset=asset_id）
    - `version: int|null`
    - `content_digest: <sha256 hex>`（SHA-256 over canonical JSON /
      文件字节，算法复用 `digests.py`，TASK-005）
  - `note: str|null`
  - 不变式：`status=="approved"` 时 `approved_at`/`approved_by` 非空
    且 `approved_targets` 非空。
- **守门语义**：给定 stage → 读该 stage 标记 → 要求 `status=="approved"`
  → 对每个 target **重新计算当前内容 digest** 并与 `content_digest`
  比较。
  - 任一 target digest 不一致 → **StaleApprovalError**（`NotApprovedError`
    子类）：内容已变，审批**自动失效**，阻断下游生成；
  - target 引用的文件/资产缺失 → 阻断（fail-closed）；
  - 缺标记或非 approved → 阻断（沿用现有 fail-closed）。
- **最小风险默认**：digest 覆盖"创意锁定证据"文件（如 shot 记录、
  concept 文档）；具体 target 清单由项目在审批时写入，守门不臆测。

### 合同 2：Provider 选择（能力/模型/参数由任务提供，不固定 i2v）

- **三级选择**：项目 `default_provider`、镜头 `shot_overrides[shot_id]`、
  一个 `fallback_provider`（覆盖 > 默认；覆盖使主==备时备用收敛为
  None——沿用原型语义）。
- **能力不再硬编码**：所需 `capability` 由**任务/镜头显式提供**，
  不再是模块常量 `image_to_video`。选择解析器校验所选 provider：
  1. 在锁定 catalog 中存在；
  2. `capability` ∈ 该 provider 的 `capabilities`；
  3. 任务给定的 `model_id` 存在于该 provider 的 models。
  `generation parameters`（分辨率、时长、其他）由任务显式提供并透传
  给报价/请求构造，选择器不臆测默认值。
- **provider binding 不可变更**：一个 GenerationTask 首次成功 PREPARE
  形成 durable provider binding（TASK-007 合同）。**已绑定任务切换
  Provider 必须经 `create-redo-task` 新建任务**（新 task_id +
  `redo_of_task_id`），绝不原地改绑定。
- **fallback 语义**：仅在**主 Provider 失败**（网络/认证/生成失败类）
  时切换到备用；**预算触顶不得触发 fallback**（见合同 4）。

### 合同 3：Provider catalog（ID + 版本 + digest 锁定，禁价格漂移）

- catalog 增加顶层 **`catalog_id: str`** 与 **`version: int`**。
- catalog 内容 digest = SHA-256 over canonical JSON（`digests.py`）。
- **项目锁定所用 catalog**：`project config` 以
  `catalog_id` + `catalog_version` + `catalog_digest` 引用，
  **取代**原型的自由 `catalog_ref` 路径字段。
- **解析器**：按 `catalog_id` 从固定全局目录位置
  （`config/providers/`）解析 catalog，校验其 `version` 与 `digest`
  等于项目锁定值；**不匹配 → fail-closed**（检测到价格/内容漂移，
  拒绝运行）。**不接受项目提供任意路径**，**不接受动态价格**。
- 价格更新流程：发布新 catalog `version`（新 digest）；已存在项目
  仍锁定旧版本，需显式迁移（新项目或显式改锁），不静默漂移。

### 合同 4：预算（三范围账本 + 事前 reservation + 并发/崩溃）

- **三范围**：
  - 单镜头（project 内 shot 维度）；
  - 单集（**project == 单集**，WFM1 一项目一集）；
  - **月度 = 账户级（跨项目）**：对**账户根**下所有项目的权威成本
    按 **Asia/Tokyo 自然月**汇总。
    - 最小风险默认：账户根 = 一个配置目录，其直接子目录为各 project
      root；月度账本 = 各项目 QCD 权威成本事件在该 JST 月的合计。
      账户根发现机制细节在 TASK-015 落地，默认如上。
- **事前 reservation（防先花后判）**：调用 Provider **之前**持久化一条
  reservation，占用 `estimate_jpy`。
  - **幂等键 = (project_id, task_id, operation_id)**：同一操作的重放/
    并发只占用同一条 reservation，**并发去重**，不重复占额。
  - 生命周期：`HELD → COMMITTED`（写入权威成本事件后）或 `RELEASED`
    （确定无计费/失败无成本时）。
  - 守门口径（事前）：`Σ已提交权威成本 + Σ未决 HELD reservation +
    本次 estimate` 与各上限比较——防并发双花。
- **崩溃恢复 / 人工对账**：启动/resume 时对 HELD reservation 对账：
  - 存在匹配 (task, operation) 的权威成本事件 → 置 COMMITTED；
  - 该 (task, operation) 已确定失败且无计费 → RELEASE；
  - 不可判定 → **标记人工对账（不静默释放、不静默重复计费）**，
    偏向"既不漏记真实计费、也不虚占"，冲突交人工。
- **fallback 不得绕过预算**：月/单集**硬上限拒绝即停止**，绝不因此
  切换到更便宜 Provider（fallback 仅失败切换，见合同 2）。
- 守门优先级不变：月硬 > 单集硬 > 单镜头(2 次失败 / 达 80% / 超单镜)
  > 软警告（软仅警告）。

### 合同 5：成本事实（float 非权威 + 整数原币权威 + 派生关系）

- **Provider float 非权威**：`ProviderCostObservation.amount`(float)
  仅作**遥测**，**永不**作为账目权威。**不修改该冻结类**（边界转换
  方案，满足"优先不改冻结合同"）。
- **权威成本事实 = 整数原币最小单位 + ISO-4217 币种**，记录于
  **新增 append-only QCD 事件 `provider_cost_recorded`**（ADR-0008）。
- **边界转换（适配器职责，TASK-016）**：厂商适配器从 Provider 的
  **计费响应**派生权威整数最小单位（优先取整数/十进制字符串计费
  字段）；仅当无整数来源时才对 float 做**文档化确定性换算**并标注
  来源；float 遥测可作为审计附带值保留，但非权威。
- **四者关系**：
  - **quote**：catalog 定价（原币整数最小单位）——信息性；
  - **estimate_jpy**：quote → 锁定 FX → **ceil 日元**——reservation 占额；
  - **reservation**：占用 estimate_jpy 的**运营态**（非事实）；
  - **actual**：`provider_cost_recorded`（原币整数）——**权威事实**；
  - **JPY 派生实际**：actual → 锁定 FX → ceil 日元，由 ledger 现算，
    **非第二事实来源**（architecture §10）。
  - 账本权威支出 = Σ 权威成本事件（换算后）；reservation 仅事前守门
    与对账用。
- **新 QCD 事件最小合同**（`provider_cost_recorded`，详见 ADR-0008）：
  - 归属 project/shot/task；
  - payload 固定键：`provider_id`、`model_id`、`operation_id`、
    `cost_minor_units`(int)、`currency`(ISO-4217)、
    `billing_source`(str, 如 `"provider_billing_field"` /
    `"float_boundary_conversion"`)、`observed_amount`(float|null 遥测)、
    `observed_unit`(str|null 遥测)；
  - 确定性 `event_id = provider_cost_recorded:{task_id}:{operation_id}`；
    读取方去重（沿用 ADR-0003 §5）。

---

## 冻结合同边界（本次锁定的权威声明）

- **唯一冻结变更**：`qcd/events.py` 新增第 8 类事件
  `QcdEventType.PROVIDER_COST_RECORDED` 及其固定 payload 键集与构造器，
  `qcd/__init__.py` 导出——**仅此一处**，属 ADR-0003 固定域的受控增补，
  由 **ADR-0008** 授权，落在 **TASK-016**。
- **明确不改**：`ProviderCostObservation`、`models.py`、`manifest.py`、
  `serialization.py`、`persistence.py`、`project_data.py`、
  `validation.py`、`errors.py` 既有类、`security/`、`orchestration/`、
  `providers/` 既有文件、`composition/`、`assets/`、`inspection/`、
  `app/`、`cli.py` 既有行为。
- `qcd/log.py` envelope 已是通用编解码，新增事件类型**无需改** log.py
  的结构（仅 events.py 的类型域扩展）。

---

## 后续实施批次（最多两批）

### TASK-015：WFM1 配置/审批/预算合同对齐（Batch A，非冻结）

- **吸收临时 B1/B2/B3 原型**，对齐合同 1–4 与合同 5 的**非发射侧**。
- **允许修改**：`config/`、`approval/`、`budget/` 全部（原型自有文件）、
  `config/providers/`（catalog 增 id/version）、`examples/.../config`、
  `examples/.../approval`、对应 tests；ADR-0001 目录增补（reservation
  与 per-stage approval 路径）由本任务提交。
- **明确不做**：不接入任何真实 Provider；不发射任何 QCD 事件；不新增
  QCD 事件类型；不改任何冻结合同；不接 CLI 生成动作（保留给 016）。
- **验收**：合同 1–4 有测试证据（digest 失效、能力参数化选择、catalog
  digest 锁定、reservation 事前/并发/崩溃对账、fallback 不绕预算）；
  ruff + 全量 pytest 全绿；冻结文件 `git diff` 为空。

### TASK-016：WFM1 云端 Provider 接线与权威成本事实（Batch B）

- **吸收临时 P-C**：registry + 首个 MiniMax 适配器（网络全打桩、真实
  冒烟 opt-in）+ CLI 接线（审批→估算/reservation→生成→守门→合成）+
  **发射 `provider_cost_recorded`**。
- **允许修改**：新增 `providers/cloud_minimax.py` 与 registry（providers
  只增文件）；**唯一冻结变更**：`qcd/events.py` 增第 8 类事件 +
  `qcd/__init__.py` 导出（ADR-0008 授权）；CLI/app 接线（TASK-007 拥有
  的入口，一次性授权加子命令/前置守门）；对应 tests。
- **明确不做**：不改其余冻结合同；真实云 API 绝不进回归门槛（沿用
  ADR-0006/ADR-0008 测试纪律）；不实现自动路由（M3 之后）。
- **前置**：TASK-015 完成 + ADR-0008 + 厂商裁决（沿用 ADR-0006 §5 三项
  待裁决：厂商/预算数值/凭据变量名）。

---

## 临时名称 → 正式编号映射

| 临时 | 正式 | 去向 |
| --- | --- | --- |
| TASK-B1（配置层） | TASK-015 | 原型保留，补 catalog id/version/digest 锁定 |
| TASK-B2（选择+审批） | TASK-015 | 补能力参数化选择、binding-redo、审批 digest 绑定 |
| TASK-B3（预算） | TASK-015 | 补 reservation、账户月度、并发/崩溃、fallback 不绕 |
| P-C（云端接线） | TASK-016 | registry + MiniMax + CLI + `provider_cost_recorded` |

## 测试要求

本任务为 docs-only，无代码测试；验收为文档一致性（见下）。合同的可测
证据在 TASK-015/016 各自验收矩阵中给出。

## 验收标准

- [ ] 五个合同均无歧义，后续开发者无需再猜（本文件 §锁定合同）；
- [ ] 冻结边界与允许修改范围明确（§冻结合同边界、§后续实施批次）；
- [ ] 后续实施明确为**最多两批**（TASK-015、TASK-016）；
- [ ] 文档引用与任务编号一致（TASK-014/015/016、ADR-0007/ADR-0008 互相引用，
      implementation_plan 已更新）；
- [ ] 仅修改文档，未触碰代码或测试；未删除/覆盖现有原型代码。
