# TASK-015：WFM1 配置/审批/预算合同对齐（Batch A）

> **状态：Implemented。** 吸收临时原型 B1/B2/B3，将其对齐
> [TASK-014](TASK-014-wfm1-contract-consolidation.md) 锁定的合同 1–4 与
> 合同 5 的非发射侧。**无冻结变更。** 已与 TASK-016 完成统一审查和资金
> 安全修正。实施提交：`867db00`；修正提交：`f94da16`。

## 正式名称

WFM1 Config / Approval / Budget Contract Alignment

## 目的

TASK-014 锁定了审批绑定、Provider 选择、catalog 版本锁、预算
reservation、成本事实五个合同。本任务把已落盘的厂商中立原型（临时命名
B1 配置层、B2 选择+审批、B3 预算）对齐这些合同，为 TASK-016 的付费接线
提供正确基础。全部落在冻结区之外，保留并调整原型、不重复重写。

## 输入

- 已落盘原型：`config/`、`approval/`、`budget/`（未提交时的 B1/B2/B3）；
- TASK-014 合同 1–4；`digests.py`（SHA-256/canonical JSON，只读复用）；
- 冻结的 `errors`/`security`/`persistence` 模式（只复用，不改）。

## 输出文件（新增/调整，均非冻结）

**合同 1 — 审批 v2（stage + 版本 + digest + 自动失效）**
- `approval/gate.py`：per-stage 标记 `approval/<stage>.json`（v2）；
  `require_stage_approved` 重算每个 target 的 `content_digest`，不一致 →
  `StaleApprovalError`（`NotApprovedError` 子类）；缺标记/非 approved/缺
  target 一律 fail-closed。
- `approval/errors.py`：新增 `StaleApprovalError`。

**合同 2 — Provider 选择（能力/模型由任务提供，不固定 i2v）**
- `config/selection.py`：`resolve_provider_selection(..., capability,
  model_id)`；主 Provider 校验能力+模型、备用校验能力；移除硬编码
  `image_to_video`；覆盖>默认、主==备时备用收敛为 None；docstring 锁定
  binding 不可变（切换走 create-redo-task）、fallback 仅失败切换。

**合同 3 — Catalog 锁（ID+版本+digest，禁漂移）**
- `config/catalog.py`：catalog 增 `catalog_id`+`version`；
  `compute_catalog_digest`。
- `config/catalog_lock.py`：`load_locked_catalog` 按 id 从固定目录解析，
  校验 version+digest，任何漂移 fail-closed；不接受任意路径。
- `config/project_config.py`：schema v2，`catalog_ref` → `catalog_id` +
  `catalog_version` + `catalog_digest`。

**合同 4 — 预算三范围 + reservation + 并发/崩溃**
- `budget/reservation.py`：事前预留（`(task_id,operation_id)` 幂等去重）、
  `held→committed/released/needs_reconciliation`、`outstanding_holds`、
  `reconcile_reservations`（崩溃后按已知实际/失败分派，不可判定→人工对账）。
- `budget/account.py`：账户级月度汇总（跨项目、各自锁定 FX、JST 月）。
- `budget/errors.py`：新增 `ReservationError`。
- （沿用原型 `fx`/`quote`/`estimate`/`ledger`/`guard`，保持厂商中立。）

**示例 + 测试**
- `config/providers/wfm1-default.json`（id 化真实 catalog，替代
  `catalog.example.json`）；`examples/.../config/wfm1.example.json`（v2）；
  `examples/.../approval/concept_lock.example.json`（v2，绑定 shot 记录）。
- `tests/test_{config_catalog,project_config,selection_resolver,
  approval_gate,catalog_lock,budget_fx,budget_estimate,budget_ledger,
  budget_guard,budget_reservation,budget_account}.py`。

## 允许修改范围

`config/`、`approval/`、`budget/` 全部（原型自有文件）；
`config/providers/`；`examples/projects/minimal/{config,approval}`；对应
`tests/`。ADR-0001 目录增补（reservation/per-stage approval/account 规则）
最终随 TASK-016 提交。

## 冻结合同禁改清单

`models.py`、`manifest.py`、`serialization.py` 既有条目、`persistence.py`、
`project_data.py`、`validation.py`、`errors.py` 既有类、`digests.py`、
`security/`、`orchestration/` 全部、`providers/` 全部、`composition/`、
`assets/`、`inspection/`、`app/`、`cli.py`、`qcd/` 全部、`pyproject.toml`。

## 明确不做

- 不接入任何真实 Provider 或 API；不发射任何 QCD 事件；不新增 QCD 事件
  类型（`provider_cost_recorded` 属 TASK-016）；
- 不改任何冻结合同；不接 CLI 生成动作（归 TASK-016）；
- 不实现 DRAFT→APPROVED 状态机（仅 digest 绑定守门）。

## 验收标准

- [x] 合同 1–4 有客观测试：digest 失效、能力参数化选择、catalog digest
      锁定、reservation 事前/幂等/崩溃对账、账户月度、fallback 语义文档化；
- [x] `ruff format --check` / `ruff check` clean；全量 pytest 全绿；
- [x] 冻结文件 `git diff` 为空；JSON only、无新依赖；
- [x] 原型代码保留并调整，无重复重写。

## 后续

统一独立审查（Codex）已覆盖 **TASK-015 + TASK-016** 全 diff；资金安全修正
见 [TASK-016](TASK-016-wfm1-cloud-provider-and-cost.md)。后续阶段审批状态机归
[TASK-019](TASK-019-wfm1-stage-approval-and-change-control.md)。
