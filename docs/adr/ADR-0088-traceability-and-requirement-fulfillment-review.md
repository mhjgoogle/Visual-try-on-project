# ADR-0088：从产品意图到验证的追溯链，与「需求完成度」优先的审查

- 状态：Accepted
- 日期：2026-08-26
- 决策者：产品负责人下发目标（2026-08-26），实施 Agent 依 AGENTS.md §1
  「ADR 的 Accept 权」自行 Accept 技术形状（无付费、无不可逆动用户数据）
- 关联：[REQ-003](../requirements/REQ-003-traceability-and-requirement-fulfillment-review.md) ·
  [TASK-108](../tasks/done/TASK-108-traceability-and-requirement-review.md) ·
  [ADR-0076](ADR-0076-dev-workflow-operating-skill.md)（dev-workflow 与 REQ 记录，本 ADR 扩展它）·
  [ADR-0081](ADR-0081-review-by-impact-scope.md)（审查触发与轮次协议，**轮次不变**，本 ADR 只定审查**内容与顺序**）·
  [ADR-0087](ADR-0087-document-lifecycle-and-default-agent-context.md)（当前架构合同 = 架构约束的引用来源）·
  [ADR-0079](ADR-0079-auto-push-skill.md)（Change 清单 = Task→代码的既有映射）

## 1. 背景

产品负责人 2026-08-26：

> 「Every implementation must be traceable from product intent to verification.」
> 「Codex 不再只是回答 The code looks good —— 它必须能回答：这个 Change 声称
> 完成了哪些 Requirement，每条是否真正完成，证据在哪里，是否符合当前
> Architecture，如果不能 Merge，具体缺的是哪一环。」

盘点现有 dev-workflow / codex-review-loop / auto-push 之后，链条上有三段是断的：

| 断点 | 实测证据（2026-08-26 盘点） |
| --- | --- |
| **审查从不看需求** | `run-review.sh` / `.ps1` 的 prompt 只送 diff，写死四个镜头（correctness / regression / edge case / security），**REQ 与验收判据一个字都不进上下文**。一个「实现了 2/3 条判据」的 Change 可以正当地拿到 `VERDICT: pass` |
| **架构约束进不了审查** | 同一 prompt 明文禁止审查者谈架构（为了让修复循环收敛）。禁令的副作用是**越界也报不出来**：需求做到了、依赖方向反了，仍然 pass |
| **卡上的关联是自由文本** | 任务卡有「关联 Requirement」「架构影响」两栏，但 TASK-040 头部一个依据/REQ/ADR 都不写也没人拦；判据是散文，审查者无法逐条对账 |

反过来，链条上有两段其实**已经存在**，不需要新机制：

- **Task → 代码**：auto-push 清单按 Task 记 `paths` + commit hash，并把不属于任何
  已申报 Task 的 diff 判成 `foreign` / `BLOCKED_WIDE` —— 那就是 ORPHAN
  IMPLEMENTATION 检测，只是从来没这么叫过。
- **审查节奏与预算**：ADR-0081 的触发表与轮次协议、脚本的 diff 体积守卫、
  Skill 的 token 纪律都在，**不得再造第二套**。

## 2. 决策

### 决策 1：一条链，六个环，每个环都有既有载体

```
Requirement → Change → Task → 架构约束 → 代码 → 验证证据 → 独立审查 → Merge
   WHY          WHAT      WORK    BOUNDARIES   HOW      PROOF       CHECK
```

引用句柄一律**复用现有编号，不新建命名空间**：

| 环 | 句柄 | 载体 |
| --- | --- | --- |
| Requirement + 判据 | `REQ-NNN vK 判据 M`（REQ 的验收判据本来就是有序列表） | `docs/requirements/` |
| Change / Task | `TASK-NNN`；QUICK 深度 = 提交信息 | `docs/tasks/{backlog,active,done}/` |
| 架构约束 | `CA §N`（`docs/current-architecture.md` 的节号即句柄）；确实不受约束时写 `none-specific` | ADR-0087 决策 4 建的那份合同 |
| 代码 | Change 清单的 `paths` + commit hash + diff | `docs/auto-push/changes/*.json` |
| 验证 | 命令 + 结果，**逐条判据**对应 | 任务卡「验证」节 |

