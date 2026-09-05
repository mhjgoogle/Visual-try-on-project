# TASK-134：把 Provider 中立从散文变成 CI 闸门 —— import-linter 分层契约

- 状态：**待开始**（2026-09-05 开卡；没有 Agent 在做）
- Workflow：Refactor（不改有效产品行为，加的是约束的执行方式）· 深度：STANDARD
- 技术目标：AGENTS.md 第 8–9 条（「核心工作流不能依赖任何具体视频厂商」「所有视频生成方法
  必须通过 `VideoProvider` 接入」）今天**只靠人读 diff 守**。散文约束在本仓库有前科：
  同类的「测试归属」在写成 `commit_gate_policy.py` 之前也一直漂。`pyproject.toml` 现在只有
  `[tool.ruff]` 与 `[tool.pytest.ini_options]`，没有任何依赖方向的机器检查。
- 架构约束：`CA §2`（依赖方向）· `CA §4`（测试归属 —— 新增闸门要落进 tooling 域）
- 来源：调研 GitHub 上的 ArcReel 时发现它把同类约束写成了 import-linter 契约。

## 要做什么

在 `pyproject.toml` 加 `[tool.importlinter]` 契约，把依赖方向变成 CI 里会红的东西。
至少两条：

1. **分层契约** —— 核心工作流层不得向上依赖具体 Provider 实现。
2. **forbidden 契约** —— 路线中立的模块不得 import 任何单一 Provider 子包。

## 值得一并抄的是它的 baseline 纪律，不只是工具

ArcReel 在契约注释里写死了三条，每条都对应本仓库踩过的坑：

- `ignore_imports` 掐的是**违规链的终端边而非首跳** —— 这样中间模块后续新增的反向依赖
  仍会被契约拦下，而不是被一条宽松的 baseline 一起放过；
- **新增 baseline 条目前先确认该边无法就地清零，清零一条即删一行**；
- 某个模块**不纳入契约**时要写明为什么，它的原话是：「纳入就要加 baseline 掩盖，
  那等于让契约声明一件它此刻并不成立的事」。

第三条尤其重要 —— 一个声明了假事实的契约比没有契约更糟，它会让人以为那条边已经被守住。

## IN SCOPE

1. 装 import-linter 进开发依赖，写首批契约（先钉住现在**已经成立**的方向，不做重构）；
2. 存量违规逐条判：能就地清零的清零，不能的进 baseline 并写明理由；
3. 接进 commit gate 的 tooling 域与 merge 前全量。

## OUT OF SCOPE

- **不做为了让契约变绿的架构重构**。契约首版只描述现状里已经成立的部分；
  想收紧的方向写成新卡，不在本卡里边改代码边改契约（那样两边都失去基准）。
- 前端侧的依赖方向（`mockups/`）不在本卡。

## 完成判据

1. `lint-imports`（或等价入口）在 CI 与本地 commit gate 里跑，绿。
2. 每条 baseline 条目都有一行注释说明为什么无法就地清零。
3. 故意加一条反向 import 能让它变红（守卫必须真的拦得住它声称要拦的东西 ——
   `tests/tooling/test_lifecycle_check.py` 头部那条纪律同样适用）。
