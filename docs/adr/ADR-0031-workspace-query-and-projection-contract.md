# ADR-0031: Creation Workspace 查询合同与可重建 Projection

- Status: Accepted
- Date: 2026-08-02
- Accepted: 2026-08-02，经独立 reviewer 审查通过（无 blocker，一项 Minor 已闭合）
- Decision owner: TASK-024
- Implementation scope: TASK-025、TASK-027～029、TASK-032、TASK-033、TASK-039、TASK-040
- Preserves: ADR-0001、ADR-0003、ADR-0004、ADR-0010
- Workflow I/O source: [L0–S7 工作层级输入输出合同](../design/workflow-stage-step-io-contract.md)
- Query/IA baseline: [查询合同](../design/workspace-query-contract.md)、
  [信息架构](../design/workspace-information-architecture.md)

## Context

工作视窗需要跨项目组合计划、状态、谱系、成本和评价，但各事实由不同领域的
唯一写入者维护。若 UI 直接扫描文件或各模块复制事实，会形成脆弱耦合与第二来源。

## Proposed Decision

- 先定义与 UI 技术无关、带版本的只读 query contract；
- 未运行项目的完整计划、依赖、预期输入输出和 Gate 必须从 workflow I/O contract
  与 stage registry 派生，不能从已有运行记录反推；
- 每个权威领域由独立 source adapter 读取，跨域组合只在 query/projection 层；
- projection 输出排序确定、来源可追踪、可删除重建，并区分 authoritative、derived、
  unavailable/legacy；
- source 损坏、digest 漂移、孤儿谱系或成本对账不明时 fail-closed 并返回结构化问题；
- projection 不修复、不写回业务状态，不持有凭据；
- 初版允许按需计算或物化缓存，但选型必须证明删除缓存后可重建。
- 若使用物化缓存，TASK-024 必须在本 ADR Accepted 前锁定缓存路径、生命周期和
  唯一写入者；任何项目/账户持久路径须由 ADR-0001 明确授权。

## TASK-024 Decisions（终稿，待独立审查后并入 Accepted）

TASK-024 收口了下列全部待决项；细节见
[查询合同](../design/workspace-query-contract.md) 与
[信息架构](../design/workspace-information-architecture.md)。

1. **查询最小稳定集合**：冻结 14 条只读查询 WQ-01～WQ-14（覆盖可观察性要求 §6
   的九条 readiness 查询 + 跨项目发现、复用使用面、审批审计、预算态势），每条有
   稳定 `query_id`、输入、返回语义（authoritative/derived/unavailable 三分标注）、
   确定排序和 fail-closed 失败语义。见查询合同 §3。
2. **Projection 策略（初版）**：WSM1 采用 **on-demand 求值、不落持久缓存**。因此
   本 ADR **不授权任何项目/账户持久 projection 路径**，也不引入缓存唯一写入者——
   “删除缓存可重建”被平凡满足（无缓存）。若 WSM1-A 证明必须物化，须回到后续 ADR
   增补，锁定缓存路径、生命周期、原子替换与唯一写入者，且任何持久路径须经 ADR-0001
   明确授权后方可实施。这一决定同时结清了原“若使用物化缓存，TASK-024 须在本 ADR
   Accepted 前锁定缓存路径”的前置条件。
3. **Source adapter 与错误聚合**：每个权威领域一个独立只读 adapter（project/profile、
   reuse、approval+audit、planning、packets、reservation/budget、qcd events、
   lifecycle/asset、qc/release/archive、stage-registry+I/O 合同）。adapter 声明其支持
   的 schema_version；遇不支持版本返回 `schema_unsupported` 结构化 problem，不崩溃、
   不猜测。跨域组合只在查询层；错误聚合进结果的 `problems` 列表（查询合同 §4），
   必要时置 `readiness_failed`。
4. **跨项目发现、分页/排序、时间与金额派生**：项目发现以账户根下项目 config 存在
   为准（沿用既有账户根语义，不新增机制）；排序键确定（stable id → version →
   时间），分页参数在结果 `scope` 回显；时间 UTC 存储、Asia/Tokyo 为派生显示；
   金额以整数原币为 authoritative 事实，JPY 折算/累计/按维度聚合为 derived，不同
   币种分列不相加。
5. **兼容与弃用策略**：查询合同带独立 `contract_version`；新增查询或可选返回字段
   为向后兼容（minor+）；删除/重命名/收紧失败语义为破坏性变更，须新 ADR 增补并记录
   迁移；`query_id` 稳定不复用。
6. **projection/cache 路径与 owner**：因初版为 on-demand 无持久缓存，本 ADR
   **不定义任何 projection/cache 持久路径、owner 或清理语义**；显式声明 WSM1 不产生
   项目/账户持久 projection 产物。后续如引入，见第 2 条的增补路径。

## Not Decided Here

UI 框架、HTTP/IPC 协议、数据库产品、Command Gateway 和 Action schema（分别由
ADR-0032～0036 裁决）；字段名/目录/schema version/Python 类型（由 TASK-025 在其
Accepted 设计内决定）；历史 M1 数据迁移方案。

## Acceptance Note

本 ADR 已于 2026-08-02 经独立 reviewer（与 TASK-024 实施 Agent 分离）审查通过：
14 条查询无损覆盖可观察性要求 §6、WQ-01 无损映射 L0–S7 I/O 合同、三分标注一致、
on-demand 无持久缓存决定符合 ADR-0001/0030、source-to-query 与 gap list owner 归属
正确、失败语义 fail-closed、未混入写/Gateway/Action/UI/DB/协议、未提前 Accept
ADR-0032～0040；一项 Minor（§5.3 unavailable 枚举补齐 L0）已闭合。据此改为
Accepted。WSM1 生产实现（TASK-025）自此可依本合同开工。ADR-0032～0040 保持
Proposed，不受本 Accepted 影响。

## Amendment 2026-08-03 (TASK-027, contract_version 1.1)

依据第 5 条"新增可选返回字段为向后兼容（minor+）"，TASK-027 对 **WQ-07
cost-breakdown** 做**纯附加、只读**扩展，`contract_version` 由 `1.0` 升至 `1.1`：

- 新增派生维度 `by_step`、`by_stage`、`by_time`（均 DERIVED，币种分列不相加，
  与既有 `by_shot/by_provider/by_model` 同构）；`by_time` 以 JST 日历月为桶键，
  与预算台账 `monthly_remaining_jpy` 的月度单位对齐。
- `per_operation` 每条新增 `occurred_at`（成本事件时间戳，AUTHORITATIVE）。
- `by_step`/`by_stage` 的归属从 I/O 合同派生（付费成本记于 `paid_generation`
  步骤，WFM1 即 `S4-T05`/`S4`），**不修改任何核心 lineage/cost 事实写入器**，
  符合 TASK-027「明确不做」与本 ADR 第 2 条 projection 只读边界。

属 minor 向后兼容变更：不删除/重命名字段、不收紧失败语义、`query_id` 不变；
shell 按主版本判定 legacy，故 1.x 客户端不受影响。无需新 ADR，按第 5 条以增补
记录即可。