**不建追溯数据库、不给文件加永久 metadata、不给函数标 REQ ID。** 产品级追踪表
已有一份（`docs/design/end-to-end-requirements-traceability.md`），也不建第二份；
per-Change 的追溯视图在收口与审查时**现算**，不落库。

### 决策 2：无 Requirement 的工作必须写「技术目标」

Bug / Refactor / Perf / 工装 默认不建 REQ（ADR-0076 已定）。代价是这些卡可以
一个依据都不写。因此：**卡头部必须至少命中一个追溯锚点** ——
`REQ-NNN`，或**带标签的**「关联 Requirement / 依据 / 技术目标 / 起因」字段；
否则是 `ORPHAN_TASK`。**光提一句 `ADR-NNNN` 不算**（几乎每张卡都会在背景里
引某条 ADR，那样等于不判）。

检查范围是 `active/` **加上** `backlog/` `done/` 里带本 ADR 字段集
（`架构约束：`）的卡 —— Done 判定要求把卡搬进 `done/`，只看 `active/` 会**正好
在 merge 那一刻**看不见它。已完成的存量卡刻意豁免：回填
依据正是 ADR-0087 要避免的一次性整理，而给没人记得的旧工作编一条依据是虚构。
（这里说的是给 100 张已完成的卡回填。）

这一条机器可判，由 `.claude/tools/lifecycle_check.py` 的 `orphan-task` 检查守。

### 决策 3：审查顺序固定为四道闸，顺序本身是决策

1. **Requirement Fulfillment** —— 声称完成的每条判据，真的实现了吗？
2. **Architecture Conformance** —— 停在卡引用的每条 `CA §N` 之内了吗？
3. **Verification Sufficiency** —— 证据证的是**那个行为**，还是它的周边？
4. **Technical Quality** —— 原有四镜头（correctness / regression / edge / security）。

顺序不是排版：**普通代码风格问题不得盖住「需求没做完」**。第 4 闸的内容一字不减，
只是不再是唯一的一闸。

第 1 闸的判词只有四个：

| 判词 | 含义 |
| --- | --- |
| `PASS` | 行为已实现**且**有证据 |
| `PARTIAL` | 有验收行为缺失 |
| `FAIL` | 实现与需求矛盾或使其失效 |
| `NOT_EVIDENCED` | 实现可能在，但证据不足以证明 |

**禁止两种 PASS**：因为实施 Agent 声称完成，或因为测试全绿。第 2 闸判
`PASS / FAIL / NOT_APPLICABLE`，第 3 闸判 `SUFFICIENT / INSUFFICIENT`。

### 决策 4：架构「符合性」在范围内，架构「提案」仍然禁止

旧 prompt 的禁令是为了收敛（审查者提重构 → 循环永不结束），这一点不变。改的是
把两件事分开：**对照卡引用的约束判越界**在范围内；**提出新架构 / 重构 / 重新设计**
仍然明文禁止，交给 ADR。

### 决策 5：Review Package —— 审查者默认不扫仓库

调用审查前，由实施 Agent 备一份 Review Package（Change ID · REQ 与判据原文 ·
Task · 引用的 `CA §N` 原文 · 变更文件 · 验证证据 · 已知风险 · 实施摘要），
写 `.claude/tmp/review-package.md`（已 gitignore），经 `REVIEW_PACKAGE` 交给脚本。
脚本把它放在 diff 之前，并在 prompt 里明确：**包外的东西默认不看**；只有某道闸
不读别处就判不了时才扩展，且必须说明。

包**不可读 / 为空 / 空白 / 超行数上限**一律 fail-closed（`ENV_ERROR` /
`PACKAGE_TOO_LARGE`，仍 exit 0）—— 沿用脚本既有姿态：宁可不审，不假装审过。
两个 host 对同一环境必须给出同一结论（ADR-0062 决策 3），空白值也算。
没有包时脚本退回**只审第 4 闸**，三道新闸报 `(none)`：纯工装/纯技术清理仍可用。

**带包时脚本还拒绝两种「看起来完成」的回答**（三轮实测出来的 fail-open）：

