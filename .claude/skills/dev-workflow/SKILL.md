---
name: dev-workflow
description: >-
  Software Development Operating Skill — the single entry point for any
  development request. INVOKE at the START of any task that will change code
  or behavior: new feature / enhancement, bug fix or debugging, refactor or
  cleanup, performance optimization, dependency or schema or framework
  migration, and requirement changes to already-shipped features. It routes
  the task to the right internal workflow, establishes requirement understanding
  and confirmation, picks the process depth, creates and maintains the Requirement
  / Change records, decides verification scope, and runs the convergence check
  before finishing. DO NOT invoke for:
  answering questions, explaining code, pure conversation, or running the
  review loop by itself (that is codex-review-loop, which this skill calls
  at the right moment).
---

# dev-workflow — 软件开发操作 Skill（v0.2）

一个入口，五条内部工作流，自动路由、自动建档、自动验证、自动收敛。
只有真正的产品决策才回到用户。

**本 Skill 是路由与记录层，不重定义本仓库已有的权威规则。**
测试归属与规模、审查触发与轮次、提交规则、决策模式，权威永远是
AGENTS.md（唯一一份规则：§1 决策模式、§6 测试与审查、§7 Git）、
ADR-0080/0081（测试归属与审查协议）、ADR-0068（连续修改链）。
本 Skill 与它们冲突时，以它们为准。

## 第 0 步 — Repo Contract 检查（每个新会话一次）

第一次在一个 repo 里工作时，先确认它能回答八个问题（怎么运行 / 有效事实
在哪 / Requirement 在哪 / Change 在哪 / 架构边界在哪 / 历史如何处理 /
测试怎么跑 / Agent 规则是什么）。本仓库的答案已收录在
[references/repo-contract.md](references/repo-contract.md) —— 已满足即直接用，
只有真缺失才补齐，**不平行创建第二套**。

## REQUIREMENT UNDERSTANDING GATE（第 1 步之前）

Before planning or implementation, establish product understanding.

Do not start coding merely because the user has described a feature.

For new requirements, meaningful requirement revisions, or ambiguous UX changes,
first produce a concise Requirement Understanding Check.

The purpose is to prove that the intended product behavior is understood.

### Output

#### 1. Goal

In your own words, state what outcome the user is trying to achieve.

Do not merely repeat the user's wording.

#### 2. Expected User Behavior

Describe concretely:

- what the user does
- what the system does
- what the user sees
- what happens next

Prefer one or two concrete user-flow examples.

#### 3. Scope

State what is included in this requirement.

#### 4. Non-Goals

State what is NOT implied by this requirement.

This is important for preventing unnecessary implementation expansion.

#### 5. Existing Behavior Impact

Identify:

- what current behavior remains unchanged
- what behavior changes
- what existing module/workflow is affected

#### 6. Acceptance Examples

Give a small number of observable examples.

Use:

Given ...
When ...
Then ...

These should describe product behavior, not implementation details.

#### 7. Open Product Decisions

Only list ambiguities that materially affect:

- user-visible behavior
- workflow
- product semantics
- compatibility with an already confirmed requirement

Do NOT ask the user about normal engineering decisions.

### GATE RULE

Implementation status remains:

`UNDERSTANDING`

until the requirement is sufficiently understood.

If no material product ambiguity remains, state:

`UNDERSTANDING_READY`

and present the understanding to the user.

For interactive product discovery, wait for the user's confirmation before promoting to:

`CONFIRMED`

Only after `CONFIRMED` may the workflow proceed to:

Impact Analysis
→ Planning
→ Implementation

### IMPORTANT

Do not use this gate as an excuse to ask unnecessary questions.

If the user's intent is already clear:

- make reasonable engineering assumptions
- state them briefly when relevant
- do not ask the user to decide implementation details

Ask the user only when different interpretations would create meaningfully different product behavior.

### ANTI-PATTERN

Bad:

> "I understand. Should I use React Context or Zustand?"

Bad:

> "Should I create src/components/feedback/FeedbackPanel.tsx?"

