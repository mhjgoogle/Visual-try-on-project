---
name: dev-workflow
description: >-
  Route development work from intake through implementation, verification and
  delivery. Use at the start of features, bug fixes, refactors, performance
  work, migrations and development-document maintenance. Claim ownership of a
  shared tree first, apply the current milestone gate, pick depth from
  uncertainty, impact, reversibility and contract change, and keep the
  human-reviewable plane thin by leaving code-level plans in the working
  memory of the agent. Do not use for questions, code explanations, pure
  conversation or a standalone review (use codex-review-loop for that).
---

# dev-workflow — 软件开发操作 Skill（v0.3）

一个入口，六个环节。**正文只说「什么时候想什么」，`references/` 说「具体怎么做」。**

## 三条最高原则

1. **复杂度增加可以加分析深度，不自动增加文件种类。** 文档只保存继续开发必需的
   事实；同一事实一处正文，别处放链接或句柄。
2. **控制面与执行面分开。** 人审的是 Requirement（What）· Design（How at system
   level）· Task（可验证切片）；**代码级计划是我的工作记忆** —— 不进卡、不进
   `docs/`、任务结束即删。判据一句话：**这一行变了，人的判断会跟着变吗？**
   不会 → 执行面。
3. **深度管流程重量，影响面管验证重量。** 两者各判各的（第 3 环）。

**本 Skill 是路由与记录层，不重定义仓库已有的权威规则。** 测试归属与规模、审查
触发与轮次、提交与合并、决策模式，权威永远是 AGENTS.md（§1 决策 · §6 测试与审查 ·
§7 Git）与 ADR-0068 / 0080 / 0081 / 0088。冲突时以它们为准。

## 六个环节

| # | 环节 | 回答什么 | 展开在 |
| --- | --- | --- | --- |
| 1 | **Intake 收案** | 这活是谁的、属于哪一层、现在该做吗 | [handoff](references/handoff.md) · [repo-contract](references/repo-contract.md) |
| 2 | **Classify 定类** | 这是哪种工作 | [workflows](references/workflows.md) |
| 3 | **Depth 定深** | 错一次的代价多大 → 要产出哪些成果物 | [depth](references/depth.md) |
| 4 | **Contract 定契约** | What（REQ）与 How-at-system-level（ADR / CA） | [records](references/records.md) · [architecture](references/architecture.md) |
| 5 | **Execute 执行** | 改什么、**明确不动什么** | [workflows](references/workflows.md) · [architecture](references/architecture.md) |
| 6 | **Close 收口** | 证据够不够、仓库有没有更乱、能不能交 | [verification](references/verification.md) · [traceability](references/traceability.md) · [lifecycle](references/lifecycle.md) |

QUICK 深度把第 4 环折叠成一行引用，把第 6 环压到几分钟；DEEP 把六环全部展开。

---

## 1 · Intake 收案

**先认领，再动手。**

1. **归属**：`ListAgents` 看同仓有没有别的会话在跑；有就先认领文件范围再动
   （AGENTS §14/§16）。工作树里的未提交改动**默认是别人的**，不是无主残留 ——
   `git status` 看得到「有改动」，看不到「是谁的」。
2. **接树**：`python .claude/tools/agent_harness.py resume` —— 谁在这张卡上 ·
   哪些卡还开着 · 上一轮「跑过什么」在这个 tip 上还算不算数
   （[handoff.md](references/handoff.md)）。**接回来就是接着做，不问「要不要继续」。**
3. **合同**（每个新 repo 一次）：八个问题的答案已在
   [repo-contract.md](references/repo-contract.md)，已满足即直接用，不平行造第二套。

然后**判层级 + 过闸**。产出是**对话里三行**，不是一份文档 —— 一道要写文档才能过的
闸会被跳过。

- **层级**：Mission / Strategy / Milestone / Requirement / Solution /
  Implementation 六选一。前三层归用户，Requirement 走理解闸（第 4 环），
  **Solution 与 Implementation 我自己定，不问**。想法留在自己那一层，**不许塌陷**：
  Milestone 级想法被当成 Implementation 直接开做，就是 `active/` 长期挂九张卡的成因；
  Implementation 细节被包装成 Requirement 递给用户拍板，是同一种错的反面。
  判不准看**错了要重做多少**：重写几个文件 → Implementation；要重新确认用户行为
  → Requirement；要改路线 → Strategy 及以上。
