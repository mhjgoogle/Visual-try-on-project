# ADR-0062：原生 Windows 成为权威开发/构建/CI/agent 环境

- 状态：Accepted
- 日期：2026-08-12
- 决策者：产品负责人（本条为其明确指示）
- 关联：[ADR-0049](ADR-0049-native-windows-run-and-test-target.md)（本 ADR 反转其
  「环境权威」部分，其余部分继续有效）、
  [ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md)（其「例外」升格为常态）、
  [ADR-0051](ADR-0051-per-project-asset-root-and-runtime-selection.md)、
  [ADR-0053](ADR-0053-project-rooted-studio-storage.md)

> **先说清一件容易读错的事**：「Ubuntu 是受支持目标」**不等于本机要常驻一个 WSL**。
> 受支持目标由**云端 CI 的 ubuntu runner** 验证（`.github/workflows/ci.yml`），不占
> 开发机任何内存。本机 WSL 只在需要某个只装在那边的工具时才启动，用完
> `wsl --shutdown` 即可释放（实测 1.05 GB → 0.03 GB）。**日常开发不需要它。**

## 1. 背景（改之前的状态，不是本 ADR 的结论）

ADR-0049 之前，WSL2 Ubuntu 是唯一的开发环境；ADR-0049 把原生 Windows 提升为
**受支持的运行+测试目标**，而当时**权威环境仍然是 Ubuntu**——这正是本 ADR 要反转的
那一点（见第 2 节决策 1）。AGENTS.md §2–§6 按那个旧前提写成：POSIX-only 路径语义、
禁止 PowerShell、仓库须在 `/home` 下、工具须在 Ubuntu 内解析。

实际使用中这个前提已经不成立，而且代价是可测量的（2026-08-12 实测）：

| 事实 | 数据 |
| --- | --- |
| 仓库实际位置 | `D:\02_Work\04_video-work\Visual-try-on-project`（NTFS），**不在 `/home` 下** |
| 前端 715 项测试 | 原生 Windows **约 0.13 s/文件**；WSL 跨 `/mnt/d` 约 **17 s** 全量 |
| WSL 常驻内存 | **1.05 GB**（`wsl --shutdown` 后降到 0.03 GB） |
| WSL git 与 Windows git | `core.autocrlf` 不一致 → WSL 侧把每个文本文件算成全量改动（**149,986 行 vs 1,918 行**），审查器要么拒绝要么审噪声 |
| 工具链实际所在 | Node LTS、npm、FFmpeg 9.0、Claude Code 都装在 **Windows**；WSL 侧另装一套是重复维护 |
| ADR-0049 的运行目标实测 | `serve.py` 在 cp932 控制台上**启动即 `UnicodeEncodeError` 退出**——受支持的运行目标其实起不来（本 ADR 同批修复） |

也就是说：权威环境写的是 Ubuntu，但开发、测试、渲染、审查实际都发生在 Windows 上，
而 WSL 带来的是一份重复的工具链、一层文件系统跨界惩罚、一个行尾语义分歧和 1 GB 内存。

## 2. 决策

### 决策 1：权威环境为原生 Windows；Ubuntu / WSL2 降为受支持目标

```
权威（authoritative）    原生 Windows + NTFS
受支持（supported）      Ubuntu / WSL2、Linux CI runner
```

「权威」的含义不变：**它是行为差异的裁决者**。两个环境结论不一致时，以 Windows 为准；
Ubuntu 上的失败仍然是缺陷，只是不再是裁决基准。

**「受支持」在哪里被验证：云端 CI，不是开发机。**

| | 权威 Windows | 受支持 Ubuntu |
| --- | --- | --- |
| 日常开发 / 测试 / 渲染 / 提交 | ✅ 全部在此 | ❌ 不需要 |
| 在哪验证 | 开发机 + `windows-latest` runner | **仅** `ubuntu-latest` runner |
| 占用开发机内存 | — | **0**（本机不需要常驻 WSL） |

开发机上安装 WSL 是**可选便利**，不是要求。若某个工具只装在 WSL（本次为 `codex`
与 playwright 的无头浏览器），用完 `wsl --shutdown` 释放；把这些工具装到 Windows 后，
本机 WSL 可以完全不启动。

### 决策 2：跨平台中立性**不因此放松**

这是本 ADR 最容易被误读的地方，所以写在决策位而不是后果位：

> 反转的是**权威归属**，不是**代码可以开始关心自己跑在哪**。

因此以下继续强制：

