---
name: dev-workflow
description: >-
  Route development work from requirement understanding through implementation,
  verification and delivery. Use at the start of features, bug fixes, refactors,
  performance work, migrations and development-document maintenance. Apply the
  current milestone gate, keep records minimal, and reconcile existing behavior
  and evidence before rework. Do not use for questions, code explanations, pure
  conversation or a standalone review (use codex-review-loop for that).
---

# dev-workflow — 软件开发操作 Skill（v0.2）

一个入口，五条内部工作流，按需记录、验证并交付可运行结果。
文档只保存继续开发必需的事实；用户不需要读完开发档案才能给反馈。

**本 Skill 是路由与记录层，不重定义本仓库已有的权威规则。**
测试归属与规模、审查触发与轮次、提交规则、决策模式，权威永远是
AGENTS.md（唯一一份规则：§1 决策模式、§6 测试与审查、§7 Git）、
ADR-0080/0081（测试归属与审查协议）、ADR-0068（连续修改链）。
本 Skill 与它们冲突时，以它们为准。

**文档约束先读**：[records.md「最小记录规则」](references/records.md)。
同一事实一处正文；QUICK 用提交、一般任务用一张卡、产品行为变化才动 REQ、
重大设计才立 ADR。复杂度增加可以加分析深度，不自动增加文件种类。
返工先核对判据、实现与证据，只处理差异；不靠多写一轮方案代替验证。

## 第 0 步 — Repo Contract 检查（每个新会话一次）

第一次在一个 repo 里工作时，先确认它能回答八个问题（怎么运行 / 有效事实
在哪 / Requirement 在哪 / Change 在哪 / 架构边界在哪 / 历史如何处理 /
测试怎么跑 / Agent 规则是什么）。本仓库的答案已收录在
[references/repo-contract.md](references/repo-contract.md) —— 已满足即直接用，
只有真缺失才补齐，**不平行创建第二套**。

「记录活多久、默认读什么、临时产物怎么办」是同一个合同的另一半，见
[references/lifecycle.md](references/lifecycle.md)（权威：AGENTS.md 第 24–27 条 /
[ADR-0087](../../../docs/adr/ADR-0087-document-lifecycle-and-default-agent-context.md)）。
**默认只加载当前事实**：AGENTS.md · 本次 REQ ·
[当前架构合同](../../../docs/current-architecture.md) 相关部分 · 本次那张卡 ·
`docs/STATUS.md` · 影响范围内的代码与测试。历史按需读，不默认读。

**接手一棵不是自己留下的树时，先核对再动手** ——
[references/handoff.md](references/handoff.md)：

```
python .claude/tools/agent_harness.py resume
```

它把三件事摆出来：工作树里有哪些未提交改动（**哪些可能是别人的**，AGENTS §14/§16）·
`docs/tasks/active/` 里哪些卡还开着 · 上一轮那条「跑过什么」在这个 tip 上**还算不算数**。
交接或压缩之前，反过来用 `handoff` 把机械状态记一条。**这不是新的询问闸**：
接回来就是接着做，不问「要不要继续」（AGENTS §1）。

## 第 0.5 步 — Idea Intake（一个新想法进来时，先做这个）

**禁止 `Idea → Code`。入口固定是 `Idea → 判层级 → 过里程碑闸 → Requirement → Code`**
（AGENTS.md §2 · [ADR-0101](../../../docs/adr/ADR-0101-idea-intake-level-and-milestone-gate.md)）。

**产出是对话里三行，不是一份文档**（ADR-0101 决策 6）：层级一行、闸的判定一行、
下一步一行。只有闸判 No 才产生持久物（一张 `backlog/` 卡）。一道要写文档才能过的
闸会被跳过 —— 保持它便宜是它能活下来的前提。

**什么时候跳过这一步**：用户指的是**已经在办的那张卡**里的下一步（继续、修它报的
错、补它缺的证据）。那不是新想法，直接干。

### 0.5a 判层级 —— 它是哪一层？

