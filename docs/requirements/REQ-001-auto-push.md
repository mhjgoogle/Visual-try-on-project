# REQ-001：Task 完成后自动 commit/push，Change 完成后受控合并

- 状态：CONFIRMED
- 相关 Change：TASK-101

## v1 — CONFIRMED（2026-08-22）

- 来源：产品负责人 2026-08-22 —— 「用户不希望每完成一个 Task 都手工 git
  status / add / commit / push，也不希望自己管理当前 Task 属于哪个 branch、
  哪些 diff 属于当前 Task、commit message、push target、merge 到 main、
  branch cleanup。」「默认允许自动 commit、自动 push，前提：所有安全 Gate
  通过。用户不应该被频繁询问。」「Automate Git mechanics. Do not automate
  product truth.」
- 用户真正需要什么：开发主循环里不再手工做 Git 机械操作；同时自动化**不得**
  把错误代码、无关 diff、冲突需求或危险 Git 操作推进到 main。
- 为什么：每次「要不要 commit / push」的询问都是一次拖慢开发的往返
  （与 CLAUDE.md 决策模式同一根因）；而手工挑 diff 又是易错的机械劳动。
- 验收判据（产品视角）：
  - 一个 Change 一条分支多个 Task commit，Task 验证通过后自动 commit+push，
    全程不问用户；
  - 只有当前 Task 的 diff 被提交（禁 `git add .`；混合文件无法区分时拒绝）；
  - 验证失败 / 疑似 secret / 异常宽 diff / 需要 force push 时自动化停下；
  - merge 到 main 只发生在 dev-workflow 的 Merge Gate = PASS 之后，
    且需求层面的冲突永远交回人。
