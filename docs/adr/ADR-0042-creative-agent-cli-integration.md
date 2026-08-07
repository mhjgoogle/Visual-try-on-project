# ADR-0042: 创意 Agent 接入（本地 Claude CLI 订阅通道）

- Status: Accepted
- Date: 2026-08-07
- Decision owner: TASK-042
- Implementation scope: TASK-042
- Depends on: ADR-0010 / ADR-0032（工作视窗边界，Accepted）、ADR-0037（创意产物合同，
  Accepted）；与 ADR-0006/0009/0041（付费视频链）互不重定义。

## Context

L0–S7 合同把创意步骤定义为"**Agent 起草/产候选；用户确认**"（如 S3-T01 镜头拆分：
"Agent 起草；用户确认；CLI 校验"），但"Agent"至今没有任何实现——仓库零第三方依赖、
无 LLM 集成，工作视窗的「生成分镜」只能播放演示 fixture。用户的产品预期是：在画布上
点「生成」，应用**自己**调用 AI 完成该步骤并让下游自动衔接，而不是与聊天窗口交互；
驱动模型为 Claude。

约束：AGENTS.md 规则 10 要求付费 API 只能在 Accepted ADR 窄授权内接入。本机已安装并
登录 **Claude Code CLI**（用户已付费订阅；本仓库既有先例：`codex-review-loop` 回退
审查即调用 `claude -p` 独立会话）。经由本地已认证 CLI 的无头调用**不引入新凭据、不产生
按次账单**（计入用户订阅用量）。

## Decision

创意 Agent 的第一条实现通道 = **本地已认证 Claude Code CLI 的无头调用（`claude -p`）**。

### Decided here

- **传输**：应用后端以子进程调用本地 `claude -p <prompt>`（参数数组、不经 shell、
  超时保护、输出大小上限）；凭据/登录完全由用户既有 CLI 会话承担，应用不持有、不传递、
  不落盘任何 API key。
- **首个能力**：剧本文本 → **结构化分镜草稿**（JSON：sequence/title/description/
  duration_seconds）。输出严格解析校验，解析失败 fail-closed（把原始输出如实呈现，
  不伪装成功）。
- **草稿域**：Agent 产出一律是**草稿**——落在工作视窗的本地 scratch（mockup `data/`，
  gitignored）或仅存在于画布状态；**不写任何核心业务文件**。草稿要成为正式 planning
  产物，仍须经既有已批准的发布/审批链（ADR-0037 / TASK-034 合同层），人工 Gate 不变。
- **下游自动衔接**：画布内下游节点（资产清单等）可从上游草稿**派生预填**，同属草稿域；
  付费视频生成仍严格 packet-only（ADR-0041），草稿不能改变已锁定的生成参数。
- **默认离线**：测试与默认路径使用注入的 fake runner，零外部调用；真实 CLI 调用仅在
  连接模式的用户显式点击时发生。
- **边界不变**：不直连 Provider、不引入 DB、不改核心权威状态；CLI 不可用/未登录时
  fail-closed 报错，不静默回退。

### Not decided here（deferred）

- API-key 服务化模式（`ANTHROPIC_API_KEY` 直连 API）——将来要脱离个人机器部署时另行
  ADR 增补（含凭据、计费、模型档位与成本记账）。
- 其它创意步骤（L0 灵感/S1 剧本起草/S2 视觉圣经等）的 Agent 化——沿本通道模式增量扩展。
- 把草稿一键发布为正式 planning 产物的 UI 写命令（须走 Gateway，另行任务）。

## Security & Boundary Invariants（TASK-042 必须遵守）

1. 子进程参数数组调用，无 shell 注入面；超时与输出上限强制。
2. 应用不接触任何 LLM 凭据；仅依赖本地 CLI 既有登录。
3. Agent 输出只进草稿域；核心业务文件零写入；人工 Gate/锁定流程不变。
4. 解析/校验 fail-closed；CLI 缺失或失败如实报错。
5. 默认（测试/离线）零外部调用。

## Consequences

- 用户在画布点「生成分镜」即得到基于自己剧本的真实 Claude 产出，下游预填自动衔接；
  无新增费用（订阅用量内）。
- 该通道绑定本机个人登录，属开发/单人阶段形态；服务化部署被显式推迟。

## Acceptance

- 2026-08-07：用户「同意」接受本 ADR（对话中确认"用现有订阅实现"方案），授权 TASK-042
  实施。
