# TASK-031：工作视窗受控运行与 Action Center 写闭环（WSM2-D）

> **状态：Planned。** 依赖 TASK-023、TASK-026、TASK-028～030 全部完成并通过
> 对应 review，ADR-0032/0033/0035 Accepted。

## 目的

将核心已支持的常规操作安全接入工作视窗，并完成评价、反馈和 Action 的界面写闭环，
使用户不再为日常操作调用 Agent，同时保持所有命令经过 Gateway。

## 输入

- TASK-030 Gateway command/preflight/outcome；
- TASK-026 UI shell、TASK-028/029 application/query；
- TASK-023 合法操作和恢复合同。
- ADR-0033/0034/0035 的 Gateway、评价和 Action 合同。

## 输出

- project/profile 初始化、目标新版本，以及 start/retry/new-parameters/resume/
  select/approve/revise/next-stage 等**核心已支持操作**的 UI preflight、确认、
  提交和结果状态；
- feedback/evaluation/action 创建与更新页面；
- Action Center 完整状态操作和用户验证闭环；
- 重复点击、断线、页面关闭、恢复、stale 和高风险确认测试。

## 修改范围

workspace UI 的 command client、forms、preflight/confirmation/outcome 页面及测试；
Gateway 只通过公开合同调用。核心模块不修改。

## 明确不做

- 不直连 CLI 子进程、Provider 或项目文件；
- 不展示或启用核心不支持的 pause/cancel/skip；
- 不实现任意参数/文件编辑、原地改写目标、Agent 代码修改或 Provider 接入；
- 不实现跨项目推荐（TASK-032）。

## 实施步骤

1. 将每个 UI action 映射到 Gateway 注册命令和合法状态。
2. 实现输入/费用/下游影响 preflight 与高风险确认。
3. 实现命令提交、receipt、进度、错误和恢复显示。
4. 接入评价、反馈、Action 的受控写闭环。
5. 对关闭页面、重复点击、断线重连和 stale 数据做对抗测试。

## 测试要求

- UI 中不存在绕过 Gateway 的写请求；
- 双击/重载/重连不重复运行和付费；
- preflight 后目标/预算变化时执行拒绝；
- 页面关闭后命令继续，恢复后显示同一 receipt；
- Action/评价目标 digest 漂移阻断；
- 浏览器状态和日志无 credential。

## 验收标准

- [ ] 常规创作操作可在工作视窗完成且全部经 Gateway；
- [ ] 不能执行时明确展示结构化原因；
- [ ] 高风险操作显示输入、预计费用和下游影响；
- [ ] 关闭工作视窗不影响核心执行；
- [ ] Agent 仍只负责工程改造和异常范围外需求。
