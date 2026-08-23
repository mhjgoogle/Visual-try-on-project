# TASK-105：流程模板第一刀 —— 内置一份 flow，新建项目时可选

- 状态：**未开工**（2026-08-23 建卡）
- workflow：Feature ｜ 深度：STANDARD
- 依据：[ADR-0084](../../adr/ADR-0084-project-flow-template-as-a-package.md)
  （Accepted 2026-08-23）「实施」节。ADR 由 [TASK-083](../done/TASK-083-phase3-adrs-first.md)
  ADR-D 定案，实现按 AGENTS.md §2 切成垂直片，本卡是第一片。
- 缺口：GAP-21（[目标流程走查](../../../src/ui-gap-audit/reports/target-workflow-walkthrough.md)）

## 为什么现在只做这一刀

ADR-0084 定的是**机制**（模板 = `kind: "flow"` 的包，复用 ADR-0067 的三级来源、
digest、不可原地覆盖、fail-closed）。一次把三级来源、项目源、`seed.json` 的骨架
深度全做出来，用户直到最后才看得到东西 —— 那正是 AGENTS.md §2 禁的按层拆分。

**这一刀自己就能跑、能演示、能验证**：新建项目时能选一份内置流程，选了以后项目里
真的有那条流程的步骤，并且能回答「这个项目是从哪份模板起步的」。

## IN SCOPE

1. **加载器**：`kind: "flow"` 的包能被读进来并校验（manifest / `flow.md` / `seed.json`
   三件套齐全、`steps[]` 的每个 `(skillId, skillVersion)` 都能解析）。
   加载失败 fail-closed 并说出原因（ADR-0084 决策 6）。
2. **一个内置 flow**：`product-flows/builtin/` 下一份，覆盖当前四步流程。
3. **新建项目时可选**：项目创建界面能列出可用的 flow 并选一份（或不选）。
4. **`createdFrom`**：新项目的 canvas 记 `{flowId, flowVersion, flowDigest}`
   三个字段（ADR-0084 决策 5）。
5. **`product-flows/` 进 [ADR-0077](../../adr/ADR-0077-repository-path-ownership.md)
   的路径所有权表**，并让 `tests/tooling/test_repository_layout.py` 认它。

## OUT OF SCOPE（明确留给第二刀）

- 项目源 `<ProjectRoot>/studio/flows/` 与用户源 `<应用数据根>/flows/`
  —— 第一刀只有内置源。三级来源的解析顺序在 ADR 里已经定死，实现它不需要
  重新决定任何事，所以推迟它不留决策债。
- **从一个已完成项目导出模板**（反方向）。
- `seed.json` 的骨架深度（几集/几场/几镜）。
- 「复制项目」（ADR-0084 决策 8 明确不在 ADR 范围内，更不在本卡）。

## 验证范围

后端 `tests/backend`（加载器与校验）+ Studio `tests/studio`（创建流程与
`createdFrom`）+ 前端 `mockups/motv-workspace/tests/`（选择界面）。
跨 py↔js 的 flow 契约断言住 `tests/contract/`（ADR-0080 决策 3）。
按 ADR-0081：改的是持久化 + 跨层合同 + 登记 → **要审**，默认 1 轮。

## 动手前必做的一件事

**先核实 ADR-0067 的加载器今天长什么样**（`skillpkg.py` / `_load_skill_catalog`），
再决定 flow 加载是复用它的哪几段。ADR-0084 说「复用同一套机制」是一个决定，
不是一句对现有代码的描述 —— 现有代码里没有任何 `kind` 的概念。
