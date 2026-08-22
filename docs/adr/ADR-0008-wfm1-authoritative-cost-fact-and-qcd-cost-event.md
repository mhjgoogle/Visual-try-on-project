# ADR-0008: WFM1 权威成本事实与新增 QCD 成本事件

- Status: Accepted
- Date: 2026-08-01
- Scope tasks: TASK-014（合同锁定）、TASK-016（实施发射侧）
- Amends: ADR-0003（QCD 事件日志格式，固定事件类型域）、
  ADR-0006（付费 API 边界与成本字段首次填充）
- Under governance: ADR-0007（WFM1 文档基线与治理；本 ADR 是其 §7
  所要求的"显式识别冻结变更并走 ADR"的落实）
- Related: TASK-014 合同 5

## Context

WFM1 云端 Provider 需要记录**权威成本事实**用于预算账本与后续 QCD
分析。两个既有约束产生张力：

1. `providers/models.py::ProviderCostObservation.amount` 是**冻结的
   float 字段**。浮点货币不得作为权威账目（精度/累加误差、跨币种
   不可靠）。
2. ADR-0003 将 QCD 事件锁定为固定 7 类；其中只有
   `manual_attempt_recorded` 携带 `cost_minor_units`/`currency`，但其
   `action` 固定 `"manual_generation"`、语义为人工尝试，用户已明确
   **禁止**用它承载云端成本。

因此云端权威成本没有合规载体。architecture §10 又要求：QCD append-only
事件日志是原始成本事实的**唯一来源**，汇总/派生值必须可由事件重算。
ADR-0007 §7 要求：任何需要改动冻结合同的后续任务必须显式识别并走 ADR
与审批流程——本 ADR 即该识别。

## Decision

1. **float 非权威（边界转换，不改冻结类）**：
   `ProviderCostObservation.amount`(float) **仅作遥测**，永不作为账目
   权威。**不修改该类**。厂商适配器在边界处由 Provider 的**计费响应**
   派生权威值（优先取整数/十进制字符串计费字段）；仅当无整数来源时对
   float 做**文档化确定性换算**并在事件中标注来源。

2. **权威成本 = 整数原币最小单位 + ISO-4217 币种**，记录于**新增
   QCD 事件类型** `provider_cost_recorded`。这是对 ADR-0003 固定域的
   **受控增补（7 → 8 类）**，是本项目唯一被授权的该类扩展。

3. **`provider_cost_recorded` 最小事件合同**：
   - 归属：`project_id` 必填；`shot_id`/`task_id` 按事件来源填充；
   - 固定 payload 键集（全部出现、无多余键，沿用 ADR-0003 §4 风格）：
     - `provider_id: str`
     - `model_id: str`
     - `operation_id: str`
     - `cost_minor_units: int`（≥0，整数最小货币单位，禁浮点）
     - `currency: str`（ISO-4217，大写）
     - `billing_source: str`（如 `"provider_billing_field"` 或
       `"float_boundary_conversion"`）
     - `observed_amount: float|null`（遥测，可空）
     - `observed_unit: str|null`（遥测，可空）
   - 确定性 `event_id = provider_cost_recorded:{task_id}:{operation_id}`；
     写入方允许等价重复、读取方**去重保留首行**（沿用 ADR-0003 §5）；
   - append-only、strict 解析、torn-tail 容忍等一律沿用 `qcd/log.py`
     既有 envelope 语义，**log.py 结构无需改动**。

4. **派生关系（唯一事实来源不破坏）**：
   - quote（catalog 原币整数）→ estimate_jpy（锁定 FX，ceil）→
     reservation（运营占额）→ **actual = `provider_cost_recorded`
     （原币整数，权威）** → JPY 派生实际（锁定 FX，ceil，ledger 现算）。
   - 账本权威支出 = Σ `provider_cost_recorded`（换算后）。reservation
     仅事前守门与崩溃对账用，**不是**成本事实来源。

5. **实施边界与授权**：
   - 代码变更**仅** `qcd/events.py`（新增枚举值 + 固定 payload 键集 +
     类型化构造器 + 值域校验）与 `qcd/__init__.py`（导出），落在
     **TASK-016**；
   - 真实云 API 绝不进默认回归门槛；单元/集成一律打桩网络，可选真实
     冒烟显式 opt-in（沿用 ADR-0006 §6）；
   - 现有 7 类事件的合同、`ProviderCostObservation`、其余冻结合同均
     **零改动**。

## Consequences

- 云端成本获得合规、可重算的权威载体，浮点永不进账目权威。
- ADR-0003 固定域由 7 扩为 8；这是逐字锁定的单点增补，未来再增仍需
  新 ADR。
- 引入的唯一冻结变更集中在 `qcd/events.py` 一处，便于 milestone 复审
  对抗验证（新事件的固定键/值域/去重/崩溃窗口）。
- reservation 与权威成本分离，避免把运营态误当事实来源。

## Not decided here

- 具体厂商计费响应字段映射（随厂商在 TASK-016 聚焦设计 + 厂商 ADR
  裁决，沿用 ADR-0006 §5 三项待裁决）；
- 账户级月度账本的账户根发现机制（TASK-015 落地，TASK-014 合同 4 给出
  最小风险默认）；
- reservation 目录结构细节（TASK-015 落地并作 ADR-0001 目录增补）。
