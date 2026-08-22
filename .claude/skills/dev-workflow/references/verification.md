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

| 改动 | 至少跑 |
| --- | --- |
| 单个 backend service/module | 该模块单测 + 直接受影响的集成测试 |
| API / Contract | 合同测试 + 相关集成（本仓库：Command/Query 相关 pytest + 前端合同调用方测试） |
| UI / 前端 | 受影响的 `node --test mockups/motv-workspace/tests/<相关>.test.mjs` + 手动 smoke |
| shared / core | 扩大到**所有直接依赖模块**的测试 |
| 修 Bug | 新回归测试（先红后绿）+ 上表对应行 |
| Perf | benchmark 对比 + 上表对应行（证明行为未变） |

**风险档与全量触发以 AGENTS.md §20 为准**（本表是它的「怎么选定向」细化，
不是替代）。全量（两阶段 pytest + 全量前端 + ruff）只在：broad core change、
大型 refactor、依赖/框架迁移、依赖图不清、发布关键验证、高风险改动。
拿不准依赖图 → 宁可扩大。Agent 有权按风险单方面扩大验证范围，无权缩小
§20 规定的下限。

审查：中/高风险完成后调 `codex-review-loop`（轮次预算见该 Skill）；
低风险不调。**发布闸门 = 验收满足 + 相关测试过 + 无未闭合 P1**，
不是零发现。

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

- [ ] Requirement 满足（对着 REQ 验收判据，不是对着代码）
- [ ] Verification 覆盖了本次 impact scope
- [ ] 架构未明显恶化（触发过治理的，结论已记录）
- [ ] Convergence 清单过完，删的删了，欠的记了
- [ ] REQ / Change Record 更新到终态（状态、相关 Change、实施摘要、验证）
- [ ] 临时 prototype 清除或正式化

全勾 → 提交（AGENTS.md §22）。轻量执行：QUICK 深度整个判定在一分钟内。
