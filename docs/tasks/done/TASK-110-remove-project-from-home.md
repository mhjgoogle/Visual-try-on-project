# TASK-110：主页可以把项目从列表里移除（文件他自己删）

- 状态：完成（2026-08-27）—— 实现完成、归属域验证通过、真机验证过；随 TASK-109 同批提交
- Workflow：Feature · 深度：STANDARD
- 关联 Requirement：[REQ-005](../../requirements/REQ-005-remove-a-project-from-the-home-list.md) v1 判据 1–6
- 关联 ADR：[ADR-0090](../../adr/ADR-0090-project-removal-is-unregister-only.md)
- 架构约束：`CA §1` 模块边界（改动只在 `mockups/motv-workspace/`）·
  `CA §4` 测试归属（`tests/studio/` + 前端 `.test.mjs`）·
  `CA §5.2` 不静默覆盖/删除用户文件 —— 本卡把它推到极端：**根本不提供删文件的路径**
- 目标：主页卡片能把项目从列表里去掉；磁盘上的项目文件夹一个字节都不动。

## IN SCOPE

- `POST /api/projects/<name>/unregister`：只改账户级注册表，**零文件系统写操作**
- 主页卡片上的移除入口 + 一次确认（文案写明「文件不会被删」与「怎么加回来」）
- 本机（画布/演示）项目走 `localStorage` 那份注册表：`projects.removeProject`

## OUT OF SCOPE

- **任何删除他文件的能力** —— 不做软删除、不做回收区、不做彻底删除
  （产品负责人 2026-08-27：「删除前端。后端的文件留下就好了啊。」「后端的文件我可以手动删除。」）
- 批量移除；清理该项目在 `runs.json` 里的运行历史（那是账户级事实，删了就查不出它花过多少钱）

## Impact Analysis

- 受影响模块：`server.py`（新端点）、`src/app.js`（卡片入口 + 处理器）、
  `src/services/projects.js`（本机移除）、`src/services/query.js`（API 调用）、
  `styles/app.css`、`index.html`（无 —— 卡片是 JS 建的）
- API / 合同：新增一条 POST；无既有合同变更
- 数据：只动 `%LOCALAPPDATA%/motv/projects.json` 与 `localStorage`；**不动项目目录**
- 受影响测试：`tests/studio/`、前端 `.test.mjs`

## 架构影响

不触发架构治理：没有新抽象、没有跨层合同变更、依赖方向不变。唯一的架构性决定是
**刻意不实现的那一半**（删文件），写在 ADR-0090 决策 2。

## 实施摘要

| 位置 | 改了什么 |
| --- | --- |
| `server.py` | `_unregister_project`：校 CSRF 头 → 从注册表摘掉该条 → 同步内存视图 → 回 `{filesDeleted: false, filesKeptAt}`。注册表里没有该名字且内存里也没有 → 404（避免「说成功了、卡片还在」） |
| `src/services/query.js` | `unregisterProject(name)`，把 `filesKeptAt` 带回界面 |
| `src/services/projects.js` | `removeProject(storage, name)`：本机注册表移除，写入失败如实回 `ok:false` |
| `src/app.js` | 卡片外包一层 `.pcardwrap`，✕ 是卡片的**兄弟**（`pcard` 是 `<button>`，嵌套按钮非法且点击会冒泡成「打开项目」）；确认文案写明文件不删、怎么加回来；正在打开的项目拒绝就地移除 |
| `styles/app.css` | `.pcardwrap` / `.pdel`（悬停显形，hover 变红） |

## 验证

| REQ-005 判据 | 证据 |
| --- | --- |
| 1 每张卡片可发起删除 | 前端测试断言 ✕ 是卡片兄弟且带 `stopPropagation`；真机截图确认悬停出现 |
| 2 只动列表、文件不动，且界面说明白 | `pytest tests/studio/test_motv_unregister_project_task110.py` 的 `test_removal_does_not_touch_one_byte_on_disk`（目录、canvas 字节、文件清单逐一比对）；真机：移除 `照见未明rev2` 后 `canvas.json` **350719 字节未变**；确认框原文含「磁盘上的项目文件夹不会被删除」 |
| 3 应用不提供删文件按钮 | 前端测试禁止 `rmdir/rmtree/deleteFolder/unlinkProject` 出现；后端测试禁止处理器里出现 `rmtree/unlink/shutil.move/os.replace/os.remove` |
| 4 当前项目不能就地删 | 前端测试断言 `canvasActive && name === PROJECT_NAME` 的拒绝分支 |
| 5 列表立刻反映现实 | `test_the_list_actually_stops_reporting_it` + 真机：移除后主页只剩 `夜班沉默` |
| 6 失败要说明原因 | 未知项目 404 且 detail 带名字；本机写入失败回 `ok:false` + 原因；CSRF 缺失 403 |

命令：`pytest tests/studio/test_motv_unregister_project_task110.py` → **6 passed**；
`node --test mockups/motv-workspace/tests/projectremove.test.mjs` → **8 passed**；
Playwright 在真实项目上走了一遍（含确认框文案与文件字节比对）。

## Follow-up

- 真机验证时我拿**产品负责人的真实项目** `照见未明rev2` 当了试验对象，把它从列表里移除
  又加回来了（文件未动，备份 `projects.json.before-restore.bak`）。以后这类验证要用临时项目。
- 「界面记着、磁盘没有」的项目现在能在主页清掉了；反过来「磁盘有、列表没有」还没有入口
  （只能靠新建时选同一个目录）。要不要做「导入已有项目文件夹」是另一张卡。
