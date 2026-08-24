# TASK-053 — 在界面里选任意路径，后端就往那儿写

- 状态：**已验收并收口**（2026-08-13，随 ADR-0051 一并收口）
- 实施基线：`ae0a54a`
- ADR：[ADR-0051](../../adr/ADR-0051-per-project-asset-root-and-runtime-selection.md)
  （**Accepted**，决策 1–5 全部保留，无决策被取代）
- **后续归属**：能力完整保留。仅**呈现位置**迁移 —— 项目位置的选择与展示归
  「⚙ 项目设置 · 项目」（[ADR-0066](../../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) IA §4），
  由 [TASK-073](../done/TASK-073-fixed-ia-and-contextual-agent.md) §1.7 承接。
  `rootadmit.py` 的准入策略与 containment 语义**不动**。
- ADR：[ADR-0051](../../adr/ADR-0051-per-project-asset-root-and-runtime-selection.md)（Proposed）
- 前置：[TASK-051B](TASK-051B-landing-and-new-project.md)
- 触发：用户明确要求——「我要的就是在界面里选任意路径、后端就往那儿写」；
  并确认了两个设计决策：**目录选择器**（而不是只手输）与
  **拒绝清单 + 首次确认**（而不是完全不限制或启动时白名单）。

## 1. 变更

- 「资产保存位置」改称 **「项目保存位置」**。
- 对话框只保留**一个** `选择…` 按钮：点开目录选择器，逐层进入，
  「选择这个文件夹」后路径直接回填，下面实时显示
  `项目将创建在 <位置>\<项目名>`。位置不再是手输的文本框。
- 连接模式下，**后端真的创建目录**：`<位置>/<项目名>/project.json`，
  并把项目登记进 `data/projects.json`，重启后仍在列表里。

## 2. 服务端

| 接口 | 作用 |
| --- | --- |
| `GET /api/fs/default` | 后端的默认位置（即 `--account-root`） |
| `GET /api/fs/list?path=` | **只读**列目录：只返回子目录名与路径，不返回文件、不返回内容；跳过隐藏项；上限 500 条并如实标注截断 |
| `POST /api/projects` | 准入 → 建目录 → 登记；返回 `project_path` |

三者都在既有的 loopback host 守卫与 Origin 守卫之下（ADR-0032）。

**账户根从单一启动常量变为每项目属性**：`self._projects` 本来就是
`name → project_root`，所以每条 per-project 路由不用改；启动时在
`discover_projects(account_root)` 之上叠加注册表。注册表里目录已消失的项目
**直接丢弃**，不会当幽灵项目继续提供。

## 3. 准入策略（`mockups/motv-workspace/rootadmit.py`）

这是整个功能的安全边界，独立成模块以便完整单测：

- 绝对路径；`realpath` 后仍是目录；不存在则创建（并如实回报 `created`）；
- **逃逸 symlink 拒绝**：解析后的位置必须仍在声明路径之下；
- **拒绝清单**：盘符/文件系统根、系统目录（`%SystemRoot%`/`%ProgramFiles%`/
  `%ProgramData%`、`/etc` `/usr` `/bin` `/var` …）、**本仓库整棵树**、
  主目录本身（子目录允许）；
- **可写性靠真写**：建再删一个探针目录，不读权限位（NTFS ACL / NFS 会骗人），
  且探针不留痕；
- **首次确认**：新位置返回 `409 root_unconfirmed` + 说明，界面确认后带
  `confirm: true` 重发；已确认的根记入 `confirmedRoots`，此后不再问。
  **确认不能绕过拒绝清单**（有专门单测）。

项目名在**服务端也校验一遍**（长度、非法字符、`.`/空格结尾、Windows 保留名），
不信任页面。

## 4. 演示模式

演示模式没有后端，因此没有文件系统访问：`选择…` 会如实提示
「目录选择需要连接模式」，创建仍是原型本地记录。要让后端真正建目录并写入，
用 `./run-windows.ps1 -Connected`（`-AssetRoot` 默认取仓库父目录）。

## 5. 验收

- `python -m pytest`：2791 passed, 67 skipped（跳过项为本机无 symlink 特权的
  POSIX-only 用例，ADR-0049）。新增
  - `tests/test_motv_root_admission.py`（19 项）——准入策略；
  - `tests/test_motv_project_create_api.py`（16 项）——HTTP 面：列目录只出目录、
    拒绝相对路径、首次确认、确认后建目录并登记、**非空同名文件夹拒绝覆盖**、
    仓库被拒、非法项目名被拒、注册表跨重启存活、目录消失的项目被丢弃。
- `node --test`：384 项全绿；`ruff check` / `format --check` 通过。
- `codex-review-loop`：5 轮，reviewer 全程为 **codex**（未回退，独立性未降级）。
  13 项 in-scope P1/P2 已修（空 symlink 检查、确认早于 mkdir、junction 逃逸、
  两处回滚、注册表 containment 与竞态、列目录失败后的陈旧路径、项目名控制字符
  等）。第 5 轮 5 条 finding 全部落在 TASK-052 文件上，按 §17 记录不改。
  报告：`.claude/tmp/last-review.md`。
- 端到端实测（Playwright + 真实后端）：默认位置来自后端 → 点 `选择…` →
  进入 `media/2026` → 选定 → 预览路径 → 创建 → **磁盘上出现
  `media/2026/雨夜停电/project.json`**，`data/projects.json` 同时记录了项目与
  已确认的根。

## 6. 不在本卡范围

跨根迁移/移动项目、远程或网络根的凭据、多用户隔离。
