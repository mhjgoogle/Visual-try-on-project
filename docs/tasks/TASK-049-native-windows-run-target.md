# TASK-049: 冻结 V1 并使其在原生 Windows 上可复现运行

- Status: In Progress
- Owner: 单实施 Agent
- 依据: ADR-0049（原生 Windows 作为受支持的运行+测试目标；supersede ADR-0001
  的 WSL-only 平台范围）、ADR-0007（文档权威与 supersession 规则）、AGENTS.md §2
  （环境约束，本任务随 ADR-0049 修订）
- 前置: M3–M11 + V1 验收 Done（feat/wfm1-batch-c，7c32152）
- 范围: 全仓库运行时可移植性（`src/`、`mockups/motv-workspace/`）、Windows 启动器
  与文档、测试套件跨平台化、Windows CI。**不含** bash agent 工具链移植（gate.sh /
  codex-review-loop 保持 Ubuntu-only，见 ADR-0049 Not Decided Here）。

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

## 非目标（明确排除）

- 不移植 bash agent 工具链（gate.sh / codex-review-loop）到 Windows。
- 不支持 FAT/exFAT/网络共享（仅 NTFS 同卷）。
- 不做 macOS 支持。
- 不改任何已冻结的数据模型/Provider/编排/QCD/路径安全/合成契约的语义（仅加平台分支）。
