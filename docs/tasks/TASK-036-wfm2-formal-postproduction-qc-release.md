# TASK-036：WFM2 正式后期、QC、发布与复盘

> **状态：Delivered（合同层，2026-08-04）。** ADR-0039 Accepted 后实施合同层
> 交付：`src/ai_video_workflow/postproduction/`（S5–S7 step catalog + 不可变、
> digest 绑定、跨面谱系的 artifact index）。ADR-0039 是合同层裁决（不定最终
> schema/service/DB），故本任务交付 catalog + index 契约执行体：唯一写入者事实域
> 分离（P5）、缺失≠零 status 语义（P7 not_applicable/unavailable）、跨面 input
> 绑定（postproduction/creative/media 解析 + external 声明）、身份/线性版本/防
> 覆盖/防篡改/body 绑定。QC/发布/复盘的具体 validator/service/CLI 与最终字段
> schema 属 ADR-0039「Not decided here」，留作 TASK-037 验收后按需细化，不在本合同
> 层展开。TASK-008 音画（S5-T04/T05）经 media/postproduction 跨面 input 接入。
> codex-review-loop 4 轮过审（0 blocking）；本地已提交。
>
> **Follow-up（跨切面，非本任务范围）：** content_digest 为自算、无外部锚定/签名——
> 与已 Accepted 的 creative/index.py、media/assets.py 及 QCD 日志同一约定。对「拥有
> 项目写权限的攻击者原地改写并重算 digest」不设防（该威胁已使整个本地工具失效）；
> 被引用的上游被改写会在下游 load 时经 digest 失配检出。若要 keyed/signed/锚定完整性
> 模型，应作跨切面 ADR 统一处理，不在 TASK-036 单独修。

## 目的

把 WFM1 视频-only 最小交付扩展为正式音画作品，完成 S4～S7 的代理、粗剪/精剪、
混音、字幕、调色、完整 QC、平台包、发布结果和结构化复盘。

## 输入

- TASK-008 音频/字幕登记与合成扩展；
- [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md) 中
  S5～S7 baseline；
- TASK-022 最小 QC/release/archive；TASK-034/035 正式设计和多媒体资产；
- ADR-0002/0003/0012、Proposed ADR-0039。

## 输出

- Accepted ADR-0039 及必要路径增补；
- 完整 S4～S7 step catalog、application services、CLI 和 manifests；
- S5-T01～S7-T05 的 input/output schema、owner、validator、conditional/
  optional-data 与 completion mapping；
- narrative/continuity/technical/rights QC 与用户终审证据；
- 正式母版、平台包、人工发布结果、scorecard/performance/reuse candidates；
- 防覆盖、外部精剪导入、重建和端到端测试。

## 修改范围

ADR-0039 授权的 post/QC/release/archive 增量、TASK-008 受控集成、测试与示例；
现有 composition/QCD/approval 通过公开合同复用。

## 明确不做

- 不自动上传商业平台、不要求付费剪辑软件；
- 不实现自动主观质量决定或删除中间产物；
- 不复制成本、运行或评价事实；
- 不实现 Workspace UI、Action 或推荐。

## 聚焦设计（S5～S7 正式后期/QC/发布/复盘合同）

本节是 TASK-036 对 ADR-0039 的聚焦设计产出，只定合同层身份/版本/谱系/Gate 与
事实域边界，不选具体 schema/字段/目录/类型/DB、不含代码。裁决结论见
[ADR-0039](../adr/ADR-0039-wfm2-postproduction-qc-release-contract.md)。

- **合同范围**：按 ADR-0039 覆盖 S5（装配后期）、S6（质量与发布）、S7（复盘归档）；
  逐项保留 semantic I/O baseline 中 S5-T01～S7-T05 的输入绑定、输出身份、
  conditional/optional-data 语义与人工最终判断，只细化为获批 schema，不删除。
