# Requirement Record 与 Change Record

生命周期（谁活多久、默认读什么、临时产物怎么办）见
[lifecycle.md](lifecycle.md)；权威是 AGENTS.md 第 24–26 条 / ADR-0087。

## 最小记录规则

写之前先找现有归属：需求归 REQ，当前合同归其权威文件，执行与验证归任务卡
（QUICK 用提交信息）。**同一事实只维护一处正文，其他地方放链接或判据句柄。**
Review Package 按 traceability.md 摘录原文供审查，属于临时快照，不成为第二份规格。

| 这次实际发生了什么 | 写什么 |
| --- | --- |
| 明确的小修正，或局部文档修正 | QUICK：提交说明目标、变化、验证；已有 REQ/TASK 就引用，不另建卡 |
| 一个需要持续跟踪的实施任务 | 一张任务卡；已有本次卡就更新，不另建 plan、design、验收报告 |
| 新产品行为或已确认行为发生变化 | 建 REQ 或在原 REQ 追加 delta；卡引用判据，不重抄需求 |
| 重大设计决策 | ADR 记理由，当前合同记结果，卡只放链接；普通实现选择留在卡内 |
| 原始调查、命令输出、试错过程 | 会话或 .claude/tmp/；卡内只保留可复核结论 |

## 控制面与执行面 —— 哪些字该写下来给人看

**四层，前三层是人审的控制面，第四层是我自己的工作记忆**
（[SKILL.md](../SKILL.md) 最高原则 2）：

| 层 | 回答什么 | 住在哪 | 谁读 |
| --- | --- | --- | --- |
| **Requirement** | 用户最终看到什么行为 | `docs/requirements/REQ-*.md` | 人 |
| **Design** | 系统用什么结构解决它 | ADR + [当前架构合同](../../../../docs/current-architecture.md)；普通选择写卡内结论 | 人 |
| **Task** | 哪几个可验证切片完成这个 Design | `docs/tasks/*/TASK-*.md` | 人 |
| **Execution detail** | 改哪个文件、哪个函数、哪个字段、按什么顺序 | 会话记忆或 `.claude/tmp/`（已 gitignore） | **只有我** |

**判据一句话：这一行变了，人的判断会跟着变吗？** 会 → 控制面；不会 → 执行面。

因此**卡上不写**这些：某个函数怎么改、某个 class 加什么方法、API 用什么参数名、
DB 哪一列怎么处理、分几步敲键盘。它们**不是**保密，是**没有审阅价值** ——
写进卡只会把「三条要审的判断」埋进「三十条不用审的步骤」里，于是整张卡都没人审。

**执行细节任务结束即删**（AGENTS §26）。有长期价值的**先提炼**成卡上的结论几行、
一条 ADR 或当前架构合同里的一行，**再删原件**。

新增独立文档前，必须能说明它回答了哪个**现有文档无法承载、后续仍需维护**的问题。
说不出来就更新现有位置。模板是信息清单，允许合并章节；不填空标题、不重复写
「目标/用户需要/预期效果」，无架构变化或 Follow-up 时省略对应章节。
普通任务卡以一屏到两屏为目标；必要的验收和证据可以超出，不为达字数拆成更多文件。

**返工前先对账**：核对当前有效判据 → 现有实现 → 验证证据，区分缺实现、缺证据、
需求变化、文档过期。缺证据先验证，文档过期只修文档，已有有效实现继续复用；
需求变更只做 delta。把「缺口 + 下一步」写回原卡；已完成卡的后续修正用 QUICK
提交引用原卡，超出 QUICK 才建关联卡。不另写一份重新规划全文的报告。

## Requirement Record（`docs/requirements/REQ-*.md`）

一个需求一个文件，命名 `REQ-NNN-short-slug.md`，编号取
`docs/requirements/` 下现有最大号 +1。索引在 `docs/requirements/index.md`
（一行一条，Agent 建 REQ 时同步加行）。

记录**为什么要做、用户真正要什么**。实现方案不写这里（写任务卡/ADR）。
只有产品需求建 REQ：Bug / Refactor / Perf 默认不建（见 SKILL.md 第 4 环）。

```markdown
# REQ-001：<一句话标题>

- 状态：CONFIRMED            # 整体状态 = 最新版本的状态
- 相关 Change：TASK-0XX · <commit>   # Agent 随实施追加

## v1 — CONFIRMED（2026-08-22）

- 来源：产品负责人 2026-08-22 —— 「<原话>」
- 用户真正需要什么：<一两句>
- 为什么：<一两句>
- 验收判据（产品视角，非测试清单）：
  1. <一条>
  2. <一条>
```

