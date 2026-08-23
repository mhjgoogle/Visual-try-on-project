# TASK-042: 创意 Agent 分镜草稿（Claude CLI 通道）+ 画布自动衔接

> **状态：Accepted（2026-08-07，随 ADR-0042）—— 实施中。** 零新增费用（本地已认证
> Claude CLI，订阅用量）；默认离线（fake runner），真实调用仅在用户点击时发生。

依据：ADR-0042（本任务实现的决策）；ADR-0010/0032 视窗边界；ADR-0037 创意产物合同；
ADR-0041 packet-only 付费生成（草稿不得影响已锁定参数）。

## 目标

工作视窗「生成分镜」真实工作：把用户在画布写的剧本交给本地 `claude -p`，得到结构化
分镜草稿回填画布；下游节点从草稿预填，全程无需聊天窗口交互。草稿域与正式产物严格分离。

## 范围

1. **后端**（`mockups/motv-workspace/server.py`）：`POST /api/agent/shots-draft`
   （Origin/CSRF 守卫、body 上限）：`{script}` → 子进程 `claude -p`（参数数组、超时、
   输出上限）→ 严格 JSON 解析/校验（sequence/title/description/duration_seconds）→
   `{shots:[...]}`；失败 fail-closed 返回原始输出摘要。agent runner 可注入（离线 fake）。
2. **前端**：分镜节点连接模式下把剧本文本发给该端点，渲染真实草稿（标注
   「草稿 · Claude 生成 · 未锁定」）；资产节点从草稿派生预填；付费视频仍 packet-only，
   UI 明示"付费生成按已锁定方案执行"。草稿随画布状态本地持久化。
3. **验证**：fake-runner 离线端到端（假 `claude` 可执行脚本）+ 一次真实 `claude -p`
   冒烟（订阅用量）；`ruff`/`pytest`/`node --check` 全绿；`codex-review-loop` 过审。

## 明确不做

不接 `ANTHROPIC_API_KEY`；不写核心业务文件；不做草稿→正式产物的发布写命令（另任务，
须走 Gateway）；不改付费链。
