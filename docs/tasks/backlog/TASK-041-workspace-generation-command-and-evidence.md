# TASK-041: 工作视窗付费视频生成命令 + UI 接入 + 1 次真实证据

> **状态：`backlog/` —— 离线部分全部完成，只剩一次需要产品负责人批准花钱的真实证据，当前没有 Agent 在做（2026-09-04 归位）。**
> `active/` 只代表**正在进行**的工作（[ADR-0087](../../adr/ADR-0087-document-lifecycle-and-default-agent-context.md) 决策 2）；一张同时表示「正在做」和「等以后」的卡会把待办读错。
> 产品负责人说一句「跑，这次 ≈USD 0.28 我认」它就回 `active/`。
>
> **2026-08-07 用户「同意」Accept；2026-08-23 逐项复核，结论见下表。**
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
> > **2026-08-26 订正：「它要的是」那三样列少了。** 实测还要**四道 stage 批准**
> > （`concept_lock` → `screenplay_lock` → `av_design_lock` → `production_lock`），
> > 而付费网关硬要 `production_lock`。逐条证据见下方 §3。
>
> ~~真跑时的完整口令（离线部分已经全部就位，剩下的就是这一条）：~~
>
> > **2026-08-26 订正：上面那句「剩下的就是这一条」是错的，那条命令也跑不起来。**
> > 产品负责人当天说「跑」，实测之后有**三件**事挡着，不是一件。逐条见下方
> > 「§3 真跑前置的实测结果」。

### §3 真跑前置的实测结果（2026-08-26）

**一、原来写的启动命令不存在那三个参数。**

`scripts/launch/studio.ps1` 的 `param()` 只有
`-Connected` / `-SetupOnly` / `-AllowCodexReview` / `-Port` / `-AssetRoot`；
`-AccountRoot` / `-EnablePaid` / `-CatalogDir` **一个都没有**，而且启动器把
后端写死成 `server.py --account-root $AssetRoot`，**没有转发任何其它参数的路径**。
照原命令粘下去只会得到 `A parameter cannot be found that matches parameter name
'AccountRoot'` —— 而那正好发生在准备花钱的那一刻。

付费模式要**直接调 `server.py`**（三个参数在它自己的 argparse 里）。已实测启动成功
（`/api/meta` 回 `{"mode":"connected","paid":true}`）：

```powershell
$env:WFM1_MINIMAX_API_KEY = '<你的 key>'
$env:AI_VIDEO_WORKFLOW_REAL_MINIMAX = '1'
$env:AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS = '1'
.\.venv\Scripts\python.exe mockups\motv-workspace\server.py `
    --account-root examples\projects `
    --enable-paid `
    --catalog-dir config\providers
```

代价（已知，可接受）：绕开启动器就没有它的 `Resolve-ClaudeOnPath` /
`Resolve-CodexOnPath`，AI 运行时不会被解析 —— 对本次付费生成不影响，
它走的是 MiniMax 传输层，不是本地 CLI。
生成的媒体落在 `examples/projects/` 内，但 `.gitignore` 的 `*.mp4` 挡着，
不违反第 23 条。

**二、`production_lock` 没批 —— 而付费路径硬要它。**

`src/ai_video_workflow/app/paid_gateway.py:330` 是
`require_stage_ready(project_root, "production_lock")`。实测两个项目的八个 stage
**全是 `draft`**：

```
concept_lock      draft   blocked_by=[]
screenplay_lock   draft   blocked_by=[concept_lock]
av_design_lock    draft   blocked_by=[screenplay_lock]
production_lock   draft   blocked_by=[av_design_lock]
```

`wfm1-minimax-evidence` 与冻结的 `wfm1-demo` **逐文件相同**（`diff` 无输出），
所以这不是副本丢了东西，是这条链本来就没批过。**本卡此前从未提到这四道闸。**

这四道闸不是可以顺手替用户按掉的：它们正是挡在付费动作前面的**人工批准**，
也就是 ADR-0006 / ADR-0009 窄授权赖以成立的那一层。Agent 自行批准它们再去花钱，
等于把整套付费设计的控制点掏空 —— AGENTS.md §1「窄授权不得自行扩大」。

**三、key 只从环境变量来。** `cloud_minimax.py:57`
`MINIMAX_CREDENTIAL_ENV = "WFM1_MINIMAX_API_KEY"`，仓库里没有、也不该有凭据文件
（第 23 条）。

**离线那一段在 2026-08-25 的 schema 迁移合并之后复验仍然全绿**：
`test_minimax_evidence_scaffold_task041.py` + `test_paid_gateway_command.py`
共 41 项通过。

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
