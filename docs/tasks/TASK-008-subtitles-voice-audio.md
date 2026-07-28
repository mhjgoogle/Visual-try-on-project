# TASK-008：字幕、配音与音频合成（阶段 5）

> **状态：规划定稿（PLANNED，Milestone 2）——待整体 Codex 设计
> 审查。** 本卡为合同级规格；实施前须按本卡产出一份聚焦设计文档
> （模型增补需独立审批，见「数据模型增补」）。

## 正式名称

Subtitle, Voice-over, and Audio Track Composition

## 业务目标

为成片挂载/烧录字幕（SRT），并把用户提供的配音与音效轨道混入
FFmpeg 合成流程，使最终 MP4 具备完整音画（implementation_plan
阶段 5）。

## 前置依赖

- TASK-006（`VideoComposer` 抽象与合成步骤）；
- TASK-005（`qcd` 模块、`MediaInspector`、digest 工具）；
- 产品级决策（见「产品级未决问题」）。

## 产品级未决问题（须用户裁决后实施）

1. 配音来源：第一版只接受**用户提供的音频文件**（与阶段 1 手工
   模式一致，推荐），还是接入 TTS API（付费 API，越出当前边界）？
   **规划假设：用户提供文件。**
2. 字幕来源：用户手工编写 SRT（推荐），还是从剧本数据生成？
   **规划假设：手工 SRT + 可选的从 Shot 描述生成 SRT 骨架。**
3. 字幕形态默认值：软字幕挂载（mov_text）还是烧录？
   **规划假设：默认软字幕，`--burn-in` 显式选项烧录。**

## 范围内

1. 数据模型增补（**独立审批项**）：`AudioAsset` 与
   `SubtitleAsset` 记录（对齐 VideoAsset 模式：登记制、版本化、
   shot 级或 project 级关联、`records/audio-assets/`、
   `records/subtitle-assets/`——需 ADR-0001 第三次增补）；
   `serialization.py` 注册表扩条目（冻结合同的显式变更，须在
   聚焦设计文档中逐字段定义并审批）；
2. 音频/字幕文件的校验与登记步骤（复用 `MediaInspector` 扩展音频
   probe；SRT 做结构校验）；
3. `composition` 扩展：混音（配音轨 + 音效轨 + 原视频音轨的显式
   增益配置）、字幕挂载/烧录，纳入 `CompositionProfile`；
4. StepManifest 断点续跑、版本化输出、报告扩展；
5. QCD：复用既有事件类型（`asset_imported`、
   `validation_completed`、`composition_completed`——payload 区分
   资产种类；不新增事件类型，如设计发现必须新增则走 ADR-0003
   修订）。

## 范围外

- TTS / 语音克隆 / 任何付费 API；
- 音频内容质量分析；
- 时间轴自动对齐（字幕时间由用户/输入文件给定）；
- 修改 TASK-005/006/007 既有合同（扩展点除外，见设计文档）。

## Production ownership

- 新增：`src/ai_video_workflow/audio/`（校验+登记）、
  `composition/` 内新增混音/字幕模块文件（不改既有文件的公开
  合同，新文件 + profile 扩展字段走设计审批）、对应 tests；
- 一次性授权修改：`models.py` / `serialization.py`（新增两模型，
  独立审批）、ADR-0001（第三次增补）。

## Public API（合同级草案）

`register_audio_asset(...)`、`register_subtitle_asset(...)`、
`CompositionProfile` 增加 `audio_mix: AudioMixSpec | None` 与
`subtitles: SubtitleSpec | None`、`run_composition_step` 签名不变。
精确签名由聚焦设计文档定案。

## Failure / recovery / security

与 TASK-005/006 同一模式：原子发布、防覆盖、版本化、manifest 五
条件跳过、路径 containment、subprocess 固定 argv。

## 测试与验收（合同级）

- 焦点测试：音频/SRT 校验规则、登记版本化、混音/字幕 argv 构造
  （打桩）、profile digest 变化触发新版本；
- 集成测试：假 composer 端到端（视频+配音+SRT → final_v2）、真实
  ffmpeg 冒烟（skipif）；
- 验收：字幕/配音/音效可经一条命令混入成片；模型增补经独立审批；
  未接入任何付费 API；全部测试与静态检查通过。

## 实施 Agent / 审查方式

Claude Code 实施；batch milestone mode——实施审查合并到
Milestone 2 回归门槛。

## 当前状态

Remaining roadmap design complete —
single Codex architecture review pending
（实施另需：产品级未决问题 1–3 用户裁决 + 模型增补独立审批）
