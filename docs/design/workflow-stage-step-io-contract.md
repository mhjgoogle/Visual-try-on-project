# L0–S7 工作层级输入输出合同

> **状态：Approved semantic contract baseline。** 本文补齐
> `ai_shortfilm_pipeline_workflow.md` 的阶段与步骤级逻辑输入输出，作为
> ADR-0037～0039/TASK-034～037 的设计输入。本文不授权物理目录、最终 JSON 字段、
> Provider 选型或冻结合同变更；这些决定仍须对应 ADR Accepted。

## 1. 合同边界

### 1.1 输入绑定

- 除用户首次输入的原始创意外，步骤输入必须绑定稳定 `ref + version +
  content_digest`，不能只写文件名或“最新版本”。
- 阶段锁定产物只有在人工批准且 digest 未漂移时，才可作为正式下游输入。
- 输入集合包括业务产物、约束、审批、预算/catalog 和上游运行结果；步骤不得从日志、
  Agent 对话、临时 URL 或目录扫描猜测关键输入。
- 上游版本变化时，旧执行记录保留，下游 readiness 失效；重新执行产生新版本或
  新 operation，不原地覆盖。

### 1.2 输出绑定

- 表中的输出名称是**逻辑产物类型**，不是未经授权的物理路径。
- 正式输出必须有稳定 ref、不可变 version、content digest、producing step，以及
  精确输入引用；生成型输出还要引用 task/operation/provider/model/parameters。
- 一个步骤可产生正文媒体和结构化 index/manifest；自由 Markdown 或媒体文件不能
  脱离结构化身份、版本和谱系索引独立成为正式事实。
- Provider 只返回结构化结果或 staging 媒体；业务输出仍由获授权的 application/
  Orchestrator 写入者发布。

### 1.3 执行与跳过

- `required`：阶段完成前必须产生通过校验的输出。
- `conditional`：只有项目 profile/上游锁定方案触发时才执行；未触发必须记录
  `not_applicable` 及依据，不能伪装为 completed。
- `optional-data`：允许外部数据尚不可得，但必须明确 `unavailable`，不能记为零。
- 表中“责任”描述创作/执行主体，不提前指定 Python 模块或物理路径的唯一写入者。
  最终 owner 由 ADR-0037～0039 接受时锁定。

## 2. 层级关系

| 层级 | 输入 | 输出 | 完成与下游关系 |
| --- | --- | --- | --- |
| Project | 用户创作目标、受众、约束、预算与交付目标 | versioned project profile/goals | profile 有效后才能创建 L0 工作实例 |
| L0 | project profile、原始灵感、预算/catalog 可用性 | approved concept lock | concept lock 是 S1 唯一正式创意入口 |
| S1 | approved concept lock、project goals | approved screenplay lock | screenplay lock 是 S2/S3 的叙事基线 |
| S2 | approved screenplay lock、concept lock、交付目标 | approved AV design lock | 代表镜头试制通过后才能进入正式生产设计/素材制造 |
| S3 | approved screenplay/AV locks、Provider/catalog/预算约束 | approved production lock | production lock 固定镜头、路线、模型、预算与验收方法 |
| S4 | approved production lock、受信资产、预算批准 | approved asset selection manifest | 所有 required 素材达到可剪辑状态后进入 S5 |
| S5 | approved assets、shot plan、format/AV locks | approved master candidate + final load review | 形成可进入完整 QC 的正式音画候选 |
| S6 | approved master candidate、目标、权利与交付约束 | approved release package/result | 无阻断 QC 且人工终审通过后发布或记录终止 |
| S7 | release/termination result、全链 QCD/评价/Action 事实 | postmortem、scorecards、reuse candidates/knowledge promotion | 复盘可重算，经验经用户确认后进入跨项目复用 |

