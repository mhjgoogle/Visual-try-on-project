# TASK-010：首个 CloudVideoProvider（阶段 7）

> **状态：大纲（OUTLINE，Milestone 3——付费 API 边界已由 ADR-0006
> 窄范围解除，仍被厂商、预算和凭据产品决策阻塞）。**
> 本卡只锁定边界与合同方向；厂商选型是产品级取舍，须用户裁决并
> 记录新的厂商 ADR 后才能完成聚焦设计。规划阶段不得虚构厂商细节。

## 正式名称

First Cloud Video Provider Integration

## 业务目标

以真实云端视频生成 API 实现 `VideoProvider` 接口，验证 Provider
抽象的有效性：上层流程（编排、校验、登记、合成）零改动。

## 阻塞项（用户裁决）

1. 厂商选型（记录新的厂商 ADR；不得复用已有 ADR 编号）；
2. 预算与计费边界具体值（付费 API 边界已由 ADR-0006 窄范围解除）；
3. 凭据管理方式确认（环境变量命名合同）。

## 边界合同（已可锁定的部分）

- 实现 TASK-003 `VideoProvider` 接口与七状态矩阵，不修改契约；
  submit 真实远端提交、poll 真实查询、collect 下载到编排器指定
  staging 路径或返回外部引用；
- 凭据一律来自环境变量/本地配置，永不入库、永不进 Git（AGENTS.md
  23）；
- 网络错误、限流、认证错误的类型化体系（TASK-003 预留的
  ProviderError 子树扩展）；真实外部副作用下的 submit 幂等性扩展
  （TASK-004 预留）；timeout 与取消传播策略在此定案；
- 新增 `providers/cloud_<vendor>.py` + 对应测试（全部网络交互
  打桩；可选真实 API 冒烟测试显式 opt-in，绝不进回归门槛）；
- D2 成本观测：首次填充真实成本字段（货币模型在此定案）。

## 依赖

TASK-003/004（已交付）；TASK-005/006/007（端到端验证链路）；
用户裁决 1–3。

## 当前状态

Outline only — ADR-0006 has lifted the paid-API boundary for this task,
but vendor / budget / credential decisions remain blocking；不计入
Milestone 1–2 回归门槛
