# ADR-0096：他能点的 = 它能做的，靠一张表，不靠两份名单

- 状态：**Accepted**（2026-09-05，实施 Agent 依 AGENTS.md §1 自行 Accept —— 纯技术决策：登记点、依赖方向、合同测试形状。决策 1–3 已由 [TASK-127](../tasks/active/TASK-127-one-action-table.md) 实施并有合同测试；决策 4 待另一张卡）
- 关联：[REQ-006](../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md) 判据 1 ·
  收敛审查 §5.C · [一份面清单提案](../design/active/proposal-one-surface-list.md) §4.2 ·
  [ADR-0089](ADR-0089-conversational-agent-write-path.md) 决策 2b ·
  [ADR-0102](ADR-0102-origin-and-confirmation-are-two-fields.md)（同一条纪律的另一侧：
  这张表把「谁能做什么」统一了，那条 ADR 说清「是谁发起的」与「谁确认的」是两个字段 ——
  两者合起来才是完整的准入判断）

## 背景

产品负责人 2026-08-29：「用户能够操作的前端的agent都应该可以操作。」

`workflow/convactions.js` 的 `ACTIONS`（35 条）已经是「Agent 的词汇表由界面动作生成」——
每条 `apply` 调的都是创作者点按钮时的同一个 `ctx.*`。**缺的是反方向**：界面按钮不经过
`ACTIONS`，`production.js` 的 `bindStoryWork` 直接调 `swork.*`（18 处）。于是「UI 有、
Agent 没有」这个差集只能靠人眼比 —— 2026-08-31 一天里人物 / 关系 / 场景地「只会改、
不会加」正是这样漏掉的（TASK-126）。

收敛审查 §3 因此判 REQ-006 判据 1 `NOT_EVIDENCED`：局部动作有测试，但没有
「每个可逆 UI command 都自动出现在 Agent registry」的穷尽性合同。

## 决策

### 1. `ACTIONS` 是唯一登记点；UI 的写也走 `runAction`

`bindStoryWork` 里每个写按钮改为 `runAction(ctx, "<id>", args, { origin: "ui" })`。
一个按钮若没有对应的 action，**它根本发不出写** —— 「他能点的」与「它能做的」由此是
同一张表的两次读取，不是两份要人手对齐的名单。

不新建第八处描述。manifest 就是升格后的 `ACTIONS`。

### 2. 每条动作带三个能力标签，由 `runAction` 统一判

`{ reversible: true|false, paid: true|false, identityBinding: true|false }`。

- `paid: true` → **执行时**一律拒（花钱是唯一必须问创作者的事，AGENTS.md §1）。付费动作
  **可以登记**（这样表知道它的名字、标签、undo，Agent 词汇表里能如实说「这件事要花钱，
  不由我做」），但 `runAction` 对它谁调都拒 —— 拒在花钱的那一刻，不在登记那一刻。
  表里今天没有付费动作；标签的存在是为了让下一条付费动作按同一条规矩被拒，
  而不是靠注释「还没进表的」。（codex 2026-09-05 轮 1 P2：原文写「登记时就被拒」，
  与实现不符；登记时拒的只有下一条。）
- `identityBinding: true` → 只允许 `origin: "ui"`（如 `confirmPlan` 绑定剧集身份，反悔不干净）。
- `reversible: false` 且非付费非绑定 → 登记时抛错：不可逆是实现缺陷，先把它做成可逆
  （AGENTS.md §1「回不了头是缺陷」）。

### 3. 穷尽性是合同测试，不是抽查

`tests/contract/test_surface_manifest.py`（跨 py↔js 合同只住 `tests/contract/`，ADR-0080 决策 3）：

1. `production.js` 里每个 `runAction(ctx, "<id>"` 的 id ∈ `ACTIONS`；
2. `ACTIONS` 每条 id 至少被一处 UI 入口或 `skillapply.planApply` 引用 —— 否则它是
   「Agent 专用」，违反「他能点的 = 它能做的」的另一半；
3. 每条有 `undo` 与三个标签；
4. `bindStoryWork` 里不再有直接的 `swork.*` 写调用（只读的 `swork.*` 允许，由白名单列出）。

### 4. 页面地图与能力输入从同一张表派生（第二步，可与第 1 步分批）

每条 action 加 `surface: { page, label, reads, inputName }`；`_CONV_PAGE_MAP` 由前端随请求
上送的 `context.actions[].surface` 生成（服务端读不到文件系统，今天 actions 已经这么上送）；
`skillctl.available[inputName]` 由 `surface.reads` 派生；
`test_agent_reading_map_task122.py` 的三张手写表改为读 manifest。
`_conv_facts` 的读路径**不动**（它有自己的预算逻辑；ADR-0095 决策 5 同一条理由）。

## 代价（已接受）

- `bindStoryWork` 的 18 处写要逐个改成 action 调用，`ACTIONS` 会长到 ~45 条。
- `runAction` 多一层判定；`sanitizeArgs` 的白名单对 UI 也生效 —— 这是**特性**：UI 传了
  表外的键，与模型传了表外的键，同样会被剥掉并说出来。
- 「Agent 专用动作」不再允许存在。今天没有这样的动作；将来若真需要，先写 ADR。
