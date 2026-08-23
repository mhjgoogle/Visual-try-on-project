# TASK-099：仓库根目录治理与启动器归档

- 状态：**已完成（2026-08-23）** —— ~~待共享工作树全量闸门~~：该闸门已过。
  本卡内容随 `ee6e47a` 进入 main，2026-08-23 在含本卡的 main 上跑过完整全量
  （pytest 3333 passed / 58 skipped + serial 6 + 前端 1807 + ruff 591 文件全过）
- Owner：Codex
- 决策：[ADR-0077](../../adr/ADR-0077-repository-path-ownership.md)

## 1. 目标

让仓库根目录只保留项目合同与元数据；启动器、测试配置分别归入自己的目录，且
Windows / Ubuntu 启动行为不变。

## 2. 范围

- `run-windows.ps1` → `scripts/launch/studio.ps1`
- `run-windows.bat` → `scripts/launch/studio.bat`
- `run.sh` → `scripts/launch/studio.sh`
- `conftest.py` → `tests/conftest.py`
- 更新当前 README、Agent 工作合同、commit gate 分类与定向测试。

不移动当前 TASK-098 正在修改的 Studio 后端/前端文件；不清理历史 ADR / 任务卡中的
历史路径记录。

## 3. 验收

1. 根目录不再有 `.py`、`.ps1`、`.bat`、`.sh` 文件。
2. 三个启动器可从任意工作目录解析仓库根。
3. pytest 仍加载 tmpfs 配置，commit gate 仍把它判为高风险。
4. 全量 pytest、全量前端、ruff 通过，无未闭合 P1。

## 4. 实施与验证记录（2026-08-22）

- 根目录已只剩仓库合同与元数据；三个启动器迁入 `scripts/launch/`，pytest 配置迁入
  `tests/`。`studio.sh` 在 Git 索引中保持 `100755`。
- 定向 pytest：67 passed，1 skipped（Bash 检查留给 Ubuntu CI）；PowerShell 解析通过。
- 非串行全量在排除 TASK-098 的单个独立失败后：3347 passed，58 skipped；串行全量：
  6 passed；前端全量：1762 passed。
- 全库 `ruff check` 与 `ruff format --check` 均通过。
- 独立审查最终结论：通过，P1 / P2 / P3 / P4 均为 0。初审提出的 Linux 可执行位
  P3 已增加回归断言并复验。

共享工作树尚不能声明全量闸门完全绿色：并行中的 TASK-098 文件
`mockups/motv-workspace/src/workflow/motionpreview.js` 含 NUL 字节，触发既有源码守卫；
其暂存内容还被 `git diff --cached --check` 判为带行尾空白。这些内容不属于本任务，
未越界修改。为避免把 TASK-098 的重叠 `app.js` 改动混入本任务，本任务尚未提交。
