# ADR-0053: Studio 数据与媒体落在项目目录内

- Status: Proposed
- Date: 2026-08-11
- Scope tasks: TASK-055
- 关联：[ADR-0051](ADR-0051-per-project-asset-root-and-runtime-selection.md)（项目位置
  可选 + 准入策略）、[ADR-0032](ADR-0032-workspace-runtime-and-loopback-topology.md)
  （loopback 拓扑）、[ADR-0049](ADR-0049-native-windows-run-and-test-target.md)
  （原生 Windows 运行目标）、[ADR-0004](ADR-0004-project-root-containment.md)
  （项目根 containment）

## Context

连接模式此前只有**核心项目**是真的：`plan / status / budget / cost / problems /
approvals` 经 `_svc` 读取 `<ProjectRoot>/`。而 studio 的**创作域**——故事、作品设定、
剧集/场景/镜头、资产登记、生成登记、时间线——连同全部上传/生成的媒体，都写在

```
mockups/motv-workspace/data/<project>.json
mockups/motv-workspace/data/uploads/<project>/
```

也就是**仓库里的 scratch 目录**。

后果是实质性的：用户在 Windows 上「打开一个真实项目」并开始创作，作品实际上落在
git 仓库里，而不是他们选的项目目录；项目目录只有一个 `project.json`。这既不符合
「真实项目工作流」，也与 AGENTS.md §23（生成媒体不得进仓库）相抵触。

## Decision

### 1. 目标结构

```
<ProjectRoot>\
├─ project.json      核心 schema，原样不动
├─ studio\
│  └─ canvas.json    studio 创作域全部内容
└─ media\            全部上传/生成的项目媒体
```

**不创建第二套项目 schema**：`project.json` 仍由核心拥有，studio 只是在它旁边多了
两个自己的目录。核心 pipeline/CLI 读取该项目的方式完全不变。

### 2. 单一收敛点

- `_App._canvas_path(name)` → `<ProjectRoot>/studio/canvas.json`
- `_App._upload_dir(project)` → `<ProjectRoot>/media/`

所有写媒体的路径（手工上传、TTS、图片生成、付费入槽、compose、整集渲染、删除文件）
本来就经 `_upload_dir` 取目录，因此改这一个函数即可让全部路径落到项目内。

### 3. containment 由**注册表**保证，不再由名字字符集保证

`_project_root(name)` 只做一次字典查找：`self._projects[name]`，路径由查到的
**已准入根**拼出，调用方输入的名字永远不会成为路径片段。

这条同时修掉一个既有缺陷：`_NAME_RE` 只允许 ASCII，而项目创建（ADR-0051）允许
中文名——于是一个叫「雨夜」的项目**永远无法保存画布**。名字是给人看的标题，
不该充当安全边界。

### 4. 旧路径只读，且迁移必须显式且完整

`mockups/motv-workspace/data/` 变为**只读 legacy**：

- **读**：项目内没有 `studio/canvas.json` 时，GET 返回 legacy 存档并打上
  `_legacy: true`，让创作者能先看清自己有什么；legacy 媒体同样可读。
- **写**：只要该项目仍有未迁移的 legacy 数据，**一切写入返回 409
  `migration_required`**——画布 PUT、媒体 PUT、以及全部写媒体的 agent 路由
  （在 POST 分发层统一拦截，新增路由不会漏掉）。
- **迁移**：`POST /api/projects/migrate-legacy` 把 canvas 与 media **一起**复制进
  项目目录；失败回滚已复制的文件。legacy 文件**保留不删**（AGENTS.md §13）。
- **迁移完成后 legacy 完全不可见**：项目内 canvas 存在即视为已迁移，媒体只从
  项目内解析。因此「画布已迁移、媒体仍在仓库」的半迁移状态在读路径上不可能出现。

前端对应：`persist.js` 见到 `_legacy` 即**阻止自动保存**并给出原因，顶部横幅提供
唯一的迁移入口（迁移会在用户磁盘上复制文件，必须由人按下）。

### 5. 原子写落在项目卷上

临时文件改为建在 `<ProjectRoot>/studio/` 内再 `os.replace`：`os.replace` 只在同一
文件系统内原子，而项目根很可能与仓库不在同一个盘。

## Consequences

- 连接模式下创作内容**不再写入仓库**；项目目录自包含，可整体复制/备份/移动。
- 中文名项目现在真的可用（此前画布保存必失败）。
- 旧的 scratch 项目不会被自动搬走，也不会被自动删除；要继续编辑必须显式迁移一次。
- `data/projects.json`（**账户级**的项目注册表 + 已确认根）仍在仓库 scratch 内：
  它跨项目，不属于任何单个项目。它不是创作数据。移动它是独立议题，见下。
- URL 形态保持 `/api/uploads/<project>/<file>`，由后端映射到 `<ProjectRoot>/media/`。
  资产记录里仍存这个 URL 而不是项目相对路径。

## 不在本 ADR 范围

- **资产记录改存项目相对路径**（真正的可移植性：项目改名/搬盘后 URL 仍然正确）。
  那是 canvas schema v10 + 全部消费方的改动，本次刻意不做。
- 把账户级注册表移出仓库 scratch。
- 旧 scratch 的清理工具（现在只保留，不回收）。
