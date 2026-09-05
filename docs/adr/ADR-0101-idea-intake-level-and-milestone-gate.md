# ADR-0101：想法先分层、再过当前里程碑闸，然后才谈需求

- 状态：Accepted
- 日期：2026-09-05
- 决策者：实施 Agent 依 AGENTS.md §1 自行 Accept（Agent 流程与工装决策，不涉付费、
  不动用户数据；每一条都逆得回来 —— 闸判错就把卡从 `backlog/` 搬回 `active/`）
- 关联：[ADR-0087](ADR-0087-document-lifecycle-and-default-agent-context.md)（文档生命周期与
  默认上下文，**不动**；本 ADR 用它的三分类给「当前真相」定位）·
  [ADR-0083](ADR-0083-docs-partitioned-by-completion.md)（目录即状态 —— 闸的 No 分支落在
  `backlog/` 而不是新目录）· [ADR-0088](ADR-0088-traceability-and-requirement-fulfillment-review.md)
  （四闸审查回答「需求做完了吗」，本 ADR 补的是它前面那一步「这需求该现在做吗」）·
  [ADR-0098](ADR-0098-index-docs-are-not-a-second-contract.md)（一份文档只答一个问题）·
  [TASK-141](../tasks/active/TASK-141-idea-intake-and-current-truth.md)

## 1. 背景

产品负责人 2026-09-05 给出五条：禁止 Idea 直接进入 Coding · 每次先读 Current
Milestone · Requirement 与 Solution 分开 · 修改之前必须做影响分析 · 必须维护一个
Current Truth。

这五条落在同一个缺口上：**dev-workflow 的入口假设「这件事该做」已经成立。**

现有流程从 Requirement Understanding Gate 开始，那道闸问的是「这个需求我理解对了
吗」，**不问「这个想法是哪一层」，也不问「这一轮必须做吗」**。于是任何一句
「增加 X」都能在同一个回合里走完理解 → 建卡 → 改代码，路径是：

```
Idea → Claude → Code
```

**代价不是假设，是观察值。**

- `docs/tasks/active/` 长期挂着九张卡，而 AGENTS.md §2 写的是「同一时间最多推进
  1 个主要用户需求 + 1 个阻塞它的技术任务」。九不是一，差额就是没被拦下的想法。
- 排期判断**确实发生过，但发生在事后**：[TASK-011](../tasks/backlog/TASK-011-local-video-provider.md)
  的卡头有一段 2026-08-24 的订正 ——「卡住它的不是『等用户裁决』，是 WFM3 还没排上」。
  那句话本该在想法进来的那一刻说，说了就是一张 `backlog/` 卡；晚说的代价是这张卡
  先被当成在办、还先长出了一道假闸门。
- 「Requirement 与 Solution 分开」这条缺失的证据在 [records.md](../../.claude/skills/dev-workflow/references/records.md)
  的反面：它规定 REQ「不写实现方案」，却没有任何一步**检验**递进来的那句话本身
  是不是方案。「增加一个一致性校验 Agent」读起来完全像需求。

**当前真相**同样有缺口。仓库能回答的是架构（[current-architecture.md](../current-architecture.md)）、
文档完成状态（生成的 [STATUS.md](../STATUS.md)）、术语与范围外（ADR-0098 那两份索引），
但 Mission / Strategy / **Current Milestone** / Active Requirements / Deferred /
Recent Decisions 这六个面**没有一个地方能一次读到**：前三个埋在
[project-context.md](../project-context.md) 的散文里，后三个要自己去 `ls` 三个目录。
里程碑闸要天天读的恰恰是第三面 —— 一道要靠人去散文里翻答案的闸，第二周就会被跳过。

## 2. 决策

### 决策 1：想法先落层，六层，各层落点与决定权不同

| 层 | 它回答什么 | 落在哪 | 谁定 |
| --- | --- | --- | --- |
| **Mission** | 这个产品为什么存在 | `project-context.md` 锚点行 | 用户 |
| **Strategy** | 用哪条路线达成 | `project-context.md` 锚点行 + ADR | 用户给方向，Agent 记录 |
| **Milestone** | 这一轮交付什么 | `project-context.md` 锚点行 | 用户，**一句话**（AGENTS §1） |
| **Requirement** | 用户/系统必须成立的行为 | `docs/requirements/REQ-*.md` | 用户确认（理解闸） |
| **Solution** | 怎么实现它 | ADR / 任务卡「架构影响」 | **Agent 自己定，不问** |
| **Implementation** | 具体改哪些文件 | 任务卡 + 提交 | **Agent 自己定，不问** |

