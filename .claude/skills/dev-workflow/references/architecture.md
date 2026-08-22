# Architecture Governance（共享子工作流）

不是独立主工作流；任何工作流命中触发条件时进入。产出通常是：
边界判断写进任务卡「架构影响」节；重大者立 ADR（AGENTS.md 第 21 条，
技术 ADR 依 CLAUDE.md 授权自行 Accept）。

## 触发条件（任一命中）

1. 跨多个模块的修改
2. 前后端 / API Contract 改变
3. shared / core / 跨层公共代码修改
4. 数据模型 / 持久化 schema 改变
5. 依赖方向改变（谁 import 谁）
6. 引入新的公共 abstraction
7. **一次看似局部的修改却触及异常多文件/模块**（Change Isolation 报警）

## 治理内容

对照现有边界权威（`docs/architecture.md`、`creator-system-contract.md`、
`workflow-stage-step-io-contract.md`、相关 ADR）检查：

- **Module / Feature Boundary**：改动落在哪个边界内？有没有越界写？
- **Dependency Direction**：有没有反向依赖、循环依赖被引入？
- **Contract**：前后端/跨层合同变了吗？变了就是高风险档 + 合同文档同步更新。
- **Shared/Core Boundary**：见下方克制规则。
- **Architecture Drift**：实际结构是否已偏离文档？偏了→文档跟上或立卡纠偏，
  不装作没看见。

## Feature-Oriented Decoupling（默认架构原则）

**Feature Boundary 优先**，不只按 frontend/backend 两大层思考。
一个 Feature（如 Search）逻辑上自成边界：UI → API Contract → 后端逻辑 →
测试，可以跨前后端但同属一个 Feature Boundary。
不同 Feature 不得依赖彼此**内部实现**；前后端只通过明确 Contract 连接
（本仓库即 creator-system-contract 的 Command/Query 名录）。

## Change Isolation

目标：一次局部 Change 尽量锁在局部 Feature/Module Boundary 内。

简单需求引发大范围跨模块修改时，**不直接接受扩散**。先查：

- boundary leakage（内部细节被外部直接引用）
- shared state coupling（隐式共享状态）
- hidden dependency（没在依赖图上的耦合）
- duplicated abstraction（同一概念多处实现，改一处必须改全部）
- architecture drift

确认是结构缺陷 → 先问 Minimum Necessary Foundation 那个问题
（CLAUDE.md「范围与切片」）：**不修这个结构，当前任务能否在自己边界内
安全完成？** 能 → 记 Follow-up（TASK-087 总账），本任务不碰它
（AGENTS.md 第 17 条：范围外不顺手修）；不能（真阻塞）→ 只做**最小范围**
修复（另立卡，Refactor 工作流），报告里写明为什么绕不开，再回来做原任务。
确认扩散是本质复杂度（如真正的合同变更）→ 接受，
升 DEEP 深度 + 高风险档，并在卡里写明为什么。

## Shared / Core 克制规则

**禁止「两个地方用了就进 shared」。** 新 shared abstraction 必须有
真实、稳定的跨模块价值（第三个使用者出现、或合同性质的稳定接口）。
否则留在 Feature 内部——重复两份小代码比一个错误的公共抽象便宜。
反向也成立：convergence 时发现 shared 里只剩一个**仓库内**使用者的抽象，
先确认它没有仓库外或合同性消费者（公开 API、Skill 包、其他集成方）——
没有才内联回去；有则它是合同的一部分，按合同变更处理，不得直接删。