- **Requirement 还是 Solution**：改写成「**谁**在**什么时候**能看到 / 得到**什么**」。
  改写后仍必须出现实现名词（Agent / 模块 / 服务 / 表 / 接口 / 脚本）才说得通 →
  它是 **Solution**，**不进 REQ、也不拿去问用户**；拿改写出来的那句去过闸，
  实现方式我自己选。
- **里程碑闸**：读 [STATUS.md](../../../docs/STATUS.md)「当前真相」第三面，四问 ——
  在当前里程碑交付面上 / 阻塞在办主线 / 不做会造成不可逆损害 / 是几分钟的当前事实
  修正。**任一 Yes 放行**；WIP（1 主线 + 1 阻塞项）已满且不属第 2 问 → 也进
  `backlog/`。**全 No → 落一张 `backlog/` 卡并当场说明，不实施、不建 REQ。**
  卡上那句「**什么条件下它会变成该做**」是 `backlog/` 与垃圾桶的区别。
  **这道闸不问用户** —— 判错可逆（`git mv` 搬回 `active/`），排序类问题永远不问。

**什么时候跳过整个第 1 环**：用户指的是**已经在办的那张卡**里的下一步（继续、
修它报的错、补它缺的证据）。那不是新案件，直接干。

## 2 · Classify 定类

按**意图**（不是措辞）选一条，一个任务只有一条。铁律见
[workflows.md](references/workflows.md)。

| 信号 | 工作流 | 那条不能破的 |
| --- | --- | --- |
| 「加/改一个功能」「支持 X」 | **Feature** | 需求先于实现；垂直切片；做出来给用户看 |
| 「坏了」「报错」「偶尔 500」 | **Bug** | 先复现拿证据再找根因；**不懂根因禁止连环 patch** |
| 「太乱」「重复」「删掉旧的」 | **Refactor** | 默认不改有效产品行为；测试先护住行为 |
| 「太慢」「卡」 | **Perf** | **无 baseline 不许动手，无同口径对比不许宣称改善** |
| 「升级依赖」「迁移 API/schema」 | **Migration** | 先盘兼容面与回滚路径，再动 |

拿不准：有错误证据 → Bug；其余 → Feature。中途发现另一类问题记 Follow-up
（[TASK-087](../../../docs/tasks/active/TASK-087-followup-ledger.md) 总账），
**不换道也不顺手修**。

## 3 · Depth 定深 —— 四个变量取最高的那一档

**任务大小不是代码量，是错误决策的代价。** 四个变量各判一档，
**深度 = 其中最高的一档**（不平均、不投票）：

| 变量 | 问什么 | QUICK | STANDARD | DEEP |
| --- | --- | --- | --- | --- |
| **U** 不确定性 | 我现在说得出验收判据和它的证据吗 | 说得出，且只有一种读法 | 有一个待确认点，可写成显式假设 | 说不出验收长什么样，或多种读法各自成立 |
| **I** 影响面 | **错了会波及谁**（不是改了几个文件） | 只有这一处表现不对 | 同域内其他功能跟着不对 | 跨域 / 跨层传播，或持久数据变脏 |
| **R** 可逆性 | 撤销要做什么动作 | `git revert` 就够 | 要一次反向迁移或重跑，数据没丢 | 碰用户数据 / 已发出去的结果 / 钱 |
| **C** 合同变更 | 动了 schema / API / 持久化格式 / 公共接口 / 架构边界 / 外部合同吗 | 没有 | 没有，但新增了一处内部约定 | **有** |

两个必须判对的例子（更多与边界情形见 [depth.md](references/depth.md)）：

- 「挪一个按钮的位置」碰了 6 个文件 → U/I/R/C 全 QUICK → **QUICK**。文件数不是刻度。
- 「一个字段 nullable → required」只改 3 行 → C=DEEP → **DEEP**。行数更不是刻度。

**深度决定成果物**：