- 路径一律走 `pathlib` / stdlib；**不得硬编码分隔符**，不得硬编码
  `C:\Users\...` 或 `/home/...`；
- 不得使用平台专属 syscall；
- 所有外部工具（ffmpeg / ffprobe / piper / claude / codex / node）一律经
  `shutil.which` 解析、**失败即 fail-closed**，不得裸名调用。

原 §3 的「只使用 Linux/POSIX 语义」这条表述被撤销：它的真实目的是可移植性，而
「以某一个 OS 的语义为准」恰恰是可移植性的反面。**目标不是 POSIX，是平台中立。**

`shutil.which` 这一条在 Windows 权威下比以前更重要，本次实测即为例证：Windows 安装器
改了 PATH，但早于安装启动的进程（agent shell、commit gate 的 hook）看不到新 PATH，
于是 `node` / `ffmpeg` 解析失败。**这不是缺陷，是必须被 fail-closed 如实报告的状态**，
处理办法是重启会话，而不是让代码去猜路径。

### 决策 3：PowerShell 从「例外」升为常态；`.sh` 变体保留

ADR-0050 曾把 agent 工装用 PowerShell 列为**例外二**。现在反过来：

- **agent 工装**（`.claude/hooks/`、skill 脚本及其 settings 接线）以 PowerShell
  (`.ps1`) 为权威实现；
- 对应的 `.sh` 变体**保留**，服务于受支持的 Ubuntu 目标，并继续遵守 ADR-0050 决策 1
  的同一行为合同表——两者必须给出相同的判定；
- **流水线与产品代码不受影响**：它们既不用 PowerShell 也不用 bash，见决策 2。

面向 Windows 用户的 `.ps1` / `.bat` 启动器（ADR-0049 例外一）不再需要「例外」这个
定语，它就是主入口。

### 决策 4：权威仓库位置为 NTFS

原「仓库须保留在 Ubuntu `/home` 下、不得放在 `/mnt/c`」撤销。权威仓库就在 Windows
NTFS 上（当前 `D:\02_Work\04_video-work\Visual-try-on-project`），同卷要求（ADR-0049）
继续有效。

**在 WSL 里对该仓库执行 git 时必须对齐行尾语义**，否则 diff 完全失真：

```
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=true
```

这是使用受支持目标时的已知注意事项，不改共享配置。

### 决策 5：CI 两个 job 都保留，权威标签互换

`.github/workflows/ci.yml` 的两个 job 步骤本来就完全相同，因此只换标签与注释：

```
windows-latest   Windows（权威）        必须绿
ubuntu-latest    Ubuntu（兼容性验证）    必须绿
```

**两个都必须绿**这一点不变——把 Ubuntu 降级为「可以红」等于放弃它作为受支持目标。

## 3. 后果

### 正面

- 权威环境与实际工作环境一致：不再出现「按文档该在 Ubuntu 跑、实际在 Windows 跑」
  的双轨。
- 少一份重复工具链、少一层 `/mnt/d` 跨界惩罚（前端测试快约两个数量级）、少 1 GB 常驻内存。
- 行尾语义分歧从「每次审查都要绕」变成「使用受支持目标时的一条已知注意事项」。

### 代价与风险

- **平台中立性失去了一个天然的执行者。** 以前「权威是 Linux」会自动惩罚任何
  Windows-only 假设；现在不会了。防线只剩决策 2 的规则 + Ubuntu CI job 必须绿。
  **Ubuntu job 的绿色因此比以前更重要，不是更不重要。**
- Windows 特有的坑现在会先在权威路径上出现：控制台代码页（cp932 已实证）、路径长度、
  文件锁、大小写不敏感。相应的测试要跟上。
- `.sh` 工装变体的实际执行频率下降，容易腐化。ADR-0050 的合同表是唯一保障，改动
  任一侧都必须同时改另一侧。

### 需要同步修改（本批完成）

- `AGENTS.md` §2 规则 2 / 3 / 4 / 5 / 6
- `.github/workflows/ci.yml` 的 job 名称与顶部注释
- `mockups/motv-workspace/serve.py`：cp932 控制台上的启动崩溃（决策 1 的直接后果：
  受支持的运行目标必须真的能起来）

### 明确不做

- 不删除 WSL 相关的 `.sh` 工装与 Ubuntu CI job。
- 不放松决策 2 的任何一条。
- 不因为「Windows 是权威」而向流水线代码引入 PowerShell、CMD 或 Windows 路径。
