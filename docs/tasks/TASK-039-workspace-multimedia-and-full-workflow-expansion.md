# TASK-039：Creation Workspace 多媒体与完整工作流扩展

> **状态：Delivered（只读观测层，2026-08-04）。** 依赖 TASK-033 baseline、
> TASK-037 WFM2 gate（证据已备齐，等签字）、TASK-038 capability registry。交付
> WQ-19 `project_multimedia` 只读 projection：`workspace/adapters/multimedia.py`
> 读 ADR-0038 media 资产索引（图片/音频/字幕/母版）+ ADR-0039 S5–S7 postproduction
> 索引（事实域+status），把这些媒体类型作为 **authoritative** 观测（不再是 WFM1
> `unavailable` 占位）；损坏/篡改/缺失经索引自带 digest 校验 fail-closed 为
> source_corrupt problem；纳入 WQ-10 rebuild-check（确定性/只读）。查询合同
> 1.4→1.5（additive）。只读、无第二事实源、无写入、无 Provider。写命令仍走 Gateway/
> capability（TASK-038）。**UI 页面/评价·Action·推荐扩展到新媒体 target 的更多 query
> adapter 及 Gateway 真实写命令接线留作后续增量**（本轮交付核心多媒体只读观测 +
> 缺失语义 + fail-closed，使统一需求不再对图片/音频/字幕标 unavailable）。

## 目的

把 WFM1 数据上的 Workspace 扩展到完整 L0～S7、图片、视频、音频、字幕、正式
后期和 WFM3 命令，使统一需求不再依赖 unavailable 占位。

## 输入

- TASK-024～033 Workspace baseline；
- TASK-034～038 的全媒体权威事实和 capability registry；
- [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md)；
- ADR-0031～0040、统一追踪矩阵。

## 输出

- 完整 L0～S7、图片候选、音视频、字幕、后期、QC、发布和复盘 query adapters；
- 全媒体 prompt/result/experiment/decision/Action 页面；
- 跨媒体成本、模型比较、复用知识和证据化推荐；
- 新增核心能力的 Gateway/UI 接线及安全测试；
- 更新后的需求→source→ADR→task→test 追踪。

## 修改范围

Workspace query/projection/UI/Gateway adapter 的增量和测试；核心事实只读消费，
写命令只经现有 Gateway/application service。

## 明确不做

- 不补造核心缺失事实、不直接调用 Provider 或编辑业务文件；
- 不新增媒体 Provider、工作流步骤或推荐算法；
- 不把 derived projection 提升为权威来源；
- 不实现多用户远程部署。

## 实施步骤

1. 扩展 source adapters 和完整流程/query contract。
2. 实现图片候选、全媒体谱系、比较、成本和 QC/发布页面。
3. 扩展评价、Action、学习与推荐到新媒体 target。
4. 接入 capability registry 中新增的安全命令。
5. 覆盖 legacy、媒体缺失、重建、stale、重放和凭据安全。

## 测试要求

- 从创意到最终成片的每类正式产物双向谱系；
- prompt 版本与图片候选并排比较及后续视频关联；
- 全媒体成本与账本一致，失败/重试可筛选；
- 新命令全部经 Gateway，重复点击不重复付费；
- projection 删除重建和全量回归。

## 验收标准

- [ ] Workspace 统一需求中的图片/音频/字幕不再标为范围外；
- [ ] 完整 L0～S7 计划、状态、产物、问题和成本可观察；
- [ ] 每个步骤均显示预期/实际输入输出、Gate、conditional 状态和下游影响；
- [ ] 所有新增操作遵守 capability 与 Gateway 合同；
- [ ] 评价、Action、复盘和推荐覆盖完整媒体类型；
- [ ] 未引入第二事实来源。
