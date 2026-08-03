# ADR-0039: WFM2 正式后期、QC、发布与复盘合同

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-036
- Implementation scope: TASK-008、TASK-036、TASK-037、TASK-039、TASK-040
- Depends on: ADR-0037、ADR-0038 Accepted
- Must preserve: ADR-0002、ADR-0003、ADR-0012、M1 composition 和 TASK-022 最小证据
- Semantic I/O baseline: [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md)
- 关联：创意/视听产物见 [ADR-0037](ADR-0037-wfm2-creative-and-audiovisual-artifact-contract.md)；
  多媒体 Provider/资产/成本见 [ADR-0038](ADR-0038-multimedia-provider-asset-and-cost-contract.md)（本 ADR 只引用编号，不重复定义）

## Context

TASK-022 只交付视频-only 的最小 QC/发布/复盘；WFM2 需要正式音画、代理、粗剪/
精剪、混音、字幕、调色、版权与连续性检查、平台包、发布结果和可复用经验。这些
产物跨越四类互相独立的事实：技术可测事实、主观创意判断、阶段审批、发布与观众
结果。若不在合同层先固定它们的**身份、版本、谱系、Gate**与责任域，实施阶段极易
出现第二事实来源（例如 QC 报告反过来改写母版）、以文件名代替稳定引用、静默覆盖
已生成母版，或把「缺失的观众数据」当成「零表现」。

本 ADR 在下述既定约束内，为 S5（装配后期）、S6（质量与发布）、S7（复盘归档）
裁决**合同层**的产物身份与边界规则，不选定最终 schema/字段/目录/类型/DB：

- AGENTS.md 11/12/13：每个步骤可独立执行、可断点续跑；禁止静默覆盖用户文件与
  已生成结果，覆盖前须显式确认或采用带版本的新路径。
- [ADR-0010](ADR-0010-creation-workspace-boundary.md) 决策 3/4/7：唯一写入者不变，
  QC/release/复盘产物是权威文件/事件的**派生可重建观察**，不得成为第二事实来源；
  技术、评价、审批、发布/Action 分属不同事实域，不得互相复用状态。
- [ADR-0030](ADR-0030-creation-workspace-delivery-governance.md)：分阶段交付与门槛；
  本 ADR 只做 WFM2 后期/QC/发布合同裁决，不提前定义 Workspace UI 或写能力。
- Semantic I/O baseline（Approved）：S5-T01～S7-T05 的输入绑定、输出身份、
  conditional/optional-data 语义与人工最终判断不得删除，只能被细化为获批 schema。

本 ADR 不重定义原 M1、不修改既有冻结合同；只在 Accepted 后授权 TASK-036/TASK-008
按获批增量实现，并按需增补 ADR-0001/ADR-0012 的路径与写入者。

## Required Decision Properties（P1–P7，本合同必须满足的红线）

以下属性是评估本 ADR 每条决策是否合格的判据；任何下游细化（schema/路径/服务）
都必须继续满足全部属性，✅ 表示满足良好，△ 表示可满足但需增补，⚠ 表示明显冲突。

| 属性 | 含义 | 约束来源 |
|---|---|---|
| P1 步骤独立可跑 | S5～S7 每步可单独运行、单独重跑，不要求整段流程连续在线 | AGENTS 11 |
| P2 断点续跑 | 中断后从已完成步骤之后继续，不重做已完成工作；StepManifest 幂等 | AGENTS 12 |
| P3 禁止静默覆盖 | 母版/QC/发布产物不原地覆盖；变更产生带版本新路径或显式确认 | AGENTS 13 |
| P4 派生可重建 | QC/发布/复盘/scorecard 是权威媒体/QCD/评价事实的派生观察，删除后可重算 | ADR-0010 决策 4 |
| P5 事实域分离 | 技术 QC／主观评价／阶段审批／发布结果／成本各有唯一写入者，不互相复用状态 | ADR-0010 决策 3/7 |
| P6 输入/输出身份 | 输入绑定 `ref+version+content_digest`；输出有稳定 ref、不可变 version、digest、producing step 与精确输入引用 | I/O baseline 1.1/1.2 |
| P7 人工 Gate 与缺失语义 | L0–S7 人工最终判断不可删除；conditional 记 `not_applicable`、optional-data 记 `unavailable`，缺失与「零」区分 | I/O baseline 1.3 |

## 事实域与责任（Decided here 的裁决对象）

本 ADR 只在合同层固定下列事实域的身份与唯一写入者角色，不指定 Python 模块或
物理路径（后者留待 Accepted 后增补 ADR-0001/0012）。

