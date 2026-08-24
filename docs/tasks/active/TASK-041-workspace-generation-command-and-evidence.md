# TASK-041: 工作视窗付费视频生成命令 + UI 接入 + 1 次真实证据

> **状态：Accepted（2026-08-07，用户「同意」）。2026-08-23 逐项复核，结论见下表。**
> ADR-0041 已 Accept。离线实现不花钱；付费实调需用户显式授权（key + 标志 +
> 预算确认），真跑前单独确认。
>
> | 增量 | 实际状态（代码级证据） |
> | --- | --- |
> | **1 · 核心命令** | ✅ **已完成**。`src/ai_video_workflow/app/paid_gateway.py` 的 `SUBMIT_VIDEO_GENERATION`；授权门是 `authorized=True` **加** `AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1` 双闸，默认 `build_wfm1_registry()` 不含它。`tests/backend/test_paid_gateway_command.py` **28 项全绿** |
> | **2 · UI 接线** | ✅ **已完成**。Studio 的 `_command_gateway`（`server.py`）在付费模式下注册该命令；`services/gateway.js` 早已不是 stub，做的是真实两步提交（`buildEnvelope` · `preflight` · `submit`）。~~「保持 stub」~~ 那句在 `docs/project-context.md` 里挂到 2026-08-23 才被订正 |
> | **4 · 证据运行前置** | ✅ **已完成（2026-08-24）**。`config/providers/wfm1-minimax.json`（minimax + `MiniMax-Hailuo-02` 768P/6s = USD 0.28 per_clip + `credential_env_vars: ["WFM1_MINIMAX_API_KEY"]`）；副本项目 `examples/projects/wfm1-minimax-evidence/` 已 re-lock 该目录的 digest，**冻结的 `wfm1-demo` 一字未改**。守卫 `tests/backend/test_minimax_evidence_scaffold_task041.py`（8 条）跑通整条离线链：锁验过 → registry 造出真的 `MinimaxVideoProvider`，**全程不发请求、不读 key** |
> | **3 · 1 次真实证据** | ⛔ **需要产品负责人**：它要 `WFM1_MINIMAX_API_KEY` + `AI_VIDEO_WORKFLOW_REAL_MINIMAX=1` + 对 ≈USD 0.28 的确认。AGENTS.md §1：**花钱是唯一必须问的那件事**，Agent 不得自行推进 |
>
> **2026-08-24 更新：离线那一段做完了，本卡只剩需要产品负责人的那一段。**
> 增量 1、2、4 全部完成并有守卫；**只剩增量 3**，它要的是
> `WFM1_MINIMAX_API_KEY` + `AI_VIDEO_WORKFLOW_REAL_MINIMAX=1` + 对 ≈USD 0.28 的
> 确认。AGENTS.md §1：花钱是**唯一**必须问的那件事，Agent 不得自行推进。
>
> 真跑时的完整口令（离线部分已经全部就位，剩下的就是这一条）：
>
> ```powershell
> $env:WFM1_MINIMAX_API_KEY = '<你的 key>'
> $env:AI_VIDEO_WORKFLOW_REAL_MINIMAX = '1'
> $env:AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS = '1'
> ./scripts/launch/studio.ps1 -Connected `
>     -AccountRoot examples/projects `
>     -EnablePaid -CatalogDir config/providers
> ```
>
> 然后在界面上对 `wfm1-minimax-evidence` 触发一次生成，预检会显示 USD 0.28，
> 由你按下第二步确认。**预检是只读的，从不扣费**；扣费只发生在你按下确认之后。

依据：ADR-0041（本任务实现的决策）；ADR-0033 Gateway 合同；ADR-0006 + ADR-0009 付费视频窄授权；
ADR-0010 / ADR-0032 工作视窗边界；ADR-0008 成本事实；ADR-0040 / TASK-038 submit capability。

## 分增量交付

- **Increment 1（核心命令，已实现/审查中）**：`submit-video-generation` Gateway 命令
  (`src/ai_video_workflow/app/paid_gateway.py`) + 离线测试。packet-only、target↔shot 绑定、
  task_id↔shot 规范绑定、MiniMax-only 付费范围、命令层 task 级 reservation 守卫、
  授权门（`authorized=True` + 部署环境标志 `AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1`）。
  默认注册表 `build_wfm1_registry` 不含此命令。**本增量不含 UI 接线**。
- **Increment 2（UI 接线 + 证据，离线搭建）**：mockup 后端 `POST→Gateway`（授权模式，
  env-gated）+ 前端真实两步提交（取代 stub）+ minimax 目录 + 副本项目 re-lock digest +
  审批/预算，使 coordinator 前置全绿。§4 的搭建与 §"UI 接入"在此增量落地。
