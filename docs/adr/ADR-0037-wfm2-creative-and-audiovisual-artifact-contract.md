# ADR-0037: WFM2 完整创意与视听设计产物合同

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-034
- Implementation scope: TASK-034、TASK-037、TASK-039、TASK-040
- Depends on: TASK-023 WFM1 milestone gate passed
- Must preserve: ADR-0001、ADR-0007、ADR-0011、ADR-0012 和现有 stage identity
- Semantic I/O baseline: [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md)

## Context

WFM1 只实现 L0–S7 最小子集；WFM2 需要完整 L0、S1、S2 及正式 S3 输入，同时保留
Agent 生成候选、用户审核和不可变版本。完整创意/视听产物——结构化剧本、场景/镜头、
人物/场景/道具资产、图像/视频/配音/字幕产物——一旦缺少稳定身份、版本和谱系，
自由 Markdown 或媒体文件就会成为无法定位的孤立事实，UI 或下游步骤只能反向补造创意
关系。本 ADR 在以下既定约束之内裁决这些产物的**身份、版本、谱系合同层**（不含最终
schema、目录或 Provider 选型）：

- AGENTS.md 架构约束 8/9：核心工作流不依赖任何具体视频厂商；所有生成方法经
  `VideoProvider` 等 Provider 接口接入。本 ADR 不泛化 `VideoProvider`、不定义任何
  Provider；多媒体 Provider 抽象与 generation/asset/cost/recovery 属 ADR-0038。
- AGENTS.md 架构约束 11/12：每个步骤可独立执行、独立重跑，中断后可续跑，不重做
  已完成工作。
- AGENTS.md 架构约束 13：禁止静默覆盖用户文件和已有生成结果；覆盖前必须显式确认或
  采用带版本的新路径。
- ADR-0010 决策 3/4/6：唯一写入者不变，产物由 Orchestrator 应用边界内的授权组件
  写入；观察层是权威文件/事件的可重建 projection；反馈/命令至少绑定
  `ref + version + content_digest`。
- ADR-0030：WFM2 沿用 batch milestone review；TASK-034 是 owner，代码实施受
  ADR-0037 Accepted 与 TASK-023 gate 约束。
- 语义 I/O baseline（1.1/1.2/1.3）：输入必须绑定稳定 `ref + version +
  content_digest`；正式输出必须有稳定 ref、不可变 version、content digest、
  producing step 与精确输入引用；生成型输出还要引用 task/operation/provider/
  model/parameters；Provider 只返回结构化结果或 staging 媒体。

## Required Decision Properties

裁决须同时满足以下属性，缺一不可：

- **P1 Provider 中立**：核心创意/视听合同不绑定任何具体厂商；Provider 只产结构化
  结果或 staging，业务产物身份由授权写入者发布（约束 8/9）。
- **P2 步骤独立与续跑**：每个 L0/S1/S2/S3 步骤可单跑、可重跑；上游版本变化时旧执行
  记录保留、下游 readiness 失效，重执行产生新版本或新 operation，不原地覆盖（约束
  11/12）。
- **P3 防静默覆盖**：锁定产物不可变发布；任何覆盖须显式确认或带版本的新路径（约束
  13）。
- **P4 稳定身份/版本/谱系**：每个正式产物有稳定 ref、不可变 version、content
  digest、producing step、精确输入 refs、parent version；生成型产物追加
  task/operation/provider/model/parameters 引用。
- **P5 人工 Gate 与载荷贯穿**：Agent 只生成候选与定向修改建议，不能独自形成最终
  批准；锁定须人工完成；一主至多一次载荷贯穿剧本、视听设计、QC 与评价引用。
- **P6 WFM1 兼容与 baseline 完整**：不改既有 stage id，只扩展产物与完成条件；不删除
  语义 I/O baseline 的输入绑定、输出身份或人工 Gate；WFM1 legacy/minimal 产物以
  兼容方式暴露给 WFM2 查询层。

## Candidates

1. **文件名/目录约定即身份**：完整创意正文用自由 Markdown/媒体，靠文件名与目录扫描
   定位版本与谱系。落地最轻，但身份、版本、输入引用只能从命名或目录推断。
2. **结构化索引覆盖正文媒体**：正文可用 Markdown/媒体，但每个锁定产物由稳定
   `ref/version/content_digest` 的结构化 index 记录身份、parent、精确输入 refs、
   修改原因、Checklist 证据与人工批准；Provider 只产 staging，授权 Orchestrator/
   application 写入者发布正式身份。
