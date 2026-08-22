# Creation Workspace ADR 与实施任务路线

> **状态：Approved planning baseline。** 路线治理见 ADR-0030，安全边界见
> ADR-0010。本文规划实现顺序，不表示 Planned 任务已实现或其 Proposed ADR 已批准。
> 核心阶段/步骤计划及逻辑输入输出统一引用
> [L0–S7 工作层级输入输出合同](workflow-stage-step-io-contract.md)。

## 1. 里程碑

| 里程碑 | 目标 | 任务 | 进入条件 | 完成门槛 |
| --- | --- | --- | --- | --- |
| WSM0 Planning | 需求、信息架构、query 合同和技术决策准备 | TASK-024 | 可立即开始 | ADR-0031 Accepted；source gap 明确 |
| WSM1 Observe | 可重建 projection、只读控制台、谱系/版本/成本观察 | TASK-025～027 | 对应 WFM1 source contract Accepted | TASK-023 readiness + 独立审查 |
| WSM2 Manage/Run | 评价、Action、Gateway 和受控写操作 | TASK-028～031 | ADR-0033～0035 Accepted；写能力等待 TASK-023 | 资金/版本/并发/恢复对抗测试 |
| WSM3-B Learn/Baseline | 复盘、跨项目学习、推荐和 WFM1 数据基线验收 | TASK-032～033 | WSM2 Accepted | Workspace-on-WFM1 重建、安全与用户验收 |
| WSM-F Full Expansion | 完整多媒体、WFM3 命令与最终联合验收 | TASK-039～040 | TASK-037/038 与 TASK-033 Accepted | 两份顶层需求全部有端到端证据 |

## 2. ADR 计划

| ADR | 状态 | 决策主题 | Owner task |
| --- | --- | --- | --- |
| ADR-0010 | Accepted | Workspace 安全边界与延期原则 | 基线 |
| ADR-0030 | Accepted | 任务编号、里程碑和依赖门槛 | 路线治理 |
| ADR-0031 | Proposed | Query contract、source adapter、projection 策略 | TASK-024 |
| ADR-0032 | Proposed | 本地运行拓扑与 UI 技术 | TASK-026 |
| ADR-0033 | Proposed | Command Gateway、preflight、幂等与确认 | TASK-030 |
| ADR-0034 | Proposed | 评价、实验和创作决定 | TASK-028 |
| ADR-0035 | Proposed | Feedback/Action 生命周期 | TASK-029 |
| ADR-0036 | Proposed | 跨项目知识与证据化推荐 | TASK-032 |
| ADR-0037 | Proposed | WFM2 完整创意与视听产物 | TASK-034 |
| ADR-0038 | Proposed | 多媒体 Provider、资产谱系与成本 | TASK-035 |
| ADR-0039 | Proposed | WFM2 正式后期、QC 与发布 | TASK-036 |
| ADR-0040 | Proposed | WFM3 自动化和命令能力 | TASK-038 |

Proposed ADR 必须在 owner task 写代码前 Accepted；不允许实现反向替 ADR 做决定。

## 3. 任务依赖图

```text
TASK-024（立即）→ TASK-025 → TASK-026
                      ↑          ↓
已稳定 WFM source ────┘       TASK-027 ← TASK-020/021/022
                                 ↓
                              TASK-028 ← TASK-022
                                 ↓
                              TASK-029
                                 ↓
TASK-023 milestone gate ─────→ TASK-030 → TASK-031 → TASK-032
TASK-023 + TASK-024～032 ───────────────────────────→ TASK-033（WFM1 baseline）
TASK-037 + TASK-038 + TASK-033 ─────────────────────→ TASK-039 → TASK-040
```

说明：TASK-024 可立即进行；TASK-025/026 可针对已稳定 source 做增量实现；
TASK-027 的完整成本/谱系等待 TASK-021/022；TASK-030/031 写能力等待 TASK-023。

## 4. 需求覆盖

| 需求域 | 主任务 | 交付边界 |
| --- | --- | --- |
| 项目/流程/步骤/问题/预算观察 | TASK-024～026 | 只读、可重建、空项目也有完整计划 |
| 版本、谱系、媒体比较、成本深钻 | TASK-027 | 只消费 TASK-020～022 权威事实 |
| 创作目标、评价、实验、创作决定 | TASK-028 | 最终判断由用户确认，不替代 QC/审批 |
| Feedback、Action、Action Center | TASK-029、TASK-031 | Gateway 前 UI 只读，目标 digest 漂移即 stale |
| 预检、确认、幂等命令与恢复 | TASK-030 | 只调用既有应用边界，不直连 Provider |
| 工作视窗常规运行操作 | TASK-031 | 仅暴露核心已支持操作，全部经 Gateway |
| 复盘、跨项目指标、经验和推荐 | TASK-032 | 派生可重建，推荐带证据且不自动决策 |
| WFM1 数据基线、安全与恢复验收 | TASK-033 | 真实 query/Gateway/UI 链与 M1/WFM1 回归 |
| 完整多媒体/完整流程扩展 | TASK-039 | 消费 TASK-034～038 source/capability，不复制事实 |
| 两份顶层需求最终验收 | TASK-040 | 不新增能力；按统一追踪矩阵逐项给出证据 |

## 5. 范围控制

- 核心工作流仍由 TASK-020～023 完成，Workspace 不补写核心缺失事实；
- UI 只消费 query contract，不按路径扫描或导入 Python 领域内部类型；
- Gateway 只调用既有 application service/Orchestrator，不重写业务状态机；
- 每个任务必须测试 projection 可重建、版本绑定和凭据脱敏；
- 不在 WSM1 引入 Action/Gateway，不在 WSM2 提前实现推荐，不在 WSM3 自动替代
  用户创作决定。
- TASK-033 不得以 WFM1 范围外媒体的 `unavailable` 冒充最终完成；最终判断只属于
  TASK-040，逐项范围见
  [端到端需求追踪矩阵](end-to-end-requirements-traceability.md)。
