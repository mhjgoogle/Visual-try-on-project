# TASK-017：MiniMax/Hailuo 真实 API 接线与安全冒烟测试

> **状态：Implemented。** 真实 `RealMinimaxTransport` 接线，复用现有
> registry/审批/报价/reservation/成本协调链。官方 API 契约见
> [ADR-0009](../adr/ADR-0009-minimax-vendor-contract.md)。默认测试全打桩，
> 真实付费冒烟显式 opt-in。

## 正式名称

MiniMax/Hailuo Real API Wiring and Safe Smoke Test

## 目的

在 TASK-016 的付费协调链上接通首个真实云端厂商（MiniMax/Hailuo）的
submit/poll/collect，保持 Provider 可插拔与资金安全语义不变，并支持断点
恢复（不丢外部 task ID、可重新取媒体、不重复付费）。

## 输入

- TASK-016 的 registry、paid coordinator、reservation、catalog 与成本事件；
- ADR-0009 的端点、认证、状态、错误、固定价记账和幂等合同；
- `GenerationSpec.provider_parameters` 中显式提供的厂商参数。

## 输出文件

**代码**
- `providers/cloud_minimax.py`：真实 `RealMinimaxTransport`
  （`POST /v1/video_generation`、`GET /v2/query/video_generation/{id}`，
  urllib，超时/错误按 charge-state 分类）；`MinimaxVideoProvider` 增
  `bills_at_catalog_price=True`、best-effort `Idempotency-Key`、
  `first_frame_image`（i2v，可选）。
- `budget/reservation.py`：reservation schema v2 增 `external_task_ref` +
  `record_external_task_ref`（submit 成功后立即持久化外部 task ID）。
- `app/paid_coordinator.py`：拆分 `_submit_phase`/`_poll_collect_phase`
  （submit 后立即持久化 external ref）；`_settle` 支持
  `catalog_fixed_price` 记账（MiniMax 无响应成本）；新增 `resume_media`
  （用持久化 ref 重新 poll/collect，不重 submit、不重付费）。
- `cli.py`：新增 `poll-media` 子命令。

**文档**：`ADR-0009`（厂商契约/状态映射/记账/幂等）。

**测试**：`test_minimax_real_transport.py`（HTTP 打桩 + opt-in 真实冒烟）、
`test_cloud_minimax.py`（+bills_at_catalog_price）、`test_paid_coordinator.py`
（catalog 定价记账、external ref 持久化、resume_media 三态）、
`test_cli_paid.py`（poll-media 不重付费）。

## 修改范围

`providers/cloud_minimax.py`、`app/paid_coordinator.py`、`budget/reservation.py`、
`budget/__init__.py`、`cli.py`、直接对应测试和 ADR-0009。不得修改 M1
orchestration、领域模型、VideoAsset 或 QCD 聚合合同。

## 关键决策（依据官方文档，非第三方猜测）

- 端点/认证/状态/下载：见 ADR-0009（`Authorization: Bearer`，成功返回
  `task.content.url`，无 file_id 交换）。
- **无响应成本字段**：MiniMax 任何响应都不返回计费；按锁定 catalog 固定价
  记账（`billing_source="catalog_fixed_price"`），仅对
  `bills_at_catalog_price` Provider 启用。
- **无 idempotency 字段**：幂等由 reservation 保证；额外发 best-effort
  `Idempotency-Key` 头。
- **错误分类（资金安全）**：HTTP 401/403→auth（未受理，可 fallback）；
  DNS/连接拒绝→NotDispatched（可 fallback）；**超时/畸形/泛网络→
  ambiguous→needs_reconciliation，禁止自动重付**；HTTP 5xx / 终态
  failed/cancelled/expired→泛 vendor error→ambiguous。

## 明确不做

不实现 TASK-009 成本报表聚合、自动路由、其它厂商、字幕/配音/发布。
不运行真实付费调用（除非显式 opt-in + 真实 Key）。

## 实施步骤

1. 按 ADR-0009 实现真实 submit/poll、状态解析与资金安全错误映射。
2. submit 成功后立即持久化外部 task ref，恢复路径只 poll/collect/fetch。
3. 仅对显式固定价 Provider 使用锁定 catalog 价格记账。
4. 接入 `poll-media` 并以本地 HTTP stub 覆盖默认测试。

## 测试要求

- HTTP 成功、处理中、认证、未发送、超时、畸形响应和厂商失败；
- submit 后崩溃、poll 超时、下载失败后恢复均不得再次 submit；
- 固定价成本恰好入账一次，未知成本保持人工对账；
- 凭据不进入文件、日志、CLI 输出或异常，Manual/M1 回归保持通过。

## 验收标准

- [x] 真实 submit/poll HTTP 接线（打桩全覆盖：成功/处理中/失败/401/超时/
      连接拒绝/畸形/默认端点）；
- [x] 超时或未知提交结果 → needs_reconciliation，不自动重付；
- [x] submit 成功即持久化 external task ID；`resume_media`/`poll-media`
      重新取回媒体、不重 submit、成本只入账一次；
- [x] 凭据 env-only，异常/输出不含凭据值（有断言）；
- [x] 真实付费冒烟 `pytest.mark.skipif` opt-in，默认打桩；
- [x] Manual/M1 流程零回归；ruff + 全量 pytest 全绿；冻结合同不变。

## 真实 API 尚需配置 / 未验证风险

- 环境变量：`WFM1_MINIMAX_API_KEY`（凭据）、`WFM1_MINIMAX_API_BASE`
  （可选，默认 `https://api.minimax.io`）、`AI_VIDEO_WORKFLOW_REAL_MINIMAX=1`
  （开启冒烟）。catalog 需含 `minimax` provider + MiniMax 模型/价目。
- 最小冒烟：
  `AI_VIDEO_WORKFLOW_REAL_MINIMAX=1 WFM1_MINIMAX_API_KEY=... pytest tests/test_minimax_real_transport.py::test_real_minimax_smoke`
- 未验证：真实错误码全集→类型映射、`content.url` 下载鉴权、i2v 参考图来源
  （WFM1 Shot 无参考图字段，i2v 需经 `provider_parameters.first_frame_image`
  提供，或用纯 prompt 的 t2v 模型）——参考图资产化属后续任务。