3. **UI/DB 先行的单一权威 schema**：先由界面或数据库定义最终产物 schema 与状态，
   创意关系以 UI 状态机为准。表达力最强，但把最终 schema、DB 与 UI 状态提前锁死。

## Candidate Evaluation

对照 Required Decision Properties（P1–P6）评估。✅ 满足良好，△ 可满足但有代价，
⚠ 明显受限或违反基线。

| 属性 | P1 Provider 中立 | P2 独立/续跑 | P3 防覆盖 | P4 身份/版本/谱系 | P5 人工 Gate/载荷 | P6 WFM1 兼容/baseline |
|---|---|---|---|---|---|---|
| 文件名/目录即身份 | △ 合同不绑厂商，但生成型缺 task/operation 引用 | ⚠ 目录扫描猜输入，续跑无法定位精确版本 | ⚠ 同名易被静默覆盖 | ⚠ 无 digest/parent，谱系靠推断 | △ Gate 靠人工约定，无证据绑定 | ⚠ 文件名当身份，违反 baseline 1.2 |
| 结构化索引覆盖正文媒体 | ✅ Provider 只产 staging，身份由授权写入者发布 | ✅ 精确 ref/version 支撑独立执行与续跑 | ✅ 不可变发布 + 显式确认/新版本路径 | ✅ ref/version/digest/parent/输入 refs 齐备 | ✅ Agent 产候选，人工锁定，载荷可贯穿引用 | ✅ 只扩展产物/完成条件，可暴露 legacy/minimal |
| UI/DB 先行单一 schema | △ 合同不必绑厂商，但易被 UI 状态牵引 | △ 可满足但状态由 UI 驱动，续跑语义受耦合 | △ 依赖 DB 事务，姿态可行但越权 | ✅ schema 内可表达 | ⚠ 易由 UI 发明自动批准/状态机 | ⚠ 提前锁死最终 schema/DB，越出本 ADR 授权 |

## Proposed Decision（待独立审查后 Accept）

采用 **结构化索引覆盖正文媒体**：完整创意正文可用 Markdown/媒体，但每个锁定产物
必须有稳定 `ref/version/content_digest` 的结构化 index，并引用精确输入、前一版、
修改原因、Checklist 证据与人工批准。理由：唯一在 P1–P6 上均为 ✅ 的候选；既保留完整
创意/视听表达（Markdown/媒体正文），又让身份、版本、谱系落在结构化合同上，天然契合
Provider 中立、独立/续跑与防覆盖三条红线，并可无损扩展 WFM1 而不改 stage id。文件名/
目录方案违反 baseline 1.2 的身份要求；UI/DB 先行方案把最终 schema、DB 与 UI 状态提前
锁死，越出本 ADR 与 ADR-0010 的授权。

### Decided here（本 ADR 裁决，合同层）

- **产物身份（P4）**：每个正式/锁定产物具备稳定 ref、不可变 version、content
  digest、producing step 与精确输入 refs；生成型产物追加引用其
  task/operation/provider/model/parameters。自由 Markdown 或媒体文件不得脱离结构化
  身份、版本和谱系索引独立成为正式事实；文件名不得代替 `ref/version/digest`。
- **版本与不可变性（P3）**：锁定产物不可变发布；修改已批准产物须创建带 parent、
  修改原因与受影响引用的新版本，绝不原地覆盖；覆盖只经显式确认或带版本的新路径。
- **谱系与证据（P4/P5）**：每个锁定产物引用精确输入、前一版、修改原因、Checklist
  证据和人工批准；主载荷及创作目标贯穿剧本、视听设计、QC 与评价引用。
- **Provider 中立（P1）**：Provider 只返回结构化结果或 staging 媒体，正式业务身份由
  授权 Orchestrator/application 写入者发布。本 ADR 不泛化 `VideoProvider`、不定义任何
  Provider，多媒体 Provider 抽象由 ADR-0038 裁决。
- **人工 Gate（P5）**：Agent 可生成候选与定向修改建议，不能独自形成最终批准；每个
  stage lock（concept/screenplay/format/AV design/production）须人工批准，且不引入
  UI/Agent 专用状态机。
- **步骤独立与续跑（P2）**：完整 L0/S1/S2/S3 计划在步骤未运行时即可查询；上游版本
  变化时旧执行记录保留、下游 readiness 失效，重执行产生新版本或 operation。
- **WFM1 兼容（P6）**：WFM1 stage/step id 保持不变，WFM2 只扩展其产物与完成条件；
  WFM1 legacy/minimal 产物以兼容方式暴露给 WFM2 查询层。