**判据必须是有序列表**：序号是后面对账与审查的引用句柄（`REQ-001 v1 判据 2`），
散文形式没法逐条判 `PASS / PARTIAL / FAIL / NOT_EVIDENCED`
（[traceability.md](traceability.md) §5）。

### 状态机

- `UNDERSTANDING` / `UNDERSTANDING_READY` 是实施工作流状态：前者表示产品行为理解
  尚未充分，后者表示 Requirement Understanding Check 已完整且没有实质产品歧义，
  可以进入已授权工作的实施。二者只需呈现在对话里，不为 Gate 单独建文档。
- `DRAFT` —— Agent 从探索/证据中推断、用户尚未要求的产品需求；不将它当成已获授权。
- `CONFIRMED` —— 有用户明确要求、既有已确认需求，或用户看过结果后的反馈作为依据；
  写清来源。不得把 Agent 的额外设想记成用户确认，也不要求用户重复确认已明确的要求。
  可逆 UI/UX 细节按 AGENTS.md §1 先做一版，假设写在卡内，不冒充用户原话。
- `SUPERSEDED` —— 被同文件更高版本或另一 REQ 取代（写明被谁取代）。
  **整份被另一个 REQ 取代时**：状态行改 `SUPERSEDED —— 被 REQ-NNN 取代`，
  文件留着不删，索引那一行同步改（两处状态必须一致 ——
  `.claude/tools/lifecycle_check.py` 会比，不一致即红）。

### 版本修订（真实使用后需求变化）

**不篡改已 CONFIRMED 的旧版本。** 同文件追加：

```markdown
## v2 — CONFIRMED（YYYY-MM-DD）· supersedes v1

- 来源：<原话/依据>
- 相对 v1 的 delta：<只写变化，不重抄全文>
```

后续实施只处理 **v1→v2 delta**，不从头重做整个功能。
v1 标题行就地补 `（superseded by v2）`，内容一字不动。

### 与存量机制的关系

存量需求已由 `docs/product_spec.md`、两份顶层需求文档、任务卡「依据」行
承载——**不回填成 REQ**。改到某条存量需求时，才为它建 REQ 并在 v1 里
指回原始出处；从那一刻起该需求的演化以 REQ 文件为准。

## Change Record

**一个任务一个，Agent 自动创建自动维护，用户不填。**

- **QUICK 深度**：提交信息即记录。首行写意图，正文写关联
  （`REQ-NNN`/`TASK-NNN`，如有）、做了什么验证。不建卡。
- **STANDARD / DEEP 深度**：任务卡 `docs/tasks/active/TASK-NNN-slug.md`
  （在办；做完后 `git mv` 进 `docs/tasks/done/` 并重新生成 `docs/STATUS.md`
  —— 目录即状态，ADR-0083）。**三个状态目录**（ADR-0087 决策 2）：
  `backlog/` 没人在做 → `active/` 正在做（含「部分完成」）→ `done/` 做完/已退役。
  立了卡但短期不做的放 `backlog/`，别停在 `active/`
  （编号顺延现有最大号），沿用本仓库既有卡风格，最小字段集：

```markdown
# TASK-NNN：<标题>

<!-- Decision Brief：这个案件的控制面。六行，是卡头，不是第二份文件。 -->
- 起因：<用户原话 / 缺陷现象 / 上一条决策> · 闸：放行（第 2 问，阻塞 TASK-106）
- 类型：Feature | Bug | Refactor | Perf | Migration · 深度：STANDARD | DEEP（C=DEEP：改持久化格式）
- 成果物：REQ-NNN · ADR-NNNN · 本卡 · 提交
- 关联 Requirement：REQ-NNN vK 判据 1,3（可多条；存量需求写「依据」行原话）
                    # 无产品需求时改写「技术目标：<一句，含为什么必要>」
- 架构约束：CA §2 依赖方向 · CA §5.3 fail-closed    # 或 none-specific
- 状态：未开工 | 进行中 | 完成 | 中止    # 写「交付了什么」，不得与所在目录矛盾

## 范围与影响
IN SCOPE：<本次要交付什么>；OUT OF SCOPE：<本次不做什么>
<Requirement / UI / 数据 Schema / Workflow / 测试 / docs 六面：要改 / 不动>
<有架构决策才补结论或 ADR 链接，不复制合同>

## 结果与验证
- 实现：<未完成 / 完成 + 文件或提交证据>
- 验证：<判据句柄 → 行为证据、命令与结果；需审查时附四闸结论>
- 真实项目尚未由人看过的验收项：<逐条列出，或无；这是信息，不是签字闸>
- 剩余：<缺口与下一步；无则省略。范围外问题链接 TASK-087，不重复维护>
```