| 深度 | Requirement | Change Record | 影响分析 | Design |
| --- | --- | --- | --- | --- |
| **QUICK** | 有就引用，没有不建 | **提交信息即记录** | 对话里一句「改什么 / 不动什么」 | 不写 |
| **STANDARD** | 按第 4 环判 | 一张卡 `docs/tasks/active/` | 卡内一节，六面各一行 | 卡内结论几行 |
| **DEEP** | 涉产品行为则必须 CONFIRMED | 卡 + 需要时 ADR | 卡内一节 + 架构治理（第 5 环） | ADR + 当前架构合同 |

**验证与审查强度只看 I，与深度无关**（AGENTS §20 / ADR-0080 · ADR-0081）：
持久化里改一行 = QUICK 流程 + backend/studio 两个域的验证 + 一轮审查。

**升档随时生效**：改动扩散出预估边界、发现与已确认行为冲突、触发架构治理条件
→ 停下升档、补齐对应记录，再继续。

## 4 · Contract 定契约（人审的那一层到此为止）

**两份契约，各有归属，都不写实现步骤。**

### Requirement（What）—— 人类契约

- **只记产品需求。** Feature 与涉及用户可见行为的 Migration 建 / 引用 REQ；
  **Bug / Refactor / Perf / 工装默认不建** —— 它们的需求是「既有已确认行为应当
  成立 / 不变」，卡上一行 `技术目标：<为什么这个技术工作是必要的>` 即可。
  例外：修复过程中发现需求本身要变 → 那一刻起建 / 修订 REQ。
- **新需求或实质修订先过理解闸**：一小段说明**用户要得到什么 · 一个可观察的验收
  例子 · 本次边界与必要假设**。已有 REQ 直接引用，只说变化。理解不足记
  `UNDERSTANDING` 并先去查代码 / 跑 App / 看结果；充分记 `UNDERSTANDING_READY`；
  用户明确要求或既有确认已覆盖的，记录依据后进 `CONFIRMED` 继续。
  **不固定输出七段，不另建「需求理解 / 影响分析 / 实施计划」三份文档。**
- **验收判据写成有序列表** —— 序号就是后面对账与审查的句柄（`REQ-003 v1 判据 2`）。
- 需求变了 → 同文件追加 `v2 · supersedes v1`，**v1 一字不动**，实施只做 delta。
- Discovery 的 prototype / 实验 / 截图默认只是 **Evidence**，不自动成为正式实现。

### Design（How at system level）—— 系统契约

回答**系统用什么结构解决它**：边界在哪、依赖朝哪、状态住哪、失败怎么办。
**它不回答哪个函数怎么改** —— 那是执行面。

- 重大设计决策 → ADR 记**理由**，[当前架构合同](../../../docs/current-architecture.md)
  记**结论**，卡只放链接。
- 普通实现选择 → 卡内几行结论，不建文档。
- 技术 ADR 我自己 Accept 并写明依据（AGENTS §1）；涉付费或不可逆动用户数据的归用户。

### Decision Brief —— 案件控制面，是卡头，不是新文件

**一个案件一个 Brief，就住在任务卡头部**（QUICK 没有卡 → 提交信息里那两行）。
它比 v0.2 的卡头**只多两行**：`起因` 与 `成果物`。逐字段规则见
[records.md](references/records.md)。

```markdown
- 起因：<用户原话 / 缺陷现象 / 上一条决策> · 闸：放行（第 2 问，阻塞 TASK-106）
- 类型：Feature · 深度：DEEP（C=DEEP：改持久化格式）
- 成果物：REQ-009 · ADR-0104 · 本卡 · 提交
- 关联 Requirement：REQ-009 v1 判据 1,3      # 或 技术目标：<一句>
- 架构约束：CA §2 依赖方向 · CA §5.3 fail-closed   # 或 none-specific
```

**Brief 不回答「做完没有」** —— 目录即状态（`backlog/` → `active/` → `done/`，
[ADR-0083](../../../docs/adr/ADR-0083-docs-partitioned-by-completion.md)）。
卡上那条既有的 `状态：` 行写的是**交付了什么**，`lifecycle_check` 只保证它与
目录**不矛盾**（`状态：完成` 却留在 `active/` 当场转红）。

