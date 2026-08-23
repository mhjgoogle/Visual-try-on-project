# TASK-102 任务卡范围注入事件留痕（2026-08-22）

`docs/tasks/TASK-102-repo-test-decoupling.md` 为未跟踪文件期间（磁盘
LastWriteTime 16:18:19，据 9d 会话核查），被非实施 Agent 修改。实施 Agent
恢复自己起草的版本前未及旁存原件（原件为 untracked，git 无基线），本文件按
实施会话收到的磁盘变更快照**逐字重建**被注入的两处差异，作为事件证据留痕。

## 注入一：IN SCOPE 新增条目 0（我起草的版本从 1 开始，无此条）

```markdown
0. **治理前置批（本次）**：以 ADR-0080 统一测试归属、独立审查、跨 Agent
   Skill 与 Git 集成规则；将 `CLAUDE.md` 收敛为 `AGENTS.md` 的入口；移除风险
   分级和 `MOTV_CONTINUOUS_CHAIN` 特例，并使本地 gate 按明确的测试所有权路由。
   本批不移动测试文件、不改变产品代码或 CI 的全量集成职责。
```

## 注入二：Impact Analysis 的「风险档」行被替换

我起草的版本：

```markdown
- 风险档：gate/测试基础设施 + Windows 可移植性 = **高**（全量+独立审查 2 轮）。
```

被替换为：

```markdown
- 验证归属：gate/测试基础设施由 `tests/test_commit_gate_policy.py` 与双 shell
  契约测试覆盖；本批后续目录移动必须逐一复验受影响域、serial 标记与 CI 集成命令。
```

## 处置

1. 卡已恢复为实施 Agent 起草的版本，并在卡内新增「范围事件记录」节说明不采纳
   的理由（与 Accepted 的 ADR-0060/0068/0069、AGENTS.md §20 冲突；治理变更
   必须走新 ADR + 用户裁决，不得写入他人任务卡）。
2. 已向全部 peer 会话广播质询；8e / 9d / d9 已否认并提供可核验证据。
3. d9 指出存在两个同名 `visual-try-on-project-42` 会话（[73db51] 与 [0d0e02]），
   后者起于事发前约 46 分钟，为待质询对象。
4. 本文件与恢复后的卡一并提交，使后续任何碰撞成为可 diff 的事实而不是口头对质。