| 层 | 它回答什么 | 落在哪 | 谁定 |
| --- | --- | --- | --- |
| **Mission** | 这个产品为什么存在 | `project-context.md` 锚点行 | 用户 |
| **Strategy** | 用哪条路线达成 | `project-context.md` 锚点行 + ADR | 用户给方向，我记录 |
| **Milestone** | 这一轮交付什么 | `project-context.md` 锚点行 | 用户，**一句话** |
| **Requirement** | 用户/系统必须成立的**行为** | `docs/requirements/REQ-*.md` | 用户要求 / 反馈为依据（下一节） |
| **Solution** | 怎么实现它 | ADR / 任务卡「架构影响」 | **我自己定，不问** |
| **Implementation** | 具体改哪些文件 | 任务卡 + 提交 | **我自己定，不问** |

**想法留在它自己那一层，不许塌陷。** 两个方向都是错：

- **向下塌陷**（最常见）：一个 Milestone 级想法被当成 Implementation 直接开做。
  `active/` 长期挂九张卡就是这么来的 —— AGENTS.md §2 写的是 1 主线 + 1 阻塞项。
- **向上冒充**：一个 Implementation 细节被包装成 Requirement 递给用户拍板。
  AGENTS.md §1 已经点名过这种往返。

判不准时看**错了要重做多少**：重写几个文件 → Implementation；要重新确认用户行为
→ Requirement；要改路线 → Strategy 及以上。

### 0.5b Requirement 还是 Solution？—— 实现名词检验

把想法改写成一句「**谁**在**什么时候**能看到 / 得到**什么**」。改写后的句子里若
仍然必须出现**实现名词**（Agent、模块、服务、表、库、接口、脚本、框架）才说得通，
它就是 **Solution**。

```
递进来的：  「增加一个剧情一致性校验 Agent」
Requirement：章节提交后，与前文冲突的设定必须在定稿前被指出来
Solution：   用一个一致性 Agent 做校验    ← 我自己定，不进 REQ、不问用户
```

**Solution 不进 REQ，也不因为它「听起来像需求」就拿去问用户。** 方案被当成需求
收下，需求就被锁死在那一种实现上：后来发现别的做法更好时，改的会是「需求」，
于是白白惊动用户一次。

判成 Solution 之后**不是停下**：它服务的那条真需求已经在上面那句改写里了 ——
拿那句去过闸，实现方式我自己选。

### 0.5c Current Milestone Gate —— 现在必须做吗？

**先读当前里程碑**：[`docs/STATUS.md`](../../../docs/STATUS.md) 的「当前真相」节
第三面（它已经在默认上下文里，不用额外去翻 `project-context.md`）。

四问，**任一 Yes 即放行**：

1. 它在**当前里程碑**的交付面上吗？
2. 它**阻塞**当前在办的那条主线吗？
3. 不做会造成**不可逆损害**吗？（数据损坏 / 安全 / 已经发出去的错误结果）
4. 它是**几分钟内能完成**的当前事实修正吗？（过期文档、错状态行）

再看 **WIP**：AGENTS.md §2 的「1 主线 + 1 阻塞项」已经满，而它不属于第 2 问 →
即使属于当前里程碑，也进 `backlog/`。

**全 No → 落卡，当场说明，不实施。** 回答形如：

> 与长期 Mission 一致，但不服务当前 Milestone（<当前里程碑那一句>），
> 进入 Backlog（TASK-NNN），不实施。

**必须落卡**，不能只在对话里说「以后再说」—— 说过就丢。最小三行即可：

```markdown
# TASK-NNN：<一句话标题>

- 状态：未开工
- 技术目标：<为什么这件事成立>        # 有产品需求时写「关联 Requirement：REQ-NNN …」
- 为什么现在不做：<闸的哪一问全 No> · **什么条件下它会变成该做**：<一句>
```

第三行的后半句是关键：没有它，`backlog/` 就从队列变成垃圾桶。头部必须带
`技术目标：` 或 `关联 Requirement：`，否则 `lifecycle_check` 判 `ORPHAN_TASK`。

