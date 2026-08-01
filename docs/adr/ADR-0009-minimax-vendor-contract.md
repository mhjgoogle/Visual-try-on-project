# ADR-0009: MiniMax/Hailuo 厂商选型与 API 契约

- Status: Accepted
- Date: 2026-08-01
- Scope tasks: TASK-017（真实 API 接线）
- Fulfils: ADR-0006 §5（厂商选型的厂商 ADR）
- Related/extends: ADR-0008（权威成本事实）、TASK-016 合同
- 来源：MiniMax 官方文档（platform.minimax.io，2026-08 核对）。不依赖
  第三方描述。

## Context

TASK-016 完成了厂商中立的付费协调链；ADR-0006 §5 将具体厂商选型、端点、
认证与凭据命名推迟到厂商 ADR。本 ADR 锁定首个云端厂商 = MiniMax/Hailuo
的真实 API 契约。

## Decision — 官方 API 契约（逐字记录）

1. **创建任务（submit）**：`POST https://api.minimax.io/v1/video_generation`
   - Header：`Content-Type: application/json`、`Authorization: Bearer {API_KEY}`
   - Body：`model`（枚举，如 `MiniMax-Hailuo-02` / `MiniMax-Hailuo-2.3` /
     `MiniMax-Hailuo-2.3-Fast`）、`first_frame_image`（image-to-video 必填，
     公网 URL 或 base64 data URL）、`prompt`（≤2000 字，可选）、
     `duration`（秒，可选）、`resolution`（`512P`/`720P`/`768P`/`1080P`，可选）、
     `prompt_optimizer`（默认 true）、`callback_url`（可选）。
   - 响应：`task_id`、`base_resp.status_code`（0=成功）、`base_resp.status_msg`。
2. **查询状态（poll）**：`GET https://api.minimax.io/v2/query/video_generation/{task_id}`
   - 响应 `task.status` ∈ 中间态 `preparing`/`queueing`/`processing`；
     终态 `succeeded`/`failed`/`cancelled`/`expired`。
   - 成功时下载地址**直接**返回于 `task.content.url`（无 file_id 交换）。
     该 URL 有效期 9 小时。
3. **下载**：对 `content.url` 直接 HTTP GET 下载媒体。
4. **认证/凭据**：Bearer API key，仅来自环境变量
   **`WFM1_MINIMAX_API_KEY`**；端点基址来自 **`WFM1_MINIMAX_API_BASE`**
   （默认 `https://api.minimax.io`）。凭据永不入库、永不进日志/异常。

## Decision — 状态映射与错误分类

| MiniMax `task.status` / 条件 | Provider 状态 / 错误 | 计费语义 |
| --- | --- | --- |
| `preparing`/`queueing`/`processing` | PROCESSING | 未定 |
| `succeeded` + `content.url` | ARTIFACT_AVAILABLE（EXTERNAL） | 已计费 |
| `failed`/`cancelled`/`expired` | `ProviderVendorError`（**泛，不声明 no-charge**） | 不确定 → ambiguous |
| submit `base_resp.status_code` 认证类 | `ProviderAuthError` | 未受理（提交前） |
| HTTP 建连失败（未发送） | `ProviderNotDispatchedError` | 证明未受理 |
| 请求超时 / 响应畸形 / 泛网络 | `ProviderTimeoutError`/`ProviderResponseError`/`ProviderNetworkError` | **不确定** → ambiguous |

沿用 TASK-016 修正后的资金安全分类：只有"证明未受理"或"显式声明
no-charge"才 release+fallback；其余一律 ambiguous → `needs_reconciliation`，
禁止自动重复付费。

## Decision — 成本记账（扩展 ADR-0008）

**MiniMax 视频 API 的任何响应都不返回成本/计费字段**（官方核实）。MiniMax
按 `(model, resolution, duration)` 的**固定价目**计费。因此：

- 当 Provider 成功但未返回 `cost_observation` 时，WFM1 以**锁定 catalog 的
  固定价**（该 spec 的报价，原币整数最小单位）作为权威成本，
  `billing_source = "catalog_fixed_price"`。这不是估算：spec 与实际生成
  绑定一致（TASK-016 `GenerationSpec`），catalog 已 digest 锁定。
- 该"无响应成本→按固定价记账"仅对**显式声明按固定价计费**的 Provider
  启用（`bills_at_catalog_price`）；其它 Provider 无成本仍 →
  `needs_reconciliation`（保守默认不变）。
- 若未来 Provider 返回真实成本，仍优先用其
  `float_boundary_conversion`（ADR-0008 §1）。

## Decision — 幂等与断点恢复

- MiniMax **无 idempotency-key 字段**（官方核实）。幂等由**协调层**保证：
  reservation `(task_id, operation_id)` 去重；遗留 `held` 不自动重提。
  额外发送一个 best-effort `Idempotency-Key` 头（MiniMax 可忽略），不作为
  正确性依据。
- submit 成功后**立即持久化 `external_task_ref` 到 reservation**，故崩溃/
  媒体未取回时不丢失外部 task ID；提供显式 `poll-media` 命令用该 ref
  重新 poll/collect，**不重新 submit、不重复付费**。

## Consequences

- 首个真实付费 Provider 接线可完成；上层协调/审批/预算/成本链零改动。
- 引入真实外部依赖与凭据面，由 env-only、打桩默认、opt-in 冒烟约束。

## Not decided here / 未验证风险

- **image-to-video 需 `first_frame_image`**，而 WFM1 Shot 当前无参考图字段；
  真实 i2v 需操作者经 `provider_parameters.first_frame_image` 提供，或用
  纯 prompt 的 t2v 模型。参考图资产化属后续任务。
- 真实 API 的确切错误码→类型映射、`content.url` 下载鉴权细节，需真实
  Key 冒烟验证（本 ADR 前未运行真实付费调用）。
- 未处理：TASK-009 成本报表聚合、自动路由、其它厂商、字幕/配音/发布。