Bad:

> "Do you want REST or WebSocket?"

These are engineering decisions.

Good:

> "When the user clicks another UI component while the feedback conversation is open,
> should the conversation remain attached to the original component,
> or follow the newly selected component?"

This is a product behavior decision.

## 第 1 步 — 路由：这是哪种任务？

按用户请求的**意图**（不是措辞）选一条主工作流：

| 信号 | 工作流 | 铁律（详见 references/workflows.md） |
| --- | --- | --- |
| 「加/改一个功能」「支持 X」 | **Feature** | 需求先于实现；垂直切片；做出来给用户看 |
| 「坏了」「报错」「偶尔 500」「不对」 | **Bug** | 先复现拿证据，再找根因；**禁止不懂根因就连环 patch** |
| 「太乱」「重复」「删掉旧的」 | **Refactor** | 默认不改有效产品行为；测试先行护住行为 |
| 「太慢」「卡」「优化性能」 | **Perf** | **无 baseline 不许动手，无对比 benchmark 不许宣称改善** |
| 「升级依赖/框架」「迁移 API/schema」 | **Migration** | 先盘点兼容面与回滚路径，再动 |

拿不准时：有错误证据 → Bug；其余 → Feature。一个任务只有一条主工作流；
中途发现另一类问题记 Follow-up（TASK-087 总账），不换道也不顺手修。

## 第 2 步 — 定深度：QUICK / STANDARD / DEEP

深度管**流程重量**（建什么档、做多少分析）；**改动影响范围**管验证与审查重量
（AGENTS.md §20 / ADR-0080，不由本 Skill 重定义）。两者独立判断——
持久化里改一行 = QUICK 深度 + backend/studio 两个域的验证 + 一轮审查。

| 深度 | 适用 | Requirement | Change Record | Impact Analysis |
| --- | --- | --- | --- | --- |
| **QUICK** | 意图明确、范围一目了然、单模块 | 已有 REQ 就引用；没有不强制建 | **提交信息即记录**（引用 REQ/TASK） | 心算，不落纸 |
| **STANDARD** | 多文件/单模块以上，或有一个待确认点 | 按需（见第 3 步） | 任务卡（`docs/tasks/TASK-*.md`） | 卡内一节，几行 |
| **DEEP** | 跨模块、动合同/schema、迁移、高不确定 | 涉产品行为则必须 CONFIRMED REQ 或明确「依据」 | 任务卡 + 需要时 ADR | 卡内一节 + 架构治理 |

升档信号（实施中随时生效）：改动扩散出预估边界、触发第 5 步任一架构条件、
发现与已确认行为冲突 → 停下升档，补齐对应记录，再继续。

## 第 3 步 — Requirement Record

格式与规则见 [references/records.md](references/records.md)。要点：

- **REQ 只记产品需求。** 需要建/引用 REQ 的是 Feature 与涉及用户可见行为的
  Migration；**Bug / Refactor / Perf 默认不建**——它们的需求是「既有已确认
  行为应当成立/不变」，任务卡引用原始依据即可。例外：修复过程中发现需求
  本身要变 → 那一刻起建/修订 REQ。

- 记录**为什么要做、用户真正要什么**，不记实现方案。
- 新需求、实质性修订或含糊的 UX 变化先经过 Requirement Understanding Gate；
  用户原话是需求来源，**不再仅凭「描述了功能」自动视为 `CONFIRMED`**。
  无实质产品歧义时先标记 `UNDERSTANDING_READY` 并呈现理解；交互式产品探索须等
  用户确认后转 `CONFIRMED`。Agent 从探索中**推断**的需求仍记为 `DRAFT`，且不能
  绕过本 Gate 进入 Impact Analysis、Planning 或 Implementation。
- 已实现的需求在真实使用后变化 → **不篡改旧版**，在同一 REQ 文件里追加
  `v2 (supersedes v1)`，后续实施只处理 **v1→v2 delta**。