**这道闸不问用户。** 判据是 AGENTS.md §1 的「错了能不能重来」—— 判错了就
`git mv` 把卡搬回 `active/`。排序类问题永远不问，而这道闸就是排序。

## REQUIREMENT UNDERSTANDING GATE（第 1 步之前）

新需求或实质修订先用一小段说明：**用户要得到什么、一个可观察的验收例子、
本次边界与必要假设**。已有 REQ/任务卡直接引用，只说明变化；不固定输出七段，
不另建「需求理解」「影响分析」「实施计划」三份文档。

理解不足时记 `UNDERSTANDING`，先查现有要求、代码或可运行结果。
理解充分时记 `UNDERSTANDING_READY`；用户明确要求或既有确认已覆盖的工作，
记录依据后进入 `CONFIRMED` 并继续。仅讨论的设想保留 `DRAFT`，不擅自扩大任务。

**授权与产品满意度分开**：可逆 UI/UX 选择按 AGENTS.md §1 先做一版给用户看，
不设重复确认或签字闸；用户明确要求先讨论方案时遵从该范围。
真正需要询问的边界以 AGENTS.md §1 与会话权限为准，不能因模板有空项就停工。

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
| **QUICK** | 意图明确、范围一目了然、单模块 | 已有 REQ 就引用；没有不强制建 | **提交信息即记录**（引用 REQ/TASK） | 对话中简述要改 / 不动，不另建文件 |
| **STANDARD** | 多文件/单模块以上，或有一个待确认点 | 按需（见第 3 步） | 任务卡（`docs/tasks/active/TASK-*.md`） | 卡内一节，几行 |
| **DEEP** | 跨模块、动合同/schema、迁移、高不确定 | 涉产品行为则必须 CONFIRMED REQ 或明确「依据」 | 任务卡 + 需要时 ADR | 卡内一节 + 架构治理 |

升档信号（实施中随时生效）：改动扩散出预估边界、触发第 5 步任一架构条件、
发现与已确认行为冲突 → 停下升档，补齐对应记录，再继续。

## 第 3 步 — Requirement Record

格式与规则见 [references/records.md](references/records.md)。要点：

- **REQ 只记产品需求。** 需要建/引用 REQ 的是 Feature 与涉及用户可见行为的
  Migration；**Bug / Refactor / Perf 默认不建**——它们的需求是「既有已确认
  行为应当成立/不变」，任务卡引用原始依据即可。例外：修复过程中发现需求
  本身要变 → 那一刻起建/修订 REQ。

- 记录**为什么要做、用户真正要什么**，不记实现方案。**验收判据写成有序列表**
  —— 序号就是后面对账与审查的引用句柄（`REQ-003 v1 判据 2`），散文写不了对账。
- 新需求与实质修订按上面的理解闸建立共同理解；状态含义只在 records.md 定义，
  不增加第二套确认规则。
- 已实现的需求在真实使用后变化 → **不篡改旧版**，在同一 REQ 文件里追加
  `v2 (supersedes v1)`，后续实施只处理 **v1→v2 delta**。
- Discovery 阶段允许读代码、跑 App、写临时代码、做 prototype、调 API、
  截图、做实验 —— 但产物默认只是 **Evidence**（帮助确认需求），
  **不自动成为正式实现**。需求确认后按正式工作流重新落地或正式化。

## 第 4 步 — Change Record

- QUICK：不建卡。提交信息写明意图 + 关联（`REQ-NNN` / `TASK-NNN`，如有）。
- STANDARD / DEEP：建任务卡**在 `docs/tasks/active/`**（目录即状态，
  [ADR-0083](../../../docs/adr/ADR-0083-docs-partitioned-by-completion.md)；
  卡不得直接躺在 `docs/tasks/` 下）。使用 references/records.md 的紧凑模板；
  必要字段可以合并，不照搬历史长卡的章节。**Agent 自动维护，用户不填。**