**铁律：想法留在它自己那一层，不许向下塌陷。** 塌陷有两个方向，两个都发生过：

- **向下**：一个 Milestone 级想法被当成 Implementation 直接开做 —— 这就是九张在办卡。
- **向上**：一个 Implementation 细节被包装成 Requirement 递给用户 ——
  AGENTS.md §1 已经点名过这种往返（「就算问我我也不知道该如何回答」）。

判不准时看**错了要重做多少**：只需重写几个文件 → Implementation；需要重新确认用户
行为 → Requirement；需要改路线 → Strategy 及以上。

### 决策 2：Requirement 与 Solution 的分界是一句可观测行为

把想法改写成一句「**谁**在**什么时候**能看到/得到**什么**」。改写后的句子里若仍然
必须出现**实现名词**（Agent、模块、服务、表、库、接口、脚本）才说得通，它就是
Solution 层，不是 Requirement。

```
递进来的：  增加一个剧情一致性校验 Agent
Requirement：章节提交后，与前文冲突的设定必须在定稿前被指出来
Solution：   用一个一致性 Agent 做校验          ← Agent 自己定，不进 REQ、不问用户
```

**Solution 不进 REQ，也不因为它「听起来像需求」就去问用户。** 一句方案被当成需求
接收，代价是需求被锁死在一种实现上：后来发现规则引擎更合适时，改的不是方案而是
「需求」，于是要惊动用户一次 —— 那次往返完全是自己造的。

### 决策 3：Current Milestone Gate —— 四问，全 No 就落 `backlog/`，不实施

每个新想法在建 REQ **之前**过这道闸。四问，任一 Yes 即放行：

1. 它在**当前里程碑**的交付面上吗？（读 `STATUS.md`「当前真相」节，见决策 5）
2. 它**阻塞**当前在办的那条主线吗？
3. 不做会造成**不可逆损害**吗？（数据损坏 / 安全 / 已经发出去的错误结果）
4. 它是**几分钟内能完成**的当前事实修正吗？（过期文档、错状态行）

全 No → 落 `docs/tasks/backlog/` 一张卡，**当场把判定说出来**，形如：

> 与长期 Mission 一致，但不服务当前 Milestone（<当前里程碑一句>），
> 进入 Backlog（TASK-NNN），不实施。

**必须落卡，不能只在对话里说一句「以后再说」** —— 说过就丢，那正是 ADR-0083 记的
同一个失效。卡最小三行即可：标题 · `技术目标：`（或 `关联 Requirement：`）· 一句
「为什么现在不做 + 什么条件下它会变成该做」。第三行是关键：没有它，`backlog/`
就变成了垃圾桶而不是队列。

**这道闸不问用户。** 判据是 AGENTS.md §1 的「错了能不能重来」：判错了就把卡从
`backlog/` 搬回 `active/`，一次 `git mv`。排序类问题永远不问（产品负责人
2026-08-23），这道闸就是排序。

**WIP 也是 No 的理由**：AGENTS §2 的 1 主线 + 1 阻塞项已经满、而新想法不属于第 2
问时，即使它属于当前里程碑，也进 `backlog/`。

### 决策 4：影响分析必须答出「哪些不动」，按六个面

原第 5 步只列「识别受影响的 X」，缺的是**否定面**。代价是那句已经付过的账：
「代码改了，但文档还是旧逻辑」。六面固定：

| 面 | 去哪找 |
| --- | --- |
| Requirement | `docs/requirements/` + 卡的「关联 Requirement」行 |
| UI | `mockups/motv-workspace/src/` + [产品信息架构](../design/creator-product-information-architecture.md) |
| 数据 Schema | 持久化结构与 `output.schema.json` 一类合同 |
| Workflow | `product-flows/` · 编排层 |
| 测试 | [CA §4](../current-architecture.md) 的归属映射 |
| docs | 当前事实类文档（架构合同、IA、glossary） |