## 3. Project 与 L0 合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| Project-Init | required | 用户表达目标、受众、叙事/风格目标、质量底线、预算/交付目标、禁止项、成功标准 | project profile/goals version | 用户定义；CLI 校验 | profile schema/引用/预算约束有效，形成不可变版本 |
| L0-01 灵感捕捉 | required | project goals；用户原始想法/意象/冲突 | idea card version | Agent 整理；用户确认 | 核心吸引点、人物/冲突线索和未知项可定位 |
| L0-02 强概念提炼 | required | current idea card；project goals | logline candidate set | Agent 生成候选；用户选择方向 | 候选互有区分，均说明主角、目标、阻力和独特机制 |
| L0-03 载荷声明 | required | idea card；logline candidates；project goals | load declaration version | Agent 分析；用户锁定 | 一项主载荷、至多一项次载荷，二者不得相同 |
| L0-04 短篇适配 | required | selected/shortlisted logline；load declaration；时长目标 | short-form test version | Agent 分析；用户判断 | 开场、升级、转折、余味完整，存在不可逆变化 |
| L0-05 可行性判断 | required | short-form test；候选概念；project budget；Provider/catalog 能力快照；资产/交付约束 | feasibility report；cost estimate/assumptions | application service 估算；用户裁决降复杂度 | P50/P90、主要风险和降级方案明确，P90 不越硬上限 |
| L0-06 概念试制 | required | shortlisted concept；load declaration；format assumptions；feasibility/cost；三个代表镜头定义 | concept probe plan；probe generation batches/assets；probe evaluation | Agent/Provider 产候选；Orchestrator 登记；用户评价 | 三类代表镜头有结果，至少一个方案通过内容、视觉和成本检查 |
| L0-07 创意定稿 | required | selected logline；load declaration；short-form test；feasibility；probe evaluation；未决项 | concept lock version；decision evidence | 用户最终批准 | 主/次载荷、logline、结尾、机制、允许的未决项均被 digest 锁定 |

## 4. S1 叙事设计合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| S1-T01 作品圣经 | required | approved concept lock；project goals | story bible version | Agent 起草；用户修订/确认 | 世界、人物、规则、主题和禁止项与 concept lock 一致 |
| S1-T02 节拍设计 | required | concept lock；story bible；时长目标 | beat sheet version | Agent 起草；用户判断 | 开场、升级、转折、结尾余味均有时间/叙事责任 |
| S1-T03 人物变化 | required | concept lock；story bible；beat sheet | character arc version | Agent 起草；用户判断 | 欲望、选择、代价和变化能由镜头行动表现 |
| S1-T04 剧本初稿 | required | story bible；beat sheet；character arc；project/format assumptions | screenplay version | Agent 起草；用户修订 | 时长和结构可执行，所有关键行为可映射至既定节拍 |
| S1-T05 主载荷审核 | required | screenplay version；load declaration；concept lock；project goals | load review version | Agent 辅助检查；用户结论 | 主载荷 Checklist 有逐项证据、问题和处置结论 |
| S1-T06 叙事风险审核 | required | screenplay version；story bible；beat sheet；character arc | narrative QC version | Agent 辅助检查；用户结论 | 逻辑、信息、公平性和说教风险均有结构化结论 |
| S1-T07 剧本锁定 | required | selected screenplay；load review；narrative QC；已解决 change requests | screenplay lock version；approval target | 用户最终批准 | 阻断问题关闭，锁定 screenplay 及全部依赖 digest |

