# codex-review-loop 使用说明（给人看的）

实施任务完成后自动触发的「审查 → 修复」循环。审查器优先用 codex
（跨模型独立审查），codex 不可用时自动回退到独立的 claude 会话
（独立性降级，报告中会注明）。本文档回答两个问题：**在哪里看进展**、
**出问题怎么停掉**。

## 在哪里看输出（不用开终端）

下面三个文件直接在 VS Code 里打开即可；文件在磁盘上更新时编辑器会
自动刷新。它们都在首次运行时由脚本自动创建，之前不存在是正常的。

| 文件 | 内容 | 更新时机 |
|---|---|---|
| [.claude/tmp/review-status.log](../../tmp/review-status.log) | 实时状态：每个关键节点一行（启动、diff 行数、正在用哪个审查器、成功/失败/回退、每轮循环进展、最终结论） | **实时追加**，看这个判断死活 |
| [.claude/tmp/last-review-output.txt](../../tmp/last-review-output.txt) | 最近一次审查器的原始输出（REVIEWER / VERDICT / 逐条发现） | 每次审查结束时整体写入 |
| [.claude/tmp/last-review.md](../../tmp/last-review.md) | 最终审查报告（轮数、结论、修了什么、遗留 P3/P4） | 整个循环结束时写入 |

想在终端里盯实时状态也可以：`tail -f .claude/tmp/review-status.log`。

## 正常运行是什么样的（不要误判为卡死）

- 预检（diff 计算、大小检查）：几秒内完成。
- **codex 审查一次要 6–10 分钟**，claude 回退审查也要 5–10 分钟——期间
  status 日志会停在 `codex reviewing…` 这一行，这是正常的，不是挂了。
- 每个审查器有 1800 秒（30 分钟）硬超时，超时会自动回退或报 `ENV_ERROR`
  退出，**脚本不会永远卡住**。上限故意放宽：误杀一次快出结论的审查，代价是
  整轮重来并额外消耗 claude 配额；而真挂死很罕见，多等一会儿无妨。
- 判断标准：status 日志最后一行是 `… reviewing…` 且距今不到 30 分钟 →
  正常；最后一行是 `ENV_ERROR: …` / `DIFF_TOO_LARGE: …` → 出错已停止；
  超过 35 分钟没有任何新行 → 才可能真的挂了，按下面方法处理。

## 出问题怎么停掉进程

在任意终端执行（只会杀审查相关子进程，**不影响你正在用的 Claude Code
会话本身**）：

```bash
pkill -f 'run-review\.sh'   # 审查脚本本体
pkill -f 'codex exec'       # 正在运行的 codex 审查
pkill -f 'claude -p'        # 正在运行的 claude 回退审查
```

确认是否还有残留：

```bash
pgrep -af 'run-review\.sh|codex exec|claude -p'
```

如果审查是作为 Claude Code 后台任务启动的，也可以直接在对话里说
「停掉审查任务」，由会话调用 TaskStop 结束它。

## 可调参数（环境变量，运行前 export）

| 变量 | 默认 | 作用 |
|---|---|---|
| `REVIEW_TIMEOUT` | 1800 | 单个审查器的秒级硬超时 |
| `REVIEW_MAX_DIFF_LINES` | 4000 | diff 超过此行数拒绝审查（省 token） |
| `REVIEW_DIFF_CONTEXT` | 1 | diff 上下文行数 |
| `REVIEW_EXTRA_EXCLUDES` | 空 | 额外排除的 pathspec（空格分隔） |
| `REVIEW_OUT_FILE` | `.claude/tmp/last-review-output.txt` | 原始输出落盘位置 |
| `REVIEW_STATUS_FILE` | `.claude/tmp/review-status.log` | 实时状态日志位置 |
| `REVIEW_TASK` | 空 | 任务标识（如 `TASK-026`）；设置后状态日志每行都带 `[TASK-026]` 前缀，标明这次审查属于哪个任务 |

## 已知环境事实

- codex 有周配额；配额耗尽时会自动回退 claude，属预期降级，不是故障。
- 审查结果全部落盘，Claude Code 会话即使中途断流（API error），重连后
  也能从上面三个文件恢复结论，不需要重跑审查。
