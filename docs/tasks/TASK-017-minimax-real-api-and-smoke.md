# TASK-017：MiniMax/Hailuo 真实 API 接线与安全冒烟测试

> **状态：Implemented。** 真实 `RealMinimaxTransport` 接线，复用现有
> registry/审批/报价/reservation/成本协调链。官方 API 契约见
> [ADR-0009](../adr/ADR-0009-minimax-vendor-contract.md)。默认测试全打桩，
> 真实付费冒烟显式 opt-in。实施提交：`a8a63a8`；milestone review 待完成。

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
  （官方三段式：`POST /v1/video_generation` →
  `GET /v1/query/video_generation?task_id=` →
  `GET /v1/files/retrieve?file_id=`，urllib，超时/错误按 charge-state
  分类）；`MinimaxVideoProvider` 增 `bills_at_catalog_price=True`、
  best-effort `Idempotency-Key`、`first_frame_image`（i2v，已校验）。
- `budget/reservation.py`：reservation schema v3（多版本兼容读取 v1–v3）
  增 `external_task_ref` + spec/报价字段 + `record_external_task_ref`
  （submit 成功后立即持久化外部 task ID）。
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

- 端点/认证/状态/下载：见 ADR-0009（`Authorization: Bearer`；三段式
  submit → query（顶层 `status` + `file_id`）→ files/retrieve
  （`file.download_url`，有效 1 小时））。
- **无响应成本字段**：MiniMax 任何响应都不返回计费；按锁定 catalog 固定价
  记账（`billing_source="catalog_fixed_price"`），仅对
  `bills_at_catalog_price` Provider 启用。
- **无 idempotency 字段**：幂等由 reservation 保证；额外发 best-effort
  `Idempotency-Key` 头。
- **错误分类（资金安全）**：HTTP 401/403 与码 1004/2049→auth（未受理，可
  fallback）；DNS/连接拒绝→NotDispatched（可 fallback）；码 2013/1008→
  request_rejected（无计费、**禁 fallback**）；**超时/畸形/泛网络→
  ambiguous→needs_reconciliation，禁止自动重付**；HTTP 5xx / 终态
  `Fail`→泛 vendor error→ambiguous。

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
- 未验证：真实错误码全集→类型映射、`file.download_url` 下载鉴权、i2v
  参考图来源（WFM1 Shot 无参考图字段，i2v 需经 `--first-frame-image`
  提供公网 URL / image data URL，或用纯 prompt 的 t2v 模型）——参考图
  资产化属后续任务。

## TASK-017 复审修正批次（2026-08-01，阻塞复审后）

独立复审判定**阻塞**：查询/下载契约与官方不符（可能扣费却取不回媒体），
及多项资金安全/健壮性缺陷。本批次逐项修正（真实契约已用官方
api-reference 页复核）：

**Blocker**
- **查询/下载三段式**（改正）：`GET /v1/query/video_generation?task_id=` →
  顶层 `status`（Preparing/Queueing/Processing/Success/Fail）+ `file_id` →
  `GET /v1/files/retrieve?file_id=` → `file.download_url`。原 `/v2/.../content.url`
  为误读，已删除。空/未知 status → `ProviderResponseError`。
- **冒烟改为有效请求**：`MiniMax-Hailuo-02 + 768P + 6s`（T2V 无 512P），
  按 10s 间隔轮询至终态，成功则断言 download_url。

**Important**
- **poll-media 绑定记录**：reservation v3 持久化 spec + 原币报价；
  `resume_media(shot, task_id, operation_id)` 仅凭记录重建，booking 用
  持久化报价，不接受重新输入的 model/resolution/duration。
- **官方错误码**：1004/2049→auth；2013 invalid params 与 1008 余额不足→
  `ProviderRequestRejectedError`（无计费、**禁 fallback**）；其它非 0→vendor。
- **轮询节奏**：注入 `sleeper`（默认 10s）+ poll-first；就绪零等待。
- **媒体下载硬化**：超时 + 流式大小上限 + scheme/content-type 校验 +
  原子防覆盖发布（`app/media_fetch.py`）；协调器 fetch 幂等（已存在即跳过）。
