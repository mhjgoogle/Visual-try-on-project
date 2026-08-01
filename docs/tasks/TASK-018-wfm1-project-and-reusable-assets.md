# TASK-018：WFM1 项目实例与复用资产边界

> **状态：Implemented。** 先行目录/所有权 ADR 见
> [ADR-0011](../adr/ADR-0011-project-profile-and-reuse-pack-paths.md)。
> 实现：`src/ai_video_workflow/profile/`（project_profile + reuse），CLI
> `profile-init` / `reuse-publish` / `reuse-add-ref` / `reuse-verify`；
> 账户根规则与月度预算守门零改动（reuse/ 无 config/wfm1.json，项目发现
> 自然跳过，有回归测试）。

## 目的

把“一集一次的项目实例”与“可跨项目复用的工作流/资产版本”分开，建立 WFM1
运行参数、复用引用和内容 digest 的最小合同，同时保留 ADR-0001 的现有项目目录。

## 输入

- `ai_shortfilm_pipeline_workflow.md` §1、§8 和 ADR-0007；
- [Creation Workspace 数据可观察性要求](../creation_workspace_data_observability_requirements.md)
  中 Project / reusable asset identity 的语义责任；
- ADR-0001 的项目根、资产目录、containment 与防覆盖合同；
- 现有项目配置、asset index、digest 与原子写入能力。

## 输出

- 项目实例 profile JSON：题材、受众、时长、画幅、语言、风格、发布目标和预算引用，
  以及表达意图、叙事/情绪目标、质量底线、禁止问题和项目成功标准；
- 项目内复用引用 JSON：`asset_id + version + content_digest`，不复制可变“最新版本”；
- 账户级只读复用包的最小布局、版本与发布规则；
- 稳定的 project/asset ref、来源和版本关系，使未来只读 projection 无需按文件名
  猜测项目与复用资产边界；
- profile/reuse-ref 的校验、初始化/导入 CLI 与测试；
- 一份先行 ADR，明确账户根、物理路径、所有权、containment 和迁移规则。
  **既有合同约束**：账户根规则已由 TASK-014 合同 4 与 ADR-0001 WFM1 增补
  定为规范（账户根 = 项目根父目录，直接子目录含 `config/wfm1.json` 者为
  项目），且已被月度预算实现依赖（`budget/account.py` 的项目发现、
  `read_account_month_spent`/`account_outstanding_holds`、账户级预算锁
  `.wfm1-budget.lock`）。本任务的 ADR 只能**显式增补或取代**该规则，不得
  静默另立；任何改动必须保持上述已实施的月度守门语义与测试继续成立。

## 修改范围

新增独立的 WFM1 profile/reuse 模块、对应 CLI/测试/示例，以及经 ADR 授权的
增量目录；现有 M1 Project、Shot、VideoAsset 和 asset index 仅只读复用。

## 明确不做

- 不把概念性的 `workflow/` 直接变成项目内强制目录；
- 不迁移或改写现有项目，不把跨项目绝对路径写入项目文件；
- 不实现素材生成、阶段审批、自动选材或远程资产库；
- 不修改冻结领域模型来承载 WFM1 profile。
- 不实现 Creation Workspace、跨项目 dashboard、推荐系统或 UI 专用数据库/schema。

## 实施步骤

1. 先提交并批准目录/归属 ADR，再实现任何新物理路径。
2. 定义封闭 JSON schema 和 canonical digest 规则。
3. 实现 profile 初始化、复用包发布和项目引用解析，默认禁止覆盖。
4. 对引用缺失、版本漂移、digest 漂移和路径逃逸全部 fail-closed。
5. 增加最小示例：一个角色、一个场景、一个道具或风格资产的跨项目复用。

## 测试要求

- schema、版本、digest、containment 和原子写入；
- 两项目引用同一不可变版本，更新复用包不静默改变旧项目；
- 重复初始化/发布不覆盖，损坏或缺失引用有明确错误；
- 原 M1 项目无需 profile 仍可运行。

## 验收标准

- [ ] 项目实例与复用资产具有不同所有权和生命周期；
- [ ] project goals 有版本和 digest，可作为后续评价的精确基准；
- [ ] 引用被版本和 digest 锁定，可审计且无路径逃逸；
- [ ] 权威 JSON 足以派生项目清单及复用来源，不依赖界面缓存；
- [ ] 未改写 ADR-0001 既有目录，新增目录有明确 ADR 授权；
- [ ] JSON only，M1 回归、全量测试和静态检查通过。