## 5. S2 视听设计合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| S2-T01 格式锁定 | required | approved screenplay lock；project delivery/platform targets；预算/技术约束 | format lock version | application service 校验；用户批准 | 平台、画幅、分辨率、帧率、时长和交付约束明确 |
| S2-T02 视觉圣经 | required | concept lock；screenplay lock；load declaration；format lock | visual bible version | Agent 起草；用户锁定 | 风格、反例、色彩、材质和一致性规则可执行 |
| S2-T03 设计登记 | required | screenplay lock；visual bible；approved reusable asset refs | design registry version | Agent/用户设计；application service 登记 | 角色、服装、场景、道具均有稳定 ref 和版本策略 |
| S2-T04 摄影规则 | required | format lock；visual bible；design registry；load declaration | cinematography guide version | Agent 起草；用户锁定 | 构图、光线、镜头运动、连续性和禁用模式明确 |
| S2-T05 声音圣经 | required | screenplay lock；concept/load；format/delivery targets | audio bible version | Agent 起草；用户锁定 | 对白、旁白、音乐、环境声、音效和响度意图明确 |
| S2-T06 代表镜头试制 | required | format/visual/design/cinematography/audio versions；probe shot definitions；Provider/catalog/预算批准 | visual probe plan；generation batches/assets；probe QC/evaluation | Provider/外部工具产候选；Orchestrator 登记；用户选择 | 人物近景、中景、最难镜头均通过内容/一致性/成本门槛 |
| S2-T07 视听锁定 | required | selected bibles/guides/registry；probe results/QC；用户选择理由 | AV design lock version；approval target | 用户最终批准 | 视听规则、正式资产版本和允许偏差被 digest 锁定 |

## 6. S3 生产设计合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| S3-T01 镜头拆分 | required | approved screenplay lock；AV design lock；format lock | shot list version | Agent 起草；用户确认；CLI 校验 | 镜头顺序、时长、叙事责任和连续性引用完整 |
| S3-T02 镜头任务卡 | required | shot list；screenplay/AV refs；project goals | shot card versions | planning service 编译；用户检查 | 每镜头输入、prompt intent、验收标准和返工边界明确 |
| S3-T03 生产路线 | required | shot cards；feasibility；asset refs；Provider capability catalog | production route version | planning service 建议；用户批准 | 每镜头静帧/2.5D/i2v/t2v/人工路线及备用策略明确 |
| S3-T04 Provider 计划 | required | production route；locked provider/model catalog；凭据可用性；项目偏好 | provider plan version | registry/selection service；用户批准 | 主/备 Provider 与模型可用、可审计且不绑定错误厂商 schema |
| S3-T05 镜头预算 | required | shot cards；provider plan；locked prices/FX；project/episode/month limits | shot budget version；episode P50/P90 preview | budget service | 尝试次数、单镜/单集/月度额度和 fallback 影响均不过硬门槛 |
| S3-T06 生产预检 | required | shot list/cards；routes；provider plan；budgets；approved upstream digests | preflight report version | application service | 连续性、可生成性、输入版本、审批、Provider 和预算无阻断 |
| S3-T07 生产锁定 | required | shot list/cards；routes；provider plan；shot budget；passed preflight | production lock version；compiled task packets | 用户批准；planning service 编译 | 每镜头方法、输入、模型、预算、验收标准和 digest 全部锁定 |