- **首帧校验**：i2v 必须提供 `--first-frame-image`，仅接受公网 http(s)/
  image data URL，拒绝本地路径（协调器 + 适配器双重校验）。
- **凭据严格**：MiniMax factory 要求 catalog `credential_env_vars` 严格
  等于 `["WFM1_MINIMAX_API_KEY"]`，否则 fail-closed。

**最小冒烟（更新）**：
`AI_VIDEO_WORKFLOW_REAL_MINIMAX=1 WFM1_MINIMAX_API_KEY=... pytest tests/test_minimax_real_transport.py::test_real_minimax_smoke`
（Hailuo-02 768P/6s，轮询至终态并取回 download_url）。

## TASK-017 第二次复审修正批次（2026-08-01）

复审再判**阻塞**（两项）。本批次修正：

**Blocker**
- **reservation 多版本兼容**：`parse_reservation` 接受 v1–v3（旧版本缺失
  字段解析为 None），预算扫描/`poll-media` 对旧记录不再失败；任何重写把
  记录升级到当前版本。旧记录**无持久化报价 → 禁止自动固定价记账**，但
  媒体照常取回并转人工对账（`_settle` 无成本路径现仍拉取媒体）。
- **真实冒烟加固**：submit 后**立即**把 task_id 写入 durable smoke record
  （`WFM1_SMOKE_DIR`，默认 `~/.wfm1-smoke/`）；仅 `succeeded` 判通过
  （failed=测试失败）；并用硬化 fetcher **实际下载**到不覆盖的新路径、
  断言非空，端到端验证 download_url。

**Important**
- **首帧校验一致 + 逃逸封堵**：协调器与 Provider 同为 8 MiB data URL 上限
  （hold 之前 fail-closed）；`_submit_phase` 捕获
  `InvalidProviderRequestError` → `request_rejected`（无计费、禁 fallback、
  释放 hold），不再逸出遗留 held。
- **媒体有效性**：fetcher 拒绝空下载；staging 幂等改为**下载回执**
  （`<staging>.fetched.json` 记 sha256）——已有文件仅当回执匹配才算成功，
  否则 `success_media_pending` 且不覆盖。

**Minor**：正文与 docstring 的旧契约（`/v2/`、`task.content.url`、
"schema v2"）已就地替换为官方三段式与 v3。

## TASK-017 第三次复审修正批次（2026-08-01）

**Blocker — 响应结构严格校验**：新增
`RealMinimaxTransport._require_ok_base_resp`——`base_resp` 必须为对象、
`status_code` 必须为 int，且**必须显式为 0 才算成功**（缺失不再隐式
成功）；`file` 必须为对象。任何合法 JSON 但形状错误（数组/字符串/缺失）
一律 `ProviderResponseError`，不再逸出 `AttributeError`。协调器级测试
断言 submit/poll 畸形响应 → `needs_reconciliation`、不 fallback、
reservation 留有人工对账信号。

**Important — 回执形状**：`_receipt_matches` 先验证回执为对象且
`sha256` 为 64 位字符串；任何结构不符/读取异常 → 安全返回不信任
（`success_media_pending`），`poll-media` 不再崩溃（含 `[]`/字符串/数字
/非法 sha 四种形状的回归测试）。

**Important — 冒烟记录安全**：记录/媒体文件名改用 task_id 的本地
SHA-256 前缀（厂商 task_id 只进 JSON 内容，含 `/` 也不破坏写入、不逃逸
`WFM1_SMOKE_DIR`，另有 resolve 包含断言）；记录写入改为临时文件 +
fsync + `os.replace` 原子替换。

## TASK-017 第四次复审修正批次（2026-08-01）

**Important — 媒体关联校验**：query 响应的 `task_id` 必须与请求一致
（串线响应不得让当前操作接收他人任务的状态/媒体）；`file_id` 仅接受
int64 或纯数字字符串（数组等形状不再被字符串化发起 retrieve）；
retrieve 响应的 `file.file_id` 必须与请求一致。缺失/类型错误/不匹配
统一 `ProviderResponseError`。协调器级测试：真实 transport 全链路下
query task_id 串线 → `needs_reconciliation`、不 fallback、
`external_task_ref` 留存供人工核对。