- Discovery 阶段允许读代码、跑 App、写临时代码、做 prototype、调 API、
  截图、做实验 —— 但产物默认只是 **Evidence**（帮助确认需求），
  **不自动成为正式实现**。需求确认后按正式工作流重新落地或正式化。

## 第 4 步 — Change Record

- QUICK：不建卡。提交信息写明意图 + 关联（`REQ-NNN` / `TASK-NNN`，如有）。
- STANDARD / DEEP：建任务卡**在 `docs/tasks/active/`**（目录即状态，
  [ADR-0083](../../../docs/adr/ADR-0083-docs-partitioned-by-completion.md)；
  卡不得直接躺在 `docs/tasks/` 下），沿用本仓库既有卡格式，含最小字段集
  （见 references/records.md）：id、状态、workflow 类型、深度、关联 REQ、
  目标、IN/OUT SCOPE、受影响模块、架构影响、实施摘要、已做验证、
  未解决项（→ Follow-up 总账）。**Agent 自动创建自动维护，用户不填。**
- 追溯链：`REQ → TASK（或提交信息）→ 代码 → 测试 → 验证记录`。

## 第 5 步 — Impact Analysis（轻量，为定范围而做）

识别：受影响 feature/module、API/合同影响、数据影响、依赖影响、
架构影响、受影响测试、文档影响。目的只有两个：**定修改范围 + 定验证范围**
（见 [references/verification.md](references/verification.md)），不是造文档。

## 第 6 步 — Architecture Governance（条件触发的共享子流程）

触发条件（任一命中 → 读 [references/architecture.md](references/architecture.md)）：

- 跨多个模块 / 前后端或 API 合同改变 / shared·core 修改 / 数据模型改变 /
  依赖方向改变 / 新公共抽象 / **一个看似局部的改动却要碰异常多文件**。

最后一条是 **Change Isolation** 铁律：简单需求引发大范围扩散时，先查
boundary leakage / 隐藏耦合 / 重复抽象，**不直接接受扩散**；必要时先做
小范围架构修复（另立卡），再回来做原任务。

## 第 7 步 — 实施

按所选工作流的节奏推进（references/workflows.md）。共同纪律：

- 垂直切片，能跑能演示；不按技术层拆。
- 工程决策自己定（拆文件、命名、helper、跑哪些测试、删明显 obsolete 代码、
  普通 refactor），**不问用户**。只有四种情况升级：产品歧义无法推断 /
  与已确认产品行为冲突 / 必须改已确认行为 / 真产品 trade-off（如保兼容 vs
  breaking）。问法按 AGENTS.md §1：「我打算 A，因为 X，代价 Y——要拦吗？」

- **以下四类永远不问，它们不在上面那四种里**（产品负责人 2026-08-23：
  「工程类的问题都不要再问……我需要你自动把所有的任务完成」）：

  | 不问 | 典型措辞（都是错的） | 正确做法 |
  | --- | --- | --- |
  | **排序 / 先做哪个** | 「先做用户功能还是先补工装缺陷？」 | 自己排，说明理由，直接做 |
  | **要不要继续** | 「要我接着做吗？」「要我核吗？」 | 继续。列表没做完就不停 |
  | **要不要核实 / 要不要清理** | 「要我把这个也查一下吗？」 | 查。核实是工作的一部分，不是待批准项 |
  | **把已列出的待办端回去让他挑** | 「剩下这些，你要哪个？」 | 按自己排的顺序做完，逐条报结果 |

  **判据**：这四类的共同点是**错了完全可以重来**（顺序不对就换个顺序，
  查错了就再查）。AGENTS.md §1 的判据是「错了能不能重来」——可重来的直接做。
  「需要产品负责人拍板」不是有效理由；**在技术问题上停下来问，等于把工作
  退回给用户**。

- Requirement Understanding Gate 在实施开始前完成；进入 `CONFIRMED` 后，
  **一次任务里把待办做到底，不中途交还控制权。** 报告写在做完之后，不是做之前。
  实施阶段真正必须停的只有**花钱**（AGENTS.md §1）或**会话权限层拒绝**
  （外部限制，如实报告一次，不反复问）。

