# REQ-002：文档与记录的统一生命周期 —— 当前事实保持精简，历史保持可追溯

- 状态：CONFIRMED
- 相关 Change：TASK-107 · ADR-0087

## v1 — CONFIRMED（2026-08-26）

- 来源：产品负责人 2026-08-26 —— 「请对当前 repo 的 Requirement / Change /
  Task / ADR / 临时开发文档建立统一的生命周期管理规则，并落实到现有
  Development Workflow 中。目标不是简单整理一次目录，而是以后所有开发任务都
  自动遵守：Current Truth 保持精简 + Historical Evidence 可追溯 +
  Completed Records 不进入默认 Agent Context + Obsolete Artifacts 应删除而不是
  永久累积。」「Current truth remains small. History remains traceable.
  The repo converges instead of accumulating forever.」

- 用户真正需要什么：**每完成一个任务，仓库不比之前更乱**。具体是四件事同时
  成立 —— 当前有效事实一眼能找到且很小；历史证据仍然查得到；已完成记录不再
  占用日常开发上下文；一次性产物被删掉而不是永久堆积。

- 为什么：本仓库的高频缺陷是**文档漂移**（2026-08-23 一天查出五处过期状态，
  其中一处错标签把两条真缺陷藏了十天）。ADR-0083 已用「目录即状态」解决了
  任务卡这一类，但 ADR 状态、临时产物、当前架构事实、默认加载什么，仍然没有
  规则 —— 于是 70 条 ADR 里有两条早已被取代却仍写着 Accepted，35KB 的已闭合
  复审历史仍然是每次 merge 前必读。

- 验收判据（产品视角，非测试清单）：
  1. 当前有效需求 / 当前架构事实，不需要遍历历史就能找到；
  2. `active/` 里的东西只代表**正在进行**的工作；
  3. 已完成记录仍可追溯（Requirement 引用、commit、验证、merge、关键决策）；
  4. superseded 的 ADR 有明确的双向链接，且旧 ADR 不被删除；
  5. 临时产物在任务结束时被删除或被提炼进正式记录，不永久堆积；
  6. 这些规则由**开发流程自动执行**，不要用户手工整理。
