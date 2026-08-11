# ADR-0051: 每项目资产根与运行时选择

- Status: Proposed
- Date: 2026-08-11
- Scope tasks: TASK-053
- 关联：ADR-0004（项目根 containment 与 symlink 策略）、ADR-0032（Workspace
  运行时与 loopback 拓扑）、ADR-0033（Command Gateway 合同）、ADR-0049（原生
  Windows 运行+测试目标）

## Context

原型后端 `mockups/motv-workspace/server.py` 至今只有**一个**账户根：启动参数
`--account-root R` 固定，`discover_projects(R)` 只扫这一个根，所有 per-project
路由都从 `self._projects: dict[str, Path]`（启动时由该根构建）取项目根。

用户的产品要求是明确的：**在界面里选任意路径，后端就往那儿写**——新建项目时
输入项目名、默认落在某个根目录下、也可以改成别的位置。当前实现做不到：换位置
必须重启后端并换 `--account-root`。

这不是表现层问题。它把「后端能写到哪里」从**启动时由操作者固定**，变成
**运行时由页面选择**，因此必须显式决策并记录。

ADR-0004 约束的是「写入必须落在**给定的**项目根之内」。它并不禁止存在多个项目
根——但此前系统里从未有过第二个根，也就从未定义过「谁有权引入一个新根」。

## Decision

### 1. 账户根从「单一启动常量」变为「每项目属性」

- `self._projects` 仍是唯一的 `name → project_root` 映射，**每个项目携带自己的
  根**。既有的每一条 per-project 路由无需改动语义：它们本来就按项目查根。
- `--account-root` 保留，含义收窄为**默认根**：新建项目的默认位置，且启动时
  仍照常 `discover_projects` 扫描它。
- **重启恢复同样受约束**：注册表里的路径在创建时已是 resolve 后的形式，载入时
  必须仍然 `resolve()` 到自身；若某个项目目录在两次运行之间被换成
  symlink/junction，解析结果就会不同，该条目被丢弃而不是继续提供——否则之后
  该项目的所有写入都会跟着链接跑出已准入的根。
- 注册表的读-改-写在一把进程内锁下进行（`ThreadingHTTPServer` 真的并发），
  否则两个并发创建可能互相覆盖，其中一个在返回 201 之后仍然消失。
- 项目→根的映射持久化在 `data/projects.json`（与画布 scratch 同级、同性质的
  原型本地状态，`.gitignore` 已忽略 `data/`），使重启后仍能找回项目。

### 2. ADR-0004 不变，只是按项目根施加

所有 durable 写入继续经 `resolve_within_root(project_root, relative)`。本 ADR
不放宽任何 containment 规则；它只是让 `project_root` 因项目而异。

### 3. 新根的准入规则（拒绝清单 + 首次确认）

引入新根**必须**同时满足：

1. **绝对路径**；`realpath` 解析后仍是**目录**（不存在则可创建，创建后复核）；
2. **先 `realpath`，再判断**：按 ADR-0004 §4，根本身位于 symlink 之下不算逃逸
   （macOS 的 `/tmp`、Windows 的 junction 都是正常用法）。关键是**之后的每一个
   判断——拒绝清单、containment、以及界面上显示给创作者的位置——都针对解析后的
   真实位置**。因此指向仓库或系统目录的 symlink/junction 会被同样拒绝；
   项目目录本身若是 symlink/junction，其解析结果必须仍直接位于已准入的根之下，
   否则创建被拒（Windows 的 junction 在 Python 里 `is_symlink()` 为 False，
   只有这条 containment 检查能拦住它）；
3. **不在拒绝清单内**（任一命中即拒绝）：
   - 盘符根 / 文件系统根（`C:\`、`D:\`、`/`）；
   - 系统目录：Windows 的 `%SystemRoot%`、`%ProgramFiles%`、`%ProgramFiles(x86)%`、
     `%ProgramData%`；POSIX 的 `/etc`、`/usr`、`/bin`、`/sbin`、`/lib`、`/boot`、
     `/dev`、`/proc`、`/sys`、`/var`；以及它们的祖先；
   - **本仓库自身与其 `.venv`**（生成媒体绝不进仓库，AGENTS.md §23）；
   - 用户主目录**本身**（其子目录允许）。
4. **可写**：以实际创建再删除一个探针目录验证，而不是只看权限位；
5. **首次确认**：一个此前未确认过的根，服务端返回 `409 root_unconfirmed` 并
   附上「将要创建什么」的说明；客户端展示后由用户显式确认，再带
   `confirm: true` 重发。已确认的根记入 `data/projects.json` 的
   `confirmedRoots`，此后不再追问。

**理由**：loopback + Origin 守卫已经把攻击面压到很小，但「页面能让后端写到任意
位置」仍是一次实质的权限扩张。拒绝清单挡住灾难性目标，首次确认保证每一个新的
写入根都经过人的一次明示同意——而不是由页面单方面决定。

### 4. 只读目录浏览接口

新增 `GET /api/fs/list?path=…`，**只返回目录项**（名称、完整路径、是否可展开），
不返回文件内容、不返回文件大小以外的元数据。与所有写路由同样受 loopback host
守卫与 Origin 守卫保护。它存在的唯一理由是：浏览器无法把真实绝对路径交给服务端，
没有它，「在界面里选路径」只能退化成「手输路径」。

### 5. 项目脚手架

`POST /api/projects` 在通过上述准入后创建 `<root>/<name>/project.json`
（`{project_id, name, created_at, description}`，与现有 `examples/projects/*`
同形）。**目录已存在且非空时拒绝**，绝不覆盖用户已有内容（AGENTS.md §13）。

## Consequences

- 后端从「只写一个根」变为「写若干个经确认的根」。这是本 ADR 的全部代价，也是
  用户明确要求的能力。
- 每一条 per-project 路由不需要改动：它们已经按 `self._projects[name]` 取根。
- 新增两个接口（一个只读列目录、一个创建项目），两者都在既有 loopback/Origin
  守卫之下。
- `data/projects.json` 成为原型的第二份本地 scratch 状态（第一份是画布存档）。
  它不是核心事实投影，不回写任何 `<project>/` 核心文件。
- **不在本 ADR 范围内**：跨根的项目迁移/移动、远程或网络根的凭据、多用户隔离。