- **后期媒体身份（S5）**：assembly/rough/fine cut、audio mix、subtitle、grade/repair、
  master candidate 均为版本化正式产物，各有稳定 ref、不可变 version、content digest、
  producing step 与精确输入引用；新版本产生新路径，不原地覆盖，历史版本保留。
- **外部精剪导入**：外部编辑/剪辑结果作为受控步骤导入即登记为新不可变版本，计算
  digest、记录输入谱系与来源、通过技术校验；不改写已有版本、不静默覆盖。
- **四类 QC 事实域（S6）**：narrative／continuity／technical／rights 各为独立事实域、
  各有唯一写入者、互不复用状态；结论从 master candidate 与资产谱系派生，可在不改动
  母版的前提下重算。技术 QC 用硬检查，主观 QC 由 Agent 辅助、用户结论，不引入自动
  主观评分。
- **发布产物（S6-T05/T06）**：平台包引用精确母版与元数据 digest、离线可检查、不覆盖；
  release result 区分成功/失败/延期/终止，外部引用非临时 URL；发布包/结果只引用权威
  媒体/QCD/评价事实，不复制成本或运行历史。
- **复盘与学习（S7）**：postmortem、scorecard、performance、reuse candidate、knowledge
  promotion 只引用权威 QCD/operation/评价/Action 事实，派生可重算、不复制；performance
  区分 `unavailable` 与「零表现」，scorecard 不跨币种相加；经验提升产生新不可变版本并
  保留来源，不自动改写既有项目或替代用户决定。
- **TASK-008 集成**：AudioAsset/SubtitleAsset 登记与混音/字幕合成作为 S5-T04/S5-T05
  受控输入接入现有 composition，遵守与 VideoAsset 同一的登记制、版本化、防覆盖与源
  谱系规则；产品级未决问题（配音来源、字幕来源、软/烧录默认）按 TASK-008 规划假设
  在 ADR-0039 Accepted 后裁决。
- **状态与缺失语义**：conditional 未触发记 `not_applicable`＋依据，optional-data
  记 `unavailable`，缺失与「零」区分，均不伪装为 completed。
- **守卫（须有测试固化）**：S5～S7 每步可独立运行、可断点续跑（StepManifest 幂等、
  已完成即跳过）；不静默覆盖母版/QC/发布/复盘产物；QC/发布/复盘为派生可重建观察，
  删除后可从权威事实重算，不成为第二事实来源；人工最终判断不可自动化替代。
- **边界**：本任务不选最终 schema/路径/DB，不定义 Workspace UI/Action/推荐，不泛化
  VideoProvider；新增路径/schema/状态先走 ADR-0001/0012 增补。

## 实施步骤

1. 决定完整 S4～S7 step/owner/skip/approval 并接受 ADR-0039。
2. 集成 TASK-008 音频字幕及多媒体资产，形成可验证正式母版。
3. 建立四类 QC、版权来源和平台包/发布结果合同。
4. 从权威 QCD/评价派生 scorecard、performance 和复用候选。
5. 覆盖外部精剪导入、重复执行、缺失可选数据和归档恢复。

## 测试要求

- 音画/字幕/编码/响度、连续性、来源和发布完整性；
- 外部编辑结果 digest、输入谱系、版本化和防覆盖；
- performance missing 与 zero 分离，复盘可重算；
- 最终判断只由用户确认；M1/WFM1 回归保持通过。

## 验收标准

- [ ] 工作流 S4～S7 完整任务均有可执行入口或明确人工步骤；
- [ ] 输出正式音画母版、完整 QC、平台包和发布结果；
- [ ] 复盘包含模型表现、返工原因和可复用候选；
- [ ] 所有事实域保持唯一写入者和可追溯引用；
- [ ] S5～S7 每一步均按 baseline 验证精确输入、输出、Gate 和缺失数据语义；
- [ ] 不以缺失的商业发布 API 阻塞 WFM2 离线验收。
