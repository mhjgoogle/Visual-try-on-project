# TASK-060：Shot 生产状态 + 连续审片（Dailies）

- 状态：进行中
- ADR：[ADR-0057](../adr/ADR-0057-shot-production-state-and-dailies.md)
- baseline：TASK-059（schema v12）
- 风险级别：**高**（canvas schema v12 → v13 + 持久化 + 迁移）

## 1. 目标

回答两个今天答不出来的问题：

    这一集做到哪一步了？
    这个参考被哪些镜头用了？

并让**审片**成为一个可以连续走完的动作。

## 2. 实施映射

### 2.1 新增域（schema v13，纯追加）

    production.shotProduction = {
      reviews:    { [creativeShotId]: { approved: true, approvedAt, note } },
      references: { [creativeShotId]: [referenceKey, …] },
    }

新模块 `src/workflow/shotprod.js`：状态派生 + 审片 + 共享参考绑定。

### 2.2 派生（不落盘）

    待设计 / 已设计 / 待生成 / 已生成 / 待审片 / 已通过

只有「已通过」有持久化来源。**生成成功 != 镜头完成**。

### 2.3 控制器

`ctx.shot`：`stage` / `stageCounts` / `mediaOf` / `approve` / `unapprove` /
`references` / `addReference` / `removeReference` / `shotsUsingReference` /
`pruneReferences`。

### 2.4 Dailies

新增 `src/ui/dailies.js` + Episode 导航项「审片」：按 canonical 顺序
（场景内 shotIds 顺序 → 未分配池）连续播放，支持
播放 / 上一镜 / 下一镜 / Shot Design 摘要 / 状态 / 通过 / 跳过。

**没有视频的镜头照常出现，不崩溃，且不能被标记通过。**

## 3. 验收

1. 迁移在真实存档上 `status=ok`，两个映射均为空
2. 既有镜头显示「待审片」，没有任何一个被自动标成已通过
3. 通过 / 撤销通过后 reload 仍在
4. 一个参考绑定到多个镜头，仍然是**一个**参考、**一条**版本链
5. 同一 shot 不能重复绑定同一个参考
6. 删除参考后，指向它的绑定被清理，不留幽灵 chip
7. Dailies 能从第一个镜头连续走到最后一个
8. 没有视频的镜头不中断流程，且「通过」不可用
9. Workflow / Assets / Timeline / Final lineage 未回归

## 4. 测试

高风险 → full pytest + 全量 node --test + ruff + Codex 独立审查。

新增 `mockups/motv-workspace/tests/shotprod.test.mjs` +
`tests/test_motv_shotprod_task060.py`。

## 5. Scope guard

本批只做**镜头生产状态 + 审片**。

## 6. 明确留待后续（不在本批）

- Reference Planning 的完整统筹界面（已有 / 缺失 / 建议复用 / 建议新建）
- 剧本 ↔ 分镜合并视图（Scene Script → Shot Breakdown → Shot Cards）
- Generation Input Set 的完整 UI
- Workflow 溯源图扩展到 Reference / Prompt 层
- 顶层过滤（全部 / 图片 / 视频 / 音频 / 失败）与 Episode Selector 重构
