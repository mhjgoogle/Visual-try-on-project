# TASK-023：WFM1 端到端验收与文档收口

> **状态：Implemented。** 交付：`tests/test_wfm1_e2e.py`（离线全链路 +
> 故障恢复矩阵〔审批过期/预算拒绝/submit 二义/下载失败/中断续跑〕+
> 双项目复用与月度在途口径 + 只读 projection 确定性重建）、
> `examples/projects/wfm1-demo/`（8 镜头 ×6s ≈48s 示例 + runbook，
> 含可选 MiniMax 冒烟说明）。已知限制：product spec /
> architecture / implementation plan 的状态行因与并行 Workspace
> 批次未提交改动重叠，本任务不改动这些文件；状态以任务卡为准。

## 目的

用一个角色、一个场景、一个地点、6-10 镜头、约 60 秒的项目证明 WFM1 从
project profile 到可播放 MP4、发布包和复盘可重复运行，且审批、预算、成本、
恢复和复用边界均由真实协调链测试支撑。

## 输入

- TASK-014 至 TASK-022 的已验收产物与合同；
- 工作流文档 §10 的 WFM1 目标和 ≤1200 JPY 预算；
- [Creation Workspace 数据可观察性要求](../creation_workspace_data_observability_requirements.md)
  的完整只读查询与失败规则；
- M1 minimal project、fake paid provider 和可选 MiniMax opt-in 环境。

## 输出

- `examples/` 下完整但不含大媒体/凭据的 WFM1 示例项目；
- 默认离线 E2E 测试与故障恢复矩阵；
- 可选真实 MiniMax 冒烟 runbook，必须显式预算/凭据/人工确认；
- 一项只读 projection readiness 验证：仅从权威文件/事件重建项目计划、进度、
  WFM1 已支持产物的谱系、成本、评价和最近问题，不创建工作视窗代码；
- product spec、architecture、implementation plan、workflow 和任务状态的最终对齐。

## 修改范围

示例、E2E 测试、测试夹具、运行说明和正式文档状态；只允许为暴露出的缺陷做
其归属任务内的最小修正，不在本卡扩展新 schema 或架构。

## 明确不做

- 不把真实付费 API 作为 CI 或 WFM1 验收的必要条件；
- 不新增 Provider、自动路由、音频/字幕、发布平台或 WFM2 功能；
- 不实现 Creation Workspace、Command Gateway、Action Center、数据库或 UI schema；
- 不以 mock 纯函数测试替代真实应用协调链；
- 不删除历史 M1 任务、roadmap、ADR 或示例。

## 实施步骤

1. 固定验收项目、预算、镜头数、总时长和预期产物清单。
2. 离线贯穿 L0-S7、paid fake、M1 校验/合成、QCD 和归档。
3. 注入审批过期、预算拒绝、submit 二义、下载失败和中途退出并验证恢复。
4. 用第二项目复用同一资产版本，验证 digest 锁和月度在途 hold 口径。
5. 完成 milestone review，按实际结果更新文档状态和已知限制。

## 测试要求

- 真实 CLI/driver 协调链，不只测试纯函数；
- 未审批零调用、超预算零调用、ambiguous 零重提、成本事件恰好一次；
- 中断后从第一个未完成步骤继续，正式输出无静默覆盖；
- 单镜头、单集、跨项目月度预算和原币/JPY 审计一致；
- 删除任何测试 projection/cache 后可从权威数据逐字节确定性重建；
- 全量 pytest、ruff、文档链接/路径/编号检查。

## 验收标准

- [ ] 单集约 60 秒、6-10 镜头，输出可播放最终 MP4 和发布包；
- [ ] 全阶段有显式状态、审批证据、输入/输出和恢复路径；
- [ ] 计划成本和实际派生成本均不超过 1200 JPY；
- [ ] 项目实例与复用资产边界有双项目证据；
- [ ] 核心数据足以支撑未来只读观察，但未引入第二事实来源或 UI 专用状态；
- [ ] 图片/音频/字幕/Action 等 WFM1 范围外数据明确 unavailable，不伪造、不扩 scope；
- [ ] M1 保持完成，WFM1 文档状态与代码/测试证据一致。