## 第 8 步 — Targeted Verification

**Test Scope = Change Impact Scope**（归属映射见 references/verification.md）。
测试归属与全量触发以 AGENTS.md §20 / ADR-0080 为准：跑改动路径的**归属域**，
全量只在集成检查点。审查按影响范围触发（ADR-0081）：需要审的调
`codex-review-loop`（默认 1 轮，P1 复审一次），纯文档与纯展示改动不调。

## 第 9 步 — Convergence（完成前必查）

清单见 references/verification.md「收敛」节。核心：obsolete 代码/测试/文档、
临时 prototype、死兼容层、保护已被取代行为的测试 —— **旧行为已被新的
CONFIRMED REQ 明确取代的，允许删**。测试保护的是 Current Valid Behavior，
不是 Historical Behavior。

## 第 10 步 — Done 判定（轻量）

「代码写完」「测试绿」都不是 Done。逐条确认：REQ 满足？验证够（对本次
impact scope）？架构没有明显恶化？obsolete 已清或已记 Follow-up？
REQ / Change Record 已更新到终态？临时 prototype 已清除或已正式化？

**卡做完了还要把它搬过去** —— 这一步属于 Done，不是收尾的可选项
（[ADR-0083](../../../docs/adr/ADR-0083-docs-partitioned-by-completion.md)
决策 1/3）：

```
git mv docs/tasks/active/TASK-NNN-*.md docs/tasks/done/
python .claude/tools/gen_docs_status.py
```

**目录即状态**：留在 `active/` 的卡就是「还没做完」，所以一张已完成却没搬走的卡
会让下一个人重新推导它——那正是 2026-08-23 一天查出五处过期状态的成因。
`tests/tooling/test_docs_status.py` 会在忘记重生成时转红，但那是补救，不是流程：
守卫事后喊，不如这一步当场做对。**部分完成的卡留在 `active/`**（「部分完成」也是
在办）。`docs/design/` 下有完成状态的文档同理。

全部是 → 提交。当前工作在 auto-push 管理的 Change 下（`docs/auto-push/changes/`
有清单）时，commit/push 交给 `auto-push` Skill：`task-ready`（申报验证结果与
diff 范围）→ `stage` → 在 shell 运行其返回的 commit 命令 → `record-commit` →
`push`——Change 分支的 push 依 ADR-0079 决策 4 自动执行，不逐次问。

**merge 到 main 同样不问**（产品负责人 2026-08-24，[ADR-0085](../../../docs/adr/ADR-0085-merge-is-not-a-human-gate.md)）。
去掉的是「谁点头」，**前置条件一条不减**，而且现在由你自己负责证明：

1. Done 判定全部成立 + **最终全量**（两阶段 pytest + 全量前端 + ruff）通过 +
   无未闭合 P1；
2. 读[待复审清单](../../../docs/design/active/pending-codex-rereview.md)，确认没有
   覆盖本分支历史的未闭合条目 —— 这一条**比以前更要紧**：以前还有一个人会在
   合并前看一眼，现在没有了（TASK-102 就栽在只查任务卡不查清单）；
3. `set-merge-gate --gate PASS --by "<依据>"` —— `--by` 写的是**Done 判定 +
   最终全量的结果**，不再是用户原话；Gate 仍绑当前 tip，tip 一动即作废；
4. `premerge-sync --ledger-checked` → `merge` → `cleanup`。

没有清单时按 AGENTS.md §22 原样提交（commit / push / merge 都不必问；
**只有花钱必须问**）。

提交完成后做一次 Post-Use Feedback（`skill-evolution` Skill 的 Fast Loop：
两次脚本调用 + 一条 50–150 字反馈，不做深度分析，不改任何 Skill）。

## v0.3 预留（现在不做）

部署编排、发布自动化、secrets 管理、安全/可观测框架、企业审批流、
sprint/ticket 管理、强制多 Agent 编排、强制 TDD。repo 已有的机制照常兼容。
