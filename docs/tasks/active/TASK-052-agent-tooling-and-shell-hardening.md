# TASK-052 — Agent 工装与 workspace_shell 加固（审查遗留收口）

- 状态：**部分已闭合（2026-08-23 复查）—— 四条里 2.1 / 2.3 已做，2.2 / 2.4 仍在**。
  ~~待开始~~ 不准确：2.1 被 [TASK-085](../done/TASK-085-gate-intent-detection.md) /
  [ADR-0070](../../adr/ADR-0070-commit-gate-intent-by-shell-parser.md) 整条做掉，
  2.3 也已修。逐条结论就写在下面各小节的开头，**剩 2.2 与 2.4 两条**
- 来源：TASK-051 / TASK-051A 的 codex 审查连续 8 轮反复报出的**范围外**发现
- 提出方式：AGENTS.md §17（范围外问题记录成新任务，不在当前任务里顺手改）

## 1. 背景

TASK-051（表现层重建）与 TASK-051A（AI 导演控制塔）的审查各跑了 3 / 5 轮。
两个任务自己的 blocking findings 已全部修完并有单测锁定；但每一轮审查都会同时
扫到工作树里 **TASK-049 / TASK-050 遗留的未提交改动**，并把其中的问题报为
blocking。它们与 UI 检查点无关，按 AGENTS.md §17 未在那两张卡里修改。

本卡把它们集中收口。**每一条都需要独立复核**——它们来自 AI 审查，未经人工确认。

## 2. 待处理项

### 2.1 commit 门的命令解析（`.claude/hooks/gate.sh` / `gate.ps1`）

> **已闭合（2026-08-23 复查）** —— 由 TASK-085 / ADR-0070 整条解决：判定输入从命令
> 文本换成 `(tool_name, 结构化 token)`，Bash 走 `shlex`、PowerShell 由 `gate.ps1` 用
> 自己的 AST 只切分不判定。四条子项逐一对上：分隔符边界 → `_SEPARATOR_CHARS`
> （`;&|()<>` + 反引号 + 换行）；引号形式 → 走词法器不再文本匹配；仓库重定向 →
> `_GIT_REDIRECT_OPTIONS = {-C, --git-dir, --work-tree}` 且 `NAME=value` 前缀被剥离；
> 跨平台互踩 → 判断不出来一律 fail-closed 跑全量。证据在
> `.claude/hooks/commit_gate_policy.py`。


- **分隔符边界**：`commit` token 只接受空白/行尾作边界，`git commit;`、
  `git commit&&…`、`git commit|tee …` 可能整体绕过检查。
- **引号形式**：`git "commit"` 因引号不被视作 token 边界而漏检。
- **仓库重定向**：只检查 Git 自身的选项（`-C` / `--git-dir`），
  `cd ../other && git commit`、`GIT_DIR=../other/.git git commit`
  会在**本仓库**跑完检查后提交**另一个仓库**。
- **跨平台探测互踩**：`gate.sh` 见到 `.venv/Scripts/python.exe` 就 exit 0；
  Linux/WSL 上若 `.venv/bin/python` 缺失或不可执行，PowerShell hook 又不可用，
  则 commit 无检查通过（fail-open）。反向地，`gate.ps1` 在 Ubuntu 宿主上会因
  找不到 `Scripts\python.exe` 而 exit 2，阻断合法提交（fail-closed 到错误方向）。

两个实现必须**同步修**（ADR-0050 决策 1 的行为合同表要求 `.sh` / `.ps1` 等价）。

### 2.2 `src/workspace_shell/server.py` — `_discard_body()` 无超时阻塞读

> **仍未闭合（2026-08-23 复查）—— 只做了一半。** 现在有**字节上界**
> （`_MAX_BODY_BYTES`，见 `server.py:92` 的 docstring），但**没有时间上界**：
> `_Handler` 既无 `timeout` 类属性也没有 `settimeout`。本条描述的向量因此依然成立
> ——**声明一个合法范围内的 `Content-Length` 再慢速发送**，字节上界拦不住它，
> handler 线程照样被占住。缺的还是原文那句「一个 socket deadline / 最大读取时长」。


返回 403/405 之前先无界阻塞读取请求体。客户端声明一个允许范围内的
`Content-Length` 后慢速发送或干脆不发，即可长期占住 handler 线程
（slowloris 类可用性问题）。需要一个 socket deadline / 最大读取时长。

### 2.3 `tests/symlink_support.py` — 跳过判定过宽

> **已闭合（2026-08-23 复查）** —— 现在按 `winerror == _WINDOWS_PRIVILEGE_NOT_HELD`
> 或 `errno in _UNSUPPORTED_ERRNOS` 判定「平台不支持」才 skip，其余 `OSError`
> 直接 `raise`（注释原话：`a broken fixture, not a missing capability`）。
> 「平台不支持」与「fixture 异常」已分开。


POSIX 上把所有 `EACCES` / `EPERM` 都当作「本平台不支持符号链接」而 skip。
真实的权限回归（fixture 目录意外不可写）会被同一条路径吞掉，测试假绿。
需要把「平台不支持」与「fixture 异常」分开。

### 2.4 `.claude/skills/codex-review-loop/scripts/run-review.ps1` — `Test-BinaryFile`

> **仍未闭合（2026-08-23 复查）** —— `run-review.ps1:330` 仍是
> `catch { return $true }`，注释原话 `unreadable -> treat as binary and skip`。
> 被 ACL / 共享锁锁住的源码文件依旧在**没有被审查**的情况下拿到 pass。


读取失败一律判定为二进制，随后**静默跳过**该文件。被 ACL / 共享锁锁住的源码
文件会在没有被审查的情况下拿到 pass。读取失败应当报错，而不是当作二进制。

## 3. 验收

- 每条都要有**针对该绕过路径的测试**（尤其 2.1 的四类形式与 2.2 的慢速客户端）。
- `.sh` / `.ps1` 两个 gate 的行为等价性要有测试或明确的对照说明（ADR-0050）。
- 全量 `pytest` + `ruff` + `node --test` 绿。
