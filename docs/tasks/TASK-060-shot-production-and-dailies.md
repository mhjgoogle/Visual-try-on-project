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

## 5A. 移交给 TASK-060 会话：立即修复失效的人工批准测试

来源：TASK-057 persistence 会话的 codex 独立审查（`.claude/tmp/last-review.md`），
用户已确认为**立即修复项**。本节由 TASK-057 会话写入，实施仍由 TASK-060 会话负责
（AGENTS.md 规则 14/15：一个任务只有一个实施 Agent）。

**缺陷**：`tests/test_motv_shotprod_task060.py:103`（提交 `cbcac64` 已带入）

```python
assert "approve:" in app.split(line)[0].rsplit("\n", 3)[-1] or True
```

`or True` 使整个断言无条件成立。`test_only_a_human_action_records_an_approval`
中「每个 `shotprod.approveShot` 调用点都是显式用户动作」这一条实际上**从未被
验证**——任何生成/导入路径偷偷调用 `approveShot` 都不会让测试失败,而这正是
ADR-0057 决策 1（生成成功 != 镜头完成）唯一的自动化防线。

**要求**：

1. 删除 `or True`,并让该断言真正成立（不得靠放宽断言强度让测试变绿）。
2. approval 必须绑定到**具体的 active video / take**,不是绑定到 Shot。
3. 换 take / 换 variant / 新增更新的 take 之后,旧 approval **不得被继承**——
   未经审看的素材不能拿到它没挣得的「已通过」。
4. reload（`studio/canvas.json` 往返）之后 approval 持久化正确:该在的在,
   不该继承的不继承。
5. 没有 video 的 Shot **不允许** approve。
6. 跑对应的 targeted 测试:`mockups/motv-workspace/tests/shotprod.test.mjs` +
   `tests/test_motv_shotprod_task060.py`（按风险分级,涉及持久化/审批状态属高风险
   → full pytest + 全量 node）。
7. 如果去掉 `or True` 后暴露的是**实现真实 bug**,一并修实现,不要改测试迁就实现。

现有 `isApprovedFor` / `hasStaleApproval`（见 §5 上方 shotprod.js 断言）是第 2–3 点
的既有基础,验证它们在上述每条路径上都真的被调用。

## 6. 明确留待后续（不在本批）

- Reference Planning 的完整统筹界面（已有 / 缺失 / 建议复用 / 建议新建）
- 剧本 ↔ 分镜合并视图（Scene Script → Shot Breakdown → Shot Cards）
- Generation Input Set 的完整 UI
- Workflow 溯源图扩展到 Reference / Prompt 层
- 顶层过滤（全部 / 图片 / 视频 / 音频 / 失败）与 Episode Selector 重构
