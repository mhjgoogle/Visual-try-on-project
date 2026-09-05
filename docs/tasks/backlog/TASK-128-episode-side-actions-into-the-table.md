# TASK-128：剧集制作侧的写也走动作表 —— REQ-006 判据 1 的另一半

- 状态：**待开始**（2026-09-05 开卡；没有 Agent 在做，所以在 backlog/ —— 切片 5 之后，与 [TASK-129](TASK-129-settings-structure-writes-into-the-table.md) 同批）
- Workflow：Refactor（不改有效产品行为）· 深度：DEEP（跨 `ctx.actions.dispatch` envelope 与 `convactions`）
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  判据 1 —— **剧集制作侧**那一半。故事开发侧（四页 + 创意简报 / 大纲 / 人物 / 场景地 /
  分集规划）由 [TASK-127](../active/TASK-127-one-action-table.md) 闭合并有合同测试
- 关联 ADR：[ADR-0096](../../adr/ADR-0096-ui-and-agent-share-one-action-table.md) 决策 1–3（同一条纪律，另一侧）
- 架构约束：`CA §3`（写路径）· `CA §5.2`（不静默覆盖）· `CA §6`（动作表由前端拥有）
- 依据：codex 对 TASK-127 的轮 1 审查 —— 合同只证了故事侧前缀，`shot.* / blocking.*`
  在证明之外；按 ADR-0088 决策 6 把缺口写成卡、在 REQ 里记下去向，**不让 PARTIAL 被
  当成 PASS 合掉**

## 为什么单独一张卡

剧集制作侧的界面写不走 `swork.*`，走的是 `ctx.actions.dispatch(envelope)`（`postconsole` /
`epprod` 的 `act()`），而 Agent 侧的 `shot.hide / shot.restore / blocking.*` 直接调 `ctx.*`。
两套 envelope 合成一张表，要先回答「envelope 的 `action` 名与 `ACTIONS` 的 id 是不是同一个
词表」—— 今天不是（`hideShot` vs `shot.hide`）。这是词表统一问题，不是接线问题，
所以不塞进 TASK-127。

## IN SCOPE

1. 盘点剧集侧的**创作者写入口**：`epprod.js` / `postconsole.js` / `storyboard.js` /
   `blockingws.js` / `shotwork` 各分区里经 `act()` 或直接 `ctx.*` 的写；
2. 每一条可逆、非付费、非绑身份的写 → `ACTIONS` 里一条动作（有的合并进既有 `shot.* /
   blocking.*`），界面改走 `uiAct(ctx, id, args, { rerender })`；
3. `test_surface_manifest.py` 的前缀集合扩到 `shot.* / blocking.*` 及新增前缀；
   第 4 条（无直接写）扩到对应的 bind 函数；
4. 付费（渲染 / 生成）、绑定身份（`confirmPlan`）、删字节（存储管理）**不进表**，
   在合同里以显式 allow-list 记明理由。

## OUT OF SCOPE

- `ctx.actions.dispatch` 这套 envelope 本身的去留 —— 若两张表合一需要 ADR，另立。
- ADR-0096 决策 4（页面地图 / 能力输入从表派生）—— 再另一张卡。

## 完成判据

1. `test_surface_manifest.py` 对**全部**非付费、非绑身份、可逆的 `ACTIONS` 成立双向：
   界面引用 ⊆ 表；表中每条被界面引用；allow-list 外无直接写。
2. REQ-006 判据 1 由 `PARTIAL` 转 `PASS`（收敛审查 §3 那一行同步）。
3. 前端全量、`tests/contract`、`tests/studio` 全绿；`motv_doctor` 无新红。
