# TASK-056 — 应用级数据移出仓库（小 checkpoint）

- 状态：**实现完成（2026-08-23）**。代码级证据：
  `server.py` 的 `_default_app_data_dir()` / `resolve_app_data_dir()` /
  `_app_data_read_path()` / `migrate_app_data()`、`_registry_path()` 与
  `_runs_path()` 都从 `APP_DATA_DIR` 派生、`runstore.RunStore(legacy_path=…)`、
  CLI 的 `--app-data-dir` / `--migrate-app-data`，
  测试 `tests/studio/test_motv_app_data_location_task056.py`（16 条）。
- 未在真实项目上被人看过的验收项：**「旧安装升级」这条只有构造出来的
  legacy 文件跑过**，没有在产品负责人自己那份 `data/` 上真跑一次
  `--migrate-app-data`（他机器上的那两个文件仍在原处，只读回退会照常读到）。
  这是信息，不是闸门（[ADR-0082](../../adr/ADR-0082-no-signoff-gate-on-task-cards.md)）。
- workflow：Migration ｜ 深度：STANDARD
- 前置：[ADR-0053 / TASK-055](TASK-055-project-rooted-storage.md)
- 触发：用户 2026-08-11 的优先级裁定 —— 项目数据已经进了项目目录，但**应用级**
  数据还留在仓库里。

## 问题

ADR-0053 把创作域与媒体搬进了 `<ProjectRoot>\`，但还剩一处：

```
mockups/motv-workspace/data/projects.json     # 已知项目 + 已确认的根
mockups/motv-workspace/data/runs.json         # 运行注册表（TASK-072 批次一新增）
```

两者都跨项目，所以放不进任何单个项目；它们也不是源码。这是**应用级**数据，
最终产品不应该一直把它写在仓库里。克隆一份仓库就带上别人的项目列表，
`git clean` 会删掉一份还活着的运行日志。

## 做了什么

| # | 变更 | 位置 |
| --- | --- | --- |
| 1 | `APP_DATA_DIR`：Windows `%LOCALAPPDATA%\motv`，POSIX `$XDG_DATA_HOME/motv` 或 `~/.local/share/motv`；平台分支是**参数**不是读 `os.name`（`pathlib` 在构造时读它，假冒 posix 会造出 Windows 上无法实例化的 `PosixPath`，两个分支因此在两个目标上都能跑） | `server.py` `_default_app_data_dir` |
| 2 | 覆盖优先级：`--app-data-dir` > `MOTV_APP_DATA_DIR` > 默认 | `resolve_app_data_dir` |
| 3 | 运营者给的路径过 **ADR-0051 同一套准入**（拒绝清单、realpath 之后再判、真写探针、`repo_root=REPO_ROOT`）—— 最后这条正好拒掉本卡要退役的那个位置 | `main()` |
| 4 | 两个注册表的**写**路径都从 `APP_DATA_DIR` 派生；`_RUNS_PATH` 常量改成 `_runs_path()` 函数，消掉「同一事实两个副本会走岔」这一类 | `_registry_path` / `_runs_path` |
| 5 | 旧位置**只读回退**：新位置没有该文件时仍从 `DATA_DIR` 读；写永远落新位置 | `_app_data_read_path`、`RunStore(legacy_path=…)` |
| 6 | 损坏隔离只动**自己的**日志：legacy 文件损坏就当空处理，不改名不删除 | `runstore._load` |
| 7 | 显式一次性迁移 `--migrate-app-data`：**拷贝**，不移动、不删除、不覆盖新位置已有内容；经目标目录内的临时文件再 `os.replace`，崩溃不会留半份注册表 | `migrate_app_data()` |
| 8 | `_persist_locked` 写失败时删掉半份临时文件 | `runstore` |
| 9 | 测试层的安全网：`tests/conftest.py` 给每个 xdist worker 设一个丢弃用的 `MOTV_APP_DATA_DIR` | `tests/conftest.py` |

**顺带闭合的证据**：该目录里原本躺着 `runs.json.tmp19264`（27 B）与
`runs.json.tmp20772`（219 KB）—— 原子写中断的产物，与
[TASK-087](../active/TASK-087-followup-ledger.md) §6.2 记的 `os.replace` 偶发 `OSError`
是同一现象。第 8 条堵住了来源，两个残骸已删。

## 范围

- IN：`projects.json` 与 `runs.json` 一起搬（合同 §5.5：同类，分散到两个位置
  正是本卡要消除的东西）；位置可配置；旧位置只读回退 + 显式迁移；
  Windows 与 POSIX 两条默认路径都有测试。
- OUT：资产 URL 的项目相对化、旧 scratch 的清理工具。
  `data/skills/`（ADR-0067 的用户 Skill 包源）**按它自己的注释也是同类**，
  但不在本卡范围内 —— 记为 [TASK-087](../active/TASK-087-followup-ledger.md) §6.4。

## 验收

| 验收项 | 结果 |
| --- | --- |
| 全新安装：注册表写到应用数据目录，仓库内不再出现 `data/projects.json` | ✅ `test_neither_registry_path_is_inside_the_repository`（断言的是**不变量**，不是某个字面路径） |
| 旧安装：能读到旧注册表并提供显式迁移；迁移后旧文件保留 | ✅ `test_an_old_install_still_reads_its_registry`、`test_migration_copies_both_registries_and_keeps_the_originals`；**真实升级路径未在产品负责人机器上跑过** |
| 位置可被参数覆盖；路径准入沿用 ADR-0051 | ✅ `test_an_explicit_location_beats_the_env_var_which_beats_the_default`；`--app-data-dir` 走 `admit_root` |
| Windows 与 POSIX 两条默认路径都有测试 | ✅ 四条，且**两个分支在两个平台上都执行** |

## 已做验证

`pytest tests/studio tests/e2e tests/contract`（564 passed）+ 全量（见提交信息）。

## 一个值得记住的教训

第一版把 `APP_DATA_DIR` 接上去、测试却没跟着改，结果**测试套件把五个 pytest
临时项目写进了开发机真实的 `%LOCALAPPDATA%\motv\projects.json`**，并且八个
xdist worker 共用一个注册表，表现成互不相干的两个测试之间报 409「项目已存在」。
把数据搬出仓库的同时，必须同步搬走「测试写到哪里」这个假设 —— 否则新位置就是
开发者自己的真实目录。防线现在有两层：`tests/conftest.py` 的按 worker 丢弃目录
（安全网），以及各 fixture 显式指向自己的 `tmp_path`（真隔离）。
