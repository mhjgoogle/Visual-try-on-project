# TASK-049: 冻结 V1 并使其在原生 Windows 上可复现运行

- Status: **Done（2026-08-23 复查）** —— 目标已达成**并被超越**：`.github/workflows/ci.yml` 里
  Windows job 存在且已是**权威**那个（`name: Windows (authoritative, ADR-0062)`），
  [ADR-0062](../../adr/ADR-0062-windows-authoritative-environment.md) 已把 ADR-0049 的
  「环境权威」部分从「受支持目标」反转为「权威」；2026-08-23 在原生 Windows 上跑过
  完整全量（pytest 3333 passed / 58 skipped + serial 6 + 前端 1807 + ruff 591 文件）。
  ~~In Progress~~ 是状态漂移，本卡要的东西早已成立
- Owner: 单实施 Agent
- 依据: ADR-0049（原生 Windows 作为受支持的运行+测试目标；supersede ADR-0001
  的 WSL-only 平台范围）、ADR-0007（文档权威与 supersession 规则）、AGENTS.md §2
  （环境约束，本任务随 ADR-0049 修订）
- 前置: M3–M11 + V1 验收 Done（feat/wfm1-batch-c，7c32152）
- 范围: 全仓库运行时可移植性（`src/`、`mockups/motv-workspace/`）、Windows 启动器
  与文档、测试套件跨平台化、Windows CI。**不含** bash agent 工具链移植（gate.sh /
  codex-review-loop 保持 Ubuntu-only，见 ADR-0049 Not Decided Here）。
  > 该排除项仅限本任务：agent 工装的 PowerShell 原生版已由 ADR-0050 / TASK-050
  > 单独承接，不改变本任务的范围与验收。

## 背景

V1 已在权威 WSL2 Ubuntu 环境冻结。需让 V1 在原生 Windows（Windows Python，无
WSL）上可复现运行与测试。全仓审计（三路并行）表明阻塞面小而集中：核心包零第三方
运行时依赖、文本 I/O 全 UTF-8；真正阻塞为少量 POSIX-only 机制 + WSL-only 文档 +
依赖 `grep`/`/bin/sh` 的测试。

## 目标

原生 Windows 上：核心流水线/CLI 可导入并运行、motv 原型三模式（演示/连接/FFmpeg
渲染）可用、完整测试套件可跑绿；同时 Linux 权威平台零回归。跨平台正确性以
Windows CI 作为记录性验证（本地无法运行原生 Windows）。

## 实施要点

### 1. 跨平台文件锁 shim（fcntl 导入墙）
新增 `src/ai_video_workflow/_fslock.py`：`flock_exclusive(fd)`/`flock_unlock(fd)`，
POSIX 走 `fcntl.flock`、Windows 走 `msvcrt.locking`（惰性按平台 import，Windows
永不 `import fcntl`）。替换 `appendlog.py`、`evaluation/log.py`、`gateway/service.py`、
`budget/lock.py` 的 fcntl 用法。

### 2. 加固 opener 的平台分支
`appendlog.py` 与 `evaluation/log.py` 的符号链接加固遍历（`O_NOFOLLOW`/`O_DIRECTORY`/
`dir_fd`/`os.pread`/`os.fchmod`/`st_nlink`）：POSIX 保持不变；Windows 分支改用既有
`security.resolve_within_root` 包含性校验 + `is_symlink()`/`S_ISREG` 守卫（去掉
Windows 上不可靠的 `st_nlink`），并在站点注明降级的符号链接保证（Windows 建符号链接
需提权，单用户模型下可接受）。

### 3. 其余 POSIX 假设
- `workspace_shell/app.py` `/proc/self/fd` 再包含检查：Windows 分支跳过，依赖开前
  包含校验。
- ffmpeg/ffprobe 的 `subprocess.run(text=True)` 4 处加 `encoding="utf-8",
  errors="replace"`（CJK stderr 安全）。
- `os.link` create-only 保持不变；ADR-0049 记录「Windows 需 NTFS 同卷」。

### 4. motv 原型运行时
- `server.py` 的 `claude` 由裸名 `Popen` 改为 `shutil.which` 解析（Windows 处理
  `.cmd`/`.bat`），缺失即 fail-closed 提示。
- Windows 演示模式：新增显式 MIME 的小型静态服务器（`python -m http.server` 在
  Windows 走注册表 MIME 会拒绝执行 ES module），供两平台演示模式使用。
- 修正 `.venv/bin` 等 POSIX-only 提示文案。

### 5. 启动器与文档
- 仓库根 + 原型：`run-windows.ps1`/`run.bat` 双击启动器（venv 建/激活、装依赖、启动），
  及 `.sh` 平价脚本。
- README（仓库 + 原型）新增「原生 Windows 安装与运行」章节（`py -m venv`、
  `.venv\Scripts\activate`、`$env:VAR=`、ffmpeg 安装、启动器）。ADR-0001 加 superseded-by 注记。

### 6. 测试跨平台化
- 约 10 个 `test_motv_*.py` 的 `["grep","-rl",...]` 改为纯 Python 递归内容扫描。
- `test_motv_av_m11.py` 的 `/bin/sh` 假 piper + `/dev/zero` + `/bin/false` + `chmod`
  改为跨平台（Python 经 `sys.executable`）或 Windows 跳过。