**Brief 不是新记录类型**：不建 traceability 数据库、不给卡加 metadata 文件、
不给每层建一种新文件（[ADR-0101](../../../docs/adr/ADR-0101-idea-intake-level-and-milestone-gate.md) §4 已裁决，不重访）。

## 5 · Execute 执行

### 先答「哪些不动」

**六个面各查一遍，输出两栏：要改的，和明确不动的**（AGENTS §2 · ADR-0101 决策 4）。

| 面 | 去哪找 |
| --- | --- |
| Requirement | `docs/requirements/` + 卡的「关联 Requirement」行 |
| UI | `mockups/motv-workspace/src/` + [产品信息架构](../../../docs/design/creator-product-information-architecture.md) |
| 数据 Schema | 持久化结构、`output.schema.json` 一类合同 |
| Workflow | `product-flows/` · 编排层 |
| 测试 | [CA §4](../../../docs/current-architecture.md) 的归属映射 |
| docs | 当前事实类文档（架构合同、IA、glossary） |

**「明确不动」那一栏是审查第 2 闸与收敛检查的对照物** —— 改了却写在「不动」栏里的
东西，就是范围扩散的第一个信号。缺了否定面，出现的就是那句已经付过的账：
「代码改了，但文档还是旧逻辑」。查过而无关的写「不动」，六面各一行就够。

### 架构治理（条件触发）

任一命中 → 读 [architecture.md](references/architecture.md)：跨多个模块 /
前后端或 API 合同改变 / shared·core 修改 / 数据模型改变 / 依赖方向改变 /
新公共抽象 / **一个看似局部的改动却要碰异常多文件**。

最后一条是 **Change Isolation** 铁律：简单需求引发大范围扩散时，先查
boundary leakage / 隐藏耦合 / 重复抽象，**不直接接受扩散**；必要时先做小范围
架构修复（另立卡），再回来做原任务。

### 执行纪律

- **垂直切片**，每片自己能跑、能演示、能验证；不按 schema → service → UI 分层推进。
- **代码级计划留在执行面**：文件、函数、字段、步骤序列写会话记忆或
  `.claude/tmp/`（已 gitignore），**不写进卡**，任务结束即删。要留的先提炼成卡上
  的结论几行再删原件（AGENTS §26）。
- 工程选择、排序、可逆 UI/UX 假设自己定，记录必要结论后继续。
  **一次任务里做到底，报告写在做完之后。** 实施阶段真正必须停的只有**花钱**
  （AGENTS §1）或**会话权限层拒绝**（如实报告一次，不反复问）。
- **改文件用编辑工具，或先写临时文件再替换**；不要让补丁脚本对目标文件直接截断
  写入 —— 编码异常会在截断之后抛出，留下 0 字节的源文件（TASK-105 实测）。

## 6 · Close 收口

### 定向验证

**Test Scope = Change Impact Scope**（第 3 环那个 **I**，不是深度）。归属映射见
[verification.md](references/verification.md) 与 AGENTS §20 / ADR-0080；
**全量只在集成检查点**（CI、连续链链尾、merge 前、发布 / 交接前）。

审查按影响范围触发（ADR-0081）：纯文档、纯展示不调；行为 / 合同 / 持久化 / 身份 /
登记 / 渲染与文件操作 / 付费 / 并发 / 安全 / Windows 可移植性 / 跨层 / 跨域 → 调
`codex-review-loop`，**默认 1 轮，P1 修复后复审一次**。「diff 很小」不是免审理由。

**调之前备 Review Package**（`.claude/tmp/review-package.md`，模板见
[traceability.md](references/traceability.md) §4）。审查因此按**四闸顺序**作答：
需求完成度 → 架构符合性 → 证据充分性 → 技术质量。**有 REQ 的 Change 不许不带包去审。**

### 收敛：仓库不能比之前更乱

**代码面**（清单在 verification.md）：obsolete 代码 / 测试 / 文档、临时 prototype、
死兼容层、保护已被取代行为的测试。测试保护 Current Valid Behavior，不保护
Historical Behavior。

