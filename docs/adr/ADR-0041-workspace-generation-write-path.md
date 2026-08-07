# ADR-0041: 工作视窗生成写路径（Gateway 付费视频生成命令）

- Status: Accepted
- Date: 2026-08-07
- Decision owner: TASK-041
- Implementation scope: TASK-041
- Depends on: ADR-0033（Accepted）、ADR-0006 + ADR-0009（Accepted，付费视频窄授权）、
  ADR-0010 / ADR-0032（Accepted，工作视窗边界/拓扑）、ADR-0040 / TASK-038（Accepted，
  submit capability 槽，与 Gateway 命令注册表 same-source）、ADR-0008（成本事实）

## Context

用户要在**创作工作视窗里实际操作、驱动真实视频生成**（不只是观察）。现状与门槛：

- Command Gateway 是唯一写入口（ADR-0033 Accepted）。但当前 WFM1 命令注册表
  (`app/gateway_commands.py:build_wfm1_registry`) 只注册 4 个 **LOW-risk、零花费**的创意事实写
  命令（record-evaluation / create-feedback / create-action / action-transition，TASK-031）。
  付费 `PaidGenerationCoordinator.submit_paid` **只能经 CLI 触达**，**未注册为 Gateway 命令**
  （TASK-031 明确"付费 start/retry/resume 未注册"）。
- 付费**视频**授权已存在且 Accepted：ADR-0006（CloudVideoProvider 窄授权）+ ADR-0009
  （MiniMax，单凭据 `WFM1_MINIMAX_API_KEY`）。图像/音频付费**不在**现有授权（ADR-0038）。
- ADR-0040 / TASK-038 已确立与 Gateway 注册表 same-source 的 capability 注册表，含 `submit`
  能力槽，但"合同层不含真实 apply handler"。
- 真实传输层已疏通（授权真跑一次成功：task_id `428040342818896`，下载 5.5MB MP4，≈USD 0.28）。

缺的不是"能不能生成"，而是"**UI → Gateway → coordinator** 这段写路径的接入"。本 ADR 在既有
合同内裁决：**注册一个真实的付费视频生成 Gateway 命令**，让工作视窗经既有 POST→Gateway 模式
驱动 `submit_paid`，严守 provider 中立、付费窄授权与 fail-closed。本 ADR 只定义"提交生成"；
retry / new-parameters / resume / 自动路由不在本 ADR。

## Candidates

1. **注册一个 HIGH-risk 付费视频生成 Gateway 命令**（apply 包装已批准的 `submit_paid`），
   UI 经现有 POST→Gateway 两步（preflight → 确认 digest → submit）驱动。✅ 唯一符合 ADR-0033
   "只注册已批准 application 操作 + 唯一写入口 + P3/P4/P5/P7"的路径。
2. UI 直接调 coordinator / Provider（绕过 Gateway）。⚠ 违反 ADR-0010 决策 2、ADR-0033 P1/P2，排除。
3. 继续只用 CLI 触发、UI 只读观察。△ 合规但不满足"在 UI 里实际操作"，作为 ADR-0041 未 Accept
   前的现状保留（见 ADR-0033:33 的 gated 姿态）。

## Decision

采用**候选 1**：注册**一个真实的付费视频生成 Gateway 命令**，作为 ADR-0033 注册表中第一个
HIGH-risk、真实花费的命令，仅覆盖**视频**链，其余保持 stub/未注册。

### Decided here（本 ADR 裁决）

- **命令**：新增 `CommandSpec`（建议名 `submit-video-generation`），`risk = HIGH`，
  `requires_target = True`。`apply` 调用**已批准的 application 入口** `submit_paid`（符合
  ADR-0033:112 "只注册已批准操作"），命令层不新写业务文件、不直连 Provider。
- **preview（只读）**：跑全部前置为 `blockers` —— stage approval 新鲜度、`production_lock`/
  task packet 校验、catalog lock、预算预检 quote；`estimated_cost` = 锁定目录报价。命令为
  HIGH-risk → 强制 preflight + `confirmation == preflight_digest`（ADR-0033 P4）。
- **输入 params（默认 WFM1 packet 流）**：`task_id / shot_id / operation_id / packet_version`，
  由 verified packet 派生 `PaidRequest`（与 `cli.py` WFM1 流一致）；不接受自由参数改动已锁定方案。
- **目标绑定**：`target = {ref, version, content_digest}` 绑定 task/shot 版本，漂移 fail-closed
  （ADR-0033 P3）。
