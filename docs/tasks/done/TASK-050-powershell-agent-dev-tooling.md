# TASK-050: agent 开发工装 PowerShell 原生化（Windows 宿主）

- Status: Delivered（2026-08-10）
- Owner: 单实施 Agent
- 依据: [ADR-0050](../../adr/ADR-0050-powershell-native-agent-dev-tooling.md)
  （agent 工装在 Windows 宿主上使用 PowerShell；supersede ADR-0049 Not Decided
  Here 第 1 条）、ADR-0049、ADR-0007（文档权威与 supersession）、AGENTS.md 规则 4
  （随 ADR-0050 追加例外二）
- 前置: TASK-049 / ADR-0049 已 Accepted
- 范围: **仅 agent 开发工装**——`.claude/hooks/` 提交闸门、`codex-review-loop`
  skill 脚本及其 settings 接线与文档。**不含**任何流水线/产品代码、不含产品测试
  的 Windows 修复。

## 背景

Claude Code 现在直接跑在 Windows 宿主上，此时 bash 工装不是「不方便」而是
**静默失效**：`gate.sh` 写死 `$ROOT/.venv/bin/python`（Windows 上为
`.venv/Scripts/python.exe`），`bash` 又会解析到 WSL 的 `bash.exe`；两个脚本还依赖
coreutils（`timeout`/`mktemp`/`date`/`wc`/`sed`）与 bash 进程替换。一个跑不了检查
却仍给结论的提交闸门，比没有闸门更危险。

## 目标

在 Windows 宿主上，提交闸门与审查循环具备与 Ubuntu 版**完全一致的行为合同**，
且不依赖 Git Bash/WSL/coreutils。

## 交付物

- `.claude/hooks/gate.ps1`——`gate.sh` 的 PowerShell 原生等价实现。
- `.claude/skills/codex-review-loop/scripts/run-review.ps1`——`run-review.sh` 的
  PowerShell 原生等价实现（新增 `REVIEW_CODEX_BIN` / `REVIEW_CLAUDE_BIN`）。
- `.claude/settings.json`：`PreToolUse` **同时注册两个闸门**（`gate.sh`
  `timeout: 270` + `gate.ps1` `timeout: 650`），matcher `Bash|PowerShell`
  （Windows 宿主上 agent 走 PowerShell 执行 git，只匹配 `Bash` 会漏掉提交
  路径）。任一平台全新 clone 都被闸门保护，无需手工配置；依据见 ADR-0050
  决策 3。
- `.sh` 版本仍是 Ubuntu 权威实现，仅做**契约对齐的最小修改**：`gate.sh` 增加
  Windows-venv 让位守卫与同一套 commit 检测正则；`run-review.sh` 同步
  `ls-files -z` 与严格 VERDICT 校验（两者都是审查发现的同类缺陷）。
- 文档：ADR-0050；ADR-0049 supersede 注记；AGENTS.md 规则 4 例外二；README
  Windows 段；skill 的 `SKILL.md` 与 `README.md` 双平台说明。

## 验收（本机实测，2026-08-10）

| 项 | 结果 |
|---|---|
| gate：非 commit 命令 | exit 0，0.5s，无输出 |
| gate：非 JSON stdin 兜底 / `git commits` 近似串 | exit 0（不误伤） |
| gate：`git -c k=v commit` / `git.exe commit` / `git commit --amend` | 识别为提交并执行检查（两版正则各 8 正例 / 5 反例过） |
| gate：提交被重定向到别的仓库（`-C` / `--git-dir` / `--work-tree`） | exit 2 并说明原因（不为没检查过的树背书） |
| gate.sh 在本机（Windows venv） | exit 0 让位给 gate.ps1，不双重把关 |
| gate：全部检查通过 | exit 0 |
| gate：某检查失败 | exit 2，stderr 含标签与原始输出 |
| gate：某检查挂起 | 到期 `taskkill /T /F`，exit 2 + `[timed out after Ns]`，无残留子进程 |
| gate：真实 `git commit` 经 Claude Code 钩子拦截 | exit 2，430s，输出 pytest 失败清单（650s 钩子超时未触发） |
| gate：PowerShell 工具路径也被拦截 | exit 2（`PreToolUse:PowerShell hook error`，在 ruff 阶段约 2s 拦下） |
| 全量 pytest（本机原生 Windows） | `2752 passed, 63 skipped, 0 failed in 328s`（修完 TASK-049 的 3 处缺口后） |
| review：`ENV_ERROR`（坏 base ref / 无审查器）、`NO_CHANGES`、`DIFF_TOO_LARGE` | 均 exit 0，文案与 `.sh` 版一致 |
| review：未跟踪文本文件计入 diff、二进制文件跳过 | 通过 |
| review：非 ASCII 文件名的未跟踪文件（`模块_new.py`）计入 diff | 通过（`ls-files -z`；不加 `-z` 时 git 会 C-quote 成 `"\346\250\241…"` 而被静默丢弃） |
| review：`VERDICT: unknown` / 行内提及 不再算完成审查 | 通过（两版各 3 正例 / 3 反例） |
| review：codex 真实审查 | `REVIEWER: codex` + `VERDICT: fail` + 逐条发现 |
| review：codex 失败 → claude 回退 | 回退成功，含 `INDEPENDENCE: degraded` 与失败原因 |
| review：状态日志与输出镜像文件 | 均按 `[时间] [TASK] …` 追加/落盘 |