**仓库面**（AGENTS §24–27 / ADR-0087 · ADR-0101，展开在
[lifecycle.md](references/lifecycle.md) §3）：新增的 `docs/` 文件每份都是当前事实
或历史证据吗（一次性产物提炼后删原件）· 有当前事实在说谎吗（尤其
`docs/current-architecture.md`，同一个提交里改）· 取代关系双向补上了吗 ·
REQ 追加 v2 了吗 · `active/` 里有做完的（→ `done/`）或没人做的（→ `backlog/`）吗 ·
同一事实是否多处重抄。

```
python .claude/tools/lifecycle_check.py     # 0 finding
python .claude/tools/gen_docs_status.py     # 六面 + 文档清单重新生成
```

**机器答不了的是那一行里程碑还对不对。** Mission / Strategy / Current Milestone 是
`docs/project-context.md` 里仅有的三行手写当前事实（`<!-- current-truth: … -->`
锚点）；本次若推进或换掉了里程碑，**在这个提交里改那一行**。

### Done 判定

「代码写完」「测试绿」都不是 Done。逐条：**每条验收判据都指得出实现与证据**吗
（指不出来的那条是 `REQUIREMENT_COVERAGE_GAP`，不是「大概做完了」）· 验证证的是
**判据里的行为**还是周边 · 引用的每条 `CA §N` 仍成立 · obsolete 已清或已记
Follow-up · REQ 与卡已到终态 · 临时产物已删或已正式化 · `lifecycle_check` 零发现。

**卡搬家属于 Done，不是可选的收尾**（ADR-0083）：

```
git mv docs/tasks/active/TASK-NNN-*.md docs/tasks/done/
python .claude/tools/lifecycle_check.py
python .claude/tools/gen_docs_status.py
```

**部分完成的卡留在 `active/`**（「部分完成」也是在办）。

### 交付

当前工作在 auto-push 管理的 Change 下（`docs/auto-push/changes/` 有清单）时，
commit / push / merge 交给 [`auto-push`](../auto-push/SKILL.md) Skill：`task-ready`
→ `stage` → 在 shell 跑它返回的 commit 命令 → `record-commit` → `push`。
没有清单时按 AGENTS §22 原样提交。**commit / push / merge 都不问**
（ADR-0085）；**只有花钱必须问**。

merge 的人工闸没有了，**前置条件一条不减**，且由我自己证明：Done 全部成立 +
**最终全量**（两阶段 pytest + 全量前端 + ruff）通过 + 无未闭合 P1 + 审查四闸结论为
Requirement 全 `PASS` · Architecture 无 `FAIL` · Verification `SUFFICIENT` ·
四个缺口标签一个不挂；再读
[待复审清单](../../../docs/design/active/pending-codex-rereview.md)确认没有覆盖本
分支历史的未闭合条目（TASK-102 就栽在只查卡不查清单）。细则见
[auto-push 的 merge 参考](../auto-push/references/merge-and-conflicts.md)。

**任一判据 `PARTIAL` / `FAIL` / `NOT_EVIDENCED` → Gate 不为 PASS，但这不是要问
用户** —— 缺实现就实现、缺证据就补、越界就改回来；真超范围就把缺口写成新卡并在
REQ 里记下它挪到哪，不让 `PARTIAL` 被 merge 掉。

提交完成后做一次 Post-Use Feedback（[`skill-evolution`](../skill-evolution/SKILL.md)
的 Fast Loop：两次脚本调用 + 一条 50–150 字反馈，不做深度分析，不改任何 Skill）。

---

## 旧步号 → 新环节

`docs/adr/` 是历史证据，**不回改**；v0.2 的步号在那里仍会出现，照此解析：

| v0.2 | v0.3 |
| --- | --- |
| 第 0 / 0.5 步（Repo Contract · Idea Intake） | **1 Intake** |
| 第 1 步（路由） | **2 Classify** |
| 第 2 步（深度） | **3 Depth** |
| 第 3 / 4 步（Requirement · Change Record） | **4 Contract** |
| 第 5 / 6 / 7 步（影响分析 · 架构治理 · 实施） | **5 Execute** |
| 第 8 / 9 / 10 步（定向验证 · 收敛 · Done） | **6 Close** |

## v0.4 预留（现在不做）

部署编排、发布自动化、secrets 管理、安全 / 可观测框架、企业审批流、
sprint / ticket 管理、强制多 Agent 编排、强制 TDD。repo 已有的机制照常兼容。
