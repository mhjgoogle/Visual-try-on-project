# ADR-0006: Lifting the Phase-1 No-Paid-API Boundary for TASK-010

- Status: Accepted
- Date: 2026-07-30
- Scope tasks: TASK-010 (first cloud video provider)
- Supersedes (narrowly): AGENTS.md 规则 10「第一阶段不接入任何付费
  API」— for the TASK-010 cloud provider only.
- Historical implementation note: TASK-010 后由 TASK-016/017 取代；本 ADR 的
  付费边界解除与安全原则由 ADR-0008/0009 延续，不再授权第二条 TASK-010 实现线。

## Context

AGENTS.md 规则 10 与 product_spec 把「第一阶段不接入付费 API」列为
硬约束。TASK-010（首个 CloudVideoProvider）本质需要一个真实付费
云端视频生成 API，因此被显式阻塞。用户（2026-07-30）决定**为
TASK-010 解除该边界**，进入 M3 的云 Provider 实施轨道。

## Decision

1. **边界解除（范围受限）**：仅为 TASK-010 的 CloudVideoProvider
   实现解除规则 10 的付费 API 禁令。核心工作流、TASK-005/006/007/
   008/009、ManualVideoProvider、LocalVideoProvider(TASK-011) 不受影响，
   仍不得因此引入付费依赖。
2. **不改变 Provider 抽象**：TASK-010 仍完整实现 TASK-003 的
   `VideoProvider` 接口与七状态矩阵，不修改 TASK-003/004 合同；上层
   编排/校验/登记/合成零改动（Provider 抽象有效性的验证目标）。
3. **凭据纪律不变**：API key / 凭据一律来自环境变量或本地配置，
   永不入库、永不进 Git（AGENTS.md 23）。凭据环境变量命名合同随
   厂商选型在 TASK-010 聚焦设计中定案。
4. **成本记录**：首次填充真实货币成本字段，沿用 ADR-0003 的整数
   最小货币单位 + ISO-4217 模型（`cost_minor_units`/`currency`），
   禁止浮点货币。预算与计费上限在 TASK-010 聚焦设计中定案。
5. **仍待用户裁决的 TASK-010 阻塞项（本 ADR 不代为裁决）**：
   - 具体厂商选型（endpoints / auth / 请求-响应形态）；
   - 预算与计费边界的具体数值；
   - 凭据环境变量命名合同。
   在上述三项定案前，不得虚构厂商细节（TASK-010 卡约束）；可先实施
   **厂商中立的可锁定部分**（VideoProvider 接口实现骨架、
   env-credential 读取模式、类型化网络错误体系、submit 幂等扩展、
   timeout/取消传播），全部网络交互打桩，真实 API 冒烟测试显式
   opt-in、绝不进回归门槛。
6. **测试/CI**：真实云 API 绝不进默认回归门槛；单元/集成测试一律
   打桩网络；可选真实冒烟测试需显式环境开关。

## Consequences

- TASK-010 可进入聚焦设计与厂商中立骨架实施；具体厂商接线待三项
  裁决与 TASK-010 聚焦设计 + 厂商 ADR。
- 规则 10 对项目其余部分仍然有效；本解除是逐字锁定的单点例外。
- 成本：首次引入真实外部付费依赖与凭据管理面；由凭据纪律
  （env-only、never-in-git）与打桩测试边界约束风险。

## Not decided here

- 厂商选型、预算数值、凭据命名（TASK-010 聚焦设计 + 用户裁决）;
- LocalVideoProvider(TASK-011) 与自动路由(TASK-012) 的产品决策。

## Later resolution

厂商中立预算、审批、reservation 与成本事实由 TASK-016/ADR-0008 落地；首个
厂商 MiniMax 的凭据、端点和计费合同由 TASK-017/ADR-0009 落地。因此 TASK-010
保留为历史卡，现行实现和后续扩展均不得绕过上述合同。
