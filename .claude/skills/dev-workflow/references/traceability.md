# 追溯链与需求完成度审查

权威是 **AGENTS.md §6 + [ADR-0088](../../../../docs/adr/ADR-0088-traceability-and-requirement-fulfillment-review.md)**。
本文件是**操作面**：怎么写引用、怎么备包、怎么读四闸判词。一句话目标 ——

> 每一次实现都能从产品意图追到验证；缺口能指名是链条上哪一环。

## 1. 一条链，六个环（句柄一律复用现有编号）

```
Requirement → Change/Task → 架构约束 → 代码 → 验证证据 → 独立审查 → Merge
   WHY           WHAT/WORK    BOUNDARIES   HOW     PROOF        CHECK
```

| 环 | 怎么引用 | 载体 |
| --- | --- | --- |
| Requirement + 判据 | `REQ-003 v1 判据 2`（REQ 的验收判据是有序列表，序号即句柄） | `docs/requirements/` |
| Change / Task | `TASK-NNN`；QUICK 深度 = 提交信息本身 | `docs/tasks/{backlog,active,done}/` |
| 架构约束 | `CA §2`（依赖方向）、`CA §5.4`（平台中立）—— [当前架构合同](../../../../docs/current-architecture.md)的**节号即句柄**；确实不受特殊约束时写 `none-specific` | ADR-0087 决策 4 |
| 代码 | Change 清单的 `paths` + commit hash + diff | `docs/auto-push/changes/*.json` |
| 验证 | 命令 + 结果，**按判据**对应 | 任务卡「验证」节 |

**不建追溯数据库**：不给文件加永久 metadata、不给函数标 REQ ID、不维护人工文件
清单。产品级追踪表已有一份（`docs/design/end-to-end-requirements-traceability.md`），
**不建第二份**。per-Change 的追溯视图在收口/审查时**现算**：

| 判据 | Task | 架构约束 | 实现 | 验证 |
| --- | --- | --- | --- | --- |
| REQ-003 v1 §1 | TASK-108 | `CA §4` | `lifecycle_check.orphan-task` | `pytest tests/tooling` |

四五行的表，写在卡的「验证」节或 Review Package 里即可，不落库。

## 2. 卡上只多两行（其余沿用 records.md 的最小字段集）

```markdown
- 关联 Requirement：REQ-NNN vK 判据 1,3      # 无产品需求时改写「技术目标：<一句>」
- 架构约束：CA §2 依赖方向 · CA §5.3 fail-closed   # 或 none-specific
```

- **只引用与自己相关的**约束。为形式凑引用与写 `architecture: frontend`
  一样没有信息量。
- 「技术目标」不是免检通道：它要能回答**为什么这个技术工作是必要的**
  （Bug/Refactor/Perf/工装 走这条）。
- 两者皆无 → `ORPHAN_TASK`，`lifecycle_check` 当场转红。锚点必须是**带标签的**
  基础字段（关联 Requirement / 依据 / 技术目标 / 起因）或显式 `REQ-NNN`；
  **背景里提一句 `ADR-NNNN` 不算**。守卫看 `active/` 全部，外加 `backlog/`
  `done/` 里带 `架构约束：` 的卡 —— 卡搬进 `done/` 之后**仍然**被看着，
  否则 merge 那一刻正好没人看。

## 3. 四个缺口标签（出现任一 → Merge Gate 不为 PASS）

| 标签 | 什么时候贴 | 谁发现 |
| --- | --- | --- |
| `ORPHAN_TASK` | 卡既无 Requirement 也无技术目标 | `lifecycle_check`（机器） |
| `ORPHAN_IMPLEMENTATION` | 有 diff 对不上任何已申报 Task | auto-push 的 `foreign` / `BLOCKED_MIXED` / `BLOCKED_WIDE`（既有机制，不另造） |
| `REQUIREMENT_COVERAGE_GAP` | 某条验收判据没有任何 Task / 验证覆盖 | 第 10 步对账 + 审查第 1 闸 |
| `ARCHITECTURE_UNKNOWN` | 改动明显碰边界（跨模块 / 合同 / 依赖方向 / schema），卡却一条约束都没引 | 第 6 步治理 + 审查第 2 闸 |

**代码已经很多不等于需求完成**：判据没被覆盖就是 `REQUIREMENT_COVERAGE_GAP`。

## 4. Review Package（调 codex-review-loop 之前备）

写 `.claude/tmp/review-package.md`（已 gitignore，属一次性产物，任务结束即删），
经 `REVIEW_PACKAGE` 交给审查脚本。**只放本次审查必需的东西**，目标 ≤120 行：

```markdown
# Review Package — <change-id / TASK-NNN>

## Requirements claimed
- REQ-003 v1 判据 1：<判据原文一行>
- REQ-003 v1 判据 4：<判据原文一行>
（无产品需求时：## Technical objective —— 一句，并写明为什么必要）

## Tasks
- TASK-108（Refactor · DEEP）：<目标一行>

## Architecture constraints in force
- CA §4 测试归属：<约束原文一行>
- CA §2 依赖方向：<约束原文一行>

## Changed surface
- <file>：<一行说明>            # 与 diff 一致；不复述 diff

## Verification evidence
- 判据 1 → `pytest tests/tooling/test_lifecycle_check.py` 全绿（N 项）
- 判据 4 → <命令 / 手动观察 / 截图>

## Known risks / out of scope
- <一行>

## Implementation summary
- <三五行：改了什么，在哪，为什么这么改>
```

纪律：

