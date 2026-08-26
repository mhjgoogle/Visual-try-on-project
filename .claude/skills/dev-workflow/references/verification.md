# Impact Analysis → Targeted Verification → Convergence

三件事是一条线：分析定范围，范围定验证，完成前收敛。

## Impact Analysis（轻量）

QUICK 心算；STANDARD/DEEP 写进任务卡（每项一行即可）：

- affected feature/module（改哪里）
- API / Contract impact（合同变没变）
- data impact（持久化/schema/存量数据）
- dependency impact（依赖方向、外部依赖）
- architecture impact（触发 architecture.md 了吗）
- affected tests（哪些测试护着这片）
- docs impact（哪份文档会说谎）

目的只有两个：**定修改范围 + 定验证范围**。不为文档而文档。

## Targeted Verification

核心原则：**Test Scope = Change Impact Scope**。不默认全量。

测试**归属**见 ADR-0080 与 AGENTS.md §20 的域表（`tests/backend` /
`tests/studio` / `tests/contract` / `tests/e2e` / `tests/tooling` /
前端 `node --test`）。本表说的是**改了什么 → 跑哪个域**：

| 改动 | 至少跑 |
| --- | --- |
| src 单个模块 | `pytest tests/backend/test_<对应>.py`（约定名不存在时跑 `tests/backend`） |
| src 顶层共享模块（persistence/models/errors…） | `pytest tests/backend tests/studio`（Studio 后端 import 它） |
| Studio Python 后端（`mockups/.../*.py`） | `pytest tests/studio tests/contract` |
| API / 跨层合同 | `pytest tests/contract` + 相关 Command/Query pytest + 前端调用方 `.test.mjs` |
| UI / 前端 | `node --test mockups/motv-workspace/tests/*.test.mjs`（或受影响子集）+ 手动 smoke |
| Agent 工装（hooks / skills / scripts） | `pytest tests/tooling` |
| tests/ 根支撑层（conftest / scenario / 假件） | 两阶段全量 pytest（它托着每个域） |
| 修 Bug | 新回归测试（先红后绿）+ 上表对应行 |
| Perf | benchmark 对比 + 上表对应行（证明行为未变） |

本地 gate 已按同一张归属映射自动选域（`.claude/hooks/commit_gate_policy.py`）。
**全量是集成检查点**，不是日常提交默认（产品负责人 2026-08-22：「我不要每次
都全量测试。」）：CI、连续链链尾、merge 前、发布/交接前，以及归属映射兜不住
（fail-closed）时。拿不准依赖图 → 宁可扩大；Agent 有权扩大验证范围，
无权缩到归属域以下。

审查：按影响范围触发（ADR-0081 / AGENTS.md §20），需要时调
`codex-review-loop`——默认 1 轮，P1 修复后复审一次，P2 修完跑归属域即收口，
P3/P4 记 Follow-up。纯文档与纯展示改动不调。
**发布闸门 = 验收满足 + 相关测试过 + 无未闭合 P1**，不是零发现。

调审查前备 Review Package，审查按**四闸顺序**作答（需求完成度 → 架构符合性 →
证据充分性 → 技术质量）：模板、判词与评级映射见
[traceability.md](traceability.md) §4–5。**验证要证明判据里的行为，不是「测试全绿」**
——「Button renders」证不了「点击后 Feedback Agent 拿到 component context」，
那种证据在审查里叫 `NOT_EVIDENCED`。

## Convergence（完成前必查）

防止「只加不减」。逐项过（多数时候答案是「无」，几秒钟）：

1. obsolete code —— 被本次改动取代的旧实现还在吗？
2. duplicated implementation —— 本次是否复制了已有逻辑？
3. dead compatibility layer —— 新旧并存期结束了吗？旧路径该退役了吗？
4. superseded tests —— 有没有测试在保护**已被取代的行为**？
5. outdated docs —— 哪份文档现在在说谎？（含本 Skill 的 records）
6. temporary prototype / workaround —— Discovery 的临时产物清了吗？
   要留的正式化了吗（有测试、有归属）？
7. unnecessary helper —— 只为过渡引入的辅助物还需要吗？
8. shared 收缩 —— shared 里出现单使用者抽象了吗？（architecture.md）

**删除判据**：旧行为已被新的 CONFIRMED Requirement 明确取代 → 相关
obsolete code/tests/docs **允许删**（软删/带版本路径优先，AGENTS.md 第 13 条）。
测试保护 Current Valid Behavior，不保护 Historical Behavior。
拿不准 → 记 Follow-up（TASK-087 总账），不硬删也不装死。

## Done 判定

- [ ] Requirement 满足：**逐条**验收判据都指得出实现与证据（对着 REQ 判据，
      不是对着代码）；指不出来的那条 = `REQUIREMENT_COVERAGE_GAP`
- [ ] Verification 覆盖了本次 impact scope，且证的是**判据里的行为**
- [ ] 卡引用的每条 `CA §N` 仍然成立（越界 = 不能 Merge，先改回边界内）
- [ ] 架构未明显恶化（触发过治理的，结论已记录）
- [ ] Convergence 清单过完，删的删了，欠的记了
- [ ] REQ / Change Record 更新到终态（状态、相关 Change、实施摘要、验证）
- [ ] 临时 prototype 清除或正式化

全勾 → 提交（AGENTS.md §22）。轻量执行：QUICK 深度整个判定在一分钟内。
