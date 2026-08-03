# ADR-0038: 多媒体 Provider、资产谱系与统一成本边界

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-035
- Implementation scope: TASK-008、TASK-035～040
- Depends on: ADR-0037 Accepted
- Must preserve: VideoProvider、ADR-0003/0008、现有预算 reservation、QCD 和 M1 资产合同
- Semantic I/O baseline: [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md)

## Context

最终短剧流程需要参考图、生成图片、关键帧、视频、对白、音乐、音效和字幕。现有可靠
付费合同只覆盖视频链（ADR-0006 窄授权解除 + ADR-0008 权威成本事实 + ADR-0009
MiniMax 厂商契约），图像与生成式音频尚无正式生产路径。若直接把 `VideoProvider`
泛化去迁就未验证的图像/音频抽象，会破坏 AGENTS.md 规则 9 与 Must preserve 的冻结
边界；若让每种媒体各自新建 Provider、资产路径与成本账本，又会产生第二事实来源，
破坏 ADR-0008 的统一资金安全链和 Workspace（ADR-0010 决策 4）对可重建统一
成本/谱系的要求。

本 ADR 在以下既定约束内，只在**合同层**裁决多媒体的 **Provider 中立抽象方向、
资产身份维度与成本记录维度**，不选定任何接口签名、资产路径、schema、字段、目录、
类型或数据库：

- **AGENTS.md 规则 8/9**：核心工作流不能依赖任何具体多媒体厂商；所有生成方法
  （手工、云 API、本地模型）必须经统一 Provider 接口接入。
- **AGENTS.md 规则 10 与 ADR-0006/0009**：付费 API 只能在 Accepted ADR 明确批准的
  窄范围内接入。当前 Accepted 的付费授权仅覆盖视频链（ADR-0006 逐字锁定 TASK-010
  历史线、由 ADR-0008/0009 延续；ADR-0009 仅授权 MiniMax 视频端点与
  `WFM1_MINIMAX_API_KEY` 一个凭据）。**图像/音频付费调用不在现有授权范围内**，
  必须待本 ADR Accepted 且在其明确批准的窄范围内方可实现。
- **AGENTS.md 规则 3（架构约束尾段）**：图片/音频等多媒体 Provider 抽象必须等待本
  ADR Accepted，不得提前泛化 `VideoProvider`。
- **ADR-0037（Proposed）**：正式创意/视听产物的 ref/version/digest 身份、精确输入
  引用、前一版、修改原因与人工批准由 ADR-0037 裁决；本 ADR 只把多媒体二进制产物
  与生成 operation 的身份/谱系对齐到该合同，不重复定义创意产物身份。
- **ADR-0010 决策 3/4** 与 **ADR-0001/0003/0008**：Provider 不写业务事实；观察层
  须可从权威文件/事件重建；成本用整数最小货币单位 + ISO-4217，禁止浮点货币。

本 ADR 未 Accepted 前，不得实现任何多媒体 Provider、资产路径或付费调用（TASK-035
状态卡原文）。

## Candidates

在「核心保持 Provider 中立、VideoProvider 冻结合同不破坏、跨媒体统一成本/谱系」
三重约束下，比较三条抽象路径：

1. **独立媒体 Provider 接口族**：为图像、音频各自新建独立接口，与 `VideoProvider`
   平行；每个接口自带其谱系与成本约定。
2. **泛化统一 `GenerationProvider`**：把现有 `VideoProvider` 上提为通用媒体生成
   协议，各媒体作为其实现。
3. **capability 声明的媒体 Provider registry + 统一成本/谱系合同层**：`VideoProvider`
   原样保留、不泛化；新增按声明 capability 接入的媒体 Provider registry，各媒体
   独立 adapter，但共享同一套资产身份、谱系与资金安全合同层。

## Required Decision Properties

- **P1 核心 Provider 中立**：核心工作流不依赖任何具体图像/音频厂商，所有生成方法
  经统一 Provider 接口接入（AGENTS.md 8/9）。
- **P2 VideoProvider 冻结合同不破坏**：不修改、不泛化现有 `VideoProvider` 去迁就
  未验证抽象（Must preserve、AGENTS.md 3.9）。
- **P3 资产身份与双向谱系**：正式媒体产物有稳定 ref/version/digest 身份，可双向
  追溯输入版本、Provider、模型、参数与 producer operation，并对齐 ADR-0037。
- **P4 统一资金安全**：quote/estimate/reservation/actual/FX/JPY 分离，预算守门，
  成本恰好一次，不新建第二账本（ADR-0003/0008）。
