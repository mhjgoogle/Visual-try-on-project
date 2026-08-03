# ADR-0009: MiniMax/Hailuo 厂商选型与 API 契约

- Status: Accepted
- Date: 2026-08-01
- Scope tasks: TASK-017（真实 API 接线）
- Fulfils: ADR-0006 §5（厂商选型的厂商 ADR）
- Related/extends: ADR-0008（权威成本事实）、TASK-016 合同
- Resolves: ADR-0006/TASK-010 延期的首个厂商裁决；TASK-010 因而转为历史卡
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
2. **查询状态（poll）**：`GET https://api.minimax.io/v1/query/video_generation?task_id={task_id}`
   - 响应**顶层** `status` ∈ `Preparing`/`Queueing`/`Processing`（中间态）、
     `Success`/`Fail`（终态）；成功时返回顶层 `file_id`（int64）+
     `video_width`/`video_height`；`base_resp.status_code`（0=成功）。
   - **不返回下载 URL**：需再调用 files/retrieve 换取。
3. **取回下载地址（retrieve）**：`GET https://api.minimax.io/v1/files/retrieve?file_id={file_id}`
   - Bearer 认证；响应 `file.download_url`（有效 1 小时）。
4. **下载**：对 `file.download_url` HTTP GET 下载媒体（协调器执行，见
   `app/media_fetch.py`，带超时/大小上限/scheme+content-type 校验/原子
   防覆盖发布）。
5. **认证/凭据**：Bearer API key，仅来自环境变量
   **`WFM1_MINIMAX_API_KEY`**（registry 严格要求 catalog 的
   `credential_env_vars == ["WFM1_MINIMAX_API_KEY"]`，否则 fail-closed，
   杜绝外发任意 env 变量）；端点基址来自 **`WFM1_MINIMAX_API_BASE`**
   （默认 `https://api.minimax.io`）。凭据永不入库、永不进日志/异常。

## Decision — 状态映射与错误分类

| MiniMax `status` / 条件 | Provider 状态 / 错误 | 计费语义 |
| --- | --- | --- |
| `Preparing`/`Queueing`/`Processing` | PROCESSING | 未定 |
| `Success` + `file_id`→`download_url` | ARTIFACT_AVAILABLE（EXTERNAL） | 已计费 |
| `Fail` | `ProviderVendorError`（**泛，不声明 no-charge**） | 不确定 → ambiguous |
| 顶层 `status` 缺失/未知 | `ProviderResponseError` | 畸形 → ambiguous |
| HTTP DNS 失败/连接拒绝（未发送） | `ProviderNotDispatchedError` | 证明未受理 → fallback 允许 |
| 请求超时 / 响应畸形 / 泛网络 | `ProviderTimeoutError`/`ProviderResponseError`/`ProviderNetworkError` | **不确定** → ambiguous |

**官方错误码映射**（`base_resp.status_code`，见官方 errorcode 文档）：

| 码 | 官方含义 | 映射 | 处置 |
| --- | --- | --- | --- |
| `0` | 成功 | — | — |
| `1004` | not authorized | `ProviderAuthError` | 未受理，可 fallback |
| `2049` | invalid API Key | `ProviderAuthError` | 未受理，可 fallback |
| `2013` | invalid params | `ProviderRequestRejectedError` | 无 job/无计费，**禁 fallback** |
| `1008` | insufficient balance | `ProviderRequestRejectedError` | 无 job/无计费，**禁 fallback** |
| 其它非 0 | — | `ProviderVendorError` | 不确定 → ambiguous |

沿用 TASK-016 修正后的资金安全分类：只有"证明未受理"或"显式声明
no-charge"才 release+fallback；`request_rejected`（无效参数/余额不足）无
计费但**禁止 fallback**（换 Provider 无意义或不可支付）；其余一律
ambiguous → `needs_reconciliation`，禁止自动重复付费。

**T2V 分辨率约束**：`MiniMax-Hailuo-02` 的 text-to-video 仅支持
`768P`/`1080P`（**无 512P**）；6s 支持 768P/1080P，10s 仅 768P。冒烟用
`768P/6s`。

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
- submit 成功后**立即持久化 `external_task_ref` 到 reservation**（v3 record
  同时持久化 spec 与原币报价），故崩溃/媒体未取回时不丢失外部 task ID；
  `poll-media` 命令**仅凭记录**重新 poll/collect（不接受重新输入的
  spec，booking 用持久化报价），**不重新 submit、不重复付费**。
- **轮询节奏**：官方建议约 10s 间隔；协调器 poll-first + `sleeper` 注入，
  就绪即取回、无谓等待为零，未就绪按间隔轮询至上限。

## Consequences

- 首个真实付费 Provider 接线可完成；上层协调/审批/预算/成本链零改动。
- 引入真实外部依赖与凭据面，由 env-only、打桩默认、opt-in 冒烟约束。

## Not decided here / 未验证风险

- **image-to-video 需 `first_frame_image`**，而 WFM1 Shot 当前无参考图字段。
  i2v 现要求操作者经 `first_frame_image` 提供，且**已校验**仅接受公网
  http(s) URL 或受限 image data URL、拒绝本地路径；capability=i2v 而无
  首帧则 `spec_invalid` fail-closed。参考图资产化属后续任务。
- 真实错误码全集仍无法由单次冒烟穷尽；未知码继续按 ambiguous fail-closed。
- TASK-009 成本报表聚合随后已由 ADR-0020/TASK-021 接入；自动路由、其它厂商、
  字幕/配音与正式发布仍分别属于 WFM3、Provider 增量与 WFM2。

## Later validation（2026-08-01）

TASK-017 的显式 opt-in 真实付费冒烟已通过（提交 `b231b91`）：真实执行 submit →
query → files/retrieve → 下载非空 MP4，并验证实际计费金额与锁定 catalog 一致。
默认回归仍只使用打桩，不持有或要求真实 Key；该验证不改变本文的错误保守分类。