- **Increment 3（真跑证据）**：授权下（key + `AI_VIDEO_WORKFLOW_REAL_MINIMAX=1` + 用户确认
  ≈USD 0.28）从 UI 触发 1 次真实生成，记录 command_id/receipt/task_id/成本/资产。

## 目标

让创作工作视窗在 UI 里**实际驱动一次真实付费视频生成**，走完整 coordinator（审批 / 目录锁 /
预算 reservation / 真实 MiniMax / 成本结算 / 恢复），并留证据。缺口是"UI → Gateway → coordinator"
这段写路径；单次真实传输层已疏通（ADR-0041 Context）。

## 范围（做什么）

1. **Gateway 命令**：新增 `submit-video-generation` `CommandSpec`（HIGH-risk、requires_target）：
   - `apply(project_root, envelope)` → 载入 shot + verified packet → 构造 `PaidRequest` →
     调 `PaidGenerationCoordinator.submit_paid`（不新写业务文件、不直连 Provider）。
   - `preview(project_root, envelope)` → 只读跑前置（stage approval 新鲜度、`production_lock`/
     packet 校验、catalog lock、`estimate_generation_cost` 报价）→ 失败进 `blockers`，
     `estimated_cost` = 目录报价。
   - `params`：`task_id / shot_id / operation_id / packet_version`；`target` 绑定 task/shot 版本。
2. **授权门的注册**：新增独立 builder（如 `build_wfm1_paid_registry()`）在**付费授权开启时**才注册
   该命令；默认 `build_wfm1_registry()`（4 个无花费命令）**不变**——保持 ADR-0033:33 默认姿态。
3. **UI 接入**：
   - 生产：`workspace_shell` 已有 POST→Gateway 两步，接入新命令（preflight 展示成本/blockers →
     HIGH-risk 用 preflight_digest 确认 → submit → receipt）。
   - 非生产 mockup：`mockups/motv-workspace/server.py` 加 `POST /api/projects/<name>/{preflight,command}`
     （经 `build_gateway` + 付费 builder，仅授权时），前端 `services/gateway.js` 由 stub 改为真实
     两步提交；生成节点"待 Gateway"→ 真实预检+确认+提交，成本/状态回显走既有真实只读查询。
   - `actor` 后端强制 `user`；loopback + same-origin + CSRF；mockup 不 import 核心内部类型。
4. **证据运行前置（真跑所需搭建）**：
   - 造一个含 `minimax` provider + `MiniMax-Hailuo-02 768P/6s` USD 0.28 per_clip 价目的目录，
     `credential_env_vars: ["WFM1_MINIMAX_API_KEY"]`，bump version；
   - 给证据项目 re-lock `catalog_digest`（用一份**副本**项目，不改冻结的 `examples/projects/wfm1-demo`
     原文，除非用户同意）；补 stage approval / 预算 config 使 coordinator 前置全绿。
5. **1 次真实证据**：授权下（`WFM1_MINIMAX_API_KEY` + `AI_VIDEO_WORKFLOW_REAL_MINIMAX=1` +
   用户确认 ≈USD 0.28）从 UI 触发一次真实生成，走通 preflight→confirm→submit→poll→collect→
   成本结算；记录 command_id / receipt / task_id / 成本 / 预算扣减 / 下载资产。

## 测试（离线，不花钱）

- 命令层单测：preview 各前置失败 → 对应 blocker；全绿 → estimated_cost；apply 经 fake transport
  成功/失败；HIGH-risk 无/错 confirmation 被拒；版本绑定漂移 fail-closed；command_id 幂等与
  operation_id reservation 双层防重复扣费；未授权时默认注册表不含该命令。
- UI 接入：mockup/shell POST→Gateway 两步的路由与 fail-closed 错误映射（复用 workspace_shell 既有
  测试模式）。
- 全量 `ruff` + `pytest` 绿；完成后走 `codex-review-loop`。

## 验收

- [ ] 离线单测覆盖命令 preview/apply/幂等/版本绑定/授权门/UI 路由，全绿。
- [ ] 未授权时默认注册表不含付费命令；仅授权 builder 注册。
- [ ] 1 次真实证据成功：command_id/receipt/task_id/成本/预算扣减/资产俱全，记录到本卡或 TASK-017。
- [ ] 边界不变量（ADR-0041 §Security）逐条满足；mockup 不 import 核心内部类型、写全经 Gateway。
- [ ] 用户对真实花费与证据签字。

## 明确不做

不接图像/音频付费；不做 retry/new-parameters/resume/collect 独立命令与自动路由；不改冻结合同；
不把 mockup 宣布为生产 WSM1-B UI；不在无授权下发起任何真实付费调用。
