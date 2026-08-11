# TASK-056 — 应用级数据移出仓库（小 checkpoint）

- 状态：未开始（中优先级，不阻塞使用）
- 前置：[ADR-0053 / TASK-055](TASK-055-project-rooted-storage.md)
- 触发：用户 2026-08-11 的优先级裁定 —— 项目数据已经进了项目目录，但**应用级**
  数据还留在仓库里。

## 问题

ADR-0053 把创作域与媒体搬进了 `<ProjectRoot>\`，但还剩一处：

```
mockups/motv-workspace/data/projects.json     # 已知项目 + 已确认的根
```

它跨项目，所以放不进任何单个项目；它也不是源码。这是**应用级**数据，最终产品
不应该一直把它写在仓库里。

## 目标

放到应用数据位置，例如：

```
%LOCALAPPDATA%\motv\projects.json
```

或用户指定的位置：

```
D:\MotvData\projects.json
```

## 范围（刻意做小）

- 只搬 `projects.json`（含 `confirmedRoots`）。
- 位置可配置：命令行参数 / 环境变量二选一，默认 `%LOCALAPPDATA%\motv\`
  （POSIX 上用 `$XDG_DATA_HOME` 或 `~/.local/share/motv/`）。
- 旧位置**只读回退 + 一次性显式迁移**，与 ADR-0053 的 legacy 处理同构：
  不自动删除旧文件。
- 不改项目数据布局，不引入新的领域模型。

## 验收

- 全新安装：注册表写到应用数据目录，仓库内不再出现 `data/projects.json`。
- 旧安装：能读到旧注册表并提供显式迁移；迁移后旧文件保留。
- 位置可被参数覆盖；路径准入沿用 ADR-0051 的拒绝清单与 containment。
- Windows 与 POSIX 两条默认路径都有测试。

## 不在范围

资产 URL 的项目相对化（等项目改名/移动/导出一并做）、旧 scratch 的清理工具。
