# TASK-022：WFM1 质检、发布包与归档收口

> **状态：Implemented。** 路径见 ADR-0012。实现：
> `src/ai_video_workflow/release/`（technical QC 事实派生 + 人工终审
> digest 绑定 + 发布包 manifest + 归档清单/复盘派生），CLI
> `qc-run/qc-review/package-release/archive-project`；stale 终审阻断发布，
> 复盘可由 QCD 事件重算，音频/字幕显式标 out-of-scope。

## 目的

在不引入发布平台集成和复杂音频生产的前提下，以 TASK-021 的视频素材完成
S4 素材就绪、S5 最小装配，并提供 S6 技术/人工 QC、发布包和 S7 项目复盘，
使一集产物可查看、可交付、可归档。

## 输入

- TASK-021 的正式镜头资产、成片、QCD 事件和阶段状态；
- TASK-005 视频检查、TASK-006 FFmpeg 输出和现有检查报告模式；
- 工作流文档 S4-S7 的最低要求。
- [Creation Workspace 数据可观察性要求](../creation_workspace_data_observability_requirements.md)
  中 QC/evaluation、creative decision、release/postmortem 的语义责任。

## 输出

- rough-cut/technical-QC/final-review 的 JSON 检查清单与审批 targets；
- 最小评价与创作决定证据：TASK-018 project goals 精确版本引用、用户结论、
  问题标签、选择/放弃原因、
  是否通过和被比较版本；AI 辅助意见只能标为辅助；
- 发布包 manifest：最终 MP4、元数据、封面/标题占位引用和内容 digest；
- 项目归档 manifest 与结构化复盘：质量、成本、周期、失败和复用建议；
- 独立 `qc`、`package`、`archive` CLI 与重复执行测试。

## 修改范围

新增 WFM1 QC/release/archive 应用模块、JSON schema、CLI、示例和测试；复用现有
inspection/composition/qcd 的公共读取接口，不改变其冻结模型。

## 明确不做

- 不上传 YouTube、TikTok 或其它外部平台；
- 不实现 TASK-008 的配音、音效、字幕管线，WFM1 最小验收允许视频-only；
- 不实现内容理解模型或主观质量自动打分；
- 不删除中间产物，不原地覆盖成片或发布包。
- 不实现实验比较 UI、Action Center、跨项目推荐或知识库 schema。

## 实施步骤

1. 定义 S4-S7 最小检查项、责任人动作和 stage target。
2. 复用 ffprobe/现有检查器生成技术 QC 事实，主观项保留人工结论。
3. 生成版本化发布包 manifest，并对所有交付文件记录 digest。
4. 从 QCD 和阶段记录派生复盘，不复制权威事件。
5. 实现归档前完整性检查和可重复执行的防覆盖策略。

## 测试要求

- 技术 QC 成功/失败、缺文件、digest 漂移和未批准终审；
- 发布包重复生成不覆盖，输入变化产生新版本或明确阻断；
- 归档 manifest 引用完整、相对 POSIX 路径且不逃逸项目根；
- QCD 复盘派生值可由原始事件重算。
- 评价和决定绑定具体 ref/version/content_digest，目标变化后旧结论不冒充当前结论；

## 验收标准

- [ ] S4-S7 的 WFM1 最小子集均有明确状态、输入、输出和人工守门点；
- [ ] 发布包可离线检查，最终 MP4 可播放且所有引用 digest 可验证；
- [ ] 归档不删除历史、不复制成本事实、不破坏 M1 输出；
- [ ] 复盘可追溯到运行、成本、评价和决定证据，最终判断由用户确认；
- [ ] 音频/字幕缺失被明确标为 WFM1 范围外，而非伪装完成。

## 修正记录（milestone review）

- technical QC schema v1→v2：`final_output` 改为 `{ref, content_digest}`，
  新增 `final_media_playable`（非空 + inspector 探测）检查；发布时校验
  QC/终审/final/profile 四者的精确 digest 对应，任一漂移阻断。
- 旧 v1 QC 文档不迁移：`package-release` 明确拒绝并要求重跑 `qc-run`
  生成 v2 文档（重跑幂等、按版本追加，无覆盖）。
- 归档清单逐文件 containment 校验并显式拒绝 symlink。
- 详见 ADR-0012「Schema 演进记录」。