- **P5 付费边界与凭据纪律**：付费仅在 Accepted ADR 窄范围内；凭据 env-only、
  registry allowlist 且未知能力 fail-closed、打桩默认、真实付费调用显式 opt-in
  （ADR-0006/0009、AGENTS.md 23）。
- **P6 唯一写入者 / 恢复 / 防覆盖**：Provider 不写业务事实，断点续跑，候选批次
  全部结果保留、选择不删未选、防覆盖（ADR-0010 决策 3、ADR-0001）。

## Candidate Evaluation

对照 P1–P6 评估。✅ 满足良好，△ 可满足但有代价，⚠ 明显受限。

| 属性 | P1 核心中立 | P2 VideoProvider 冻结 | P3 资产身份/双向谱系 | P4 统一资金安全 | P5 付费边界/凭据 | P6 唯一写入者/恢复 |
|---|---|---|---|---|---|---|
| 1 独立接口族 | ✅ 各媒体经独立接口接入 | ✅ 不触碰 VideoProvider | △ 谱系约定分散各接口，跨媒体追溯不统一，易碎片化 | △ 资金链在各接口重复挂接，易退化为"各媒体另建账本" | ✅ 可各自 env-only/fail-closed | ✅ Provider 不写业务事实 |
| 2 泛化 GenerationProvider | ✅ | ⚠ 直接改冻结合同、把未验证抽象强加于已上线视频链，违反 Must preserve 与 AGENTS.md 3.9 | △ 统一但以破坏冻结边界为代价 | △ | △ | ⚠ 迁就未验证抽象，视频链回归风险大 |
| 3 capability registry + 统一合同层 | ✅ 各媒体按声明 capability 接入 registry，核心中立 | ✅ VideoProvider 原样保留，媒体 Provider 平行新增、不泛化 | ✅ 统一资产身份/谱系合同层，跨媒体一致追溯并对齐 ADR-0037 | ✅ 统一复用现有资金安全链，不新建账本 | ✅ registry 未知能力 fail-closed + 凭据 allowlist | ✅ Provider 不写业务事实，合同层保证候选保留/防覆盖 |

## Proposed Decision（待独立审查后 Accept）

采用 **候选 3：capability 声明的媒体 Provider registry + 统一成本/谱系合同层**。
理由：唯一在全部 P1–P6 上均为 ✅ 的候选。它把「新媒体接入」与「统一成本/谱系」
解耦——各媒体经声明 capability 的 registry 平行接入（P1），`VideoProvider` 冻结
合同原样保留、不被未验证抽象污染（P2），而资产身份、谱系与资金安全统一在一个
合同层上，避免碎片化账本（P3/P4）。候选 1 的统一目标只能靠各接口自觉、碎片风险
高；候选 2 以破坏冻结视频链为代价换统一，违反 Must preserve 与 AGENTS.md 3.9。

本裁决只落在**合同层维度**，不锁定任何接口签名、资产路径、schema、字段、目录、
类型或数据库（见「Not decided here」）。

### Decided here（本 ADR 合同层裁决）

- **Provider 中立抽象方向（P1/P2）**：图像、音频等新媒体经**声明 capability 的
  媒体 Provider registry** 平行接入；`VideoProvider` 冻结合同**原样保留、不泛化**。
  是否为独立 Image/Audio Provider、受控通用协议或二者组合，须先以 capability 与
  副作用语义在 TASK-035 Accepted 设计中评估，不得为迁就未验证抽象改动
  `VideoProvider`。registry 对未知能力 **fail-closed**。
- **资产身份维度（P3）**：所有正式媒体版本必须具有稳定 **ref / version / digest**
  身份、**producer operation** 引用、**输入 refs**、候选 **batch**、**选择关系**
  与**消费者**关系；须可从此身份**双向追溯**输入版本、Provider、模型、参数与
  operation，并与 ADR-0037 的产物身份合同对齐（临时/签名 URL 不得作为唯一产物
  身份）。Provider 仍**不写业务事实**。
- **成本记录维度（P4）**：付费媒体的 **quote / estimate / reservation / actual /
  FX / JPY 派生**继续按 ADR-0003/0008 **分离**，复用或显式兼容现有资金安全链；
  预算拒绝对应**零调用**，成本记账**恰好一次**，ambiguous 结果**不自动重提**、
  进入需人工对账；跨媒体不得新建第二成本账本。金额用整数最小货币单位 + ISO-4217。
- **失败/重试/谱系可审计（P3/P6）**：失败、重试、redo、fallback 与 ambiguous 对
  所有付费媒体保持可审计；候选批次**全部结果保留**，选择**不删除未选结果**。
