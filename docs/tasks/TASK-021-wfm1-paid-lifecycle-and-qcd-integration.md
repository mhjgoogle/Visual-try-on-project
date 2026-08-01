# TASK-021：WFM1 付费生成生命周期与 QCD 接回

> **状态：Draft（待批量设计基线批准）。** 复用 TASK-004/005/006/007 和
> TASK-016/017，不重写 M1 Orchestrator。修改冻结的 QCD 聚合前必须先有明确 ADR。

## 目的

把付费协调器取得的 staging 媒体接回 M1 的 GenerationTask、媒体校验、
VideoAsset 登记和 FFmpeg 合成闭环，并让官方 QCD 聚合包含云端权威成本，消除
“预算已记账但报表漏报”的双口径。

## 输入

- TASK-020 已批准的镜头 task packets；
- TASK-016/017 的 paid outcome、reservation、外部 ref 和成本事件；
- TASK-004/005/006/007 的 provider binding、校验、资产登记、合成与 redo 合同；
- TASK-009/ADR-0003 的 append-only QCD 聚合合同。
- [Creation Workspace 数据可观察性要求](../creation_workspace_data_observability_requirements.md)
  中 run/attempt、artifact lineage 与 cost dimensions 的语义责任。

## 输出

- paid outcome 到现有 GenerationTask/validation/VideoAsset 的应用层 adapter；
- task packet/prompt version → operation → Provider/model/parameters → staging result →
  正式 VideoAsset 的可重建谱系；
- 单镜头恢复/重试命令：已提交任务只 poll/fetch，redo 必须新 task；
- 完成镜头按既有顺序进入 FFmpeg 合成，不创建第二套正式资产路径；
- `provider_cost_recorded` 纳入官方成本聚合、报表和去重测试；
- 成本可通过既有任务/镜头映射按阶段、步骤、镜头、Provider、模型和时间派生，
  不复制新的成本事实；
- 一份先行 ADR，授权并限定 TASK-009/ADR-0003 的聚合扩展。

## 修改范围

新增 WFM1 lifecycle adapter 与直接 CLI/测试；最小调用既有 orchestration、
validation、assets、composition；QCD 聚合只做 ADR 授权的云成本增量。

## 明确不做

- 不合并 PaidGenerationCoordinator 与 M1 ProviderOrchestrator；
- 不原地切换已绑定 Provider，不自动重提 ambiguous reservation；
- 不改变 `provider_cost_recorded` 固定 payload 或复制第二份成本事实；
- 不实现自动路由、跨主机锁、音频/字幕或真实发布平台。
- 不实现 Creation Workspace、Command Gateway、成本 dashboard 或 Action Center。

## 实施步骤

1. 先批准 QCD 聚合增量 ADR，锁定 manual/cloud 成本统一口径和去重规则。
2. 定义 paid outcome 到既有 task/manifest 的单向 adapter，不新增竞争写入者。
3. 将 staging 媒体交给 TASK-005 校验/导入/登记，再复用 TASK-006 合成。
4. 为 media pending、ambiguous、redo 和 already committed 提供明确恢复动作。
5. 扩展 TASK-009 聚合并验证账本、报表和事件重放得到相同结果。

## 测试要求

- fake paid provider 贯穿审批、预算、submit、fetch、校验、资产登记和合成；
- 崩溃点覆盖 submit 后、记账后、下载后、校验前后，均不重复付费/覆盖文件；
- provider binding 不可变，fallback/redo 的 task 与 operation 可追溯；
- manual 与 cloud 成本聚合、event_id 去重、原币和 JPY 派生一致；
- 从正式资产可反查 operation/task packet/prompt version，从输入可查全部输出；
- Manual/M1 最小闭环保持通过。

## 验收标准

- [ ] 付费镜头从 task packet 到正式 VideoAsset/成片只有一条权威路径；
- [ ] 任一恢复入口不会重复 submit、重复记账或静默覆盖；
- [ ] 官方 QCD 报表包含云端成本，并可追溯原币、FX 与派生 JPY；
- [ ] 谱系与成本筛选信息可由权威记录重建，不依赖 UI 索引；
- [ ] 冻结聚合只发生 ADR 授权的最小增量。
