# ADR-0102：发起方与确认方是两个字段 —— 「他在对话里说的」不等于「他自己点的」

- 状态：**Accepted**（2026-09-05，实施 Agent 依 AGENTS.md §1 自行 Accept）。
  这是**技术合同**：它把一条**已经在代码里生效**的约定升成显式规则，不改任何现行行为、
  不动付费边界、不碰用户数据。**本 ADR 不放宽任何闸** —— 它做的恰恰相反：写清楚为什么
  某些写动作**应当**继续拒绝 Agent，免得下一个人把那道拒绝当成待修的阻碍。
- 关联：[TASK-128](../tasks/backlog/TASK-128-episode-side-actions-into-the-table.md)（因它而阻塞，本 ADR 解阻）·
  [ADR-0096](ADR-0096-ui-and-agent-share-one-action-table.md) 决策 1–3（同一条纪律的另一侧）·
  [REQ-006](../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md) 判据 1 ·
  `CA §5`（当前架构约束）

## 背景：一个问错了的问题

TASK-128 盘点「剧集侧的写也走动作表」时撞上一堵墙，并把它写成了一道二选一：

> 创作者在对话里说「把第 3 个片段的增益调到 -6」，Agent 执行它 —— 这算
> `origin: "user"`（他本人下的指令，Agent 只是手），还是算 `origin: "ai"`
> （需要他再确认一次）？

两个答案各自都自洽，于是那张卡停在那里等一条 ADR。

**但这个问法把两件不同的事揉成了一件**：

| 事实 | 它回答什么 | 例子 |
| --- | --- | --- |
| **发起方** | 这个动作是谁提出的 | 他点了按钮 / 他在对话里说了一句 / Agent 自己决定的 |
| **确认方** | 谁为它按下了那一下 | 他在界面上点了「执行」/ 没有人，Agent 直接写 |

「他在对话里下指令」在这两栏里的取值是**不同的**：发起方是他，确认方**没有**。
把它压成一个 `origin` 字段，就只能在「谎称他点过」和「假装不是他要的」之间二选一 ——
**两个答案都错，因为问题本身丢了一半信息。**

## 这个仓库其实早就选过边了

那条约定一直活着，只是从没被写进任何文档：

```js
// mockups/motv-workspace/src/workflow/convactions.js · runAction
if (spec.identityBinding && origin !== "ui") {
  throw new Error(`「${spec.label}」会绑定身份，只能由你自己在界面上点`);
}
```

`identityBinding` 的动作**只认 `origin === "ui"`** —— 也就是说这个仓库已经宣告过
**「他在对话里说的」≠「他自己点的」**。同一条边在另一处也成立：

```js
// mockups/motv-workspace/src/workflow/actions.js · allowedAt
if (origin === "user") return { ok: true };
if (spec.risk === "read") return { ok: true };
if (level === "manual" || level === "suggest") {
  return { ok: false, reason: "当前只允许「AI 建议 → 你确认 → 执行」…" };
}
```

`CURRENT_LEVEL = "suggest"`，所以在今天这个级别上，**非 `user` 发起的一切写动作
一律被拒**。而 `app.js` 的分派是 `origin: meta.origin || "user"` —— **默认 user**。

**这就是那堵墙的真实形状**：照直搭桥（不显式传 `origin`）会让对话里的 Agent
顶着 `user` 身份穿过 `allowedAt`。**那不是「把两张表合一」，那是拆闸。**

## 决策

### 1. `origin` 记的是**发起方**，取值三选一，一律照实传

| 值 | 含义 |
| --- | --- |
| `"ui"` | 他在界面上点的 |
| `"agent"` | 对话里的 Agent 发起的（**包括他在对话里让它做的**） |
| `"system"` | 程序自身发起的（迁移、恢复、定时） |

**「他在对话里让 Agent 做的」记 `"agent"`，不记 `"ui"`。** 理由不是不信任他，
而是这一栏记的是**事实**：那一下不是他按的。谁提出的这件事由对话记录本身承载，
不需要靠篡改这一栏来表达。

### 2. 确认是**另一件事**，由动作自己的标签表达，不挤进 `origin`

- `identityBinding` —— 绑定实体身份，反悔不干净 → **只有 `"ui"`**；
- `paid` —— 花钱 → 任何发起方都要他明确确认（AGENTS.md §1 唯一那道人工闸）；
- 其余可逆动作 → 由 `allowedAt` 按当前自动化级别判。

**升级自动化级别（`suggest` → `confirm` → `auto-low-risk`）需要它自己的 ADR。**
本 ADR 不动 `CURRENT_LEVEL`。

### 3. 因此「Agent 写不了某些东西」不是缺陷，是设计

在 `suggest` 级别下，剧集侧那些写动作**应当**继续拒绝 `origin: "agent"`。
他要在对话里做这些，**正确形状是 Agent 提案 + 他点确认** ——
`proposeOutline` / `proposeScript` 就是这个形状，已经在跑。

下一个接线的人**不要**为了让判据变绿去放宽 `allowedAt`：那会把一道真闸拆掉，
而闸拆掉之后没有任何测试会转红 —— 这正是本 ADR 存在的理由。

### 4. 接线时不需要改 `app.js`

已核实：`runAction(ctx, id, args, meta)` 把 `meta` 原样交给 `spec.apply(ctx, args, meta)`，
所以 `apply` 里能拿到 `meta.origin` 并交给 `ctx.actions.dispatch`。
**正因为它只是一行，才更要先写进 ADR 而不是顺手填一个值。**

## 代价（已接受）

**REQ-006 判据 1「Agent 能做创作者能做的事」在剧集侧永远不会字面成立** ——
只要 `CURRENT_LEVEL` 还是 `suggest`，那些写动作就必须经他确认。

**这是判据的措辞问题，不是实现的缺口。** 按判据原文去追 `PASS`，会追到一个拆掉闸门
的实现上；那时**该改的是判据，不是代码**（ADR-0088 决策 6：缺口写成卡并在 REQ 里
记下去向，不让 `PARTIAL` 被 merge 掉）。

建议的判词形状：

> 每一条他能点的写，Agent 都**说得出对应的名字**，并且**走得到那条提案路径**。

**但这条改动本 ADR 不做** —— 判据是产品需求，改它的含义归产品负责人（AGENTS.md §1：
技术决策自己定，产品行为的确认归他）。这里只把缺口和建议记下来，去向写在
[TASK-128](../tasks/backlog/TASK-128-episode-side-actions-into-the-table.md)。

## 由此解阻的事

TASK-128 第 2–4 条自此是纯接线：`postconsole.js` 那 25 处写登记成动作、`origin`
照实传、再逐条判 `allowedAt` 级别。**题目也要跟着改** —— 不再是「剧集侧的写也走
动作表」，而是「剧集侧的写**都说得出名字**，并且各自走对那条路」。