- **追溯**：卡上只多两行 —— `关联 Requirement：REQ-NNN vK 判据 1,3`（无产品需求
  时改写 `技术目标：<一句，含为什么必要>`）与 `架构约束：CA §N …`（或
  `none-specific`）。两者皆无的卡是 `ORPHAN_TASK`，`lifecycle_check` 当场转红。
  完整链、句柄约定、缺口标签见 [references/traceability.md](references/traceability.md)。

## 第 5 步 — Impact Analysis（轻量，为定范围而做）

**改之前做，六个面都查一遍**（AGENTS.md §2 · ADR-0101 决策 4）：

| 面 | 去哪找 |
| --- | --- |
| **Requirement** | `docs/requirements/` + 卡的「关联 Requirement」行 |
| **UI** | `mockups/motv-workspace/src/` + [产品信息架构](../../../docs/design/creator-product-information-architecture.md) |
| **数据 Schema** | 持久化结构、`output.schema.json` 一类合同 |
| **Workflow** | `product-flows/` · 编排层 |
| **测试** | [CA §4](../../../docs/current-architecture.md) 的归属映射 |
| **docs** | 当前事实类文档（架构合同、IA、glossary） |

**输出两栏：要改的，和明确不动的。** QUICK 在对话简述，其他深度放原卡，不另建文件。
「不动」那一栏是后面审查
第 2 闸与收敛检查的对照物，**改了却写在「不动」栏里的东西就是范围扩散的第一个
信号**（→ 第 6 步 Change Isolation）。缺了否定面，出现的就是那句已经付过的账：
「代码改了，但文档还是旧逻辑」。

目的仍然只有两个：**定修改范围 + 定验证范围**
（见 [references/verification.md](references/verification.md)），不是造文档 ——
六面各一行就够，查过而无关的写「不动」，别扩写成报告。

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
- 工程选择、排序、可逆 UI/UX 假设按 AGENTS.md §1 自己定，记录必要结论后继续。
  确认规则统一使用上面的理解闸，不在实施阶段另加一轮文档确认。

- Requirement Understanding Gate 在实施开始前完成；进入 `CONFIRMED` 后，
  **一次任务里把待办做到底，不中途交还控制权。** 报告写在做完之后，不是做之前。
  实施阶段真正必须停的只有**花钱**（AGENTS.md §1）或**会话权限层拒绝**
  （外部限制，如实报告一次，不反复问）。

## 第 8 步 — Targeted Verification

**Test Scope = Change Impact Scope**（归属映射见 references/verification.md）。
测试归属与全量触发以 AGENTS.md §20 / ADR-0080 为准：跑改动路径的**归属域**，
全量只在集成检查点。审查按影响范围触发（ADR-0081，触发表与轮次协议不变）：需要审的调
`codex-review-loop`（默认 1 轮，P1 复审一次），纯文档与纯展示改动不调。

**调之前备 Review Package**（`.claude/tmp/review-package.md`，模板见
[references/traceability.md](references/traceability.md) §4）：本次声称完成的判据原文、
Task、引用的 `CA §N` 原文、变更面、验证证据、已知风险、实施摘要。审查因此按
**四闸顺序**作答 —— 需求完成度 → 架构符合性 → 证据充分性 → 技术质量，
且默认不扫全仓库（ADR-0088）。**有 REQ 的 Change 不许不带包去审。**

## 第 9 步 — Convergence（完成前必查）

**两个面，一起过。**

**代码面**：清单见 references/verification.md「收敛」节。核心：obsolete
代码/测试/文档、临时 prototype、死兼容层、保护已被取代行为的测试 ——
**旧行为已被新的 CONFIRMED REQ 明确取代的，允许删**。测试保护的是
Current Valid Behavior，不是 Historical Behavior。

**仓库面**（AGENTS.md 第 24–27 条 / ADR-0087 · ADR-0101，展开见
[references/lifecycle.md](references/lifecycle.md) §3）：