- **baseline 绑定（P6）**：TASK-034 必须逐项把语义 I/O baseline 细化为 schema/owner/
  validator，不得删除或合并步骤、删除输入绑定、输出身份或人工 Gate。

### TASK-034 Must Decide（在上述合同层内细化，须对应 ADR 授权）

- L0/S1/S2/S3 完整产物 catalog、stage target 和最小结构化索引；
- 将语义 I/O baseline 细化为 schema、owner、validator 和 change-impact 规则；
- Agent-assisted、manual、CLI-validated 三种执行方式及审计边界；
- 三个代表镜头试制、主载荷 Checklist 和 change impact 的完成语义；
- WFM1 legacy/minimal 产物向 WFM2 查询层暴露的兼容方式。

### Not decided here（延期至 TASK-034 Accepted 设计或后续 ADR）

- 最终 JSON schema、字段名、物理目录与落盘路径——新路径、唯一写入者、原子发布和
  containment 必须在 Accept 前明确增补 ADR-0001/ADR-0012，不允许按需求文档中的逻辑
  文件名直接落盘；
- 具体 Python 类型、模块划分与唯一写入者实现；
- 数据库 / 物化 projection 存储结构；
- LLM 厂商、prompt 工程平台与自动创意批准；
- 图片/音频等多媒体 Provider 抽象、S2 probe 与 S4 generation/asset/cost/recovery
  （ADR-0038）、S5–S7 后期/QC/发布/复盘 schema（ADR-0039）；
- Workspace UI 布局与视觉样式。

## Security & Boundary Invariants（下游 TASK-034/037 必须遵守）

1. **Provider 中立**：核心创意/视听合同不绑定具体厂商；Provider 只产结构化结果或
   staging，正式身份由授权写入者发布；本 ADR 不定义 Provider。
2. **独立/续跑**：每步可单跑/重跑；上游版本变化旧记录保留、下游 readiness 失效，
   重执行产生新版本或 operation，不原地覆盖。
3. **防静默覆盖**：锁定产物不可变发布；覆盖须显式确认或带版本的新路径。
4. **身份绑定**：无 `ref/version/content_digest` 的自由 Markdown/媒体不得成为正式
   事实；步骤不得从日志、Agent 对话、临时 URL 或目录扫描猜测关键输入。
5. **人工 Gate 不可绕过**：Agent 不能独自形成最终批准；stage lock 须人工批准，不引入
   UI/Agent 专用状态机或自动创意批准。
6. **baseline 完整**：不删除、不合并、不改写 L0–S7 的输入绑定、输出身份或人工 Gate；
   既有 stage/step id 不变。
7. **授权边界**：新增物理路径、schema 或状态须先走 ADR-0001/ADR-0012 增补，不在本
   ADR 隐式授权；多媒体 Provider/后期 schema 分别等待 ADR-0038/0039。

## Consequences

- 复用文件式核心、CLI、审批/预算、防覆盖与恢复能力，无需为完整创意/视听流程新建
  执行层或 Provider 生命周期；
- 完整 L0/S1/S2/S3 计划在未运行时即可查询，谱系与版本可从权威 index 重建，供 WFM2
  查询层与未来 Workspace 观察；
- 裁决落在合同层（身份/版本/谱系），不锁死最终 schema/目录/DB/Python 类型，为
  TASK-034 Accepted 设计与 ADR-0001/0012 路径增补留出空间；
- 结构化索引引入额外的发布与校验责任，须承担不可变发布、digest 绑定与 change-impact
  失效传播的实现成本。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 裁决只落在合同层（产物身份/版本/谱系），未锁定最终 schema/字段/目录/Python
      类型/DB，未创建代码；
- [ ] Provider 中立成立：未泛化 `VideoProvider`、未定义 Provider，多媒体抽象留给
      ADR-0038；
- [ ] 每步独立/续跑与防静默覆盖姿态明确（不可变发布 + 显式确认/带版本新路径）；
- [ ] 每个正式产物的身份、版本、谱系、精确输入 refs 与人工批准证据绑定明确，文件名
      不代替 `ref/version/digest`；
- [ ] 与语义 I/O baseline 一致：未删除输入绑定、输出身份或人工 Gate，未改既有
      stage id，并说明 WFM1 legacy/minimal 兼容；
- [ ] 新路径/schema/状态明确须经 ADR-0001/0012 增补，未隐式授权落盘；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
