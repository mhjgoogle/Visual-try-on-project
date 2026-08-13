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

想在终端里盯实时状态也可以：

- Ubuntu/WSL2：`tail -f .claude/tmp/review-status.log`
- 原生 Windows：`Get-Content -Wait .claude/tmp/review-status.log`

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
会话本身**）。

Ubuntu/WSL2：

```bash
pkill -f 'run-review\.sh'   # 审查脚本本体
pkill -f 'codex exec'       # 正在运行的 codex 审查
pkill -f 'claude -p'        # 正在运行的 claude 回退审查
```

确认是否还有残留：

```bash
pgrep -af 'run-review\.sh|codex exec|claude -p'
```

原生 Windows（PowerShell）：

```powershell
# 先看有没有残留（脚本本体 / 正在跑的审查器）
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'run-review\.ps1|codex .*exec|claude .*-p' } |
  Select-Object ProcessId, Name, CommandLine

# 确认后按 ProcessId 连子进程一起杀掉
taskkill /T /F /PID <ProcessId>
```

如果审查是作为 Claude Code 后台任务启动的，也可以直接在对话里说
「停掉审查任务」，由会话调用 TaskStop 结束它。

## 两套脚本（ADR-0050）

同一套行为合同有两个实现，按 agent 宿主平台选：

| 宿主 | 提交闸门 | 审查脚本 |
|---|---|---|
| Ubuntu/WSL2（权威开发环境） | `.claude/hooks/gate.sh` | `scripts/run-review.sh` |
| 原生 Windows | `.claude/hooks/gate.ps1` | `scripts/run-review.ps1` |

`.claude/settings.json` 里**两个闸门都注册**，各自在非本平台自动让位：
Windows 上 `gate.sh` 检测到 Windows venv 立即 exit 0，Ubuntu 上 `powershell`
不存在只会产生一条非阻塞提示（PreToolUse 只有 exit 2 才阻塞）。因此任何一个
平台上全新 clone 都是被闸门保护的，不需要手工配置。

审查脚本要**按宿主平台手动选**：**不要在 Windows 上跑 `.sh` 版**——它写死了
`.venv/bin/python`，Windows 上不存在该路径。

Windows 上提交闸门里的 pytest 预算是 600 秒（实测整套跑绿 328 秒，无 tmpfs），
所以一次提交前检查约需 6 分钟，属正常。

**闸门会宁可多拦不可漏拦**：它只看命令文本，凡是同时出现 `git` 和独立的
`commit` 词就跑全套检查——包括只是「提到」提交的命令（例如往文件里写一段讲
提交的说明）。这是故意的：用正则解析 shell 命令行必然漏掉某些写法（带空格的
引号路径等），而漏掉一次就等于那次提交完全没被检查。多拦一次只多花 6 分钟。
命令里出现 `-C` / `--git-dir` / `--work-tree` 时会直接拒绝并说明原因——检查只
覆盖本仓库，闸门不为没看过的代码背书。用 Edit/Write 工具改文件不受影响（闸门
只挂在 Bash / PowerShell 上）。

## 可调参数（环境变量，运行前 export / `$env:` 赋值）

| 变量 | 默认 | 作用 |
|---|---|---|
| `REVIEW_TIMEOUT` | 1800 | 单个审查器的秒级硬超时 |
| `REVIEW_MAX_DIFF_LINES` | 4000 | diff 超过此行数拒绝审查（省 token） |
| `REVIEW_DIFF_CONTEXT` | 1 | diff 上下文行数 |
| `REVIEW_EXTRA_EXCLUDES` | 空 | 额外排除的 pathspec（空格分隔） |
| `REVIEW_OUT_FILE` | `.claude/tmp/last-review-output.txt` | 原始输出落盘位置 |
| `REVIEW_STATUS_FILE` | `.claude/tmp/review-status.log` | 实时状态日志位置 |
| `REVIEW_TASK` | 空 | 任务标识（如 `TASK-026`）；设置后状态日志每行都带 `[TASK-026]` 前缀，标明这次审查属于哪个任务 |
| `REVIEW_CODEX_BIN` | 空 | **仅 `.ps1` 版**：codex 可执行文件绝对路径（Windows 上 codex 常装在用户目录、不在 `PATH`）；路径不存在时视为「未安装」 |
| `REVIEW_CLAUDE_BIN` | 空 | **仅 `.ps1` 版**：claude 可执行文件绝对路径，同上 |

## 已知环境事实

- codex 有周配额；配额耗尽时会自动回退 claude，属预期降级，不是故障。
- Windows 上 `codex` / `claude` 通常不在 `PATH`（VS Code 扩展自带的二进制、
  带哈希的安装目录）。若脚本报 `ENV_ERROR: neither codex nor claude is
  installed`，用上面两个 `REVIEW_*_BIN` 变量直接指向可执行文件即可。
- 审查结果全部落盘，Claude Code 会话即使中途断流（API error），重连后
  也能从上面三个文件恢复结论，不需要重跑审查。
