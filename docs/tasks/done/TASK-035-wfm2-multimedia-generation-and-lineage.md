# TASK-035：WFM2 多媒体生成、资产谱系与统一成本

> **状态：Implemented（2026-08-04）。** ADR-0038 Accepted、TASK-034 交付后实施。
> 新包 `src/ai_video_workflow/media/`：capability 声明的 `MediaProvider` registry
> （fail-closed；仅离线零成本 stub）、媒体资产身份/谱系索引（不可变线性版本、
> content_digest + 媒体文件 sha256 绑定、跨域 input_refs 解析）、generation batch +
> selection（全候选保留、未选不删）、正式资产 promotion，统一成本复用现有
> budget/reservation/QCD 链（`provider_cost_recorded` 事件，ledger 自动汇总，不建第二账本）。
> 路径经 ADR-0001 第七次增补授权（`media/assets|batches|selections/…`、`staging/media/…`）。
> `VideoProvider` 冻结合同原样保留、不泛化；默认全打桩不花钱，真实付费仍为显式 opt-in
> （ADR-0006/0009）。WFM2 端到端最终验收由 TASK-037。原文见下「聚焦设计」。

## 目的

为参考图、母资产、关键帧、生成图片及生成式音频建立 Provider 中立、版本化、
可恢复和可计费的正式生产路径，并保持现有 VideoProvider 与资金安全合同可靠。

## 输入

- TASK-034 的正式视听设计和 probe targets；
- [L0–S7 工作层级输入输出合同](../../design/workflow-stage-step-io-contract.md) 中
  S2 probe 与 S4 baseline；
- TASK-014～017/021 的 catalog、预算、Provider、成本和恢复能力；
- ADR-0002/0003/0008、Proposed ADR-0038。

## 输出

- Accepted ADR-0038 及必要的目录/QCD 增补；
- Image/Audio Provider 或 capability 方案及 registry；
- reference/master/keyframe/generated image、audio generation batch 和选择谱系；
- S2 probe、S4-T01～T08 的 input/output schema、owner、validator 与 completion mapping；
- 跨媒体 quote/reservation/actual/FX/JPY、恢复、凭据和对账测试；
- WFM2 示例素材元数据，不提交大媒体或凭据。

## 修改范围

仅限 ADR-0038 授权的多媒体 provider/application/asset 模块、catalog 增量、CLI、
测试和示例；VideoProvider 和现有付费协调链优先复用，不做无必要泛化。

## 明确不做

- 不锁定具体付费厂商或默认调用真实 API；
- 不实现完整后期、发布、Workspace 页面或自动路由；
- 不让 Provider 写业务文件、选择正式资产路径或绕过预算；
- 不把临时 URL 作为唯一产物身份。

## 已记录的后续项（范围外，不在本任务修）

- **共享下载器 SSRF 加固（follow-up）**：外部 `external_ref` 通过注入的
  `UrllibMediaFetcher` 下载（scheme allowlist + redirect 复检 + size cap）。该下载器
  是 WFM1 视频付费链（`app/paid_coordinator.py`）与本媒体链**共用**的安全边界，二者
  当前均**未**在连接层阻断 loopback/私网/metadata IP（SSRF）。此暴露是既有、跨链、
  已 Accepted 的姿态，正确修复位置在共享下载器（ADR-0006/0009 范围），会同时改动视频
  付费链，超出 TASK-035（ADR-0038 合同层）授权。媒体层只做 http(s) scheme fail-fast 并
  委托下载器，IP 层 SSRF 加固作为独立 follow-up（同时覆盖视频+媒体）跟踪，不在此单侧
  实现（AGENTS.md 17：范围外问题记录不顺手改）。默认离线 stub 从不产生 external_ref。

## 聚焦设计（多媒体 Provider / 资产 / 成本合同）

本节是 TASK-035 对 ADR-0038 的聚焦设计产出，只定合同层维度与边界规格，不选具体
Provider 接口签名 / 资产路径 / schema / 字段 / 目录 / 类型 / DB / 厂商，不含代码。
裁决结论见 [ADR-0038](../../adr/ADR-0038-multimedia-provider-asset-and-cost-contract.md)。

- **Provider 中立抽象方向**：图像、音频等新媒体经**声明 capability 的媒体 Provider
  registry** 平行接入，核心工作流不依赖任何具体厂商（AGENTS.md 8/9）；现有
  `VideoProvider` **冻结合同原样保留、不泛化**（Must preserve、AGENTS.md 3.9）。
  独立/通用/组合的最终接口选型须先以 capability 与副作用语义评估，registry 对
  未知能力 **fail-closed**。
- **资产身份与谱系**：所有正式媒体版本具有稳定 **ref / version / digest** 身份、
  **producer operation**、**输入 refs**、候选 **batch**、**选择关系**与**消费者**，
  可双向追溯输入版本 / Provider / 模型 / 参数 / operation，并与 ADR-0037 产物身份
  对齐；临时 / 签名 URL 不作为唯一产物身份；Provider **不写业务事实**。
- **统一成本记录维度**：付费媒体的 **quote / estimate / reservation / actual /
  FX / JPY 派生**按 ADR-0003/0008 分离，复用或显式兼容现有资金安全链；预算拒绝
  零调用、成本恰好一次、ambiguous 不自动重提进入人工对账；跨媒体不新建第二账本；
  金额用整数最小货币单位 + ISO-4217。
- **付费边界纪律**：图像 / 音频付费实现**只能在 ADR-0038 Accepted 且其明确批准的
  窄范围内、并在 ADR-0006/0009 既有付费授权框架内**进行（凭据 env-only、registry
  credential allowlist、真实付费调用显式 opt-in、默认回归全打桩、凭据永不入库 /
  入日志）；ADR-0038 未 Accepted 前不实现任何 Provider、资产路径或付费调用。
- **staging / collect 边界**：外部工具、人工导入、云 API 与本地图片模型收敛到统一
  staging/collect 语义（路径 containment、原子防覆盖发布），不因来源不同各自绕过。
- **守卫（须有测试固化）**：Provider 不写业务文件、不选择正式资产路径、不绕过预算；
  候选批次全部结果保留、选择不删未选；原 M1/WFM1 视频链全量回归不被破坏。

## 实施步骤

1. 比较独立 Provider 与 capability 协议并接受 ADR-0038。
2. 定义多媒体 operation/batch/artifact/selection 的最小关系。
3. 复用资金安全链，必要增量先获 ADR-0003/0008 授权。
4. 接入本地/假图片 Provider 和可打桩云边界，默认测试无付费网络。
5. 验证候选、选择、redo/fallback、成本和恢复的端到端谱系。

## 测试要求

- registry 可插拔且未知能力 fail-closed；
- 批次全部结果保留，选择不删除未选结果；
- 预算拒绝零调用，ambiguous 不自动重提，成本恰好一次；
- 路径 containment、防覆盖、凭据脱敏和临时 URL 排除；
- 原 M1/WFM1 视频链全量回归。

## 验收标准

- [ ] 图片/音频正式产物可双向追溯到输入、Provider、模型、参数和 operation；
- [ ] 所有付费媒体纳入统一预算和成本审计；
- [ ] VideoProvider 冻结合同未因错误抽象被破坏；
- [ ] Workspace 所需候选/选中/消费者事实可从权威记录重建；
- [ ] S2 probe 与 S4 每一步均能证明输入版本、正式输出和 conditional 处置；
- [ ] 真实付费调用仍为显式 opt-in。
