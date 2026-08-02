# TASK-016：WFM1 云端 Provider 接线与权威成本事实（Batch B）

> **状态：Implemented。** 吸收临时 P-C。接通付费生成闭环，保持 Provider
> 可插拔。唯一冻结变更（新增 `provider_cost_recorded` QCD 事件）由
> [ADR-0008](../adr/ADR-0008-wfm1-authoritative-cost-fact-and-qcd-cost-event.md)
> 授权。合同见 [TASK-014](TASK-014-wfm1-contract-consolidation.md)。

## 正式名称

WFM1 Cloud Provider Wiring and Authoritative Cost

## 目的

在 TASK-015 对齐的配置/审批/预算之上，接通真实付费生成的协调链，并
以厂商中立、可插拔的方式接入首个云端 Provider（MiniMax/Hailuo），同时
把权威成本事实写入 QCD——全程不重构 M1 Orchestrator、不改
`ProviderCostObservation`。

## 输入

- TASK-015 的 `config/`、`approval/`、`budget/`；
- 冻结的 `VideoProvider` 契约、`ProviderResult`/`ProviderCostObservation`；
- QCD 事件基础设施；ADR-0008 授权的新事件。

## 输出文件（全部新增，除授权的冻结/接线点）

**Provider 可插拔**
- `providers/registry.py`：`ProviderRegistry` + `default_registry()`
  （注册 manual + minimax）；未知 id **fail-closed**。
- `providers/cloud_minimax.py`：`MinimaxVideoProvider`（stateless、
  filesystem-free，collect 返回**外部**产物引用）+ 可打桩
  `MinimaxTransport` + `RealMinimaxTransport`（opt-in，未配置端点即拒跑）。
- `providers/cloud_errors.py`：`CloudProviderError` 子树（网络/超时/
  认证/厂商/响应），继承冻结的 `ProviderError`。

**协调链**
- `app/cost_boundary.py`：float 遥测 → 权威整数原币最小单位
  （Decimal、half-up、`billing_source="float_boundary_conversion"`）。
- `app/paid_coordinator.py`：`PaidGenerationCoordinator` 七步链 + fallback。
- `app/media_fetch.py`：`UrllibMediaFetcher`（协调器负责下载外部产物到
  staging；Provider 不碰文件系统）。

**冻结变更（ADR-0008 授权，仅此处）**
- `qcd/events.py`：新增第 8 类事件 `PROVIDER_COST_RECORDED` + 固定
  payload 键集 + 值域校验 + `event_id` 派生 + 构造器；`qcd/__init__.py`
  导出。

**CLI 接线（app 层，TASK-007 一次性授权）**
- `cli.py`：所有 Provider 经 registry 构建（`manual` 用合成 entry，其余
  从锁定 catalog 解析；**非 manual 的未知 id 不再静默构造 Manual**）；
  新增 `paid-submit` 子命令 + `--catalog-dir`。

**测试**：`test_provider_registry`、`test_cloud_minimax`、
`test_cost_boundary`、`test_qcd_provider_cost_event`、
`test_paid_coordinator`（fake-paid-provider 集成）、`test_cli_paid`；
`tests/paid_fakes.py`。

## 接通的数据流

审批 digest 校验 → provider/model/capability 解析 → catalog 报价 →
预算事前检查（committed 实际 + 未决 holds + 本次预估）→ reservation 预留
→ Provider submit/poll/collect → 权威成本 `provider_cost_recorded`（原币
整数）+ commit reservation → 协调器下载外部产物到 staging。

## 关键语义（与 TASK-014 合同一致）

- **技术故障**（submit 前网络/认证/厂商）→ 释放 hold → fallback（新
  operation_id，重新审批/报价/预算/预留）；
- **预算拒绝** → 停止，**绝不 fallback**；
- **submit 后不确定**（未知计费状态）→ `needs_reconciliation`，**不自动
  重复付费**；
- **崩溃**：遗留 `held` reservation 不重提交，转 `needs_reconciliation`；
- **账户根发现规则**：账户根默认 = 项目根父目录，其直接子目录中含
  `config/wfm1.json` 者为项目；月度账本 = 各项目在该 JST 月的权威成本
  之和，各按自身锁定 FX 换算（见 ADR-0001 增补）。

## 明确不做

- 不重构 M1 Orchestrator；不改 `ProviderCostObservation` 或其余冻结合同；
- 不把 MiniMax 规则写进 budget/approval/选择等通用模块；
- 不运行真实付费调用（除非显式配置端点 + 凭据 + opt-in）；
- 不实现自动路由（M3 之后）。

## 测试要求 / 验收标准