输出**两栏**：要改的，和**明确不动的**。「不动」那一栏不是走过场 —— 它是后面
审查第 2 闸（架构符合性）与收敛检查的对照物：改了却在「不动」栏里的东西，是范围
扩散的第一个信号（SKILL.md 第 6 步 Change Isolation）。

### 决策 5：当前真相六面**生成**进 STATUS.md，锚点缺失即 fail-closed

| 面 | 来源 | 手写还是派生 |
| --- | --- | --- |
| Mission | `project-context.md` `<!-- current-truth: mission -->` | 手写一行 |
| Strategy | 同上 `strategy` 锚点 | 手写一行 |
| Current Milestone | 同上 `milestone` 锚点 | 手写一行 |
| Active Requirements | `docs/requirements/` 状态行 + `active/` 卡的引用 | 派生 |
| Deferred | `docs/tasks/backlog/` + TASK-087 总账 | 派生 |
| Recent Decisions | `docs/adr/` 最近若干条 | 派生 |

**为什么是三行锚点而不是抽取散文**：抽散文的生成器会在别人重排一次段落时安静地
抽错，而错误的当前真相比没有更坏（ADR-0087 的判据：过期时会不会骗人）。三行锚点
是**唯一手写的部分**，缺失或为空时 `gen_docs_status.py` **退出非零并说明缺哪一行**
—— 生成不出来的当前真相是缺陷，不是可以留白的格子。

**为什么落在 STATUS.md 而不是新建一份 `current-state.md`**：STATUS.md 已经在
AGENTS §25 的默认上下文里。里程碑闸每次都要读第三面，读的东西必须是**默认已经加载
的**，否则闸本身变成负担，第二周就没人过了。且 ADR-0098 那条「一份文档只答一个
问题」在这里成立 —— STATUS.md 答的一直是「现在是什么状态」，六面是同一个问题的
完整答案，不是第二个问题。

### 决策 6：入口这两步的产出是**对话里几行**，不是新文档

分层与过闸写在回答里（判定 + 一句理由），只有 Gate 判 No 才产生一个持久物
（一张 `backlog/` 卡）。**不建 traceability 数据库、不给卡加 metadata 文件、
不按里程碑二级归档** —— [out-of-scope.md](../out-of-scope.md) 那条边界不重访。
一道要写文档才能通过的闸，会被跳过；这条限制是这个决策能活下来的前提。

## 3. 代价（已接受）

- **每个想法多一次判断。** 换掉的是「做到一半发现不该现在做」，以及九张在办卡
  互相锁死那种状态。判断本身是三行，不是一份文档（决策 6）。
- **里程碑锚点是手写的一行，会过期。** 压制手段只有两个：生成器 fail-closed，
  以及 AGENTS 第 27 条把它写进每次收敛检查。仍然可能出现「锚点在但说的是上个
  里程碑」—— 这是本 ADR 没有解决的残留风险，代价是闸会照着旧里程碑放行。
- **闸会判错。** 该做的被推进 `backlog/` 是可逆的（搬回来），不该做的被放行则由
  原有的 Change Isolation 与收敛检查兜底。按 AGENTS §1，可逆的事直接做，不上交。
- **存量九张在办卡不回填层级。** 本 ADR 只管新想法；存量的收口归 TASK-125 与
  各自的卡。这意味着「`active/` 应该只有 1+1」这件事**不会因为本 ADR 立刻成立**。

## 4. 被否掉的方案

| 方案 | 为什么否 |
| --- | --- |
| 新建 `docs/current-state.md` 手写六面 | 第二份手写真相 = 第二个漂移源；且不在默认上下文里，闸读不到 |
| 把六面做成数据库 / 每卡 metadata | `out-of-scope.md` 已经裁决过，不重访 |
| 闸判 No 时问用户「要不要做」 | 排序类问题，AGENTS §1 明令不问；且用户说过「只能选择推荐选项」 |
| 只加规则不加生成器 | 「每次先读 Current Milestone」没有可读的落点时等于没加 |
| 给每层建一种新记录类型 | 六层里四层已有落点（REQ / ADR / 卡 / 提交），前三层一行就够 |