## 7. S4 素材制造合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| S4-T01 参考资料登记 | required | production lock；approved external/reusable refs；来源/权利信息 | reference asset records/versions | 用户选择；asset service 校验登记 | 每项参考有来源、digest、适用范围和权利状态 |
| S4-T02 母资产生成 | required | design registry；visual bible；reference assets；approved generation spec/budget | master asset batches；candidate assets；selection decision | Provider/外部工具生成；Orchestrator 登记；用户选择 | required 角色/场景/道具各有通过 QC 的锁定版本 |
| S4-T03 关键帧生成 | required | shot cards；master assets；cinematography guide；reference assets；approved generation spec/budget | keyframe batches/assets；selection decision | Provider/外部工具生成；Orchestrator 登记；用户选择 | 生产路线要求的首/尾/关键帧齐备且与母资产一致 |
| S4-T04 对白与旁白 | conditional | screenplay/shot cards；audio bible；角色声音授权/参考；approved generation/import spec | dialogue/narration assets；transcript/timing refs | Audio Provider 或用户提供；asset service 登记；用户批准 | 有对白/旁白的镜头具备可剪辑、可追溯且权利明确的音频 |
| S4-T05 视频镜头生成 | required | task packet；prompt version；selected references/keyframes；provider plan；approval/budget/reservation | video operation/attempt records；candidate VideoAssets；cost facts | VideoProvider；协调器/Orchestrator 写事实；用户选择 | 每个 required 镜头至少一个正式、校验通过且成本已结算/对账的版本 |
| S4-T06 音乐/环境/音效 | conditional | audio bible；shot/timeline intent；rights constraints；approved generation/import spec/budget | music/ambience/SFX assets；cost/rights records | Audio Provider/用户提供；asset service 登记；用户批准 | profile/AV lock 要求的声音层齐备、可剪辑且权利明确 |
| S4-T07 代理与预览 | required | approved image/video/audio assets；format/proxy profile | proxy assets；preview manifest | media application service | 代理可播放、引用源 digest、可删除重建且不替代正式资产 |
| S4-T08 素材选择批准 | required | 全部 candidate batches/assets；project goals；shot acceptance/QC；成本事实 | asset selection manifest；approval targets；redo/change decisions | 用户最终选择；application service 记录 | required 素材均 selected/approved；未选结果、理由和返工关系保留 |

## 8. S5 装配后期合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| S5-T01 初始时间线 | required | approved asset selection；shot list；format lock；proxy profile | assembly timeline version；assembly preview | composition/edit service | 镜头、音频槽位、转场和源引用完整，可确定性重建 |
| S5-T02 粗剪 | required | assembly timeline；selected assets；project goals/screenplay | rough cut version；rough-cut decision/evaluation | 编辑工具/用户；application service 导入登记 | 故事可理解，缺口和返工对象有精确版本绑定 |
| S5-T03 精剪 | required | approved rough cut；feedback/decisions；selected source assets | fine cut version；edit decision list | 编辑工具/用户；application service 导入登记 | 节奏、情绪和镜头连续性达到锁定目标，历史版本保留 |
| S5-T04 混音 | required | fine-cut timeline；dialogue/music/SFX assets；audio bible；format target | audio mix version；mix manifest | audio/composition service + 用户检查 | required 声音层、增益/响度和源谱系完整，输出通过技术校验 |
| S5-T05 字幕/修复/调色 | required | fine cut；audio mix；screenplay/transcript；format/cinematography rules | subtitle asset/version 或 not_applicable decision；grade/repair record；master candidate version | media tools + 用户；application service 登记 | 有对白时字幕与音频同步；无字幕需求时依据可审计；画面/编码符合锁定格式 |
| S5-T06 主载荷终检 | required | master candidate；concept/load declaration；project goals；screenplay lock | final load review；creative decision | Agent 辅助；用户最终判断 | 主载荷有证据成立，阻断问题关闭或明确退回目标步骤 |

## 9. S6 质量与发布合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| S6-T01 叙事 QC | required | master candidate；screenplay/concept/project goals；final load review | narrative QC version | Agent/检查包辅助；用户结论 | 理解、节奏、信息和主载荷无阻断问题 |
| S6-T02 连续性 QC | required | master candidate；shot list；design registry；selected asset lineage | continuity QC version | application/Agent 辅助；用户结论 | 角色、场景、道具、动作和镜头连接问题均有证据/处置 |
| S6-T03 技术 QC | required | master candidate；format lock；audio/subtitle requirements | technical QC version | media inspector/application service | 音画、字幕、编码、分辨率、帧率和响度通过硬检查 |
| S6-T04 权利与来源 QC | required | master/media asset lineage；Provider/operation records；license/source declarations | rights QC version | application service 汇总；用户确认 | 所有正式媒体可追溯，未知权利或来源问题均阻断 |
| S6-T05 发布包 | required | approved master；passed QC set；delivery targets；title/cover/metadata versions | versioned platform package manifests/assets | release service | 每个平台包引用精确母版/元数据 digest，离线可检查且不覆盖 |
| S6-T06 发布结果 | required | approved release package；用户发布或终止决定 | release result manifest；external publication refs 或 termination reason | 用户执行/确认；release service 记录 | 成功、失败、延期或终止明确，外部引用不以临时 URL 作为唯一身份 |