- [x] fake-paid-provider 集成覆盖：审批失败 0 调用、预算拒绝 0 调用、
      reservation 幂等、成本只入账一次、崩溃不重复提交、镜头级切换、
      fallback 不绕预算、技术故障 fallback、不确定 → 对账；
- [x] 凭据只来自 env，不进配置/日志/异常（`test_cloud_minimax`）；
- [x] 全量 pytest 全绿、ruff clean；
- [x] 冻结合同仅 ADR-0008 授权的 `qcd/events.py` 一处变更，其余为空。

## 资金安全修正批次（2026-08-01，统一审查后）

Codex/对抗审查发现付费提交的错误分类与并发预算安全不足，本批次修正
（不接真实 API、不改冻结合同、不重构 Orchestrator）：

**错误分类最终矩阵**（`app/paid_coordinator.py::_drive_provider`）：

| 阶段 / 信号 | 分类 | 处置 |
| --- | --- | --- |
| prepare 失败 | technical（pre-dispatch） | 无 hold 影响；fallback 允许 |
| submit `ProviderAuthError` / `ProviderNotDispatchedError` | technical（证明未受理） | 释放 + fallback |
| submit `ProviderTimeoutError` / `ProviderResponseError` / 泛 `ProviderNetworkError` | **ambiguous** | needs_reconciliation，不 fallback、不重提 |
| post-submit `ProviderNoChargeFailureError`（显式声明无计费） | technical | 释放 + fallback |
| post-submit 泛 `ProviderVendorError` / `FAILED` / `CANCELLED` | **ambiguous** | needs_reconciliation，不 fallback |
| post-submit 网络/超时/响应错误 | ambiguous | needs_reconciliation |

- 新增 `providers/cloud_errors.py`：`ProviderNotDispatchedError`（唯一"证明未发送"的网络子类）、`ProviderNoChargeFailureError`（唯一"显式无计费"的厂商子类）；泛 `ProviderNetworkError` 不再被当作无副作用。

**预算并发原子性**：新增 `budget/lock.py::account_budget_lock`（`fcntl` 账户级排他锁）。在**同一锁内**完成：读跨项目 committed（`read_account_month_spent`）+ 汇总跨项目 outstanding holds（新增 `budget/account.py::account_outstanding_holds`）+ 本项目 episode/shot spend+holds + `evaluate_pre_flight` + `hold_reservation`——杜绝不同 operation 的 check-then-act 超支；月度上限计入他项目 held/needs_reconciliation。同 operation 并发经锁内 existing-check 保持幂等。

**其它守门加固**：
- M1 `prepare/submit/run` 仅 Manual；非 Manual 一律路由到 `paid-submit`（`cli.py::_build_provider`）。
- 报价与 payload 绑定同一不可变 `GenerationSpec`（duration 必须与 shot 一致，否则 `spec_invalid` fail-closed）；镜头失败次数由 `shot_consecutive_failures`（持久化 reservation）计算，删除可传入的 `--failures`。
- Provider 构造在创建 hold **之前**完成，失败返回 `provider_unavailable`，不遗留 held reservation。

**后续项（不在本批次）**：`provider_cost_recorded` 尚未进入 TASK-009 QCD
aggregation/报表（预算 ledger 已计入）；由
[TASK-021](TASK-021-wfm1-paid-lifecycle-and-qcd-integration.md) 在单独 ADR
授权后扩展。

## 真实 API 后续

真实端点、认证、固定价记账和外部 task ref 恢复由
[ADR-0009](../adr/ADR-0009-minimax-vendor-contract.md) 与
[TASK-017](TASK-017-minimax-real-api-and-smoke.md) 承接。真实冒烟仍须显式
opt-in，绝不进入默认回归门槛。

## 修正记录（milestone review）

- 协调器新增 task 级操作守门：同一 task 已存在任何 reservation 时，
  用户发起的新 operation 返回 `operation_conflict`（零 hold、零调用）；
  仅协调器内部 fallback operation 豁免。重做必须新建 task。
- 本卡的自由参数 `paid-submit` 入口保留为显式隔离路径，需 `--unplanned`
  标志；WFM1 正式付费入口改为 packet 驱动（见 TASK-020 修正记录）。
- 补充边界说明（milestone review M-3/M-4）：`paid-submit --account-root`
  仅影响 packet 校验时的复用包解析；预算账户根恒为项目根的父目录，
  不可被参数改写。reservation 文件为无签名本地 JSON，威胁模型为本机
  单用户：手工篡改/删除 `budget/reservations/` 可影响操作守门与在途
  口径，但已提交成本不受影响（台账由 append-only QCD 事件派生）。
- 回放守门（M-1）：重放历史 released reservation 得到的技术失败
  （`PaidOutcome.resumed=True`）不再触发 fallback，杜绝遗留混合状态
  下的二次扣费。