| 事实域 | 权威产物（逻辑类型） | 唯一写入者角色 | 关键属性 |
|---|---|---|---|
| 后期媒体 | assembly/rough/fine cut、audio mix、subtitle、grade/repair、master candidate | composition/edit/audio/media application service | P3 版本化、P6 源谱系、可确定性重建 |
| 技术 QC | narrative/continuity/technical/rights QC 结论 | 各 QC application/Agent 辅助 + 用户结论 | P4 从母版/谱系派生、P5 与评价/审批分离 |
| 阶段审批 | final load review、各 stage Gate 批准 | 用户最终判断，Orchestrator 记录 | P7 不可删除、P5 不复用 QC 状态 |
| 发布结果 | platform package manifest、release result、外部发布引用 | release service 记录用户执行/终止决定 | P6 引用精确母版/元数据 digest、外部引用非临时 URL |
| 复盘/学习 | postmortem、provider scorecard、performance snapshot、reuse candidate、knowledge promotion | analytics/knowledge application service 派生 + 用户结论 | P4 可重算、P5 只引用不复制成本/运行/评价 |

## Proposed Decision（待独立审查后 Accept）

### Decided here（本 ADR 裁决的合同层规则）

1. **后期媒体身份与版本（S5）**：assembly timeline、rough cut、fine cut、audio mix、
   subtitle、grade/repair record、master candidate 都是版本化正式产物，各有稳定 ref、
   不可变 version、content digest、producing step 与精确输入引用（P6）；新版本产生新
   路径，绝不原地覆盖已发布版本，历史版本保留（P3）。粗剪/精剪等中间产物不得被删除
   以「节省空间」，只可标记状态。
2. **外部人工精剪导入受控（S5-T02/T03/T05）**：外部编辑工具或剪辑软件的结果可作为
   受控步骤导入，但导入即登记为新不可变版本，须计算 digest、记录输入谱系与来源，并
   通过技术校验；导入不改写已有版本、不静默覆盖（P3/P6）。
3. **四类 QC 事实域分离（S6-T01～T04）**：narrative（主观理解/节奏）、continuity
   （连续性）、technical（音画/字幕/编码/响度硬检查）、rights（版权/来源/生成记录）
   是四个独立事实域，各有唯一写入者，互不复用状态（P5）；QC 结论从 master candidate
   与资产谱系派生，可在不改动母版的前提下重算（P4）。技术 QC 用硬检查，主观 QC 由
   Agent 辅助、用户结论，本 ADR 不引入自动主观质量评分。
4. **发布产物身份与谱系（S6-T05/T06）**：每个平台包引用精确母版与 title/cover/metadata
   的 digest，离线可检查、不覆盖已有包（P3/P6）；release result 明确区分成功/失败/延期/
   终止，外部发布引用不以临时 URL 作为唯一身份。发布包与 release result 只**引用**权威
   媒体/QCD/评价事实，不复制成本或运行历史（P4/P5）。
5. **复盘与学习为派生可重算（S7）**：postmortem、provider/model scorecard、reuse
   candidate、knowledge promotion 只引用权威 QCD/operation/评价/Action 事实，不复制成本
   或运行历史，删除后可从权威事实重算（P4/P5）。scorecard 不跨币种错误相加。
6. **观众数据缺失≠零（S7-T03，optional-data）**：performance 数据允许尚不可得，但必须
   记为 `unavailable` 并说明来源/范围/时间/局限，绝不记为「零表现」（P7）。
7. **人工 Gate 与 baseline 语义完整保留**：S5-T01～S7-T05 逐项保留 baseline 的输入绑定、
   输出身份、conditional/optional-data 语义与人工最终判断；主载荷终检、各 QC 结论、发布/
   终止决定、经验提升的最终判断只由用户确认，Agent/服务不得替代（P7）。conditional 步骤
   （如字幕 not_applicable、音乐层不适用）未触发时记 `not_applicable` 及依据。
8. **断点续跑与幂等（P1/P2）**：S5～S7 每步可单独运行、单独重跑；已完成步骤的输出经
   StepManifest/digest 判定为已完成即跳过，不重做；上游版本变化时旧执行记录保留、下游
   readiness 失效，重新执行产生新版本或新 operation，不原地覆盖。
9. **TASK-008 集成兼容（音频/字幕）**：TASK-008 的 AudioAsset/SubtitleAsset 登记与混音/
   字幕合成，作为 S5-T04（混音）/S5-T05（字幕）的受控输入接入现有 composition；音频/
   字幕产物遵守与 VideoAsset 同一的登记制、版本化、防覆盖与源谱系规则，产品级未决问题
   （配音来源、字幕来源、软/烧录默认）由 owner 任务在 Accepted 后依 TASK-008 假设裁决，
   本 ADR 只固定「登记化、版本化、可追溯、不静默覆盖」的合同约束。
10. **可重建观察，非第二事实源**：QC/发布/复盘产物供 Workspace 只读展示时，仍是权威
    文件/事件的派生 projection（ADR-0010 决策 4）；Workspace 不直接生成或修改这些产物，
    变更命令未来经 Command Gateway（本 ADR 不定义 Gateway）。

