# 交接与接回来（dev-workflow 引用文档）

权威：[AGENTS.md](../../../../AGENTS.md) 第 14–18、24–26 条 ·
[ADR-0087](../../../../docs/adr/ADR-0087-document-lifecycle-and-default-agent-context.md) ·
[TASK-131](../../../../docs/tasks/done/TASK-131-agent-harness-discovery-and-runtime-evidence.md) 切片 C。
本文件不新增规则，只写**怎么做**。

## 0. 这一节要防的是什么

两件都真的发生过：

1. **把「上次测试 PASS」带到一棵内容已经变了的树上。** 最省事也最危险的一种自欺 ——
   它让人跳过验证，却以为验过了。
2. **不知道工作树里的改动是别人的。** 2026-09-05 本仓库同时跑着三个会话，其中一个
   差点覆盖掉另一个正在写的补审修复；当时没有任何东西提醒（AGENTS §14/§16）。

对策不是新建一套状态机 —— **任务卡就是那份记录**（ADR-0083：目录即状态）。
这里只补两件机器能替你做的事：把机械状态记下来，和接回来时把它核对一遍。

## 1. 交接 / 压缩之前：更新**本次那张卡**

写进 `docs/tasks/active/TASK-NNN-*.md`，不是写进别处：

| 写什么 | 为什么必须是它 |
| --- | --- |
| 当前在第几个切片 | 「做到哪了」只有卡说了算，别让下一个人从 diff 里推 |
| 关联判据（`REQ-NNN 判据 M` / `技术目标`） | 没有它，下一轮不知道自己在为什么而做（`ORPHAN_TASK`） |
| **最后核实的 Git tip** | 所有「已做验证」都挂在这个 tip 上；tip 一动，它们就只是历史 |
| 未提交文件**归属谁** | 同仓多会话时这是唯一能防止互相覆盖的东西 |
| 已做验证（跑过什么命令、结果） | 引用现有 Review Package 或 `verification_ref`，不另建第二份 |
| **下一条可执行动作** | 一句话、能直接照着做的那种；不是「继续完善 X」 |

**QUICK 工作不为了恢复机制强建卡**（AGENTS §24）—— 那种工作的记录就是提交信息。

机械那半可以让工具记，省得手抄 tip：

```
python .claude/tools/agent_harness.py handoff --task TASK-131 \
    --verified "pytest tests/tooling 通过（321 passed）" \
    --next "把 SessionStart 接线补上，然后跑最终全量"
```

它写 `.claude/tmp/resume/TASK-131.json`（**gitignore 掉的一次性产物**，
ADR-0087 决策 6）。里面只有 tip / 分支 / 跑过什么 / 下一步 ——
**刻意没有「进度」「已完成」这类语义判断**：一个脚本写下的 `done` 会在下一次
被当成事实读走，而脚本没有资格宣告任务完成。长期结论提炼进卡，然后删原件。

## 2. 接回来：先核对，再动手

```
python .claude/tools/agent_harness.py resume
```

它回答三件事，一件都不猜：

- 现在在哪个分支、哪个 tip，工作树里有哪些未提交改动；
- `docs/tasks/active/` 里有哪些卡（目录即状态：在那儿就是还没做完）；
- 上一轮那条「跑过什么」**还算不算数** —— tip 变了就标 `⚠ 要重新评估`。

然后按这个顺序：

1. **读用户这一次要什么**，再读相关的那张卡。不自动恢复不相关的旧任务。
2. **比对 tip**。被标 `⚠` 的验证记录一律当历史看，不当结论。
3. **认领未提交改动**。不是你的，就别碰 —— 先问那个会话（`ListAgents` /
   `SendMessage`），把范围说清楚再动手。这一步不是礼貌，是 AGENTS §16。
4. 照卡上那条「下一条可执行动作」继续。

**不新增「是否继续」这类询问**（AGENTS §1：排序类四问永远不问）。接回来就是接着做。

## 3. 事件接线：有就用，没有就明说

| 事件 | 现状 | 做法 |
| --- | --- | --- |
| Claude `PreToolUse` | 已接 `gate_dispatch.py`（提交闸门） | 不动 |
| Claude `SessionStart` | **接线未落**（见下） | 想接就跑 `resume --brief`：干净的树 + 没有过期快照时它**一个字都不输出** |
| Claude `PreCompact` | 未接 | 顶多提示「该更新卡上的证据了」，**不许**让脚本代写进度 |
| Codex 生命周期事件 | **UNKNOWN** | 本机没有核实过它支持哪些事件。**不接线、不假设**，用第 1/2 节的显式步骤 |

`SessionStart` 那一行为什么还没接：实施 Agent 的会话权限层拒绝编辑
`.claude/settings.json`（配置文件受保护）。这是外部限制，不绕过。要接的话，
往 `.claude/settings.json` 的 `hooks` 里加：

```json
"SessionStart": [
  { "hooks": [ { "type": "command",
      "command": "python \"$CLAUDE_PROJECT_DIR/.claude/tools/agent_harness.py\" resume --brief",
      "timeout": 20000 } ] }
]
```

**噪声评估**（上游 runtime-wiring 的要求，本项目照做）：这段输出会进**每个会话**
的上下文，所以成本是永久的、收益只在「确实有事」时出现。因此 `--brief` 的规矩是
**没话说就一个字都不说**，而且只说两件事：工作树里有别人的改动、某条验证记录的
tip 已经变了。两件都是上面第 0 节那两个真实事故的直接对应物。

接不上也不要紧 —— 第 2 节那条命令自己跑一遍就是同样的东西。
**缺 hook 支持不得变成一道新的人工闸**（AGENTS §1）。
