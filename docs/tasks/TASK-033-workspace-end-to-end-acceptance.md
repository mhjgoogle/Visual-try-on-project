# TASK-033：Creation Workspace WFM1 数据基线验收（WSM3-B）

> **状态：Planned。** Workspace-on-WFM1 baseline milestone gate；依赖
> TASK-023～032 全部完成并通过对应 review。本任务不是两份顶层需求的最终产品验收；
> 多媒体扩展与最终验收由 TASK-039/040 承接。
> 本任务不新增产品能力，只补验收、修正归属任务缺陷并收口文档状态。

## 目的

证明工作视窗能够在 **WFM1 已支持的产物类型和命令范围内**跨项目观察、比较、
评价、管理、运行和学习，同时在关闭、重启、projection 损坏、重复命令和付费
二义场景下保持核心工作流安全。

## 输入

- TASK-024～032 的 Accepted 合同与实现；
- 一个空项目、一个完整项目、一个运行/失败项目和至少两个历史项目；
- 工作视窗统一需求、WFM1 数据可观察性要求及 ADR-0010、ADR-0030～0036；
- 统一需求追踪矩阵中标为 `workspace_wfm1_baseline` 的条目。

## 输出

- 默认离线 Workspace E2E fixture 和真实浏览器/运行时测试；
- WFM1-supported 需求→ADR→task→test traceability matrix；
- projection rebuild、Gateway money-safety、secret 和恢复对抗测试；
- 用户验收 runbook、已知限制和正式文档状态收口。

## 修改范围

E2E/安全/恢复测试、fixture、运行文档和状态文档；缺陷只回到 owner task 做最小
修正，不在本任务新增 schema、页面或功能。

## 明确不做

- 不新增 Provider、工作流步骤、推荐算法或多用户部署；
- 不把 WFM1 明确范围外的图片生成、正式音频/字幕或完整 WFM2 L0–S7 伪装为已验收；
- 不把真实付费调用作为默认 CI；
- 不降低审批、预算、版本、并发、确认或凭据安全门槛；
- 不以 mock 纯函数替代真实 query/Gateway/UI 协调链。

## 实施步骤

1. 固定 WFM1-supported 需求 traceability 和多项目验收数据集；其余条目必须明确
   指向 TASK-034～040，不得以 unavailable 冒充最终完成。
2. 贯穿观察、谱系/比较、成本、评价、Action、受控运行、复盘和推荐。
3. 注入 projection 删除/损坏、UI 关闭、Gateway 重放、stale target 和 ambiguous。
4. 验证恢复后权威事实、成本和 UI 视图一致。
5. 完成独立 milestone review 和人工创作工作台验收。

## 测试要求

- 工作视窗关闭/重启不影响任务，projection 可重建；
- 重复点击/并发/replay 不重复运行或付费；
- stale approval/action/preflight 全部 fail-closed；
- secret、私有 URL、路径逃逸和非 localhost 访问防护；
- 所有核心 M1/WFM1 测试继续通过；
- WFM1 baseline 需求覆盖无未解释缺口；范围外条目均有后续 owner。

## 验收标准

- [ ] 统一需求在 WFM1-supported 范围内的观察、运行、管理、评价、学习闭环均有
  真实证据；
- [ ] UI、projection 损坏不破坏或改变权威业务状态；
- [ ] 所有写操作经 Gateway，Provider 与 UI 均不写业务事实；
- [ ] 资金、版本、恢复、防覆盖和凭据安全通过对抗测试；
- [ ] 文档、ADR、任务状态、代码和测试一致。
- [ ] 图片、音频、字幕、完整 WFM2/WFM3 与最终 Workspace 验收明确由
  TASK-034～040 承接，不在本任务虚假收口。