1. 这次新增的 `docs/` 文件，每一份都是**当前事实**或**历史证据**吗？
   一次性产物删掉，或提炼几行进 REQ / 卡 / ADR / 当前架构合同后删原件。
2. 有当前事实在**说谎**吗？尤其 `docs/current-architecture.md` ——
   边界 / 依赖方向 / 前后端合同 / 测试归属变了就在**同一个提交里**改它。
3. 取代了某条决策吗？→ **双向**链接补上（只改新 ADR 等于没写）。
4. 需求变了吗？→ REQ 追加 v2，v1 一字不动。
5. `active/` 里有做完的（→ `done/`）或没人在做的（→ `backlog/`）卡吗？
6. 有不再代表当前有效行为的测试 / 文档 / 兼容层吗？→ 删或更新。
7. **当前真相还能被重新构建吗？**（AGENTS.md 第 27 条 / ADR-0101 决策 5）
8. 本次有没有同一事实多处重抄、空模板章节、无独立用途的新文档？
   按 records.md 最小记录规则合并为一处正文与链接；只处理本次范围。

生命周期与旧记录由机器辅助检查，重复正文与文档必要性由 Agent 判断：

```
python .claude/tools/lifecycle_check.py
```

第 7 问也是机器先答一半 —— 六个面由生成器产出，锚点缺失即 fail-closed：

```
python .claude/tools/gen_docs_status.py     # 写 STATUS.md 的「当前真相」节
```

**机器答不了的是那一行里程碑说得还对不对。** Mission / Strategy / Current
Milestone 是 `docs/project-context.md` 里仅有的三行手写当前事实
（`<!-- current-truth: … -->` 锚点）；这次 Change 若推进或换掉了里程碑，
**就在这个提交里改那一行**。剩下三面（Active Requirements / Deferred /
Recent Decisions）从目录派生，不用手写。

**目标不是每个 Change 都增加文档，而是 Change 做完之后仓库不比之前更乱。**

## 第 10 步 — Done 判定（轻量）

「代码写完」「测试绿」都不是 Done。逐条确认：**每条验收判据都指得出实现与证据**
（判不出来的那条就是 `REQUIREMENT_COVERAGE_GAP`，不是「大概做完了」）？验证够
（对本次 impact scope，且证的是**判据里的行为**不只是周边）？引用的 `CA §N`
都仍然成立？obsolete 已清或已记 Follow-up？
REQ / Change Record 已更新到终态？临时 prototype 已清除或已正式化？
**当前架构合同仍然准确？`lifecycle_check` 零发现？**

**卡做完了还要把它搬过去** —— 这一步属于 Done，不是收尾的可选项
（[ADR-0083](../../../docs/adr/ADR-0083-docs-partitioned-by-completion.md)
决策 1/3）：

```
git mv docs/tasks/active/TASK-NNN-*.md docs/tasks/done/   # 或 backlog/（没人在做）
python .claude/tools/lifecycle_check.py                   # 0 finding
python .claude/tools/gen_docs_status.py                   # 重新生成总览
```

三条一起做，**不是可选项**。`backlog/` 是第三个状态目录（ADR-0087 决策 2）：
立了卡但短期不做的放那里 —— `active/` 只代表**正在进行**的工作。

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

1. Done 判定全部成立（含卡搬家 + `lifecycle_check` 零发现 + `STATUS.md` 已重新
   生成）+ **最终全量**（两阶段 pytest + 全量前端 + ruff）通过 + 无未闭合 P1；
   并且审查四闸的结论是 **Requirement 全 `PASS` · Architecture 无 `FAIL` ·
   Verification `SUFFICIENT` · 四个缺口标签一个不挂**（ADR-0088 决策 6）。
   任一判据 `PARTIAL` / `FAIL` / `NOT_EVIDENCED` → Gate 不为 PASS；**这不是要问
   用户** —— 缺实现就实现、缺证据就补、越界就改回来，真超范围就把缺口写成新卡
   并在 REQ 里记下它挪到哪；
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