卡保持轻量——上面每节几行即可，不写几十页。

### Decision Brief 逐字段

**它是卡头那六行，不是一份新文件。** 每一行都是**人要看的**（谁读了这六行，
就知道这个案件为什么存在、有多重、会产生什么、做完没有）：

| 字段 | 写什么 | 写错了会怎样 |
| --- | --- | --- |
| `起因` | 为什么出现这个案件：用户原话 / 缺陷现象 / 上一条决策；后半句挂里程碑闸的判定（`闸：放行（第 N 问…）`） | 缺了它，三个月后没人说得出这张卡为什么存在 —— 那就是 `ORPHAN_TASK` 的人类版本 |
| `类型` · `深度` | 五条工作流之一 + QUICK/STANDARD/DEEP，**括号里写是哪个变量顶上去的**（`C=DEEP：改持久化格式`） | 只写档位不写变量，升档降档就没有可复核的依据（[depth.md](depth.md)） |
| `成果物` | 这个案件会产生哪些**持久物**：REQ / ADR / 本卡 / 只有提交 | 这是防文档蔓延的那道闸：开工时说了只产出「本卡 + 提交」，收口时冒出三份新文档就是范围扩散 |
| `关联 Requirement` 或 `技术目标` | 追溯句柄（[traceability.md](traceability.md) §2） | 两者皆无 → `ORPHAN_TASK`，`lifecycle_check` 当场转红 |
| `架构约束` | 只引与自己相关的 `CA §N`；确实不受约束写 `none-specific` | 为形式凑引用没有信息量；该引不引 → `ARCHITECTURE_UNKNOWN` |
| `状态` | **交付了什么**（如「audio/ 包 + AV 混流步骤」），不是「做完没有」 | 与所在目录矛盾（`完成` 却在 `active/`）→ `lifecycle_check` 转红 |

**QUICK 深度没有卡**，它的 Brief 就是提交信息里的那两行：首行写意图，
正文写关联（`REQ-NNN` / `TASK-NNN`）与做了什么验证。

**不建 traceability 数据库、不给卡加 metadata 文件、不给每层建一种新记录类型**
（[ADR-0101](../../../../docs/adr/ADR-0101-idea-intake-level-and-milestone-gate.md) §4
已裁决，不重访）。Brief 之所以成立，正因为它**没有**新增文件。

**Milestone Gate 判「现在不做」时落的卡更轻**（SKILL.md 第 1 环 ·
[ADR-0101](../../../../docs/adr/ADR-0101-idea-intake-level-and-milestone-gate.md) 决策 3）：
标题 + `技术目标：`（或 `关联 Requirement：`）+ 一行「为什么现在不做 ·
**什么条件下它会变成该做**」就够，直接落 `docs/tasks/backlog/`。
最后那半句是 `backlog/` 与垃圾桶的区别；缺了基础字段则是 `ORPHAN_TASK`。
它**不建 REQ、不进 Understanding Gate** —— 那两步是放行之后的事。

**卡不是调查记录本。** 调查过程、试错、原始输出属于一次性产物：留 `.claude/tmp/`
或会话 scratchpad，收口时把**结论几行**写进卡然后删原件（AGENTS.md 第 26 条）。

## 追溯链

`REQ-NNN 判据 M → TASK-NNN（或提交信息）→ CA §N → 代码 → 验证证据 → 审查 → Merge`。
双向：REQ 里追加「相关 Change」，卡里写「关联 Requirement」+「架构约束」，
提交信息里引用两者之一。

句柄约定、四个缺口标签（`ORPHAN_TASK` / `ORPHAN_IMPLEMENTATION` /
`REQUIREMENT_COVERAGE_GAP` / `ARCHITECTURE_UNKNOWN`）、Review Package 模板与
四闸判词都在 [traceability.md](traceability.md) —— **本文件不重复**。