1. **有标题但没评级** —— 五节必须**按顺序**出现（`REQUIREMENT` → `ARCHITECTURE`
   → `VERIFICATION` → `BLOCKING` → `NON_BLOCKING`）且第 1 闸至少给一个判词；
   否则与「没有 `VERDICT:` 行」同等对待。
2. **verdict 与自己的内容矛盾** —— `pass` 上方有非 PASS 的闸，或 `BLOCKING`
   真的列着发现时，脚本加一行 `GATE_CONSISTENCY: inconsistent … treat this
   review as fail.`，**不改审查者原话**，控制器与 Merge Gate 据此按 fail 处理。

机器守不到的两处，如实记在这里而不是假装守住了：**QUICK 深度的 Change 以提交信息
为记录**，`orphan-task` 只看任务卡（要拦需改 ADR-0070 的提交信息合同，另立卡）；
**判据级覆盖率不由脚本数**（解析包的散文会误杀，而误杀要花掉一整轮）——
规则是「没被评级的判据按 `NOT_EVIDENCED` 记」，方向仍然 fail-closed。

### 决策 6：Merge Gate 增加三个必成立项，人工闸不回来

merge 前置链（ADR-0085 定的那条，不变）追加：Requirement Fulfillment 全 `PASS` ·
Architecture Conformance 无 `FAIL` · Verification `SUFFICIENT` · 无
`ORPHAN_TASK` / `ORPHAN_IMPLEMENTATION` / `REQUIREMENT_COVERAGE_GAP` /
`ARCHITECTURE_UNKNOWN`。任何一条 `PARTIAL` / `FAIL` / `NOT_EVIDENCED` →
Merge Gate ≠ PASS。

**判据不满足不等于要问用户**（AGENTS.md §1 不变）：缺实现就实现，缺证据就补证据，
架构越界就改回边界内。只有**两条有效 CONFIRMED 需求真冲突**、或**必须改已确认
的产品行为**才升级用户。范围确实超出本卡时，正路是把缺口写成新卡并把该判据在
REQ 里显式降级/挪走，而不是让它以 `PARTIAL` 状态被 merge 掉。

## 3. 后果

- **好的**：审查者能回答「哪条判据没完成、证据缺在哪、越了哪条约束」；
  卡与 REQ 之间从散文变成可逐条对账；`ORPHAN_TASK` 当场转红。
- **要接受的**：调审查前多一步备包（几分钟，且本来就要写实施摘要）；
  prompt 变长约 40 行 —— 用「默认不扫仓库」换回来的 token 远多于这 40 行。
- **不做的**：不建 traceability 数据库、不加第二套 Codex 触发规则、
  不新建独立的 review Skill、不给普通 Task 无条件调 Codex（ADR-0081 的触发表不动）。

## 4. 落地

| 位置 | 动作 |
| --- | --- |
| `.claude/skills/dev-workflow/references/traceability.md` | 新增：链、句柄、Review Package 模板、四闸判词、四个缺口标签 |
| `.claude/skills/dev-workflow/SKILL.md` | 第 3/4/8/10 步接线（各 1–4 行），追溯链那行改为指向新 reference |
| `.claude/skills/dev-workflow/references/records.md` | 卡最小字段集补「技术目标」「架构约束」；原「追溯链」节合并进新 reference |
| `.claude/skills/dev-workflow/references/verification.md` | Done 判定改为按判据对账 + 证据充分性 |
| `.claude/skills/codex-review-loop/SKILL.md` | Phase 0 增备包一步；四闸顺序与判词接进评级；Ironclad 规则区分符合性与提案 |
| `.claude/skills/codex-review-loop/scripts/run-review.{sh,ps1}` | `REVIEW_PACKAGE` 支持（两侧行为相同，ADR-0050 决策 1）；prompt 换成四闸；输出增三节 |
| `.claude/skills/auto-push/SKILL.md` | Merge Gate 前置链补一行（声明，非新动作） |
| `AGENTS.md` §6 | 审查顺序与四判词入规则（唯一一份规则） |
| `docs/current-architecture.md` | §5 注明节号即引用句柄 |
| `.claude/tools/lifecycle_check.py` | 新增 `orphan-task` 检查 |
| `tests/tooling/` | `test_lifecycle_check.py` 补断言；`test_review_package_contract.py` 新增 |