## 10. S7 复盘归档合同

| Step | 执行 | 必需输入 | 逻辑输出 | 责任 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| S7-T01 QCD 复盘 | required | release/termination result；QCD events；operations；阶段审计；评价/Action facts | postmortem version | analytics service 派生；用户补充结论 | 时间、成本、返工、失败、未解决问题均可追溯并可重算 |
| S7-T02 Provider 表现 | required | generation attempts/costs；QC/evaluations；selection/redo/fallback decisions | provider/model scorecard version | analytics service 派生；用户解释 | 质量、稳定性、成本效率和样本范围明确，不跨币种错误相加 |
| S7-T03 观众数据 | optional-data | release result；明确统计窗口；可获得的平台/人工数据 | performance metrics snapshot 或 unavailable record | 用户导入；application service 校验 | 缺失与零分离，来源、范围、时间和局限明确 |
| S7-T04 复用候选 | required | postmortem；scorecard；performance；评价/实验/Action；正式资产/模板 | reuse candidate set | analytics/Agent 提议；用户审查 | 每项候选有来源 refs、适用条件、失败证据和推荐处置 |
| S7-T05 经验提升 | conditional | user-approved reuse candidate；当前知识/模板版本；冲突检查 | new reusable knowledge/template/checklist version；promotion decision | 用户批准；知识 application service 发布 | 产生新不可变版本并保留来源；不得自动改写既有项目或替代用户决定 |

## 11. 阶段 Gate 最小判定

| Gate | 必须验证 |
| --- | --- |
| L0 → S1 | concept lock approved；目标/载荷/可行性/probe refs digest 有效 |
| S1 → S2 | screenplay lock approved；load/narrative reviews 无阻断项 |
| S2 → S3 | format 与 AV design locks approved；三类代表镜头 probe 通过 |
| S3 → S4 | production lock approved；task packets、Provider/catalog、P50/P90 与预算预检有效 |
| S4 → S5 | asset selection approved；required 媒体齐备；付费 operation 已结算或进入显式 reconciliation |
| S5 → S6 | master candidate、mix/subtitle、final load review 通过并绑定当前输入 |
| S6 → S7 | narrative/continuity/technical/rights QC 无阻断；全部付费 operation 已结算或人工对账关闭；release result 或 termination decision 已记录 |
| Project complete | postmortem/scorecard/reuse candidates 已生成；optional performance 明确 available/unavailable；归档引用完整 |

## 12. ADR 与任务归属

| 合同范围 | 决策/实施 owner | 验收 owner |
| --- | --- | --- |
| Project、WFM1 stage identity 与最小规划 | TASK-018～020、ADR-0011/0012 | TASK-023 |
| L0、S1、S2、正式 S3 逻辑产物与完成条件 | ADR-0037 / TASK-034 | TASK-037 |
| S2 probe、S4 多媒体 generation/asset/cost/recovery | ADR-0038 / TASK-035、TASK-008 | TASK-037 |
| S5、S6、S7 正式后期/QC/发布/复盘 | ADR-0039 / TASK-036 | TASK-037 |
| Workspace 查询与完整计划展示 | ADR-0031 / TASK-024～027、TASK-039 | TASK-033（WFM1 baseline）、TASK-040（final） |

ADR-0037～0039 Accepted 时必须逐项确认本文没有无 owner、无输入身份、无输出身份、
无完成条件或无验收归属的步骤。若实现需要新增物理路径、schema 或状态，先走相应
ADR 增补，不在本文中隐式授权。
