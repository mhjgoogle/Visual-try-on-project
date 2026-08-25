# TASK-106：前端接上 `run_id` 路径 —— 并由此退役同步分支与 `/api/agent/*`

- 状态：**待开始**（分析已完成，见 §1；实施与 ADR 未做）
- workflow 类型：Migration
- 深度：DEEP（跨前后端合同 + 新增运行期机制）
- 负责 Agent：待定（单一实施 Agent，AGENTS.md 第 14 条）
- 起因：[TASK-074](TASK-074-delivery-migration-and-legacy-retirement.md) §1.5 批次 4
  的核查 —— 三件看起来无关的事查下去是**同一个缺失的机制**
- 依据：[创作者系统合同](../../design/creator-system-contract.md) §5.0 / §5.5、
  [ADR-0065](../../adr/ADR-0065-every-ai-action-through-the-runtime-layer.md)、
  [ADR-0066](../../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) 决策 8

---

## 0. 这张卡为什么存在

TASK-074 §1.5 的清理表里有两行判「否」，§1.4 的边界表里有一条 ✅ 其实只覆盖了
后端。**三条是同一件事**：

```
前端没有读运行状态的能力
   ├── §1.4 边界 4「刷新页面 → 状态从后端恢复」→ 产品路径未接通
   ├── §1.5「/api/skill/run 同步分支」    → 条件「前端已全部走 run_id」不成立
   └── §1.5「/api/agent/* 五个创作端点」  → 同一个条件
```

分三处记就会被当成三件事分别排期，而它们其中任何一件单独做都做不成。

## 1. 已完成的分析（2026-08-25 实测，不必重做）

| 实测 | 结果 |
| --- | --- |
| `grep -rn "api/runs" src/services/` | **1 处**，且是 `POST /api/runs/<id>/cancel`。`GET /api/runs` 与 `GET /api/runs/<id>` **零调用点** |
| `grep -n "timeoutMs: 0" src/services/command.js` | **16 处**长任务，全部是同步阻塞 `await`，客户端不设上限 |
| `src/controllers/skillctl.js` 里的 resume / reconcile / 轮询 | **没有** |
| `_reconcile_skill_runs` 挂在哪 | 只挂 canvas **PUT**（`server.py:5755`）；`_canvas_get` 不对账 |
| 后端异步面 | **已就绪**：`X-Motv-Async: 1` → `202 {run_id}`；`_agent_sync_response` 保留旧响应形状；`GET /api/runs`、`POST /api/runs/<id>/{cancel,confirm,submit}` 都在 |

**所以缺口只在前端一侧，且是一个新机制而不是一次接线。**

刷新之后页面拿到的是**上次保存时**的运行状态：canvas GET 不对账，而对账只发生在
下一次 PUT 上，那时纠正过的值进了磁盘却没有回到页面。

## 2. IN SCOPE

1. **前端运行状态读取与对账循环**：读 `GET /api/runs`（按项目）与
   `GET /api/runs/<id>`，与画布里的 run 记录对账，谁说了算按系统合同 §5.5
   （后端拥有生命周期字段，画布拥有 proposal）。
2. **长任务改走 `X-Motv-Async: 1`**：16 处 `timeoutMs: 0` 的调用改为
   「拿到 `run_id` → 返回 → 由循环推进」。
3. **退役 `/api/skill/run` 同步分支**（前端不再用之后）。
4. **退役 `/api/agent/*` 五个创作端点**（同上）。ADR-0065 决策 1 的收口
   （TASK-068）改的是端点**内部**，刻意保留了 URL 与响应键；这一步才是把 URL 也去掉。
5. **§1.4 边界 4 的产品级验证**：不是「后端 API 能答」，是「刷新之后页面真的显示
   任务还在跑」。

## 3. OUT OF SCOPE

- `/api/agent/*` 里**非创作**的那几个（`render-episode` / `mix-shot` / `tts` /
  `compose` / `image-gen` / `adopt-paid` / `motion-preview`）—— ADR-0065 明确
  「不动」的那三个在内，它们不在收口范围里。
- 后端异步面的任何改动（已就绪）。
- 画布 schema（对账用的字段 v15 起就有）。

## 4. 先要定的决定（→ ADR，实施 Agent 自行 Accept）

这些**不是可以边写边定**的实现细节，它们决定机制的形状：

1. **多久问一次**，以及不问的时候怎么知道该问了（有在跑的 run 才轮询？指数退避？）。
2. **谁说了算**：循环拿到的状态与 `_reconcile_skill_runs` 在 PUT 上做的对账，
   两处规则必须是同一份，否则会出现「保存一次状态就变一次」。
3. **关标签页 / 断网**：run 还在后端跑，页面回来时怎么重新认领。
4. **失败与退避**：轮询自己失败时不得把「问不到」渲染成「没在跑」
   （ADR-0064 决策 6 的诚实规则）。
5. **同步分支删除的时机**：前端全部切完之后，还是留一版兼容。按 AGENTS.md §1
   「回不了头是缺陷」，倾向留一版并在下一张卡删。

## 5. 验收标准

- [ ] 刷新页面时有长任务在跑 → 页面**从后端**恢复它的状态（真实项目上看得到）
- [ ] 16 处长任务全部经 `run_id` 路径；`grep` 全仓无同步长任务残留
- [ ] `/api/skill/run` 同步分支与 `/api/agent/*` 五个创作端点删除后全量测试绿
- [ ] 轮询失败时界面说「问不到」，不说「没在跑」
- [ ] TASK-074 §1.4 边界 4 的归属改到一条**驱动前端代码**的测试上

## 6. 风险

**高**：跨前后端合同 + 新增运行期机制 + 删除在用端点。
→ 全量 pytest + 全量前端 + ruff + 独立审查；删除阶段单独再审一次。