- **付费边界纪律（P5）**：图像/音频付费实现**只能在本 ADR Accepted 且其明确批准
  的窄范围内进行**，并须在 ADR-0006/0009 既有付费授权框架内（凭据 env-only、
  registry credential allowlist、真实付费调用显式 opt-in、默认回归全打桩、
  凭据永不入库/入日志）。本 ADR 未 Accepted 前不得实现任何媒体 Provider、资产
  路径或付费调用。
- **staging / collect 边界（P1/P6）**：外部工具产物、人工导入、云 API 与本地图片
  模型必须收敛到**统一的 staging/collect 语义**（路径 containment、原子防覆盖
  发布），不得因媒体来源不同而各自绕过。

### Not decided here（延期至 TASK-035 Accepted 设计或后续 ADR）

- 具体 Provider 接口签名、方法集、类型与是否独立/通用/组合的最终选型；
- 具体资产路径、目录布局、命名规则、asset/batch/selection 的最终 schema 与字段；
- 具体成本记录 schema、字段、事件形态与任何持久化 / 数据库 / catalog 结构；
- 具体图片 / TTS / 音乐厂商、模型选型、自动路由权重、对象存储与远程资产库；
- 新资产/记录路径的 owner、credential env 变量命名 allowlist 与恢复语义的精确
  定义——必要时在 Accepted 前增补 ADR-0001/0003/0008，不得按逻辑文件名直接落盘。

## TASK-035 Must Decide

- Provider 接口候选及为何不改变 `VideoProvider`；
- image/audio/subtitle asset 与 generation batch 的最小共同语义；
- S2 probe、S4-T01～T08 每一步的 schema、唯一写入者、校验与 completion mapping；
- 跨媒体预算、catalog、reservation 与成本事件的兼容策略；
- 外部工具、人工导入、云 API 与本地图片模型的统一 staging/collect 边界。

## Security & Boundary Invariants（下游 035/008/039/040 必须遵守）

1. 核心保持 Provider 中立：所有多媒体生成方法经统一 Provider 接口接入，核心不
   依赖任何具体厂商（AGENTS.md 8/9）。
2. `VideoProvider` 冻结合同不被修改或泛化；新媒体平行接入，不迁就未验证抽象。
3. Provider 不写业务事实；正式产物身份、谱系与成本由 orchestrator 应用边界内的
   指定写入者记录（ADR-0010 决策 3）。
4. 付费实现只在本 ADR Accepted 且窄授权范围内进行，并遵守 ADR-0006/0009 的凭据
   纪律：env-only、registry allowlist 且未知能力 fail-closed、真实调用 opt-in、
   默认回归全打桩、凭据永不入库/入日志/入异常。
5. 预算拒绝零调用；成本恰好一次；ambiguous 不自动重提，进入需人工对账。
6. 候选批次全部结果保留，选择不删除未选结果；正式产物路径做 containment 与原子
   防覆盖发布；临时/签名 URL 不作为唯一产物身份。
7. 观察层所需候选/选中/消费者事实可从权威记录**重建**，不得成为第二事实来源
   （ADR-0010 决策 4）。

## Consequences

- 复用文件式核心、`VideoProvider`、现有付费协调链、预算/QCD、恢复与防覆盖能力，
  无需新执行层，也无需破坏冻结视频合同即可接入图像/音频；
- 统一资产身份与成本合同层先落地，具体接口/路径/schema/厂商留待 TASK-035
  Accepted 设计与后续 ADR，为演进留出空间；
- 引入新的外部付费依赖面（图像/音频），由 env-only 凭据、registry allowlist、
  打桩默认与 opt-in 冒烟约束风险；
- 若后续证明需要通用协议，仍须以 capability/副作用语义先行验证，不得回头以泛化
  破坏已上线视频链。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 裁决只落在合同层维度（Provider 中立抽象方向、资产身份维度、成本记录维度），
      未选定接口签名/资产路径/schema/字段/目录/类型/DB，未创建任何代码；
- [ ] 与 AGENTS.md 8/9/10、ADR-0006/0009 窄付费授权、ADR-0010 决策 3/4、
      ADR-0003/0008 成本模型及 ADR-0037 产物身份一致；
- [ ] `VideoProvider` 冻结合同未被泛化或修改，新媒体为平行接入；
- [ ] 图像/音频付费实现明确声明须待本 ADR Accepted 且在窄授权范围内，未提前实现
      任何 Provider、资产路径或付费调用；
- [ ] 统一资金安全（分离、零调用拒绝、恰好一次、ambiguous 不自动重提）与谱系
      可审计（候选保留、不删未选、双向追溯）在合同层明确；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Not Decided Here

具体图片/TTS/音乐厂商、模型选型、自动路由权重、对象存储和远程资产库；接口签名、
资产路径、schema/字段/目录/类型与任何数据库或持久化结构（见「Not decided here」
延期清单）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
