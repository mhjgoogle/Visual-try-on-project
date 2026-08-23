# TASK-024：Creation Workspace 查询合同与信息架构收口（WSM0）

> **状态：Docs-complete；ADR-0031 终稿待独立审查后 Accepted。** 已产出
> [查询合同](../../design/workspace-query-contract.md)、
> [信息架构](../../design/workspace-information-architecture.md)（含 source-to-query
> 可追溯矩阵、WFM1 gap list、stage/step 计划无损映射），并把 ADR-0031 的全部待决项
> 收口为终稿。未写任何生产代码或冻结合同。**ADR-0031 仍为 Proposed**：按 ADR-0030
> 与治理规则，须经独立审查判定后方可改 Accepted，此前 TASK-025 不得开工。
> 路线见 [ADR-0030](../../adr/ADR-0030-creation-workspace-delivery-governance.md)。

## 目的

把工作视窗需求转换为稳定、与 UI 技术无关的只读 query use cases、信息架构和
source mapping，确认当前核心数据能回答什么、缺什么、由哪个 WFM1 任务补齐。

## 输入

- 工作视窗统一需求与数据可观察性要求；
- [L0–S7 工作层级输入输出合同](../../design/workflow-stage-step-io-contract.md)；
- ADR-0010、ADR-0030、ADR-0031；
- TASK-018～022 已实现合同、TASK-023 readiness 与验收合同；
- 现有 CLI、orchestration、QCD、approval、budget、profile/reuse 数据来源。

## 输出

- `docs/design/workspace-query-contract.md`：版本化 query catalog、语义、排序、
  authoritative/derived/unavailable 标记和错误模型；
- `docs/design/workspace-information-architecture.md`：项目、步骤、谱系、比较、成本、
  评价、Action、学习的导航与页面责任，不做视觉稿；
- source-to-query traceability matrix 与 WFM1 gap list；
- stage/step plan query 对 I/O、required/conditional 和 Gate 的无损映射；
- ADR-0031 的最终裁决；ADR-0032～0036 的决策输入更新。

## 修改范围

仅 `docs/`：需求、architecture、implementation plan、ADR-0031、上述 design 文档
及必要的 WFM1 task gap 说明。不改代码、测试和冻结合同。

## 明确不做

- 不选择 UI 框架或数据库；
- 不实现 projection、API、页面或 Command Gateway；
- 不修改 TASK-020 并发代码，不为缺失数据设计 UI 私有补丁；
- 不把 Proposed ADR 自动标为 Accepted。

## 实施步骤

1. 将需求逐条映射为只读查询和页面责任。
2. 对每个查询标注权威 source、owner、版本兼容和失败语义。
3. 用现有最小项目做纸面 walkthrough，记录 unavailable 与 owner task。
4. 决定 ADR-0031 中 on-demand/materialized、adapter 和兼容策略。
5. 形成 WSM1 可实现的冻结 query baseline 和 milestone checkpoint。

## 测试要求

- 文档链接、query ID 唯一性、需求覆盖和 source owner 完整性检查；
- 至少覆盖空项目、运行中、失败、stale approval、ambiguous cost 和 legacy 数据；
- 每个写操作需求均明确标为 WSM2，不混入只读合同。

## 验收标准

- [x] 统一需求每项均映射到 query/page/task 或明确 deferred
  —— 查询合同 §7 source-to-query 矩阵 + §8 gap list；可观察性要求 §6 九条
  readiness 100% 覆盖到 WQ-01～WQ-10（独立审查覆盖映射表确认）。
- [x] query contract 不依赖 UI、数据库和内部 Python 对象
  —— 查询合同 §1（UI/DB 中立）、§10（当前不决定）；独立审查项 G ✓。
- [x] 关键关系不依赖日志、文件名或 Agent 对话猜测
  —— 查询合同 §4/§6 fail-closed；WQ-05/09 显式"从自由文本推断即 readiness 失败"；
  独立审查项 F ✓。
- [x] 新项目未运行时也能从 I/O 合同显示完整步骤、依赖、预期输入输出和 Gate
  —— WQ-01 + 查询合同 §5 无损映射（计划定义层始终可返回，L0–S7 含 gate/依赖）；
  独立审查项 B ✓。
- [x] ADR-0031 经独立审查后 Accepted
  —— 独立 reviewer（与实施 Agent 分离）2026-08-02 判定 PASS，无 blocker、一项
  Minor 已闭合；ADR-0031 Status = Accepted。
- [x] 未修改任何代码或冻结合同
  —— 本任务仅改 `docs/`；`git status -- src/ tests/` 无未提交改动。

## 交付物

- [查询合同](../../design/workspace-query-contract.md)（WQ-01～WQ-14 + 结果信封 +
  问题模型 + §5 stage/step 无损映射 + §7 追溯矩阵 + §8 gap list + §9 WSM1 冻结基线）；
- [信息架构](../../design/workspace-information-architecture.md)（页面职责→查询映射、
  读/写分层、里程碑归属，无视觉稿/框架/DB/路由）；
- [ADR-0031](../../adr/ADR-0031-workspace-query-and-projection-contract.md) 终稿并
  Accepted（六项待决全部收口，on-demand 无持久缓存）。
