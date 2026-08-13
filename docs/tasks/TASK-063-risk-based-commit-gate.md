# TASK-063：风险分级本地 Commit Gate

- 状态：完成（2026-08-12）
- Owner：单实施 Agent
- 依据：[ADR-0060](../adr/ADR-0060-risk-based-local-commit-gate.md)、
  [ADR-0050](../adr/ADR-0050-powershell-native-agent-dev-tooling.md)、AGENTS.md §5。
- 风险：中（只改 agent 开发工装；错误分类必须 fail-closed）。

## 目标

取消每次本地 commit 无条件跑全量 pytest 的策略，同时保留高风险/未知路径的
全量回归门槛和两个平台 gate 的一致行为。

## 交付

- 一个可单测的共享路径分类器；Bash 与 PowerShell gate 都调用它。
- 文档、测试、限定 workspace、限定 motv 前端的快速路径。
- 其它源码、配置、fixture、hook、混合路径、删除及分类失败均 fail-closed 到
  全量 pytest。
- 回归测试覆盖各快速路径及高风险/混合路径不能被快速放行。

## 验收

- `python -m pytest tests/test_commit_gate_policy.py -q`
- `ruff format --check .` 与 `ruff check .`
- Bash 语法检查与 PowerShell 解析检查通过。
- 由于本次同时改动 hook/策略文件，策略分类必须得到 `full`；合并前 CI 仍执行
  Linux/Windows 全量 pytest 与 Node 测试。