## 审查（codex-review-loop）

- 第 1 轮：codex，`VERDICT: fail`，4 blocking + 1 non-blocking。全部按类修复
  （不止修被点到的那一行）：
  - P1 settings.json：Ubuntu 全新 clone 会没有闸门 → 改为双注册 + `gate.sh`
    让位守卫（依据：PreToolUse 只有 exit 2 阻塞、hooks 跨 settings 合并且并行）。
  - P1 commit 检测漏 `git -C/-c/--opt` 与 `git.exe` → 两版正则同步收紧。
  - P1 `ls-files` 未用 `-z`，非 ASCII 路径被 C-quote 后静默漏审 → 两版同步。
  - P2 只要出现 `VERDICT:` 就算完成审查 → 两版改为必须 `pass|fail` 且行首锚定。
  - P2（原报为 non-blocking，自评升级）stdin 同步写在计时之前，prompt 远大于
    64 KB 管道缓冲，审查器不读 stdin 就会永久阻塞、超时形同虚设 → 改为
    `WriteAsync` + 截止时间，并把 `WaitForExit()` / `Task.Result` 全部改成有界
    等待（杀进程树失败时不再无限挂住）。
- 第 2 轮：codex，`VERDICT: fail`，4 blocking + 1 non-blocking。修 4 条、驳回 1 条：
  - P1 VERDICT 正则把模板行 `VERDICT: pass|fail` 也判为有效（`|` 满足「非字母
    数字」）→ 两版改为后随空白或行尾。
  - P1 闸门识别出 `git -C 别的仓库 commit` 后，检查仍跑在**本仓库**，等于为没
    看过的代码背书 → 两版改为 fail-closed：命中 `-C` / `--git-dir` /
    `--work-tree` 直接 exit 2 并说明要在那个仓库里提交。PowerShell 侧必须用
    `-cmatch`，否则默认大小写不敏感会把 `git -c k=v`（配置覆盖）误判为 `-C`。
  - P1 钩子外层超时只比检查预算多 4 秒，杀进程/收流的开销会顶破它；而外层超时
    是**非阻塞**错误 → 提交反而放行（fail-open）。两个入口分别放宽到 290s /
    700s，并在两个脚本里写明这段余量是干什么的。
  - P2 `symlink_or_skip` 吞掉所有 `OSError`，缺父目录等 fixture 自身错误会被
    伪装成 skip、静默丢掉安全覆盖 → 只在 `WinError 1314` / `EPERM` / `EACCES`
    / `ENOSYS` 时 skip，其余原样抛出（已用 ENOENT 实测会抛）。
  - **驳回（uncertain）**：「`Resolve-Reviewer` 返回 npm `.cmd`/`.bat` shim 时
    `UseShellExecute=false` 起不来」。本机实测 `Process.Start` 能直接执行 `.cmd`
    并正确传参（`fakecodex.cmd exec --sandbox read-only -` 正常返回），不成立；
    未加无谓的 `cmd.exe /c` 包装。

- 第 3 轮：codex，`VERDICT: fail`，3 blocking，全部修复：
  - P1 检测正则解析不了带引号的选项值（`git -C "D:\有空格 的仓库" commit` 整个
    被判为「不是提交」→ 所有检查被跳过）。**改变思路**：不再试图解析 git 的参数
    语法——regex 解析 shell 命令行注定漏，而每漏一种写法就是一次完全不设防的
    提交。改为两个独立 token 判定：命令里是否出现 `git`，以及是否出现独立的
    `commit` token。过度拦截只多跑一次检查，漏判则等于没有闸门。
  - P1 `-cmatch` 把整条重定向正则都变成大小写敏感，`Git -C x commit` 漏判 →
    大小写敏感只作用在**选项 token** 上（`-C` vs `-c`），`git` 本身仍不敏感。
  - P1 `git diff` 的结果没检查 `ExitCode` / `TimedOut`，失败或超时会退化成
    `NO_CHANGES` 或残缺 diff——等于给没人看过的代码发合格证。两版都改为
    fail-closed（新增 `Invoke-GitDiffOrFail` / `append_diff`）。
  - 顺带发现并修掉两个**只有真跑才会暴露**的 bash 缺陷：`$(git ls-files -z)`
    会被命令替换吞掉 NUL 分隔符（多个未跟踪文件被粘成一个打不开的名字、全部漏
    审）→ 改走临时文件；`$(...)` 剥掉每段 diff 末尾换行，导致相邻两段被粘成
    一行畸形 diff（3 个新文件应 21 行，实测 19 行）→ 统一经 `append_chunk`
    补回换行。修后 bash 与 PowerShell 两版对同一场景给出一致结果。

## 遗留（不在本任务范围，见 ADR-0050 Not Decided Here）

- 两套实现的去重、`pwsh` 7 验证、工装进 CI，均未决。
- 本机 symlink 相关用例走 skip；要在本机获得真实覆盖需开启 Windows 开发者
  模式（Linux 与 Windows CI 不受影响，仍是验证记录）。
