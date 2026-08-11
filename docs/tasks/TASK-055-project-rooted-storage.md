# TASK-055 — Studio 数据与媒体落在项目目录内（high-risk checkpoint）

- 状态：已实现，待验收
- ADR：[ADR-0053](../adr/ADR-0053-project-rooted-studio-storage.md)（Proposed）
- 前置：[ADR-0051 / TASK-053](TASK-053-choose-project-location.md)（项目位置可选）
- 触发：用户要求把 Production Studio 变成**真正可用的连接式 UI**；本卡是其中
  第一个、被单独隔离出来的高风险 checkpoint（存储位置迁移），UI 页面重建在其后。

## 1. 变更

```
<ProjectRoot>\
├─ project.json      核心 schema，未改
├─ studio\canvas.json  故事/设定/剧集/场景/镜头/资产登记/生成登记/时间线
└─ media\            全部上传与生成的项目媒体
```

- `_canvas_path` / `_upload_dir` 改为项目内路径；**所有**写媒体路径本来就经
  `_upload_dir`，因此一处改动即可覆盖 TTS / 图片生成 / 付费入槽 / compose /
  整集渲染 / 删除文件。
- containment 改由**项目注册表**保证（名字只做字典键），不再由 `_NAME_RE` 的
  ASCII 字符集保证 —— 顺带修复「中文名项目永远无法保存画布」的既有缺陷。
- 原子写的临时文件改建在项目卷上（`os.replace` 只在同卷原子）。

## 2. legacy 行为

- `mockups/motv-workspace/data/` 变为**只读**。
- 未迁移项目：GET 返回 legacy 存档并带 `_legacy: true`（可读、可看）；
  **所有写入 409 `migration_required`**（画布、媒体、以及写媒体的 agent 路由，
  在 POST 分发层统一拦截）。
- `POST /api/projects/migrate-legacy`：canvas 与 media **一起**复制进项目目录，
  失败回滚；legacy 文件保留不删；已在项目内的同名媒体不被覆盖。
- 迁移完成后 legacy **完全不可见**（项目内 canvas 存在即视为已迁移），
  因此不存在「画布已迁移、媒体仍在仓库」的半迁移状态。
- 前端：`persist.js` 见 `_legacy` 即停用自动保存并给出原因；顶部横幅是唯一的
  迁移入口（迁移会在用户磁盘上复制文件，必须由人触发）。

## 3. 验收（§8 全部覆盖）

`tests/test_motv_project_storage.py`（26 项）：

| 要求 | 用例 |
| --- | --- |
| 新建/打开真实项目 | `test_a_new_project_gets_the_documented_layout` |
| canvas 写入项目目录 | 同上 + `test_a_saved_canvas_survives_a_restart` |
| media 写入项目目录 | 同上 + `test_media_is_served_back_byte_for_byte` |
| reload 不丢数据 | `test_reload_returns_exactly_what_was_saved` |
| 两个项目隔离 | `test_two_projects_are_isolated` |
| Core pipeline/CLI 仍可读 | `project.json` 未被触碰（layout 用例断言） |
| repo scratch 不再被写 | layout 用例 + `test_an_unknown_project_is_refused_not_scratch_backed` |
| legacy 只读 | `test_a_legacy_project_is_readable_but_not_writable` |
| legacy 显式迁移 | `test_migration_moves_canvas_AND_media_together` |
| 无半迁移 | `test_after_migration_the_legacy_tree_is_invisible`、`test_legacy_media_only_still_blocks_writes` |
| 不覆盖已有媒体 | `test_migration_never_overwrites_media_already_in_the_project` |
| path traversal | `test_canvas_names_cannot_traverse`、`test_media_filenames_cannot_traverse` |
| symlink 不外泄 | `test_media_read_never_follows_a_symlink_out_of_the_project`、`test_migration_does_not_follow_a_symlink_out_of_the_scratch` |
| atomic write | `test_no_temp_files_are_left_behind_by_a_save` |
| FFmpeg/render 读项目媒体 | 渲染路径经 `_upload_dir`；`tests/test_motv_av_m11.py` 已改为项目内 media |

连接模式禁止自动 seed：`app.js` 的 demo 卡片是 `CONNECTED ? null : {...}`，
真实后端下不提供、也不会 seed（Playwright 冒烟用例断言落地页没有演示卡片）。

**真实连接冒烟**（Edge + 真后端，非静态 mock）：新建项目 `夜班沉默` → 在剧本
工作区真实输入 → 自动保存 → 磁盘上出现
`<AccountRoot>\夜班沉默\studio\canvas.json`，仓库 scratch 只剩账户级
`projects.json`。

## 4. 已知剩余项（不在本卡）

- 资产记录仍存 `/api/uploads/<project>/<file>` 而非项目相对路径：项目改名/搬盘后
  URL 会失效。真正的可移植性需要 canvas schema v10，本次刻意不做。
- `data/projects.json`（账户级注册表 + 已确认根）仍在仓库 scratch 内。它跨项目、
  不是创作数据，但严格说仍是「连接模式往仓库写」的最后一处。
- 旧 scratch 只保留、不回收，没有清理工具。