- 约 12 个核心库测试的无 `encoding=` `read_text()` 补 `encoding="utf-8"`。

### 7. Windows CI
新增 `.github/workflows/` Windows job（windows-latest、项目 Python、装 FFmpeg、
`pip install -e ".[dev]"`、`pytest`、`node --test`）。

## 测试

- 本地（Linux）：全量 `pytest` + 全量 `node --test` 零回归。
- Windows：CI job 跑绿（记录性验证）。
- 新增单测覆盖锁 shim 与 opener 平台分支的行为。

## 验收

- ADR-0049 Accepted；AGENTS.md §2 已修订；ADR-0001 有 superseded-by 注记。
- Linux 全量测试零回归；Windows CI job 绿。
- codex-review-loop 覆盖数据/状态/文件操作变更并 PASS。

## 补充（2026-08-10，本机原生 Windows 首次跑全量后补齐）

Windows CI 之外首次在**真实开发者机器**上跑全量（TASK-050 的提交闸门要求
suite 全绿），暴露 3 处 CI 覆盖不到的缺口，均属本任务范围：

1. **symlink fixture 需要特权**：33 个用例用 `symlink_to` / `os.symlink`
   构造 fixture，本机无开发者模式时 `WinError 1314`，测试还没跑就失败。新增
   [tests/symlink_support.py](../../tests/symlink_support.py)：
   `symlink_or_skip()` 建不出链接就 skip（沿用 `test_windows_portability.py`
   既有约定）。只守 fixture 构造，被测代码「必须拒绝 symlink」的断言不变；
   Linux 与 Windows CI（runner 有该特权）照常执行，验证记录不受影响。
2. **Windows 换行翻译破坏摘要**：`test_wfm1_e2e.py::test_fault_matrix` 用
   `read_text` / `write_text` 篡改并还原 `planning/brief_v1.json`，Windows 上
   还原写回把 `\n` 变成 `\r\n`，审批摘要永久失配，后续 (c)(d) 段全部走错分支。
   改为字节读写（摘要就是按字节算的）。
3. **遗漏的 `grep` 子进程**：`test_motv_assets_m3.py` /
   `test_motv_shot_bridge_m4c.py` 仍直接 `subprocess.run(["grep", ...])`，
   Windows 上 `grep` 不在 PATH。改用本任务已引入的可移植扫描
   `tests/_scan.py::core_files_containing`（其余 10 处早已改用它）。
4. **Windows 上「拒绝写动词」会把响应打掉（真实产品缺陷，非测试问题）**：
   `src/workspace_shell/server.py::_reject_write` 从不读取声明的请求体就
   `close_connection`。Windows 上关闭仍有未接收数据的 socket 是 **abortive
   close（RST）**，会连带丢弃已发出的 405，客户端只看到
   `ConnectionAbortedError`（WinError 10053），而不是状态码——
   `test_write_verbs_and_loopback_over_real_socket` 因此间歇性失败（前 3 次全量
   都碰巧通过，第 4 次才暴露）。新增 `_discard_body()`：先按 `Content-Length`
   有界丢弃请求体（上限 `_MAX_BODY_BYTES`，chunked / 超限不读），再回响应并
   关闭；同一类问题的跨源 403 路径一并修。修后该用例连跑 8 次全过。

## 待处理：codex 在 TASK-065 审查中对 `_discard_body()` 的发现（范围外转入）

2026-08-12，TASK-065 的 codex 审查扫到了本任务的 `_discard_body()`（当时它还在
working tree 里未提交），报了一条 **P1**：

> `src/workspace_shell/server.py:112` — 客户端声明一个合法大小的 `Content-Length`
> 之后停住不发，`rfile.read()` 会一直阻塞在 405 之前 → 未认证客户端可以占住
> handler 线程，形成拒绝服务。

这条**属于本任务（TASK-049 §4 的修法），不属于 TASK-065**，按 AGENTS.md 第 17 条
（不顺手改范围外代码）原样转记在这里，未在 TASK-065 中修改。

判断与建议（供实施时参考，尚未实施）：

- 缺陷是真的：`_discard_body()` 有**字节上界**（`_MAX_BODY_BYTES`）但**没有时间
  上界**，而 `BaseHTTPRequestHandler` 是每连接一线程。慢速客户端（slowloris 风格）
  声明 1 MB 然后每 30 秒发 1 字节，就能长期占住一个线程。
- 威胁模型需要一并判断：这个 shell server 是**本机只读工作视窗**，默认绑
  loopback。若确认只绑 127.0.0.1 且不接受外部连接，攻击者必须已经能在本机跑代码
  —— 那时整个进程都归他，这条的净收益有限。**但**「只绑 loopback」这件事必须去
  代码里确认，而不是假定。
- 若要修：给 socket 设 `timeout`（`self.connection.settimeout(...)`）并在
  `_discard_body()` 里捕获超时，超时即放弃丢弃、直接关闭（退回 RST 也比挂住线程
  好）；同时确认 `ThreadingHTTPServer` 的 `daemon_threads` 设置。

## 非目标（明确排除）

- 不移植 bash agent 工具链（gate.sh / codex-review-loop）到 Windows。
- 不支持 FAT/exFAT/网络共享（仅 NTFS 同卷）。
- 不做 macOS 支持。
- 不改任何已冻结的数据模型/Provider/编排/QCD/路径安全/合成契约的语义（仅加平台分支）。