- **审查者默认不扫仓库**。包外的东西只在某道闸不读别处就判不了时才扩展，
  且审查者必须说明它读了什么。
- 包**不可读 / 为空 / 超上限**一律 fail-closed（`ENV_ERROR` /
  `PACKAGE_TOO_LARGE`，脚本仍 exit 0）—— 宁可不审，不假装审过。
- 没有包时脚本退回**只审第 4 闸**（技术质量），另三闸报 `(none)`。
  纯工装、纯技术清理可以这么用；**有 REQ 的 Change 不许这么用**。
- 判据/约束**抄原文一行**，不要写「见 REQ-003」—— 那等于让审查者去读仓库。

## 5. 四闸顺序与判词（审查者输出，控制器据此评级）

顺序即优先级：**普通代码问题不得盖住「需求没做完」**。

| 闸 | 问什么 | 判词 |
| --- | --- | --- |
| 1 Requirement Fulfillment | 声称完成的每条判据真的实现了吗？证据在哪？ | `PASS` / `PARTIAL` / `FAIL` / `NOT_EVIDENCED` |
| 2 Architecture Conformance | 停在引用的每条 `CA §N` 之内了吗？ | `PASS` / `FAIL` / `NOT_APPLICABLE` |
| 3 Verification Sufficiency | 证据证的是那个**行为**，还是它的周边？ | `SUFFICIENT` / `INSUFFICIENT` |
| 4 Technical Quality | correctness / regression / edge case / security | 原有 P1–P4 分级不变 |

判词定义（第 1 闸）：

- `PASS` —— 行为已实现**且**有证据。
- `PARTIAL` —— 有验收行为缺失（三条判据实现了两条 = `PARTIAL`）。
- `FAIL` —— 实现与需求矛盾或使其失效。
- `NOT_EVIDENCED` —— 实现可能在，但证据不足以证明那个行为
  （「Button renders」不能证明「点击后 Feedback Agent 拿到 component context」）。

**禁止两种 PASS**：因为实施 Agent 声称完成；因为测试全绿。

架构：**符合性在范围内，提案仍然禁止**（ADR-0088 决策 4）。对照引用的约束判越界
是第 2 闸的职责；提出新架构 / 重构 / 重新设计一律超范围，交给 ADR。

控制器怎么评级（codex-review-loop Phase 1）：

| 审查结果 | 当作 | 轮次影响（ADR-0081 不变） |
| --- | --- | --- |
| 判据 `FAIL` / `PARTIAL` | **P1** —— 必修 | 修完买一轮复审 |
| 判据 `NOT_EVIDENCED` | **P1** —— 补证据 | 只补测试/证据、产品代码未动 → **不买轮**，跑归属域即收口 |
| 约束 `FAIL` | **P1** —— 改回边界内 | 修完买一轮复审 |
| 第 3 闸 `INSUFFICIENT` | **P1** —— 补到能证明行为 | 同 `NOT_EVIDENCED` |
| 第 4 闸 | 原样 P1/P2/P3/P4 | 原协议 |

**没被评级的判据按 `NOT_EVIDENCED` 记**（不是按 PASS）。包里声称了三条判据、
回答只评了两条时，第三条就是 `NOT_EVIDENCED` —— 控制器手里有包，数得出来；
脚本不去数（包的写法一变就会误杀，而误杀要花掉一整轮）。方向仍是 fail-closed：
少评一条等于挡住 merge。

两条机器守的 fail-closed（脚本自己判，不靠控制器自觉）：

- **带包时「有标题但没评级」不算一次审查** —— 三节必须**按顺序**出现，且第 1 闸
  至少给出一个判词；否则与「没有 `VERDICT:` 行」同等对待（codex 回退 claude，
  claude 也这样就 `ENV_ERROR`）。
- **`GATE_CONSISTENCY: inconsistent` 压过 `VERDICT:`** —— `pass` 与某个闸的
  `PARTIAL`/`FAIL`/`NOT_EVIDENCED`/`INSUFFICIENT` 同时出现、**或 `BLOCKING`
  里真的列着发现**时，脚本在 `REVIEWER:` 旁边加这一行，该轮**按 fail 处理**。
  脚本不改审查者的原话，只把矛盾说出来；散文里出现闸词也会触发它 ——
  那个方向是有意 fail-closed 的。

守不到的地方，如实写在这里：**QUICK 深度的 Change 用提交信息当记录**，
`orphan-task` 只看任务卡，所以「提交信息里既没 REQ 也没技术目标」这条机器拦不住
（要拦得改 commit gate 的信息合同 = ADR-0070，另立卡）。它仍然被审查第 1 闸拦 ——
没有需求的 Change 备不出一个声称需求的包。

## 6. 收口：Merge Gate 多三个必成立项

ADR-0085 定的 merge 前置链**一条不减**，追加（ADR-0088 决策 6）：

- Requirement Fulfillment 全 `PASS`；
- Architecture Conformance 无 `FAIL`；
- Verification `SUFFICIENT`；
- 四个缺口标签一个都不挂。

任一判据 `PARTIAL` / `FAIL` / `NOT_EVIDENCED` → **Merge Gate ≠ PASS**。

**判据不满足不等于要问用户**（AGENTS.md §1 不变）：缺实现就实现，缺证据就补，
越界就改回来 —— 都是工程问题，自己做完。真的超出本卡范围时，正路是**把缺口写成
新卡，并在 REQ 里显式记下该判据挪到哪**，而不是让它以 `PARTIAL` 状态被 merge 掉。
只有**两条有效 CONFIRMED 需求真冲突**、或**必须改已确认的产品行为**才升级用户。