- **幂等/防重复扣费**：Gateway `command_id` receipt + coordinator `operation_id` reservation
  双层；一个 command_id 稳定对应一个 operation_id（ADR-0033 P5）。
- **fail-closed 准入**：未审批 / 超预算 / provider 不可用 / catalog 漂移 → blockers 或 typed
  rejection，绝不落 stale 拒绝、绝不 fallback 静默扣费（ADR-0033 P7；coordinator 既有语义）。
- **付费范围**：**仅视频**，经 `VideoProvider` 抽象与 coordinator（provider 中立）；付费实调仅
  MiniMax 视频、单凭据 `WFM1_MINIMAX_API_KEY`（ADR-0006 + ADR-0009）。**图像/音频付费明确不在
  本 ADR 范围**（ADR-0038 未 Accept 部分）。
- **UI 接入**：经既有 POST→Gateway 两步；后端强制 `actor = "user"`（不可伪造 provenance）；
  仅 loopback + same-origin + CSRF（ADR-0032）。**生产工作视窗**经 `workspace_shell`；**非生产
  mockup**（`mockups/motv-workspace/`）可在其 loopback 后端加同样的 POST→Gateway 以完成接入与
  一次真实证据运行——mockup 仍不 import 核心内部类型、写全部经 Gateway。
- **证据**：接入后跑**1 次**真实完整链路（≈USD 0.28），记录 task_id / receipt / 成本事实作为
  疏通证据（TASK-017 先例）。默认离线 stub，付费实调仅在显式授权（key + 标志）下。

### Not decided here（延期至后续 ADR / 任务）

- retry / new-parameters / resume / collect 独立命令与自动重试策略（ADR-0040 / TASK-012）。
- 自动化路由、批量固定职责（WFM3）。
- 图像/音频付费（ADR-0038 Accepted 部分）。
- 把 mockup 宣布为生产 WSM1-B UI，或生产付费验收（受 TASK-023 等门槛）。

## Security & Boundary Invariants（下游 TASK-041 必须遵守）

1. 唯一写入口：所有生成写经 Gateway 命令；UI/后端不直连 Provider、不直接写业务文件。
2. 命令 apply 只调已批准 application 入口（`submit_paid`），不复制 Orchestrator/Provider 逻辑。
3. HIGH-risk：preview 报 `estimated_cost` + blockers；提交须 `confirmation == preflight_digest`。
4. 版本绑定 fail-closed；幂等双层（command_id + operation_id）防重复扣费。
5. 付费仅视频、仅 MiniMax、单凭据；离线 stub 为默认，实调需显式授权；凭据只经 env、不落库、
   不入日志。
6. 默认注册表（无授权时）**不含**本付费命令；仅在付费授权开启时经独立 builder 注册（保持
   ADR-0033:33 "现行不接入真实写命令"默认姿态）。
7. actor 强制 user；loopback + same-origin + CSRF；关闭 UI 不影响核心执行与恢复。

## Consequences

- 工作视窗可在既有 Gateway 合同内**真正驱动**一次付费视频生成，预算/审批/reservation/成本事实
  全部复用现有 coordinator，无新执行层。
- 这是 ADR-0033 注册表中第一个 HIGH-risk、真实花费命令，放宽 TASK-031 的"付费未注册"默认，但
  被"仅授权时注册 + 付费窄授权 + fail-closed"约束。
- retry/resume/collect 等后续命令沿本命令模式增量注册。

## Acceptance Criteria（决策属性，Accept 时确认）

- [x] 命令为 HIGH-risk、requires_target、apply 只调 `submit_paid`，未新写业务文件/未直连 Provider。
- [x] preview 把 approval/packet/catalog/budget 前置作为 blockers 只读呈现，estimated_cost=目录报价。
- [x] 幂等双层 + 版本绑定 + fail-closed 准入语义与 ADR-0033 P3/P4/P5/P7 一致。
- [x] 付费范围仅视频/MiniMax/单凭据；图像/音频付费明确排除；默认注册表无付费命令。
- [x] UI 经 POST→Gateway 两步、actor 强制 user、loopback+CSRF；mockup 不 import 核心内部类型。
- [x] 由用户裁定 Accept（未由实施 Agent 自 Accept）。

（以上为决策属性；具体实现的验收在 TASK-041。）

## Acceptance

- 2026-08-07：用户 Accept 本 ADR（「同意」），授权 TASK-041 实施。付费实调仍需单独的
  key + 标志 + 预算确认；离线实现不花钱。
