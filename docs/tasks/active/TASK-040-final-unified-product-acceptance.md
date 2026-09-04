# TASK-040：AI 短剧工作流与 Creation Workspace 最终统一验收

- 状态：**逐条判词见 §验收判词（2026-09-04 订正）。** 不再用一个总标题
  `Evidence Ready` 表示整卡状态 —— 它把一条 `FAIL`、三条 `PARTIAL` 和一条
  `NOT_EVIDENCED` 一起盖住了（[收敛审查](../../design/active/product-requirement-and-ux-convergence-review.md) §8.2）。
  这是**里程碑卡**：里程碑 PASS 属用户（runbook §5，一句话即可），实施 Agent 不代判；
  但「证据齐没齐」是 Agent 自己的判定，必须逐条给。
- 本任务不新增功能，只备齐最终联合验收证据：
  `tests/test_final_unified_acceptance.py` +
  [最终追踪矩阵](../../design/active/final-unified-acceptance-traceability.md) +
  [runbook](../../design/active/final-unified-acceptance-runbook.md) +
  [里程碑评审](../../design/done/final-unified-milestone-review.md)。
  TASK-037 与本门两处确认共同构成最终产品验收。

- 依据：[AI 短剧工作流需求](../../ai_shortfilm_pipeline_workflow.md) +
  [Creation Workspace 需求](../../ai_video_creation_workspace_requirements.md)
  —— 本卡是这两份顶层需求的最终统一验收门，逐项对应见上面那份追踪矩阵

## 目的

以两份顶层需求为唯一验收源，证明完整短剧生产工作流和统一创作工作视窗形成
“目标→运行→观察→评价→Action→确认→复盘→学习→复用”的真实闭环。

## 输入

- `ai_shortfilm_pipeline_workflow.md`；
- `ai_video_creation_workspace_requirements.md`；
- [L0–S7 工作层级输入输出合同](../../design/workflow-stage-step-io-contract.md)；
- 统一追踪矩阵、Accepted ADR、实现、测试和用户 runbook。

## 输出

- 逐需求 requirement→ADR→task→code→test→evidence 最终矩阵；
- 完整项目、运行/失败项目和跨项目历史数据验收集；
- 全链安全、资金、恢复、重建、凭据和人工创作验收报告；
- 正式文档状态、已知限制和后续升级清单。

## 修改范围

验收测试、fixtures、runbook、追踪矩阵和正式状态文档；缺陷回归 owner task 修正。

## 明确不做

- 不新增 Provider、工作流步骤、UI 页面、schema 或算法；
- 不用 unavailable 关闭明确要求的最终能力；
- 不把真实付费 API 设为默认 CI；
- 不降低人工批准、预算、版本、恢复或凭据安全标准。

## 实施步骤

1. 冻结两份需求的逐条验收清单和证据位置。
2. 贯穿完整 L0～S7、多媒体生成、正式后期、Workspace 操作和 Action。
3. 验证复盘、跨项目指标、知识提升和新项目推荐。
4. 注入崩溃、重放、预算、stale、projection 损坏和 secret 攻击场景。
5. 完成独立架构/实现审查和用户创作验收。

## 测试要求

- 两份需求每一条均有通过证据或经用户批准的显式范围变更；
- 真实 query/Gateway/Orchestrator 协调链，不以纯函数 mock 替代；
- 全媒体成本、谱系、版本和 Action 可审计；
- UI 关闭/重建不影响核心，重复命令不重复执行/付费；
- 全量测试、静态检查、文档链接/编号/状态一致。

## 验收标准

- [ ] 两份顶层需求无未解释缺口；
- [ ] I/O baseline 全部步骤均有最终 requirement→schema→owner→code→test→evidence；
- [ ] 完整工作流与 Workspace 均可跨项目复用；
- [ ] 自动化不替代用户创作决定；
- [ ] 所有业务事实有唯一写入者且 projection 可重建；
- [ ] 独立审查和用户验收通过后方可宣布最终产品基线完成。

## 验收判词（2026-09-04）

判词含义：`PASS` 当前实现与测试直接证明 · `PARTIAL` 主体存在但有一条真实使用路径
不成立 · `FAIL` 已看到与判据相反的当前行为 · `NOT_EVIDENCED` 可能实现了但仓库没有
足够证据。**一条 `PARTIAL` 也不许被总标题盖掉。**

| # | 判据 | 判词 | 依据 / 缺口 |
| --- | --- | --- | --- |
| 1 | 两份顶层需求无未解释缺口 | `PARTIAL` | 追踪矩阵逐条在册；缺口不是「没解释」而是**没闭合**：长任务刷新恢复（TASK-106）与 Candidate/QC/Final 生命周期（TASK-074）两处 |
| 2 | I/O baseline 每步有 requirement→schema→owner→code→test→evidence | `PASS` | [最终追踪矩阵](../../design/active/final-unified-acceptance-traceability.md) 逐步在册，`tests/test_final_unified_acceptance.py` 跑通闭环 |
| 3 | 完整工作流与 Workspace 均可跨项目复用 | `PARTIAL` | 核心 CLI/工作流可跨项目；Studio 侧仓库内只有 `wfm1-demo`，其 Studio canvas 为**空对象**，充实的 UI 状态无法在仓库内复现 → 切片 5 建可重复 Connected Project 样本 |
| 4 | 自动化不替代用户创作决定 | `FAIL` | 本卡自己的判据。`render` 路径把合成结果**直接登记为 Final**（`assetlib.addFinal`，`kind: "final"`），G4 不是导出前置 —— 「将候选设为最终版本」这条用户确认被绕过。闭合在 TASK-074 |
| 5 | 所有业务事实有唯一写入者且 projection 可重建 | `PARTIAL` | 写路径经 Command Gateway、投影可从权威文件重建；未闭合的是 `approveShot` 双写身份不一致（TASK-087 §4.12）与前端未完整读 `/api/runs`（TASK-106） |
| 6 | 独立审查 + 用户验收通过后方可宣布最终基线 | `NOT_EVIDENCED` | 自动化测试全绿不等于用户验收；真实浏览器视觉/无障碍与 MediaRecorder 至今没有实测证据（[收敛审查](../../design/active/product-requirement-and-ux-convergence-review.md) §10）。**里程碑 PASS 属用户，一句话即可** |

### 因此本卡还挡在哪三件事后面

1. **TASK-106** —— 长任务统一异步 + 刷新恢复（切片 2）。判据 1、5。
2. **TASK-074** —— Candidate/QC/Final 真实交付生命周期（切片 3）。判据 1、4。
3. **切片 5** —— 可重复 Connected Project 样本 + 真实项目人工走查（判据 3、6）。

三件闭合之后本卡才有资格递到用户面前要那**一句话**。在此之前它留在 `active/`，
因为「部分完成」也是在办（ADR-0083）。