### Not decided here（延期至 TASK-036 Accepted 设计或后续 ADR 增补）

- S5～S7 各产物的**最终 JSON schema/字段名、物理目录路径、文件类型与命名**（须在
  Accepted 前增补 ADR-0001/ADR-0012 的路径与唯一写入者，不按逻辑文件名直接落盘）；
- QC 结论、scorecard、performance、reuse candidate 的具体存储结构与数据库/索引选型
  （projection 可采用索引/DB，但须可重建，不引入第二事实源）；
- 具体 QC 阈值集合、响度/编码硬检查参数与 continuity 检查算法；
- 商业发布平台 API、DaVinci 等剪辑软件自动化、观众数据供应商接入、自动主观质量评分；
- Workspace UI、Action、推荐模型的呈现与写路径（ADR-0031～0036/ADR-0040 范畴）。

## TASK-036 Must Decide（Accepted 后由 owner 任务细化）

- S4–S7 完整步骤、输入输出、可跳过条件与人工/自动边界；
- TASK-008 音频/字幕产物与现有 composition 的兼容方式与产品级未决问题裁决；
- narrative/continuity/technical/rights QC 和发布结果的责任域与 validator；
- scorecard、performance、reuse candidate 与 Workspace learning 的来源关系；
- 上述 Decided here 的合同规则细化为 schema、owner、validator、conditional/optional-data
  与 completion mapping，逐项对齐 semantic I/O baseline，不删除任何输入绑定、输出身份或
  人工 Gate；新增路径/schema/状态先走 ADR-0001/0012 增补。

## Contract Invariants（下游 TASK-036/TASK-008/TASK-037 必须遵守）

1. 每个正式后期/QC/发布产物有稳定 ref、不可变 version、content digest、producing step
   与精确输入引用；输入绑定 `ref+version+content_digest`，不用文件名或「最新版本」。
2. 禁止静默覆盖：母版、QC、发布包、复盘产物变更一律产生带版本新路径或显式确认，
   历史版本保留；原子发布、防覆盖沿用现有模式。
3. S5～S7 每步可独立运行与断点续跑；StepManifest 幂等，已完成即跳过，不重做。
4. 四类 QC／阶段审批／发布结果／成本／评价各有唯一写入者，互不复用状态；Provider 只
   返回结构化结果或 staging 媒体，业务事实由授权 application/Orchestrator 写入。
5. QC/发布/复盘/scorecard 是权威媒体/QCD/评价事实的派生观察，删除后可从权威事实重建，
   不成为第二事实来源；不复制成本或运行历史，只引用。
6. 人工最终判断（主载荷终检、QC 结论、发布/终止、经验提升）不可删除、不可自动化替代；
   conditional 记 `not_applicable`＋依据，optional-data 记 `unavailable`，缺失与「零」区分。
7. 外部精剪/编辑导入须版本化、计算 digest、保留输入谱系与来源，通过技术校验后方可作为
   下游正式输入；不改写已有版本。
8. 不以缺失的商业发布 API 或观众数据供应商阻塞 WFM2 离线验收。

## Consequences

- 复用 M1 composition、QCD、防覆盖、恢复与版本化能力，无需新执行层即可扩到正式音画；
- 四类 QC 与发布/复盘事实域清晰分离，Workspace 可在其上做只读观察而不制造第二事实源；
- 合同层固定身份/版本/谱系/Gate，但不锁死 schema/路径/DB，为 TASK-036 Accepted 设计与
  后续演进留出空间；
- 外部精剪与 TASK-008 音频/字幕以「登记化、版本化、防覆盖」方式接入，需承担 digest 与
  谱系登记成本；
- performance 明确区分 missing/zero、scorecard 不跨币种相加，复盘可重算但需权威事实齐备。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 决策只落在合同层（身份/版本/谱系/Gate/事实域），未选定最终 schema/字段/目录/类型/DB；
- [ ] S5-T01～S7-T05 的输入绑定、输出身份、conditional/optional-data 语义与人工最终判断
      全部保留，未删除任何 baseline 步骤或 Gate；
- [ ] 步骤独立可跑、断点续跑、禁止静默覆盖（P1/P2/P3）在合同规则与 Invariants 中明确；
- [ ] 四类 QC／审批／发布／成本／评价事实域分离，唯一写入者与派生可重建（P4/P5）明确；
- [ ] performance missing 与 zero 区分、scorecard 不跨币种相加、外部精剪导入版本化（P6/P7）明确；
- [ ] 与 ADR-0010 决策 3/4/7、ADR-0037/0038 与 semantic I/O baseline 一致，未越权定义
      Workspace UI/Gateway/Action，未提前泛化 VideoProvider；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
