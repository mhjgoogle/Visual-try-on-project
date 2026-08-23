# TASK-020：WFM1 生产规划与镜头任务包

> **状态：Implemented。** 路径见 ADR-0012。实现：
> `src/ai_video_workflow/planning/`（brief/story/shot_plan/prompt 不可变
> 版本 + digest 锁定 task packet + P50/P90 预览），CLI `plan-compile`；
> 编译前置 `require_stage_ready(production_lock)`（未批准/stale 阻断），
> packet 可无损构造 TASK-016 GenerationSpec/PaidRequest（有对等测试）。

## 目的

为单集 60 秒短剧形成可校验的 brief、故事/剧本、资产主版本、镜头表和逐镜头
生成包，使 Provider 选择、报价、预算和生成参数都有明确、已审批的输入。

## 输入

- TASK-018 project profile 与不可变复用引用；
- TASK-019 已批准的阶段 targets；
- [Creation Workspace 数据可观察性要求](../../creation_workspace_data_observability_requirements.md)
  中 creative/prompt version 与 task packet identity 的语义责任；
- 现有 Scene/Shot、GenerationSpec、catalog quote 与 digest 能力。

## 输出

- L0-S3 最小结构化 index/manifest JSON 及 schema：brief、故事结构/剧本、
  资产主版本、shot plan；创意正文可继续采用工作流指定的 Markdown；
- 每镜头 task packet：prompt、duration、resolution、capability、model、引用资产、
  `first_frame_image` 解析结果、P50/P90 预估和输入 digest；
- 提示词版本关系：稳定 ref/version/digest、上一版引用、修改原因、参考资产和
  generation batch 输入标识；不把提示词覆盖成只有“最新值”；
- 从批准产物编译/校验 task packet 的 CLI；
- 6-10 镜头、总时长约 60 秒的示例数据和集成测试。

## 修改范围

新增 WFM1 planning/task-packet 应用模块、JSON schema/示例、CLI 和测试；只通过
适配层读取现有 Shot，冻结模型与 M1 bootstrap 不修改。

## 明确不做

- 不调用付费视频 API，不执行合成或发布；
- 不实现通用 LLM agent、提示词自动优化平台或图片生成管线；
- 不把任意本地路径/未审批 URL 直接透传为 `first_frame_image`；
- 不实现自动 Provider 路由，选择仍由项目/镜头配置决定。
- 不实现提示词比较 UI、实验系统、Action 或工作视窗 projection schema。

## 实施步骤

1. 定义最小产物 schema、stage target 和相互引用关系。
2. 从已审批内容生成 deterministic task packet，并锁定输入 digest。
3. 解析受信任的参考图/主版本为 Provider 参数，保持来源可审计。
4. 调用现有 selection/quote/estimate 生成 P50/P90 计划，不创建 reservation。
5. 增加示例集和重复编译、上游变化、缺资产等错误路径测试。

## 测试要求

- schema、引用完整性、镜头顺序、总时长与 6-10 镜头约束；
- 未审批/stale 输入、资产 digest 漂移、非法 provider 参数全部阻断；
- 同输入重复编译结果一致，不覆盖已有不同 digest 输出；
- 多版本提示词可追溯差异来源、参考资产和对应 task packet；
- task packet 可无损构造 TASK-016 的 `GenerationSpec` 和报价。

## 验收标准

- [ ] L0-S3 的 WFM1 最小子集均有明确、可读、可校验的落盘产物；
- [ ] 每个镜头可追溯到批准内容、资产版本、报价与生成参数；
- [ ] 提示词版本不可变且保留修改原因，为后续结果比较提供权威输入关系；
- [ ] 任务包不依赖具体厂商 schema，厂商参数仅在 adapter 边界解析；
- [ ] 未付费即可完成全套生产计划和预算预览。

## 修正记录（milestone review）

- `plan-compile` 只加载 production_lock 审批目标中锁定的确切
  `shot_plan_v<N>`（绝不 latest）；磁盘存在更新版本时阻断，要求重审批。
- packet 的 `input_digest` 纳入 FX 表与 fallback provider；复用改为
  全内容重算比较，不信任文件内存储的 digest。
- 新增 `verify_packet`：WFM1 付费入口 `paid-submit --packet-version <N>`
  必经 `require_stage_ready(production_lock)` + packet 重算校验后，
  由 packet 重建请求（`packet_to_paid_request`），拒绝任何自由参数。
