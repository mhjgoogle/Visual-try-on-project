# TASK-140：main 的 CI 连续八次全红，而没有人看见

- 状态：**待开始**（2026-09-05 开卡；没有 Agent 在做）
- Workflow：Bug · 深度：STANDARD（先复现拿证据，再找根因；**禁止不懂根因就连环 patch**）
- 技术目标：AGENTS.md 第 20 条把**全量**定义为「集成检查点 —— CI、连续链链尾、
  merge 前、发布/交接前」。**其中 CI 这一路已经失效九天以上，而没有任何机制会喊。**
- 架构约束：`CA §4`（测试归属 —— CI 跑的是两阶段 pytest + 全量前端 + ruff）
- 来源：做 TASK-134（把依赖方向契约接进 CI）时，为取证给 `.claude/tools/gh-api.py`
  加了 `run-list` / `run-view`，第一次查就看到了这个。

## 事实（2026-09-05 用 `gh-api.py run-list --branch main` 取得）

```
33058868594  completed/failure  main  4cf84d77ee78  2026-08-27T09:30:21Z
33058454395  completed/failure  main  75290cc63b96  2026-08-27T09:24:55Z
32962933162  completed/failure  main  e43252b4271e  2026-08-26T11:21:44Z
32853209238  completed/failure  main  cf7044966de4  2026-08-25T13:25:11Z
32852625622  completed/failure  main  663a2dfd3cc9  2026-08-25T13:19:20Z
32852124063  completed/failure  main  582dd73c53be  2026-08-25T13:14:13Z
32733841589  completed/failure  main  d8ab806b4ccf  2026-08-24T13:38:03Z
32733226325  completed/failure  main  6729c8f0a681  2026-08-24T13:31:52Z
```

**连续八次，无一例外。** `run-view 33058868594` 显示两个 job（Windows 权威 /
Ubuntu 受支持目标）都停在同一步：

```
success  Ruff lint
success  Ruff format check
failure  Pytest (parallel)          ← 两个 job 都是这里
skipped  Pytest (serial process-tree tests)
skipped  Frontend unit tests (motv mockup)
```

前端测试**从未跑到**（前一步失败就 skip 了），所以「前端在 CI 上绿过」这件事，
最近九天里一次都没发生。

## 为什么没人看见（这才是要修的东西）

1. **没人看**：这个仓库的日常验证是本地 commit gate + 本地全量，merge 不经 PR
   （ADR-0085 去掉了人工闸）。CI 的结论因此**不进任何决策路径**。
2. **看不了**：本机没有 `gh`，而 `.claude/tools/gh-api.py` 在 TASK-134 之前只有
   四个 `pr-*` 子命令 —— **没有任何入口能查 workflow run**。想看也没工具。
3. **触发面窄**：`on.push.branches` 只有 `[main, "feat/**"]`，而所有开发都在
   `change/**` 分支上。开发期的每一次 push 都不会触发 CI，问题只能在 merge 之后
   才暴露，而那时已经没人在看了。

三条叠起来的效果是：**一个写在规则里的集成检查点，事实上九天没有产生过任何约束。**

## 要做什么（不预设根因）

1. **先复现拿证据**：本地能否复现 `Pytest (parallel)` 的失败？两个平台都失败说明
   多半不是平台差异。注意本地全量当前是绿的（TASK-134 收口时 3922 passed），
   **所以这大概率是 CI 环境与本地环境的差异**，而不是代码本身坏了 —— 别一上来就改代码。
2. 找到根因后再决定修法。
3. **让它以后能被看见**：至少一条 —— 把 `change/**` 纳入触发面，或在 merge 前把
   「CI 最近一次绿」列进 Merge Gate 的前置条件（第 22 条那张清单现在没有这一项）。

## OUT OF SCOPE

- 不在本卡里改 `pytest` 的并行度、超时或 marker 语义来「让它变绿」——
  那是把红灯拧掉，不是修。
- 不改 ADR-0085 的 merge 无人工闸决定；本卡只补它缺的机器证据。

## Follow-up 关联

- TASK-134 的判据 1「`lint-imports` 在 **CI** 与本地 commit gate 里跑，绿」
  因本卡而**无法闭合**：契约的 CI 接线已经写好并推送，但 `change/**` 不触发 CI，
  而 main 上的 CI 本身是红的。那张卡因此留在 `active/`。
